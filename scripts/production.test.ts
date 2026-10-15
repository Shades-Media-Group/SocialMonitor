import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pruneBackups, refusal, updater, verifyCommit } from './production.mjs'

// Git here must not read this computer's settings (its signing key, its hooks).
const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = saved.global
  if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = saved.system
})

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sm-production-')))
  dirs.push(d)
  return d
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()

/** A commit, signed with key when given; returns its sha. */
function commit(cwd: string, message: string, key?: string, file = 'notes.txt') {
  writeFileSync(join(cwd, file), `${message}\n`)
  git(cwd, 'add', '-A')
  const sign = key
    ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'commit', '-S']
    : ['commit']
  git(cwd, ...sign, '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

const hasSsh = !spawnSync('ssh-keygen', ['-?']).error

describe.skipIf(!hasSsh)('production updater', () => {
  let keys: string
  let trusted: string
  let stranger: string
  let signers: string
  beforeAll(() => {
    keys = temp()
    trusted = join(keys, 'trusted')
    stranger = join(keys, 'stranger')
    for (const k of [trusted, stranger])
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', k])
    signers = join(keys, 'allowed_signers')
    const pub = readFileSync(`${trusted}.pub`, 'utf8').trim()
    writeFileSync(signers, `cristian.brinza@shades.md namespaces="git" ${pub}\n`)
  })

  describe('the signature gate', () => {
    it('passes a commit signed by an allowed key, and fails unsigned and unknown keys', () => {
      const repo = temp()
      git(repo, 'init', '-q', '-b', 'main')
      const base = commit(repo, 'base')
      const good = commit(repo, 'signed', trusted)
      const other = commit(repo, 'other key', stranger)
      expect(verifyCommit(repo, good, signers)).toBe(true)
      expect(verifyCommit(repo, base, signers)).toBe(false)
      expect(verifyCommit(repo, other, signers)).toBe(false)
      const empty = join(keys, 'empty')
      writeFileSync(empty, '')
      expect(verifyCommit(repo, good, empty)).toBe(false)
      expect(verifyCommit(repo, good, join(keys, 'missing'))).toBe(false)
    })

    it('checks every commit in the range, not only the tip', () => {
      const repo = temp()
      git(repo, 'init', '-q', '-b', 'main')
      const live = commit(repo, 'live (unsigned baseline)')
      const a = commit(repo, 'a', trusted)
      expect(refusal(repo, live, a, signers)).toBeNull()
      commit(repo, 'sneaked in, unsigned')
      const tip = commit(repo, 'signed tip', trusted)
      expect(refusal(repo, live, tip, signers)).toMatch(/without a trusted signature/)
      expect(refusal(repo, a, tip, signers)).toMatch(/without a trusted signature/)
    })

    it('needs merge commits signed too', () => {
      const repo = temp()
      git(repo, 'init', '-q', '-b', 'main')
      const live = commit(repo, 'live')
      git(repo, 'checkout', '-q', '-b', 'side')
      commit(repo, 'side', trusted, 'side.txt')
      git(repo, 'checkout', '-q', 'main')
      commit(repo, 'main', trusted)
      git(repo, 'merge', '-q', '--no-ff', '-m', 'merge, unsigned', 'side')
      const unsignedMerge = git(repo, 'rev-parse', 'HEAD')
      expect(refusal(repo, live, unsignedMerge, signers)).toMatch(/without a trusted signature/)
      git(repo, 'reset', '-q', '--hard', 'HEAD~1')
      git(
        repo,
        '-c',
        'gpg.format=ssh',
        '-c',
        `user.signingkey=${trusted}`,
        'merge',
        '-q',
        '-S',
        '--no-ff',
        '-m',
        'merge, signed',
        'side',
      )
      expect(refusal(repo, live, git(repo, 'rev-parse', 'HEAD'), signers)).toBeNull()
    })

    it('refuses a move that is not a fast-forward (a force-push)', () => {
      const repo = temp()
      git(repo, 'init', '-q', '-b', 'main')
      const base = commit(repo, 'base')
      const live = commit(repo, 'live', trusted)
      git(repo, 'checkout', '-q', '-b', 'rewritten', base)
      const forced = commit(repo, 'rewritten history', trusted)
      expect(refusal(repo, live, forced, signers)).toMatch(/not a fast-forward/)
    })
  })

  describe('release and rollback', () => {
    // origin on GitHub, the server's clone, and a Mac that pushes.
    let origin: string, server: string, mac: string, home: string
    let data: string, db: string
    let running: string | null = null
    const starts: string[] = []
    const broken = new Set<string>()
    const migrates = new Set<string>()
    const failsBuild = new Set<string>()
    let u: ReturnType<typeof updater>
    const state = () => join(home, 'state')
    const status = () => JSON.parse(readFileSync(join(state(), 'status.json'), 'utf8'))
    const live = () => readFileSync(join(state(), 'live'), 'utf8').trim()
    const columns = () => {
      const d = new DatabaseSync(db, { readOnly: true })
      try {
        return (d.prepare('PRAGMA table_info(brands)').all() as { name: string }[]).map(
          (c) => c.name,
        )
      } finally {
        d.close()
      }
    }
    const push = (message: string, key?: string) => {
      const sha = commit(mac, message, key)
      git(mac, 'push', '-q', 'origin', 'main')
      return sha
    }

    beforeAll(() => {
      const root = temp()
      origin = join(root, 'origin.git')
      git(root, 'init', '-q', '--bare', '-b', 'main', origin)
      mac = join(root, 'mac')
      git(root, 'clone', '-q', origin, mac)
      commit(mac, 'the history before signing')
      git(mac, 'push', '-q', 'origin', 'main')
      server = join(root, 'server')
      git(root, 'clone', '-q', origin, server)
      home = join(root, 'home')
      data = join(server, 'data')
      mkdirSync(data)
      db = join(data, 'socialmonitor.db')
      const d = new DatabaseSync(db)
      d.exec(
        "CREATE TABLE brands (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO brands (name) VALUES ('Tavelo')",
      )
      d.close()

      u = updater({
        repo: server,
        data,
        state: state(),
        releases: join(home, 'releases'),
        current: join(home, 'current'),
        signers,
        quiet: true,
        healthTimeout: 300,
        pollMs: 10,
        build: async (dir: string) => {
          if (failsBuild.has(basename(dir))) throw new Error('yarn install exited with code 1')
        },
        child: {
          start(dir: string) {
            const sha = basename(dir)
            starts.push(sha)
            running = sha
            if (migrates.has(sha)) {
              const d = new DatabaseSync(db)
              d.exec(
                "ALTER TABLE brands ADD COLUMN fresh TEXT; INSERT INTO brands (name) VALUES ('written by the failed release')",
              )
              d.close()
            }
          },
          stop: async () => {
            running = null
          },
        },
        health: async () =>
          running && !broken.has(running) ? { ok: true, commit: running.slice(0, 7) } : null,
      })
    })

    it('makes the cloned checkout the first release, without a signature check', async () => {
      const sha = await u.baseline()
      expect(live()).toBe(sha)
      expect(realpathSync(join(home, 'current'))).toBe(join(home, 'releases', sha))
      await expect(u.baseline()).rejects.toThrow(/Already set up/)
    })

    it('releases a signed push: backup, switch, health', async () => {
      const sha = push('feature', trusted)
      expect(await u.round()).toBe(true)
      expect(live()).toBe(sha)
      expect(running).toBe(sha)
      expect(status()).toMatchObject({ result: 'ok', live: sha })
      expect(
        readdirSync(join(data, 'backups')).some((f) => f.startsWith(`pre-${sha.slice(0, 7)}-`)),
      ).toBe(true)
    })

    it('rolls back an unhealthy release, restores the database it migrated, and leaves it alone', async () => {
      const before = live()
      const sha = push('breaks on start', trusted)
      broken.add(sha)
      migrates.add(sha)
      expect(await u.round()).toBe(false)
      expect(live()).toBe(before)
      expect(running).toBe(before)
      expect(realpathSync(join(home, 'current'))).toBe(join(home, 'releases', before))
      expect(status()).toMatchObject({ result: 'rolled-back', live: before })
      expect(columns()).not.toContain('fresh')
      expect(readFileSync(join(state(), 'bad'), 'utf8').trim()).toBe(sha)
      const count = starts.length
      expect(await u.round()).toBe(true)
      expect(starts.length).toBe(count)
    })

    it('refuses an unsigned push and keeps the live release running', async () => {
      const before = live()
      const count = starts.length
      push('unsigned')
      expect(await u.round()).toBe(false)
      expect(status().result).toBe('refused')
      expect(status().message).toMatch(/without a trusted signature/)
      expect(live()).toBe(before)
      expect(starts.length).toBe(count)
    })

    it('a failed build changes nothing', async () => {
      // The unsigned commit is still in the range, so sign on top and drop it first.
      git(mac, 'reset', '-q', '--hard', 'HEAD~1')
      const sha = commit(mac, 'does not build', trusted)
      git(mac, 'push', '-q', '--force', 'origin', 'main')
      failsBuild.add(sha)
      const before = live()
      expect(await u.round()).toBe(false)
      expect(status().result).toBe('failed')
      expect(live()).toBe(before)
      expect(existsSync(join(home, 'releases', sha))).toBe(false)
    })
  })
})

describe('pre-release backups', () => {
  it('keeps the newest 20', () => {
    const dir = temp()
    for (let i = 0; i < 25; i++) {
      const f = join(dir, `pre-abc${i}-x.db`)
      writeFileSync(f, '')
      utimesSync(f, 1000 + i, 1000 + i)
    }
    writeFileSync(join(dir, 'other.db'), '')
    const removed = pruneBackups(dir)
    expect(removed.sort()).toEqual([
      'pre-abc0-x.db',
      'pre-abc1-x.db',
      'pre-abc2-x.db',
      'pre-abc3-x.db',
      'pre-abc4-x.db',
    ])
    expect(readdirSync(dir)).toHaveLength(21)
  })
})
