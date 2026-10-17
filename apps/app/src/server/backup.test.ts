import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDb } from '../../../../scripts/backup.mjs'
import { openDb } from '../core/db.ts'
import type { DB } from '../core/db.ts'
import * as auth from '../core/auth.ts'
import { addBrand } from '../core/store.ts'
import { backupName } from '../core/backup.ts'
import { holdRuns, queueRun, releaseRuns } from '../core/run.ts'
import { backupRoutes } from './backup-routes.ts'
import type { Ctx } from './routes.ts'
import { guard } from './routes.ts'

const dirs: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sm-backup-routes-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const route = (method: string, path: string) =>
  backupRoutes.find((r) => r.method === method && r.path.test(path))!
const download = route('GET', '/api/admin/backup')
const restore = route('POST', '/api/admin/restore')
const listing = route('GET', '/api/admin/backups')

/** A live database in data/ of a temp folder, with a super admin, a viewer and a brand. */
function setup() {
  const data = temp()
  const db = openDb(join(data, 'socialmonitor.db'))
  const boss = auth.getUser(db, auth.createUser(db, { email: 'boss@example.com', super: true }).id)!
  const viewer = auth.getUser(db, auth.createUser(db, { email: 'view@example.com' }).id)!
  addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
  return { data, db, boss, viewer }
}

const ctx = (db: DB, user: auth.User | null, extra: Partial<Ctx> = {}): Ctx => ({
  db,
  params: {},
  query: new URLSearchParams(),
  body: {},
  local: true,
  user,
  cookies: [],
  secure: false,
  ip: '127.0.0.1',
  country: null,
  ua: 'test',
  session: null,
  client: { ua: 'test', ip: '127.0.0.1', country: null },
  origin: 'http://localhost:4400',
  ...extra,
})

/** A request body that sends a file in a few chunks, as a browser upload arrives. */
async function* chunks(buf: Uint8Array, size = 4096) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}
const upload = (db: DB, user: auth.User, file: Uint8Array, name = 'backup.db') =>
  restore.handle(
    ctx(db, user, { stream: chunks(file), query: new URLSearchParams({ name }) }),
  ) as Promise<{ ok: boolean; before: Record<string, number>; after: Record<string, number> }>

/** The downloaded file's bytes, as the server would stream them. */
function take(db: DB, user: auth.User) {
  const out = download.handle(ctx(db, user)) as { __file: string; name: string; cleanup: string }
  const bytes = readFileSync(out.__file)
  rmSync(out.cleanup, { recursive: true, force: true })
  return { bytes, name: out.name }
}

const brands = (db: DatabaseSync) =>
  (db.prepare('SELECT name FROM brands ORDER BY name').all() as { name: string }[]).map(
    (b) => b.name,
  )

