import { closeSync, mkdtempSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { TABLES, snapshotDb } from '../../../../scripts/backup.mjs'
import type { DB } from './db.ts'
import { openDb, upgradeDb } from './db.ts'

/**
 * Backups from Settings: the whole database downloaded as one file, and such a file put back.
 *
 * A restore never swaps files under the running app. Every part of it (the routes, the scheduler,
 * an update in progress) holds the one open handle, so the file is replaced through SQLite's online
 * backup API into that same file: the handle stays open and simply sees the restored contents on
 * its next statement, as it would see another connection's commit. Then the migrations run on it.
 */

/** The largest upload a restore accepts. It is streamed to disk, never held in memory. */
export const MAX_RESTORE_BYTES = 1024 ** 3

const HEADER = 'SQLite format 3\0'

/** The open database's file; a restore or a download needs one (not :memory:). */
export function dbFile(db: DB) {
  const file = db.location()
  if (!file) throw new Error('This database is not a file.')
  return file
}

/** data/backups, beside the database: the updater's pre-release copies and the pre-restore ones. */
export const backupsDir = (db: DB) => join(dirname(dbFile(db)), 'backups')

const pad = (n: number) => String(n).padStart(2, '0')
/** socialmonitor-2026-10-17-0930.db, in the server's time. */
export function backupName(at = new Date()) {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return `socialmonitor-${day}-${pad(at.getHours())}${pad(at.getMinutes())}.db`
}
/** 20261017T093000Z, as the updater stamps its copies. */
const stamp = (at = new Date()) => at.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')

/** A fresh, consistent copy of the live database in its own temporary folder. */
export function makeBackup(db: DB, at = new Date()) {
  const dir = mkdtempSync(join(tmpdir(), 'socialmonitor-backup-'))
  const name = backupName(at)
  const path = join(dir, name)
  snapshotDb(dbFile(db), path)
  return { dir, path, name, size: statSync(path).size }
}

export interface BackupFile {
  name: string
  size: number
  at: string
}
/** The copies in data/backups, newest first. */
export function listBackups(db: DB): BackupFile[] {
  const dir = backupsDir(db)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const s = statSync(join(dir, f))
      return { name: f, size: s.size, at: s.mtime.toISOString() }
    })
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** How many rows each main table has. */
export function countRows(db: DatabaseSync) {
  return Object.fromEntries(
    TABLES.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  )
}

/** Writes a request body to a file, refusing it past max bytes. Returns its size. */
export async function receive(
  body: AsyncIterable<Uint8Array>,
  file: string,
  max = MAX_RESTORE_BYTES,
) {
  const out = await open(file, 'w')
  let size = 0
  try {
    for await (const chunk of body) {
      size += chunk.length
      if (size > max) throw new RestoreError(413, 'The file is larger than 1 GB.')
      await out.write(chunk)
    }
  } finally {
    await out.close()
  }
  if (!size) throw new RestoreError(400, 'Choose a backup file.')
  return size
}

/** A refusal, with the HTTP status the route answers. */
export class RestoreError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const NOT_OURS = 'This file is not a SocialMonitor backup.'

/** Every table, column, index, trigger and view a database has, as "table.column" and "type:name". */
function shape(db: DatabaseSync) {
  const out = new Set<string>()
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as { type: string; name: string }[]
  for (const o of objects) {
    out.add(`${o.type}:${o.name}`)
    if (o.type !== 'table') continue
    for (const c of db.prepare(`PRAGMA table_info("${o.name.replace(/"/g, '""')}")`).all() as {
      name: string
    }[])
      out.add(`${o.name}.${c.name}`)
  }
  return out
}
/** What this version of the app makes: the schema of a new database after every migration. */
let known: Set<string> | null = null
const knownShape = () => {
  if (known) return known
  const db = openDb(':memory:')
  try {
    return (known = shape(db))
  } finally {
    db.close()
  }
}

/**
 * Checks an uploaded file and prepares it to go live, in work/: a SQLite database (by its header),
 * undamaged (integrity_check), with SocialMonitor's tables, and nothing this version does not know,
 * which would mean it comes from a newer version. The migrations then run on a copy, so an older
 * backup arrives already at this version's schema. Returns that copy's path and its row counts.
 */
export function checkUpload(upload: string, work: string, pageSize: number) {
  const head = Buffer.alloc(16)
  const fd = openSync(upload, 'r')
  try {
    readSync(fd, head, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  if (head.toString('latin1') !== HEADER) throw new RestoreError(400, NOT_OURS)

  const copy = join(work, 'restore.db')
  let src: DatabaseSync | null = null
  try {
    // Not read-only: a file copied from a WAL database opens only where its journal can be made.
    src = new DatabaseSync(upload)
    const integrity = (src.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])
      .map((r) => r.integrity_check)
      .join('; ')
    if (integrity !== 'ok') throw new RestoreError(400, 'This backup is damaged.')
    const has = shape(src)
    if (TABLES.some((t) => !has.has(`table:${t}`))) throw new RestoreError(400, NOT_OURS)
    // The migrations only ever add, so a table, column, index or trigger this version does not
    // make means a newer version made the file. Checked before anything runs on it.
    const ours = knownShape()
    if ([...has].some((x) => !ours.has(x)))
      throw new RestoreError(
        409,
        'This backup comes from a newer version of SocialMonitor. Update SocialMonitor first.',
      )
    // Its own copy, at the live database's page size: SQLite's backup into a WAL database needs
    // both the same. VACUUM INTO writes it whole, without the upload's journal.
    src.prepare('VACUUM INTO ?').run(copy)
  } catch (e) {
    if (e instanceof RestoreError) throw e
    throw new RestoreError(400, 'This backup is damaged.')
  } finally {
    src?.close()
  }
  const fix = new DatabaseSync(copy)
  try {
    if ((fix.prepare('PRAGMA page_size').get() as { page_size: number }).page_size !== pageSize) {
      fix.exec(`PRAGMA journal_mode = DELETE; PRAGMA page_size = ${Number(pageSize)}; VACUUM`)
    }
  } finally {
    fix.close()
  }

  let db: DatabaseSync
  try {
    db = openDb(copy)
  } catch {
    throw new RestoreError(400, 'This backup could not be brought up to this version.')
  }
  try {
    return { file: copy, counts: countRows(db) }
  } finally {
    db.close()
  }
}

/** Replaces the live database's contents with a prepared copy (checkUpload), on the same handle. */
export async function swapInto(db: DB, copy: string) {
  const src = new DatabaseSync(copy)
  try {
    await backup(src, dbFile(db), { rate: -1 })
  } finally {
    src.close()
  }
  upgradeDb(db)
}

/** Signs everyone out: the restored database's sessions belong to before the backup. */
export function endAllSessions(db: DB) {
  db.exec('UPDATE users SET session_version = session_version + 1; DELETE FROM sessions')
}

/** Where the safety copy of the current database goes before a restore. */
export const safetyPath = (db: DB, at = new Date()) =>
  join(backupsDir(db), `pre-restore-${stamp(at)}.db`)
