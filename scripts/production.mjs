// SocialMonitor in production: runs the dashboard and keeps it up to date, safely. Started by
// systemd (scripts/production-setup.sh installs it); see "Production" in docs/server.md.
//
//   node scripts/production.mjs                 the service: runs the app, and every 60 s checks main
//   node scripts/production.mjs --release <sha> asks the running service to release that commit now
//                                               (still signature-checked)
//   node scripts/production.mjs --once          one round of the loop, with the service stopped (tests)
//   node scripts/production.mjs --baseline      once, at setup: makes this checkout the first release
//
// A round: `git fetch origin main`. When origin/main is a fast-forward of the live commit and every
// commit in between is signed by a key in the allowed_signers file, it is released: build it in its
// own folder → back up the database → stop the app, switch, start it → wait for /api/health to report
// the new commit → healthy: done; not healthy: the previous release goes back (with the database from
// before, when the new one changed its schema), and that commit is left alone until a newer one comes.
//
// Nothing from a fetched commit runs before its signature is checked: no `git pull`, no merges, and
// git runs with hooks turned off. The allowed_signers file lives outside the repository, so a push
// can't add its own key. data/ and .env stay at the repository root and are shared by every release.
//
// State: ~/.local/state/socialmonitor/ (status.json, updater.log, build.log, live, bad).
// Releases: ~/.local/share/socialmonitor/releases/<sha>, with `current` pointing at the live one.
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { missingSettings, snapshotDb } from './backup.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DB_NAME = 'socialmonitor.db'
const short = (sha) => String(sha).slice(0, 7)

/** Where everything lives. Each can be moved by the environment (the tests do). */
export function paths(env = process.env, repo = ROOT) {
  const share = env.SOCIALMONITOR_RELEASES_DIR ?? join(homedir(), '.local/share/socialmonitor')
  return {
    repo,
    data: resolve(env.SOCIALMONITOR_DATA ?? join(repo, 'data')),
    envFile: join(repo, '.env'),
    releases: join(share, 'releases'),
    current: join(share, 'current'),
    state: env.SOCIALMONITOR_STATE_DIR ?? join(homedir(), '.local/state/socialmonitor'),
    signers:
      env.SOCIALMONITOR_ALLOWED_SIGNERS ?? join(homedir(), '.config/socialmonitor/allowed_signers'),
  }
}

/** git in the repository, with the repository's hooks off and no prompts. */
export function git(repo, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}
const succeeds = (fn) => {
  try {
    fn()
    return true
  } catch {
    return false
  }
}
const isAncestor = (repo, a, b) => succeeds(() => git(repo, ['merge-base', '--is-ancestor', a, b]))

/** True when a key in the allowed_signers file signed this commit. An SSH key outside the file
 * gets trust "undefined", and minTrustLevel=fully fails it, as it does GPG signatures. */
export function verifyCommit(repo, sha, signers) {
  if (!existsSync(signers) || !statSync(signers).size) return false
  return succeeds(() =>
    git(repo, [
      '-c',
      `gpg.ssh.allowedSignersFile=${signers}`,
      '-c',
      'gpg.minTrustLevel=fully',
      'verify-commit',
      sha,
    ]),
  )
}

/** Why `to` can't go live after `from`, or null when it can: it must be a fast-forward, and every
 * commit in from..to, merges and merged branches included, must carry a trusted signature. */
export function refusal(repo, from, to, signers) {
  if (!isAncestor(repo, from, to))
    return `${short(to)} is not a fast-forward of the live ${short(from)} (a force-push?): not deploying it`
  const commits = git(repo, ['rev-list', `${from}..${to}`])
    .split('\n')
    .filter(Boolean)
  const unsigned = commits.filter((c) => !verifyCommit(repo, c, signers))
  return unsigned.length
    ? `commits without a trusted signature (${unsigned.map(short).join(', ')}): not deploying ${short(to)}`
    : null
}

/** The schema as SQL text: a release that changed it ran migrations. */
export function schemaOf(file) {
  if (!existsSync(file)) return ''
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (
      db
        .prepare(
          "SELECT group_concat(sql, ';\n') AS s FROM (SELECT sql FROM sqlite_master ORDER BY name)",
        )
        .get().s ?? ''
    )
  } finally {
    db.close()
  }
}

/** Keeps the newest `keep` pre-release copies in dir. */
export function pruneBackups(dir, keep = 20) {
  if (!existsSync(dir)) return []
  const old = readdirSync(dir)
    .filter((f) => /^pre-.+\.db$/.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(keep)
    .map(({ f }) => f)
  for (const f of old) rmSync(join(dir, f), { force: true })
  return old
}

/** The release folder's commit, for status.json. */
const versionOf = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
  } catch {
    return ''
  }
}

