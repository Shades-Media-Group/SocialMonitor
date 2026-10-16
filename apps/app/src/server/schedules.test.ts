import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '../core/db.ts'
import type { DB } from '../core/db.ts'
import * as auth from '../core/auth.ts'
import { addBrand, listSchedules, saveSchedule } from '../core/store.ts'
import type { Schedule } from '../core/types.ts'
import type { Ctx } from './routes.ts'
import { guard, routes } from './routes.ts'

const find = (method: string, path: string) =>
  routes.find((r) => r.method === method && r.path.test(path))!

const ctx = (db: DB, user: auth.User, params: Record<string, string>, body: unknown): Ctx => ({
  db,
  params,
  query: new URLSearchParams(),
  body,
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
})

/** Calls a route as this person, through its guard, as the server does. */
async function call(db: DB, user: auth.User, method: string, path: string, body: unknown = {}) {
  const route = find(method, path)
  const params = { ...(path.match(route.path)?.groups ?? {}) }
  const c = ctx(db, user, params, body)
  guard(route, c)
  return (await route.handle(c)) as unknown
}

function setup() {
  const db = openDb(':memory:')
  const brand = addBrand(db, 'Tavelo', [
    'https://www.instagram.com/tavelo',
    'https://www.tiktok.com/@tavelo',
  ])
  const lead = auth.getUser(db, auth.createUser(db, { email: 'lead@example.com' }).id)!
  auth.setMembership(db, lead.id, brand.id, 'admin')
  const viewer = auth.getUser(db, auth.createUser(db, { email: 'view@example.com' }).id)!
  auth.setMembership(db, viewer.id, brand.id, 'viewer')
  return { db, brand, lead, viewer }
}

describe('a brand’s automatic updates are its schedules', () => {
  it('the switch pauses every schedule of the brand, and resumes them all with a next start', async () => {
    const { db, brand, lead } = setup()
    const other = addBrand(db, 'Norvik', ['https://www.tiktok.com/@norvik'])
    const times = saveSchedule(db, {
      brand_id: brand.id,
      kind: 'times',
      times: ['00:00', '12:00'],
      networks: ['tiktok', 'instagram'],
      range: 'due',
    })
    const every = saveSchedule(db, {
      brand_id: brand.id,
      kind: 'interval',
      every_hours: 6,
      networks: ['instagram'],
      range: 'all',
      enabled: false,
    })
    const elsewhere = saveSchedule(db, {
      brand_id: other.id,
      kind: 'interval',
      every_hours: 24,
      networks: ['tiktok'],
    })

    const off = (await call(db, lead, 'PUT', `/api/brands/${brand.id}/schedules`, {
      enabled: false,
    })) as Schedule[]
    expect(off.map((s) => [s.id, s.enabled, s.next_run_at])).toEqual([
      [times.id, 0, null],
      [every.id, 0, null],
    ])
    // Another brand's schedule is not touched.
    expect(listSchedules(db, other.id)[0]).toMatchObject({ id: elsewhere.id, enabled: 1 })

    const on = (await call(db, lead, 'PUT', `/api/brands/${brand.id}/schedules`, {
      enabled: true,
    })) as Schedule[]
    expect(on.every((s) => s.enabled === 1)).toBe(true)
    for (const s of on) expect(new Date(s.next_run_at!).getTime()).toBeGreaterThan(Date.now())
  })

  it('only the brand’s admins may flip the switch', async () => {
    const { db, brand, viewer } = setup()
    await expect(
      call(db, viewer, 'PUT', `/api/brands/${brand.id}/schedules`, { enabled: false }),
    ).rejects.toThrow(/admins/)
  })

  it('the quick setup creates a normal schedule that the Schedules list shows, already planned', async () => {
    const { db, brand, lead } = setup()
    await call(db, lead, 'POST', '/api/schedules', {
      brand_id: brand.id,
      kind: 'interval',
      every_hours: 12,
      times: [],
      networks: ['instagram', 'tiktok'],
      range: 'due',
      enabled: true,
    })
    const list = (await call(db, lead, 'GET', '/api/schedules')) as Schedule[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      brand_id: brand.id,
      kind: 'interval',
      every_hours: 12,
      networks: ['instagram', 'tiktok'],
      range: 'due',
      enabled: 1,
    })
    expect(list[0]!.next_run_at).not.toBeNull()
  })

  it('a schedule saved with enabled 0 is paused, not on', async () => {
    const { db, brand, lead } = setup()
    const s = (await call(db, lead, 'POST', '/api/schedules', {
      brand_id: brand.id,
      kind: 'interval',
      every_hours: 4,
      networks: ['tiktok'],
      enabled: 0,
    })) as Schedule
    expect(s).toMatchObject({ enabled: 0, next_run_at: null })
  })
})

describe('what a schedule reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-schedules-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('stores and shows the older "new" as "due", which is how it always ran', () => {
    const { db, brand } = setup()
    const s = saveSchedule(db, {
      brand_id: brand.id,
      kind: 'interval',
      every_hours: 24,
      networks: ['instagram'],
      range: 'new',
    })
    expect(s.range).toBe('due')
    db.prepare("UPDATE schedules SET range = 'new' WHERE id = ?").run(s.id)
    expect(listSchedules(db)[0]!.range).toBe('due')
  })

  it('moves stored "new" schedules to "due" when the database opens', () => {
    const file = join(dir, 'old.db')
    const db = openDb(file)
    const brand = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
    db.prepare(
      `INSERT INTO schedules (brand_id, kind, every_hours, times, networks, range)
       VALUES (?, 'interval', 24, '[]', '["instagram"]', 'new')`,
    ).run(brand.id)
    db.close()
    const again = openDb(file)
    expect(again.prepare('SELECT range FROM schedules').get()).toEqual({ range: 'due' })
    again.close()
  })
})
