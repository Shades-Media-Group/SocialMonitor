import { describe, expect, it } from 'vitest'
import { openDb } from '../core/db.ts'
import type { DB } from '../core/db.ts'
import * as auth from '../core/auth.ts'
import { addBrand, addCompetitor, listProfiles, savePost, setVerdict } from '../core/store.ts'
import { adminUsage } from '../core/admin.ts'
import type { Network } from '../core/types.ts'
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
  runId: number | null = null,
) {
  db.prepare(
    `INSERT INTO ai_usage (at, brand_id, task, network, engine, model, input_tokens, output_tokens,
       cost_usd, items, run_id) VALUES (?, ?, ?, ?, 'claude', 'claude-haiku-5-5', ?, ?, ?, ?, ?)`,
  ).run(at, brandId, task, network, tokens.input, tokens.output, tokens.cost, tokens.items, runId)
}

/** An update as the runs table keeps it; a null tally is one from before tallies were kept. */
function run(
  db: DB,
  brandIds: number[],
  networks: readonly Network[],
  started: string,
  seconds: number | null,
  status: string,
  tally: Record<number, { posts: number; comments: number; new: number }> | null,
) {
  const finished =
    seconds == null ? null : new Date(Date.parse(started) + seconds * 1000).toISOString()
  return (
    db
      .prepare(
        `INSERT INTO runs (trigger, scope, started_at, finished_at, status, tally)
         VALUES ('manual', ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        JSON.stringify({ brandIds, networks, range: 'new', limit: 10 }),
        started,
        finished,
        status,
        tally && JSON.stringify(tally),
      ) as { id: number }
  ).id
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
  return { db, tavelo, other, rival }
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

  it('lists each update with what it read and used, rivals in, other brands out', () => {
    const { db, tavelo, other, rival } = setup()
    const net = { instagram: ['instagram'], both: ['instagram', 'tiktok'] } as const
    // Before updates were tied to their AI calls: no tally, so nothing is shown as zero.
    const old = run(db, [tavelo.id], net.both, ago(40), 95, 'ok', null)
    const ok = run(db, [tavelo.id, other.id], net.both, ago(1), 330, 'partial', {
      [tavelo.id]: { posts: 4, comments: 50, new: 12 },
      [rival.id]: { posts: 2, comments: 20, new: 5 },
      [other.id]: { posts: 9, comments: 90, new: 30 },
    })
    const tokens = (cost: number, items = 0) => ({ input: 1000, output: 100, cost, items })
    use(db, ago(1), tavelo.id, 'sort-comments', 'instagram', tokens(0.02, 12), ok)
    use(db, ago(1), tavelo.id, 'describe-post', 'instagram', tokens(0.01, 1), ok)
    use(db, ago(1), rival.id, 'sort-comments', 'tiktok', tokens(0.01, 5), ok)
    use(db, ago(1), other.id, 'sort-comments', 'tiktok', tokens(0.5, 30), ok)
    const postponed = run(db, [tavelo.id], net.instagram, ago(0.5), null, 'postponed', {})
    run(db, [other.id], net.instagram, ago(0.4), 60, 'ok', {})

    const { runs } = adminUsage(db, tavelo.id, AT).updates
    expect(runs.map((r) => r.id)).toEqual([postponed, ok, old])
    expect(runs[0]).toMatchObject({
      status: 'postponed',
      recorded: true,
      seconds: null,
      posts: 0,
      calls: 0,
      cost_usd: 0,
    })
    expect(runs[1]).toMatchObject({
      trigger: 'manual',
      status: 'partial',
      networks: ['instagram', 'tiktok'],
      seconds: 330,
      recorded: true,
      posts: 6,
      comments: 70,
      new_comments: 17,
      sorted: 17,
      calls: 3,
      tokens: 3300,
      input: 3000,
      output: 300,
      cache_read: 0,
      cache_write: 0,
    })
    expect(runs[1]!.cost_usd).toBeCloseTo(0.04, 10)
    expect(runs[1]!.by_task.map((u) => [u.key, u.calls, u.items])).toEqual([
      ['sort-comments', 2, 17],
      ['describe-post', 1, 1],
    ])
    expect(runs[2]).toMatchObject({
      recorded: false,
      seconds: 95,
      posts: null,
      comments: null,
      sorted: null,
      calls: null,
      tokens: null,
      cost_usd: null,
      by_task: [],
    })
  })

  it('estimates the next update from the median of the last five with AI on its networks', () => {
    const { db, tavelo } = setup()
    const est = () => adminUsage(db, tavelo.id, AT).updates.estimate
    expect(est()).toBeNull()
    const spend = (networks: readonly Network[], cost: number, input: number, status = 'ok') => {
      const id = run(db, [tavelo.id], networks, ago(1), 60, status, {})
      use(
        db,
        ago(1),
        tavelo.id,
        'sort-comments',
        'instagram',
        { input, output: 0, cost, items: 1 },
        id,
      )
    }
    // Six on Instagram (the oldest falls out of the five), one on both networks, then an update
    // with no AI, a running one and a stopped one, all three left out.
    for (const [cost, input] of [
      [9, 9000],
      [0.01, 1000],
      [0.05, 5000],
      [0.02, 2000],
      [0.04, 4000],
      [0.03, 3000],
    ] as const)
      spend(['instagram'], cost, input)
    spend(['instagram', 'tiktok'], 0.5, 50_000)
    run(db, [tavelo.id], ['instagram', 'tiktok'], ago(0.5), 60, 'ok', {})
    spend(['instagram', 'tiktok'], 7, 70_000, 'running')
    spend(['instagram', 'tiktok'], 7, 70_000, 'stopped')
    // The latest update read both networks: only the one like it counts.
    expect(est()).toEqual({
      tokens: 50_000,
      cost_usd: 0.5,
      from: 1,
      networks: ['instagram', 'tiktok'],
      same_networks: true,
    })
    // A schedule names the next update's networks: the median of the last five on Instagram.
    db.prepare(
      `INSERT INTO schedules (brand_id, kind, every_hours, networks, next_run_at)
       VALUES (?, 'interval', 6, '["instagram"]', ?)`,
    ).run(tavelo.id, ago(-0.2))
    expect(est()).toMatchObject({ tokens: 3000, from: 5, networks: ['instagram'] })
    expect(est()!.cost_usd).toBeCloseTo(0.03, 10)
    // No update on TikTok alone: every network's updates stand in, and it says so.
    db.prepare(`UPDATE schedules SET networks = '["tiktok"]'`).run()
    expect(est()).toMatchObject({ networks: ['tiktok'], same_networks: false, from: 5 })
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
