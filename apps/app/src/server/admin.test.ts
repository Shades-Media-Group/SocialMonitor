import { describe, expect, it } from 'vitest'
import { openDb } from '../core/db.ts'
import type { DB } from '../core/db.ts'
import * as auth from '../core/auth.ts'
import { addBrand, addCompetitor, listProfiles, savePost, setVerdict } from '../core/store.ts'
import { adminUsage } from '../core/admin.ts'
import type { Ctx } from './routes.ts'
import { guard, routes } from './routes.ts'

const AT = Date.parse('2026-10-16T12:00:00.000Z')
const ago = (days: number) => new Date(AT - days * 86_400_000).toISOString()

function use(
  db: DB,
  at: string,
  brandId: number,
  task: string,
  network: string | null,
  tokens: { input: number; output: number; cost: number; items: number },
) {
  db.prepare(
    `INSERT INTO ai_usage (at, brand_id, task, network, engine, model, input_tokens, output_tokens,
       cost_usd, items) VALUES (?, ?, ?, ?, 'claude', 'claude-haiku-5-5', ?, ?, ?, ?)`,
  ).run(at, brandId, task, network, tokens.input, tokens.output, tokens.cost, tokens.items)
}

function setup() {
  const db = openDb(':memory:')
  const tavelo = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
  const other = addBrand(db, 'Norvik', ['https://www.tiktok.com/@norvik'])
  const rival = addCompetitor(db, tavelo.id, 'Lumio', ['https://www.tiktok.com/@lumio'])
  const [profile] = listProfiles(db, tavelo.id)
  savePost(db, profile!, {
    ext_id: '1',
    url: 'u',
    posted_at: null,
    kind: 'post',
    caption: 'Summer bags',
    thumb_url: null,
    likes: 1,
    comments_count: 2,
    shares: 0,
    views: 0,
    comments: [
      { ext_id: 'a', parent_ext_id: null, author: 'x', text: 'love it', likes: 0, posted_at: null },
      {
        ext_id: 'b',
        parent_ext_id: null,
        author: 'y',
        text: 'too pricey',
        likes: 0,
        posted_at: null,
      },
    ],
  })
  const c = db.prepare('SELECT id FROM comments ORDER BY id LIMIT 1').get() as { id: number }
  setVerdict(db, c.id, 'praise', false, 'likes it')
  use(db, ago(1), tavelo.id, 'sort-comments', 'instagram', {
    input: 1000,
    output: 200,
    cost: 0.02,
    items: 60,
  })
  use(db, ago(2), tavelo.id, 'describe-post', 'instagram', {
    input: 500,
    output: 50,
    cost: 0.01,
    items: 1,
  })
  use(db, ago(3), rival.id, 'sort-comments', 'tiktok', {
    input: 400,
    output: 100,
    cost: 0.01,
    items: 40,
  })
  use(db, ago(5), tavelo.id, 'summary', null, { input: 300, output: 100, cost: 0.005, items: 0 })
  // Outside the 30 days and the month: all time only.
  use(db, ago(60), tavelo.id, 'sort-comments', 'instagram', {
    input: 9000,
    output: 900,
    cost: 0.3,
    items: 300,
  })
  use(db, ago(1), other.id, 'sort-comments', 'tiktok', {
    input: 100,
    output: 10,
    cost: 0.001,
    items: 5,
  })
  return { db, tavelo, other }
}

const route = routes.find((r) => r.method === 'GET' && r.path.test('/api/brands/1/admin'))!
const ctx = (db: DB, user: auth.User | null, brandId: number): Ctx => ({
  db,
  params: { id: String(brandId) },
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
})

describe('the Admin tab', () => {
  it('is for super admins only, not even a brand admin', () => {
    const { db, tavelo } = setup()
    const boss = auth.getUser(
      db,
      auth.createUser(db, { email: 'boss@example.com', super: true }).id,
    )!
    const lead = auth.getUser(db, auth.createUser(db, { email: 'lead@example.com' }).id)!
    auth.setMembership(db, lead.id, tavelo.id, 'admin')
    expect(() => guard(route, ctx(db, null, tavelo.id))).toThrow(/Sign in/)
    expect(() => guard(route, ctx(db, lead, tavelo.id))).toThrow(/super admins/)
    expect(() => guard(route, ctx(db, boss, tavelo.id))).not.toThrow()
    expect(() => route.handle(ctx(db, boss, 999))).toThrow(/No such brand/)
  })

  it('adds up the brand with its rivals, by period, task, network and day', () => {
    const { db, tavelo } = setup()
    const a = adminUsage(db, tavelo.id, AT)
    expect(a.rivals).toBe(1)
    expect(a.periods.last30).toEqual({
      calls: 4,
      input: 2200,
      output: 450,
      cache_read: 0,
      cache_write: 0,
      cost_usd: expect.closeTo(0.045, 10),
      items: 101,
    })
    expect(a.periods.month.calls).toBe(4)
    expect(a.periods.all.calls).toBe(5)
    expect(a.periods.all.cost_usd).toBeCloseTo(0.345, 10)
    expect(a.by_task.map((r) => [r.key, r.calls, r.items])).toEqual([
      ['sort-comments', 2, 100],
      ['describe-post', 1, 1],
      ['summary', 1, 0],
    ])
    expect(Object.fromEntries(a.by_network.map((r) => [r.key, r.calls]))).toEqual({
      instagram: 2,
      tiktok: 1,
      null: 1,
    })
    expect(a.daily).toHaveLength(30)
    expect(a.daily.at(-1)!.day).toBe('2026-10-16')
    expect(a.daily.find((d) => d.day === '2026-10-15')).toMatchObject({ calls: 1, tokens: 1200 })
    expect(a.daily.reduce((s, d) => s + d.calls, 0)).toBe(4)
    expect(a.volume).toMatchObject({ posts: 1, comments: 2, sorted: 1, runs: 0, report_bytes: 0 })
    // $0.045 over the 100 comments sorted; five recorded days scaled to thirty.
    expect(a.derived.usd_per_1000_sorted).toBeCloseTo(0.45, 10)
    expect(a.derived.projected_month_usd).toBeCloseTo((0.045 / 5) * 30, 10)
  })

  it('compares every brand, rivals folded into the brand that watches them', () => {
    const { db, tavelo } = setup()
    const brands = adminUsage(db, tavelo.id, AT).brands
    expect(brands.map((b) => [b.name, b.calls, b.comments])).toEqual([
      ['Tavelo', 4, 100],
      ['Norvik', 1, 5],
    ])
    expect(brands[0]!.tokens).toBe(2650)
  })

  it('shows nothing recorded yet as zeros, never invented numbers', () => {
    const db = openDb(':memory:')
    const b = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
    const a = adminUsage(db, b.id, AT)
    expect(a.periods.all.calls).toBe(0)
    expect(a.derived).toEqual({
      usd_per_1000_sorted: null,
      projected_month_usd: null,
      recorded_days: 0,
    })
  })
})