/**
 * The updater. Everything that touches the outside world is passed in, so the tests give it a fake
 * app, a fake health check and a fake build:
 *   child    { start(dir), stop(): Promise }   the app process
 *   health   () => Promise<{ ok, commit } | null>
 *   build    (dir) => Promise                  install and build a release folder; throws on failure
 *   offsite  () => Promise                     the restic backup, when configured
 *   onLive   (sha) => Promise                  after a healthy release
 */
export function updater(o) {
  const { repo, data, state, releases, current, signers } = o
  const healthTimeout = o.healthTimeout ?? 120_000
  const pollMs = o.pollMs ?? 2000
  const file = (n) => join(state, n)
  const read = (n) => {
    try {
      return readFileSync(file(n), 'utf8').trim()
    } catch {
      return ''
    }
  }
  const write = (n, v) => writeFileSync(file(n), `${v}\n`)
  mkdirSync(state, { recursive: true })
  mkdirSync(releases, { recursive: true })

  const log = (text) => {
    const line = `${new Date().toISOString()}  ${text}\n`
    if (!o.quiet) process.stdout.write(line)
    appendFileSync(file('updater.log'), line)
  }
  const liveDir = () => (existsSync(current) ? realpathSync(current) : null)
  const status = (result, message) => {
    const dir = liveDir()
    const body = {
      result,
      message,
      live: read('live'),
      version: dir ? versionOf(dir) : '',
      at: new Date().toISOString(),
    }
    writeFileSync(file('status.json.tmp'), `${JSON.stringify(body, null, 2)}\n`)
    renameSync(file('status.json.tmp'), file('status.json'))
  }
  /** Points `current` at dir in one step, so it never dangles. */
  const point = (dir) => {
    const tmp = `${current}.tmp`
    rmSync(tmp, { force: true })
    symlinkSync(dir, tmp)
    renameSync(tmp, current)
  }
  const removeRelease = (dir) => {
    succeeds(() => git(repo, ['worktree', 'remove', '--force', dir]))
    rmSync(dir, { recursive: true, force: true })
    succeeds(() => git(repo, ['worktree', 'prune']))
  }
  /** A clean folder for sha, checked out from the repository (git checks nothing out by itself). */
  const checkout = (sha) => {
    const dir = join(releases, sha)
    removeRelease(dir)
    git(repo, ['worktree', 'add', '--detach', dir, sha])
    return dir
  }

  async function waitHealthy(sha) {
    const until = Date.now() + healthTimeout
    while (Date.now() < until) {
      const h = await o.health().catch(() => null)
      if (h?.ok && h.commit && sha.startsWith(h.commit)) return true
      await new Promise((r) => setTimeout(r, pollMs))
    }
    return false
  }

  async function release(sha) {
    const subject = git(repo, ['log', '-1', '--format=%s', sha])
    log(`release: ${short(sha)} ${subject}`)
    status('building', `building ${short(sha)}`)

    let dir
    try {
      dir = checkout(sha)
      // A second try: a download that broke halfway is the usual failure.
      await o.build(dir).catch(async (e) => {
        log(`release: the build failed (${e.message}), trying once more`)
        await o.build(dir)
      })
    } catch (e) {
      log(`release: the build FAILED: ${e.message}. The end of build.log has the details.`)
      if (dir) removeRelease(dir)
      write('bad', sha)
      status('failed', `the build of ${short(sha)} failed: nothing changed`)
      return false
    }

    const db = join(data, DB_NAME)
    let backup = null
    if (existsSync(db)) {
      try {
        const backups = join(data, 'backups')
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
        backup = join(backups, `pre-${short(sha)}-${stamp}.db`)
        snapshotDb(db, backup)
        pruneBackups(backups)
        log(`backup: ${basename(backup)}`)
      } catch (e) {
        log(`backup FAILED (${e.message}): not switching without one`)
        removeRelease(dir)
        status('failed', 'the backup failed: nothing changed')
        return false
      }
      await o
        .offsite?.()
        .catch((e) => log(`off-site backup failed (${e.message}); releasing anyway`))
    }

    const schema = schemaOf(db)
    const previous = liveDir()
    const previousSha = read('live')
    await o.child.stop()
    point(dir)
    o.child.start(dir)

    if (await waitHealthy(sha)) {
      write('live', sha)
      rmSync(file('bad'), { force: true })
      log(`release: ${short(sha)} is live and healthy`)
      status('ok', `live: ${short(sha)} ${subject}`)
      // Keep the live release and the one before it, for the next rollback.
      for (const f of readdirSync(releases))
        if (![dir, previous].includes(join(releases, f))) removeRelease(join(releases, f))
      await o.onLive?.(sha)
      return true
    }

    log(`release: ${short(sha)} is NOT healthy after ${healthTimeout / 1000}s, rolling back`)
    write('bad', sha)
    await o.child.stop()
    if (!previous) {
      status(
        'failed',
        `${short(sha)} is not healthy, and there is no earlier release to go back to`,
      )
      return false
    }
    // The new release changed the schema (it ran migrations), so the database goes back to the copy
    // taken just before the switch. This is safe: the copy is consistent, the old release expects
    // exactly that schema, and the only writes lost are the ones the failed release made in the
    // minutes it was up, while it never passed its health check.
    if (backup && schemaOf(db) !== schema) {
      for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true })
      copyFileSync(backup, db)
      log(
        `rollback: the database is back to ${basename(backup)} (the new release had changed its schema)`,
      )
    }
    point(previous)
    o.child.start(previous)
    if (await waitHealthy(previousSha)) {
      log(`rollback: ${short(previousSha)} is healthy again`)
      status('rolled-back', `${short(sha)} was not healthy; back on ${short(previousSha)}`)
    } else {
      log('rollback: still not healthy')
      status('failed', `neither ${short(sha)} nor ${short(previousSha)} is healthy`)
    }
    return false
  }

  /** Releases sha after the checks. manual: --release, which may also go back to an older commit
   * already in the live history (trusted, since it went live through these checks or the baseline). */
  async function releaseCommit(sha, manual = false) {
    const live = read('live')
    if (!live) {
      status('failed', 'nothing is live yet: run scripts/production-setup.sh')
      return false
    }
    let full
    try {
      full = git(repo, ['rev-parse', '--verify', `${sha}^{commit}`])
    } catch {
      log(`release: no commit ${sha} here`)
      status('refused', `no commit ${sha} here`)
      return false
    }
    if (full === live) return true
    const back = manual && isAncestor(repo, full, live)
    const why = back ? null : refusal(repo, live, full, signers)
    if (why) {
      if (read('bad') !== full) log(`git: ${why}`)
      write('bad', full)
      status('refused', why)
      return false
    }
    const done = await release(full)
    // Going back by hand: leave main's tip alone until a newer commit comes, or the next round
    // would put it straight back.
    if (done && back) {
      let tip = live
      try {
        tip = git(repo, ['rev-parse', 'origin/main'])
      } catch {
        /* no origin/main yet */
      }
      write('bad', tip)
    }
    return done
  }

  /** One round: a pending --release first, then origin/main. */
  async function round() {
    const request = read('request')
    if (request) {
      rmSync(file('request'), { force: true })
      return releaseCommit(request, true)
    }
    try {
      git(repo, ['fetch', '--quiet', '--no-tags', 'origin', 'main'])
    } catch (e) {
      log(`git: fetch failed (${e.message.split('\n')[0]})`)
      return false
    }
    const tip = git(repo, ['rev-parse', 'origin/main'])
    if (tip === read('live') || tip === read('bad')) return true
    return releaseCommit(tip)
  }

  /** The first release, at setup: this checkout as it is, trusted without signatures. */
  async function baseline() {
    if (read('live'))
      throw new Error(`Already set up: ${short(read('live'))} is live. Nothing done.`)
    const sha = git(repo, ['rev-parse', 'HEAD'])
    log(`baseline: ${short(sha)} (the history up to here is trusted as cloned)`)
    const dir = checkout(sha)
    await o.build(dir)
    point(dir)
    write('live', sha)
    status('ok', `baseline: ${short(sha)}`)
    return sha
  }

  return { round, release, releaseCommit, baseline, log, status, liveDir }
}

