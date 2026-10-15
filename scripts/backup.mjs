// Encrypted off-site backup of data/ with restic, and the restore test that proves it works.
//
//   node scripts/backup.mjs                  nightly: snapshot the database, back up data/, and forget
//                                            old snapshots only when a prune credential is set
//   node scripts/backup.mjs --test-restore   monthly: restore the latest snapshot to a temp folder,
//                                            check the database there, delete the folder
//
// Settings come from the environment or .env: RESTIC_REPOSITORY, RESTIC_PASSWORD or
// RESTIC_PASSWORD_FILE, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. Forgetting snapshots deletes
// objects, so it runs only with RESTIC_PRUNE_AWS_ACCESS_KEY_ID and RESTIC_PRUNE_AWS_SECRET_ACCESS_KEY,
// a separate credential that is not kept on the computer. Optional: RESTIC_BIN, the restic binary.
//
// Logs to data/backup.log, writes the last results to data/backup-status.json, and exits non-zero on
// any failure so the scheduler reports it. See "Backups" in docs/server.md.
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DB_NAME = 'socialmonitor.db'
const TAG = 'socialmonitor'

/** What is backed up besides the database, relative to data/. Never the browser profile, the cache,
 * the keys or the tunnel's credentials: those belong to one machine. */
export const INCLUDE = ['reports', 'media', 'templates.json', 'brands.seed.json']
/** The tables the restore test counts. */
export const TABLES = ['brands', 'profiles', 'posts', 'comments', 'runs', 'users']

/** A consistent copy of a live SQLite database, safe while the dashboard writes to it. Never copy
 * the .db file itself: with WAL on, the file alone can be missing committed writes or be torn. */
export function snapshotDb(src, dest) {
  if (!existsSync(src)) throw new Error(`No database at ${src}`)
  mkdirSync(dirname(dest), { recursive: true })
  rmSync(dest, { force: true })
  const db = new DatabaseSync(src, { readOnly: true, timeout: 30_000 })
  try {
    db.prepare('VACUUM INTO ?').run(dest)
  } finally {
    db.close()
  }
}

/** Opens a database read-only and reports its integrity and the row count of each main table. */
export function checkDb(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const integrity = db
      .prepare('PRAGMA integrity_check')
      .all()
      .map((r) => r.integrity_check)
      .join('; ')
    const counts = Object.fromEntries(
      TABLES.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]),
    )
    return { integrity, counts }
  } finally {
    db.close()
  }
}

export const backupArgs = (paths) => ['backup', '--tag', TAG, ...paths]
export const forgetArgs = () => [
  'forget',
  '--tag',
  TAG,
  '--group-by',
  'host,tags',
  '--keep-daily',
  '30',
  '--keep-monthly',
  '12',
  '--prune',
]
export const restoreArgs = (target) => ['restore', 'latest', '--tag', TAG, '--target', target]

/** The settings that are missing from env, by name. */
export function missingSettings(env) {
  const missing = ['RESTIC_REPOSITORY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter(
    (k) => !env[k],
  )
  if (!env.RESTIC_PASSWORD && !env.RESTIC_PASSWORD_FILE)
    missing.push('RESTIC_PASSWORD or RESTIC_PASSWORD_FILE')
  return missing
}

/** The environment for forget: the prune credential in place of the nightly one, or null when no
 * prune credential is set, in which case nothing is forgotten. */
export function pruneEnv(env) {
  const id = env.RESTIC_PRUNE_AWS_ACCESS_KEY_ID
  const secret = env.RESTIC_PRUNE_AWS_SECRET_ACCESS_KEY
  return id && secret ? { ...env, AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret } : null
}

/** Finds a file by name anywhere under dir (restic restores the original absolute path). */
export function findFile(dir, name) {
  const hit = readdirSync(dir, { recursive: true }).find((p) => basename(String(p)) === name)
  return hit === undefined ? null : join(dir, String(hit))
}

function main() {
  try {
    process.loadEnvFile(join(ROOT, '.env'))
  } catch {
    /* no .env: the environment alone */
  }
  const env = process.env
  const data = resolve(env.SOCIALMONITOR_DATA ?? join(ROOT, 'data'))
  mkdirSync(data, { recursive: true })
  const logFile = join(data, 'backup.log')
  const statusFile = join(data, 'backup-status.json')
  const mode = process.argv.includes('--test-restore') ? 'restoreTest' : 'backup'

  const log = (text) => {
    const line = `${new Date().toISOString()} ${text}\n`
    process.stdout.write(line)
    appendFileSync(logFile, line)
  }
  const record = (patch) => {
    let status = {}
    try {
      status = JSON.parse(readFileSync(statusFile, 'utf8'))
    } catch {
      /* first run */
    }
    status[mode] = { ...status[mode], lastRunAt: new Date().toISOString(), ...patch }
    writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`)
  }
  const restic = (args, runEnv = env) => {
    const r = spawnSync(env.RESTIC_BIN || 'restic', args, {
      env: runEnv,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    })
    if (r.error)
      throw new Error(
        r.error.code === 'ENOENT' ? 'restic is not installed or not on PATH' : r.error.message,
      )
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    if (out) log(`restic ${args[0]}:\n${out}`)
    if (r.status !== 0) throw new Error(`restic ${args[0]} exited with code ${r.status}`)
  }

  try {
    const missing = missingSettings(env)
    if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')}`)

    if (mode === 'backup') {
      const snapshot = join(data, 'backup-snapshot', DB_NAME)
      try {
        snapshotDb(join(data, DB_NAME), snapshot)
        const paths = [snapshot, ...INCLUDE.map((p) => join(data, p)).filter(existsSync)]
        restic(backupArgs(paths))
      } finally {
        rmSync(dirname(snapshot), { recursive: true, force: true })
      }
      const prune = pruneEnv(env)
      if (prune) restic(forgetArgs(), prune)
      else log('Old snapshots kept: no prune credential set (RESTIC_PRUNE_AWS_*).')
      record({ ok: true, error: null, lastSuccessAt: new Date().toISOString() })
      log('Backup done.')
    } else {
      const target = mkdtempSync(join(tmpdir(), 'socialmonitor-restore-'))
      try {
        restic(restoreArgs(target))
        const db = findFile(target, DB_NAME)
        if (!db) throw new Error(`The latest snapshot has no ${DB_NAME}`)
        const { integrity, counts } = checkDb(db)
        log(`integrity_check: ${integrity}; rows: ${JSON.stringify(counts)}`)
        if (integrity !== 'ok') throw new Error(`The restored database is damaged: ${integrity}`)
        record({ ok: true, error: null, lastSuccessAt: new Date().toISOString(), counts })
        log('Restore test passed.')
      } finally {
        rmSync(target, { recursive: true, force: true })
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`FAILED (${mode}): ${message}`)
    record({ ok: false, error: message })
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