describe('backups in Settings', () => {
  it('are for super admins only', () => {
    const { db, viewer } = setup()
    for (const r of [download, restore, listing]) {
      expect(() => guard(r, ctx(db, null))).toThrow(/Sign in/)
      expect(() => guard(r, ctx(db, viewer))).toThrow(/super admins/)
    }
    expect(restore.raw).toBe(true)
  })

  it('downloads a consistent copy that checkDb accepts, and logs who took it', () => {
    const { data, db, boss } = setup()
    const out = download.handle(ctx(db, boss)) as {
      __file: string
      name: string
      type: string
      cleanup: string
    }
    expect(out.name).toMatch(/^socialmonitor-\d{4}-\d{2}-\d{2}-\d{4}\.db$/)
    expect(out.type).toBe('application/octet-stream')
    const copy = join(temp(), out.name)
    copyFileSync(out.__file, copy)
    rmSync(out.cleanup, { recursive: true, force: true })
    const { integrity, counts } = checkDb(copy)
    expect(integrity).toBe('ok')
    expect(counts).toMatchObject({ brands: 1, users: 2 })
    // Nothing is left in data/ besides the database itself.
    expect(readdirSync(data).filter((f) => !f.startsWith('socialmonitor.db'))).toEqual([])
    const row = db.prepare("SELECT * FROM audit WHERE event = 'backup.downloaded'").get() as {
      actor: number
      target: string
    }
    expect(row).toMatchObject({ actor: boss.id, target: out.name })
  })

  it('names the file by the minute', () => {
    expect(backupName(new Date(2026, 9, 17, 9, 5))).toBe('socialmonitor-2026-10-17-0905.db')
  })

  it('refuses a file that is not SQLite, and leaves the database as it was', async () => {
    const { db, boss } = setup()
    await expect(upload(db, boss, new TextEncoder().encode('{"brands": []}'))).rejects.toThrow(
      /not a SocialMonitor backup/,
    )
    expect(brands(db)).toEqual(['Tavelo'])
  })

  it('refuses a SQLite file without SocialMonitor tables', async () => {
    const { db, boss } = setup()
    const other = join(temp(), 'other.db')
    const o = new DatabaseSync(other)
    o.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)')
    o.close()
    await expect(upload(db, boss, readFileSync(other))).rejects.toThrow(/not a SocialMonitor/)
  })

  it('refuses a damaged file', async () => {
    const { db, boss } = setup()
    const { bytes } = take(db, boss)
    // Keep the header, scramble the pages after the first.
    const bad = Buffer.from(bytes)
    for (let i = 4096; i < bad.length; i++) bad[i] = (i * 31) & 0xff
    await expect(upload(db, boss, bad)).rejects.toThrow(/damaged/)
    expect(brands(db)).toEqual(['Tavelo'])
  })

  it('refuses a backup from a newer version', async () => {
    const { db, boss } = setup()
    const { bytes } = take(db, boss)
    const newer = join(temp(), 'newer.db')
    writeFileSync(newer, bytes)
    const n = new DatabaseSync(newer)
    n.exec('ALTER TABLE brands ADD COLUMN from_the_future TEXT')
    n.close()
    const err = await upload(db, boss, readFileSync(newer)).catch((e: { status: number }) => e)
    expect(err).toMatchObject({ status: 409, message: expect.stringMatching(/newer version/) })
  })

  it('makes a safety copy, swaps the data in on the live handle and signs everyone out', async () => {
    const { data, db, boss } = setup()
    const { bytes } = take(db, boss)
    // After the backup: a brand that the restore takes away, and a session that it ends.
    addBrand(db, 'Norvik', ['https://www.tiktok.com/@norvik'])
    auth.createSession(db, boss, false, { ua: 'x', ip: '127.0.0.1', country: null })
    expect(brands(db)).toEqual(['Norvik', 'Tavelo'])

    const c = ctx(db, boss, {
      stream: chunks(bytes),
      query: new URLSearchParams({ name: 'mine.db' }),
    })
    const out = (await restore.handle(c)) as {
      ok: boolean
      signin: boolean
      before: Record<string, number>
      after: Record<string, number>
      safety: string
    }
    expect(out).toMatchObject({ ok: true, signin: true })
    expect(out.before.brands).toBe(2)
    expect(out.after.brands).toBe(1)
    // The same handle sees the restored data, and still writes.
    expect(brands(db)).toEqual(['Tavelo'])
    addBrand(db, 'Lumio', ['https://www.tiktok.com/@lumio'])
    expect(brands(db)).toEqual(['Lumio', 'Tavelo'])
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal',
    )

    // The safety copy holds the database from before, with the reason in its audit log.
    const safety = join(data, 'backups', out.safety)
    expect(out.safety).toMatch(/^pre-restore-\d{8}T\d{6}Z\.db$/)
    expect(existsSync(safety)).toBe(true)
    const s = new DatabaseSync(safety, { readOnly: true })
    expect(brands(s)).toEqual(['Norvik', 'Tavelo'])
    expect(
      s.prepare("SELECT count(*) AS n FROM audit WHERE event = 'backup.restore_started'").get(),
    ).toMatchObject({ n: 1 })
    s.close()

    // The restored database keeps the trail; nobody is signed in any more.
    const row = db.prepare("SELECT * FROM audit WHERE event = 'backup.restored'").get() as {
      actor: number
      target: string
      detail: string
    }
    expect(row).toMatchObject({ actor: boss.id, target: 'mine.db' })
    expect(JSON.parse(row.detail)).toMatchObject({ by: 'boss@example.com', before: { brands: 2 } })
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toMatchObject({ n: 0 })
    expect(c.cookies.some((k) => k.includes('Max-Age=0'))).toBe(true)
    // Nothing of the upload is left beside the database.
    expect(readdirSync(data).filter((f) => f.startsWith('.restore-'))).toEqual([])

    const listed = listing.handle(ctx(db, boss)) as { name: string }[]
    expect(listed.map((b) => b.name)).toEqual([out.safety])
  })

  it('brings an older backup up to this version', async () => {
    const { db, boss } = setup()
    const { bytes } = take(db, boss)
    const older = join(temp(), 'older.db')
    writeFileSync(older, bytes)
    const o = new DatabaseSync(older)
    o.exec('ALTER TABLE users DROP COLUMN lang; DROP TABLE campaigns')
    o.close()
    await upload(db, boss, readFileSync(older))
    expect(db.prepare("SELECT lang FROM users WHERE email = 'boss@example.com'").get()).toEqual({
      lang: 'en',
    })
    expect(db.prepare('SELECT count(*) AS n FROM campaigns').get()).toMatchObject({ n: 0 })
  })

  it('waits for a running update, and holds new ones while it restores', async () => {
    const { db, boss } = setup()
    const { bytes } = take(db, boss)
    expect(holdRuns()).toBe(true)
    try {
      expect(() =>
        queueRun(db, { brandIds: [1], networks: ['instagram'], range: 'due', limit: 1 }, 'manual'),
      ).toThrow(/being restored/)
      await expect(upload(db, boss, bytes)).rejects.toThrow(/update is running/)
    } finally {
      releaseRuns()
    }
    expect(brands(db)).toEqual(['Tavelo'])
  })
})
