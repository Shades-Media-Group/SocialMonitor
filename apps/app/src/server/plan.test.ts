import type { DB } from '../core/db.ts'
import type { User } from '../core/auth.ts'
import type { Ctx, Route } from './routes.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.SOCIALMONITOR_DATA = `${process.env.TMPDIR ?? '/tmp'}/sm-plan-test-${process.pid}`
})

const { DATA_DIR, openDb, upgradeDb } = await import('../core/db.ts')
const auth = await import('../core/auth.ts')
const store = await import('../core/store.ts')
const { plan, rivalsInPlan, setPlan } = await import('../core/plan.ts')
const st = await import('../core/stories.ts')
const { listAudit } = await import('../core/audit.ts')
const { tabsFor } = await import('../web/tabs.ts')
const { guard, routes } = await import('./routes.ts')
const { storiesRoutes } = await import('./stories-routes.ts')
const { byteRange, mediaFile } = await import('./media.ts')
const { maySeeStory } = await import('./stories-routes.ts')

afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }))

const ALL = [...storiesRoutes, ...routes]
const find = (method: string, path: string) =>
  ALL.find((r) => r.method === method && r.path.test(path))!

const ctx = (
  db: DB,
  user: User | null,
  params: Record<string, string>,
  body: unknown = {},
  query = '',
): Ctx => ({
  db,
  params,
  query: new URLSearchParams(query),
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
const call = async (route: Route, c: Ctx) => {
  guard(route, c)
  return route.handle(c)
}
/** The HTTP status a call ends with: 200 when it answers. */
const status = async (route: Route, c: Ctx) => {
  try {
    await call(route, c)
    return 200
  } catch (e) {
    return (e as { status?: number }).status ?? 400
  }
}

function setup() {
  const db = openDb(':memory:')
  const brand = store.addBrand(db, 'Tavelo', ['https://www.tiktok.com/@tavelo.md'])
  const rival = store.addCompetitor(db, brand.id, 'Lumio', ['https://www.tiktok.com/@lumio.store'])
  const user = (email: string, isSuper = false) =>
    auth.getUser(db, auth.createUser(db, { email, super: isSuper }).id)!
  const owner = user('owner@example.com', true)
  const lead = user('lead@example.com')
  const viewer = user('viewer@example.com')
  const stranger = user('stranger@example.com')
  auth.setMembership(db, lead.id, brand.id, 'admin')
  auth.setMembership(db, viewer.id, brand.id, 'viewer')
  return { db, brand, rival, owner, lead, viewer, stranger }
}

describe('the plan carries over what each brand had', () => {
  it('copies the Dashboards switches, leaves them in place, and makes room for every rival', () => {
    const db = openDb(':memory:')
    const a = store.addBrand(db, 'Tavelo', ['https://www.tiktok.com/@tavelo.md'])
    const b = store.addBrand(db, 'Nordo', ['https://www.tiktok.com/@nordo'])
    // Tavelo watched four rivals before any limit; Nordo had Share of voice off and Ads on.
    for (const name of ['R1', 'R2', 'R3', 'R4']) {
      const r = store.addBrand(db, name, [`https://www.tiktok.com/@${name.toLowerCase()}`])
      db.prepare('UPDATE brands SET competitor_of = ? WHERE id = ?').run(a.id, r.id)
    }
    db.prepare(
      "INSERT INTO brand_dashboards (brand_id, competition, ads, ads_country, updated_at) VALUES (?, 0, 1, 'RO', '2026-10-30')",
    ).run(b.id)
    db.exec('DELETE FROM brand_plans')
    upgradeDb(db)
    expect(plan(db, a.id)).toEqual({
      competition: true,
      ads: false,
      ads_country: 'MD',
      stories: false,
      rival_stories: false,
      rival_limit: 4,
    })
    expect(plan(db, b.id)).toMatchObject({
      competition: false,
      ads: true,
      ads_country: 'RO',
      rival_limit: 3,
    })
    expect(rivalsInPlan(db, a.id).every((r) => !r.paused)).toBe(true)
    expect(store.withCompetitors(db, [a.id])).toHaveLength(5)
    // Brands that have a plan keep it; the old switches stay as they were.
    setPlan(db, b.id, { competition: true }, null)
    upgradeDb(db)
    expect(plan(db, b.id).competition).toBe(true)
    expect(
      db.prepare('SELECT competition, ads FROM brand_dashboards WHERE brand_id = ?').get(b.id),
    ).toEqual({
      competition: 0,
      ads: 1,
    })
    // A rival never gets a plan of its own: it answers with its brand's.
    expect(db.prepare('SELECT count(*) AS n FROM brand_plans').get()).toEqual({ n: 2 })
  })

  it('takes only valid values', () => {
    const { db, brand } = setup()
    expect(() => setPlan(db, brand.id, { rival_limit: 6 }, null)).toThrow(/0 to 5/)
    expect(() => setPlan(db, brand.id, { rival_limit: -1 }, null)).toThrow(/0 to 5/)
    expect(() => setPlan(db, brand.id, { rival_limit: 2.5 }, null)).toThrow(/whole number/)
    expect(() => setPlan(db, brand.id, { ads_country: 'Moldova' }, null)).toThrow(/two-letter/)
    expect(setPlan(db, brand.id, { stories: true, rival_limit: 0, other: 1 }, null)).toMatchObject({
      stories: true,
      rival_limit: 0,
    })
  })
})

describe('the plan is the owner’s', () => {
  it('is read and changed by super admins only, and logged where only they read it', async () => {
    const { db, brand, owner, lead, viewer } = setup()
    const params = { id: String(brand.id) }
    for (const [method, path] of [
      ['GET', '/api/brands/1/plan'],
      ['PUT', '/api/brands/1/plan'],
    ] as const) {
      const route = find(method, path)
      for (const who of [lead, viewer])
        expect(await status(route, ctx(db, who, params, { stories: true })), who.email).toBe(403)
      expect(() => guard(route, ctx(db, null, params))).toThrow(/Sign in/)
    }
    expect(plan(db, brand.id).stories).toBe(false)
    await call(
      find('PUT', '/api/brands/1/plan'),
      ctx(db, owner, params, { stories: true, rival_limit: 2 }),
    )
    expect(await call(find('GET', '/api/brands/1/plan'), ctx(db, owner, params))).toMatchObject({
      stories: true,
      rival_limit: 2,
      rivals: 1,
      original_days: 10,
    })
    const row = listAudit(db, { brands: null }).rows.find((r) => r.event === 'plan.changed')
    expect(row?.brand_id).toBeNull()
    expect(listAudit(db, { brands: [brand.id] }).rows.some((r) => r.event === 'plan.changed')).toBe(
      false,
    )
  })

  it('names only what the brand’s people may open in the brand list', async () => {
    const { db, brand, owner, lead } = setup()
    setPlan(db, brand.id, { stories: true, rival_limit: 4 }, owner.id)
    const [row] = (await call(find('GET', '/api/brands'), ctx(db, lead, {}))) as Record<
      string,
      unknown
    >[]
    expect(row).toMatchObject({ competition: true, stories: true, rival_stories: false })
    expect(row).not.toHaveProperty('plan')
    expect(row).not.toHaveProperty('ads')
    const [mine] = (await call(find('GET', '/api/brands'), ctx(db, owner, {}))) as Record<
      string,
      unknown
    >[]
    expect(mine!.plan).toMatchObject({ rival_limit: 4 })
  })
})

describe('the competitor limit', () => {
  it('stops a brand admin at the limit with a message the dashboard translates', async () => {
    const { db, brand, lead } = setup()
    const add = find('POST', '/api/brands/1/competitors')
    const params = { id: String(brand.id) }
    for (const name of ['Nordo', 'Pelo'])
      await call(add, ctx(db, lead, params, { name, links: [`https://www.tiktok.com/@${name}`] }))
    let error: { status?: number; message?: string; extra?: Record<string, unknown> } = {}
    try {
      await call(
        add,
        ctx(db, lead, params, { name: 'Quil', links: ['https://www.tiktok.com/@quil'] }),
      )
    } catch (e) {
      error = e as typeof error
    }
    expect(error.status).toBe(409)
    expect(error.message).toBe(
      'Your plan tracks up to 3 competitors. Ask SocialMonitor to raise it.',
    )
    expect(error.extra).toMatchObject({
      template: 'Your plan tracks up to {n} competitors. Ask SocialMonitor to raise it.',
      vars: { n: 3 },
    })
    expect(store.listCompetitors(db, brand.id)).toHaveLength(3)
  })

  it('pauses the rivals past a lowered limit, keeps them, and resumes them when raised', async () => {
    const { db, brand, rival, owner, lead } = setup()
    const second = store.addCompetitor(db, brand.id, 'Nordo', ['https://www.tiktok.com/@nordo'])
    const third = store.addCompetitor(db, brand.id, 'Pelo', ['https://www.tiktok.com/@pelo'])
    setPlan(db, brand.id, { rival_limit: 1 }, owner.id)
    const list = (await call(
      find('GET', '/api/brands/1/competitors'),
      ctx(db, lead, { id: String(brand.id) }),
    )) as {
      id: number
      paused: boolean
    }[]
    expect(Object.fromEntries(list.map((r) => [r.id, r.paused]))).toEqual({
      [rival.id]: false,
      [second.id]: true,
      [third.id]: true,
    })
    // Paused rivals are not read by updates, and nothing is deleted.
    expect(store.withCompetitors(db, [brand.id])).toEqual([brand.id, rival.id])
    expect(store.listCompetitors(db, brand.id)).toHaveLength(3)
    setPlan(db, brand.id, { rival_limit: 3 }, owner.id)
    expect(store.withCompetitors(db, [brand.id])).toEqual([brand.id, rival.id, second.id, third.id])
  })
})

const STORY_ROUTES: [string, string][] = [
  ['GET', '/api/brands/1/stories'],
  ['GET', '/api/brands/1/stories/stats'],
  ['GET', '/api/brands/1/stories/run'],
  ['POST', '/api/brands/1/stories/check'],
]

describe('Stories behind the plan', () => {
  it('refuses the brand’s people (403) and hides the tab while the plan has no Stories', async () => {
    const { db, brand, owner, lead, viewer, stranger } = setup()
    const params = { id: String(brand.id) }
    for (const [method, path] of STORY_ROUTES) {
      const route = find(method, path)
      expect(route, `${method} ${path}`).toBeDefined()
      for (const who of [lead, viewer, stranger])
        expect(guardStatus(route, ctx(db, who, params)), `${path} ${who.email}`).toBe(403)
      // Super admins always may.
      expect(guardStatus(route, ctx(db, owner, params))).toBe(200)
    }
    expect(tabsFor({ my_role: 'admin', stories: false }, false).map(([k]) => k)).not.toContain(
      'stories',
    )
    expect(tabsFor({ my_role: 'admin', stories: false }, true).map(([k]) => k)).toContain('stories')
    setPlan(db, brand.id, { stories: true }, owner.id)
    for (const [method, path] of STORY_ROUTES.slice(0, 3)) {
      for (const who of [lead, viewer])
        expect(guardStatus(find(method, path), ctx(db, who, params))).toBe(200)
      expect(guardStatus(find(method, path), ctx(db, stranger, params))).toBe(403)
    }
    // Checking now is for the brand's admins, not its viewers.
    const check = find('POST', '/api/brands/1/stories/check')
    expect(guardStatus(check, ctx(db, lead, params))).toBe(200)
    expect(guardStatus(check, ctx(db, viewer, params))).toBe(403)
    expect(tabsFor({ my_role: 'viewer', stories: true }, false).map(([k]) => k)).toContain(
      'stories',
    )
  })

  it('shows the rivals’ stories and files only while Competitor stories is on', async () => {
    const { db, brand, rival, owner, lead } = setup()
    setPlan(db, brand.id, { stories: true }, owner.id)
    const keep = (brandId: number, ext: string) =>
      st.saveStory(db, brand.id, brandId, {
        network: 'tiktok',
        ext_id: ext,
        handle: ext,
        posted_at: '2026-11-04T08:00:00.000Z',
        expires_at: '2026-11-05T08:00:00.000Z',
        caption: '',
        media: [
          {
            kind: 'image',
            urls: [],
            width: 720,
            height: 1280,
            duration: null,
            bytes: null,
            codec: null,
            cover: null,
          },
        ],
        stickers: [],
        mentions: [],
        links: [],
        music: null,
        views: null,
        likes: null,
        shares: null,
        replies: null,
        insights: null,
        permalink: null,
        is_ad: false,
      }).id
    const mine = keep(brand.id, 'tavelo.md')
    const theirs = keep(rival.id, 'lumio.store')
    const dir = join(DATA_DIR, 'media', 'stories', String(brand.id))
    mkdirSync(dir, { recursive: true })
    for (const id of [mine, theirs]) writeFileSync(join(dir, `${id}-0.webp`), 'x')
    const get = find('GET', '/api/brands/1/stories')
    const params = { id: String(brand.id) }
    const handles = async (who: typeof lead) =>
      ((await call(get, ctx(db, who, params))) as { stories: { handle: string }[] }).stories.map(
        (s) => s.handle,
      )
    expect(await handles(lead)).toEqual(['tavelo.md'])
    expect(await handles(owner)).toHaveLength(2)
    const root = join(DATA_DIR, 'media')
    const access = (who: typeof lead) => (w: number, id: number) => {
      const s = db.prepare('SELECT watcher_id, brand_id FROM stories WHERE id = ?').get(id) as
        { watcher_id: number; brand_id: number } | undefined
      return !!s && s.watcher_id === w && maySeeStory(db, who, w, s.brand_id)
    }
    const path = (id: number) => `/media/stories/${brand.id}/${id}-0.webp`
    expect(mediaFile(root, path(mine), false, access(lead))).toBe(join(dir, `${mine}-0.webp`))
    expect(mediaFile(root, path(theirs), false, access(lead))).toBeNull()
    expect(mediaFile(root, path(theirs), true, access(owner))).toBe(join(dir, `${theirs}-0.webp`))
    setPlan(db, brand.id, { rival_stories: true }, owner.id)
    expect(await handles(lead)).toHaveLength(2)
    expect(mediaFile(root, path(theirs), false, access(lead))).not.toBeNull()
    // Stories off again: the brand's own files go too.
    setPlan(db, brand.id, { stories: false, rival_stories: false }, owner.id)
    expect(mediaFile(root, path(mine), false, access(lead))).toBeNull()
  })

  it('serves nothing under stories/ but a story’s own files, by any spelling', () => {
    const root = join(DATA_DIR, 'media')
    mkdirSync(join(root, 'stories', '1'), { recursive: true })
    mkdirSync(join(root, 'ads'), { recursive: true })
    writeFileSync(join(root, 'stories', '1', '5-0.mp4'), 'x')
    writeFileSync(join(root, 'stories', '1', 'notes.txt'), 'x')
    writeFileSync(join(root, 'ads', '1.jpg'), 'x')
    const yes = () => true
    expect(mediaFile(root, '/media/stories/1/5-0.mp4', false, yes)).toBe(
      join(root, 'stories', '1', '5-0.mp4'),
    )
    for (const p of [
      '/media/stories/1/notes.txt',
      '/media/stories/1/../../ads/1.jpg',
      '/media/stories/1/%2e%2e/%2e%2e/ads/1.jpg',
      '/media/stories/..%2f..%2f..%2fsocialmonitor.db',
      '/media/stories/1/5-0.mp4%00.webp',
      '/media/stories/',
      '/media/stories/1',
      '/media/stories/1/5-0.mp4/../../../../../etc/passwd',
    ])
      expect(mediaFile(root, p, false, yes), p).toBeNull()
    // Without a check that says yes, nothing.
    expect(mediaFile(root, '/media/stories/1/5-0.mp4', true)).toBeNull()
    expect(mediaFile(root, '/media/stories/1/5-0.mp4', false, () => false)).toBeNull()
  })

  it('answers ranges, as Safari needs to play a video', () => {
    expect(byteRange(undefined, 100)).toBeNull()
    expect(byteRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 })
    expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(byteRange('bytes=100-', 100)).toBe('bad')
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull()
  })

  it('hands out the original while it is kept, then the compact copy, to those who may see it', async () => {
    const { db, brand, rival, owner, lead, stranger } = setup()
    setPlan(db, brand.id, { stories: true }, owner.id)
    const base = {
      network: 'tiktok' as const,
      posted_at: '2026-11-04T08:00:00.000Z',
      expires_at: null,
      caption: '',
      media: [
        {
          kind: 'video' as const,
          urls: [],
          width: 720,
          height: 1280,
          duration: 10,
          bytes: null,
          codec: null,
          cover: null,
        },
      ],
      stickers: [],
      mentions: [],
      links: [],
      music: null,
      views: null,
      likes: null,
      shares: null,
      replies: null,
      insights: null,
      permalink: null,
      is_ad: false,
    }
    const id = st.saveStory(db, brand.id, brand.id, {
      ...base,
      ext_id: '1',
      handle: 'tavelo.md',
    }).id
    const rivalStory = st.saveStory(db, brand.id, rival.id, {
      ...base,
      ext_id: '2',
      handle: 'lumio.store',
    }).id
    mkdirSync(join(DATA_DIR, 'stories', String(brand.id)), { recursive: true })
    mkdirSync(join(DATA_DIR, 'media', 'stories', String(brand.id)), { recursive: true })
    writeFileSync(join(DATA_DIR, 'stories', String(brand.id), `${id}-0.mp4`), 'original')
    writeFileSync(join(DATA_DIR, 'media', 'stories', String(brand.id), `${id}-0.mp4`), 'compact')
    db.prepare(
      `UPDATE story_media SET original_path = ?, compact_path = ?, status = 'done' WHERE story_id = ?`,
    ).run(`stories/${brand.id}/${id}-0.mp4`, `/media/stories/${brand.id}/${id}-0.mp4`, id)
    const dl = find('GET', '/api/stories/1/download')
    const as = (who: typeof lead, storyId: number, file: string) =>
      call(dl, ctx(db, who, { id: String(storyId) }, {}, `file=${file}`)) as Promise<{
        __file: string
        name: string
        type: string
      }>
    expect(await as(lead, id, 'original')).toMatchObject({
      __file: join(DATA_DIR, 'stories', String(brand.id), `${id}-0.mp4`),
      name: `tavelo.md-tiktok-story-2026-11-04-${id}-original.mp4`,
      type: 'video/mp4',
    })
    expect((await as(lead, id, 'compact')).__file).toBe(
      join(DATA_DIR, 'media', 'stories', String(brand.id), `${id}-0.mp4`),
    )
    st.cleanupOriginals(db, new Date('2099-01-01T00:00:00.000Z'))
    db.prepare('UPDATE story_media SET original_until = ? WHERE story_id = ?').run('2000-01-01', id)
    st.cleanupOriginals(db, new Date('2026-12-01T00:00:00.000Z'))
    await expect(as(lead, id, 'original')).rejects.toThrow(/no longer kept/)
    for (const [who, storyId] of [
      [stranger, id],
      [lead, rivalStory],
    ] as const)
      expect(await status(dl, ctx(db, who, { id: String(storyId) }))).toBe(404)
  })
})

/** The status the route's own check gives, without running it (a check would open a browser). */
function guardStatus(route: Route, c: Ctx) {
  try {
    guard(route, c)
    return 200
  } catch (e) {
    return (e as { status?: number }).status ?? 400
  }
}