/** The app as a child process, restarted with backoff when it stops by itself. */
export function appProcess(p, log) {
  let child = null
  let stopping = false
  let failures = 0
  let dir = null
  let timer = null
  const launch = () => {
    const started = Date.now()
    child = spawn(process.execPath, ['apps/app/src/server/main.ts'], {
      cwd: dir,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SOCIALMONITOR_DATA: p.data,
        SOCIALMONITOR_ENV_FILE: p.envFile,
      },
    })
    child.on('exit', (code, signal) => {
      child = null
      if (stopping) return
      failures = Date.now() - started > 60_000 ? 0 : failures + 1
      const wait = Math.min(60_000, 1000 * 2 ** failures)
      log(`app: stopped (${signal ?? `code ${code}`}); starting it again in ${wait / 1000}s`)
      timer = setTimeout(launch, wait)
    })
  }
  return {
    start(d) {
      dir = d
      stopping = false
      failures = 0
      launch()
    },
    stop() {
      stopping = true
      clearTimeout(timer)
      if (!child) return Promise.resolve()
      const c = child
      return new Promise((done) => {
        const kill = setTimeout(() => c.kill('SIGKILL'), 15_000)
        c.once('exit', () => {
          clearTimeout(kill)
          done()
        })
        c.kill('SIGTERM')
      })
    },
  }
}

/** Runs a command, its output going to build.log; rejects on a non-zero exit. */
function run(cmd, args, cwd, logFile, env = process.env) {
  return new Promise((done, fail) => {
    const fd = openSync(logFile, 'a')
    const c = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd] })
    let ended = false
    const end = (err) => {
      if (ended) return
      ended = true
      closeSync(fd)
      if (err) fail(err)
      else done()
    }
    c.on('error', end)
    c.on('exit', (code) =>
      end(code === 0 ? null : new Error(`${cmd} ${args.join(' ')} exited with code ${code}`)),
    )
  })
}

async function main() {
  const p = paths()
  const args = process.argv.slice(2)
  mkdirSync(p.state, { recursive: true })
  const pidFile = join(p.state, 'updater.pid')
  const running = () => {
    const pid = Number(existsSync(pidFile) && readFileSync(pidFile, 'utf8'))
    return pid && pid !== process.pid && succeeds(() => process.kill(pid, 0)) ? pid : 0
  }

  const buildLog = join(p.state, 'build.log')
  // What this process runs, to notice when a release brings a new version of it.
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  let log = console.log
  const child = appProcess(p, (t) => log(t))
  const u = updater({
    ...p,
    child,
    health: async () => {
      // The app's port: 4400, unless SOCIALMONITOR_API_PORT moves it (the child reads it too).
      const port = process.env.SOCIALMONITOR_API_PORT ?? 4400
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000),
      })
      return r.ok ? r.json() : null
    },
    build: async (dir) => {
      writeFileSync(buildLog, `${new Date().toISOString()} building ${dir}\n`)
      await run('yarn', ['install', '--frozen-lockfile', '--non-interactive'], dir, buildLog)
      await run('yarn', ['--cwd', 'apps/app', 'build'], dir, buildLog)
      // The Chromium this Playwright version expects; a no-op when it is already there.
      await run(join(dir, 'node_modules/.bin/playwright'), ['install', 'chromium'], dir, buildLog)
    },
    offsite: async () => {
      let conf = { ...process.env }
      try {
        conf = { ...parseEnv(readFileSync(p.envFile, 'utf8')), ...process.env }
      } catch {
        /* no .env */
      }
      if (missingSettings(conf).length) return
      await run(process.execPath, ['scripts/backup.mjs'], p.repo, join(p.state, 'offsite.log'))
    },
    onLive: async (sha) => {
      // The checkout at the repository root follows the live commit, so its scripts (this updater,
      // the backup, the tunnel) match. A checkout with local changes is left as it is.
      try {
        git(p.repo, ['merge', '--ff-only', '--quiet', sha])
      } catch {
        log(
          `git: the checkout at ${p.repo} has local changes or moved on; its scripts stay as they are`,
        )
        return
      }
      if (readFileSync(fileURLToPath(import.meta.url), 'utf8') !== self) {
        log('updater: a new version of myself is live; restarting (systemd starts me again)')
        await child.stop()
        process.exit(0)
      }
    },
  })
  log = u.log

  if (args[0] === '--release') {
    const pid = running()
    if (!args[1]) throw new Error('Usage: production.mjs --release <sha>')
    if (!pid) throw new Error('The service is not running: sudo systemctl start socialmonitor')
    const before = existsSync(join(p.state, 'status.json'))
      ? readFileSync(join(p.state, 'status.json'), 'utf8')
      : ''
    writeFileSync(join(p.state, 'request'), `${args[1]}\n`)
    process.kill(pid, 'SIGUSR2')
    console.log(`Asked the service to release ${args[1]}. Waiting for the result…`)
    for (let i = 0; i < 900; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      let now = before
      try {
        now = readFileSync(join(p.state, 'status.json'), 'utf8')
      } catch {
        /* not written yet */
      }
      const pending = existsSync(join(p.state, 'request'))
      if (now !== before && !pending && JSON.parse(now).result !== 'building')
        return console.log(now)
    }
    throw new Error('No result after 15 minutes: see updater.log')
  }
  if (running())
    throw new Error('The service is running; stop it first: sudo systemctl stop socialmonitor')
  writeFileSync(pidFile, String(process.pid))

  if (args[0] === '--baseline') {
    await u.baseline()
    return
  }

  if (args[0] === '--once') {
    if (u.liveDir()) child.start(u.liveDir())
    await u.round()
    await child.stop()
    return
  }

  let wake = null
  const stop = async () => {
    await child.stop()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGUSR2', () => wake?.())
  if (u.liveDir()) child.start(u.liveDir())
  else u.status('failed', 'nothing is live yet: run scripts/production-setup.sh')
  u.log('watching origin/main every 60s')
  for (;;) {
    await u.round().catch((e) => u.log(`round failed: ${e.message}`))
    await new Promise((r) => {
      wake = r
      setTimeout(r, Number(process.env.SOCIALMONITOR_CHECK_EVERY ?? 60) * 1000)
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
