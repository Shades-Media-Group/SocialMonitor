import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../core/db.ts'
import type { DB } from '../core/db.ts'
import * as auth from '../core/auth.ts'
import { addBrand, addCompetitor, withCompetitors } from '../core/store.ts'
import {
  addAdvertiser,
  adsIdle,
  adsView,
  dashboards,
  saveAds,
  type SavedAd,
  setDashboards,
  startAdsRead,
} from '../core/ads.ts'
import type { LibraryMedia } from '../core/collect/ad-library.ts'
import { Challenge } from '../core/collect/browser.ts'
import { listAudit } from '../core/audit.ts'
import { tabsFor } from '../web/tabs.ts'
import type { Ctx, Route } from './routes.ts'
import { guard, routes } from './routes.ts'
import { adsRoutes } from './ads-routes.ts'
import { mediaFile } from './media.ts'

const ALL = [...adsRoutes, ...routes]
const find = (method: string, path: string) =>
  ALL.find((r) => r.method === method && r.path.test(path))!

const ctx = (
  db: DB,
  user: auth.User | null,
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

/** Runs a route as the server does: the guard, then the handler. */
const call = async (route: Route, c: Ctx) => {
  guard(route, c)
  return route.handle(c)
}

function setup() {
  const db = openDb(':memory:')
  const brand = addBrand(db, 'Tavelo', ['https://www.facebook.com/tavelo'])
  const rival = addCompetitor(db, brand.id, 'Lumio', ['https://www.tiktok.com/@lumio'])
  const user = (email: string, isSuper = false) =>
    auth.getUser(db, auth.createUser(db, { email, super: isSuper }).id)!
  const owner = user('owner@example.com', true)
  const lead = user('lead@example.com')
  const viewer = user('viewer@example.com')
  auth.setMembership(db, lead.id, brand.id, 'admin')
  auth.setMembership(db, viewer.id, brand.id, 'viewer')
  return { db, brand, rival, owner, lead, viewer }
}

const ad = (over: Partial<SavedAd> = {}): SavedAd => ({
  library_id: '1001',
  page_id: '111111111111',
  page_name: 'Tavelo',
  active: true,
  started_on: '2026-10-28',
  ended_on: null,
  platforms: ['facebook', 'instagram'],
  body: 'Autumn bags, 20% off',
  title: null,
  caption: 'tavelo.example',
  link_url: 'https://tavelo.example/autumn',
  cta: 'Shop now',
  format: 'IMAGE',
  media_kind: null,
  media_url: null,
  versions: 1,
  categories: [],
  reach: null,
  spend: null,
  impressions: null,
  ...over,
})

const ADS_ROUTES: [string, string][] = [
  ['GET', '/api/brands/1/dashboards'],
  ['PUT', '/api/brands/1/dashboards'],
  ['GET', '/api/brands/1/ads'],
  ['GET', '/api/brands/1/ads/run'],
  ['POST', '/api/brands/1/ads/advertisers'],
  ['PUT', '/api/brands/1/ads/advertisers/1'],
  ['DELETE', '/api/brands/1/ads/advertisers/1'],
  ['POST', '/api/brands/1/ads/read'],
  ['POST', '/api/brands/1/ads/stop'],
]

describe('the dashboard switches', () => {
  it('keep Share of voice on and Ads off for brands that never set them', () => {
    const { db, brand } = setup()
    expect(dashboards(db, brand.id)).toEqual({ competition: true, ads: false, ads_country: 'MD' })
  })

  it('are set by super admins only, and logged where only super admins read it', async () => {
    const { db, brand, owner, lead, viewer } = setup()
    const put = find('PUT', '/api/brands/1/dashboards')
    const params = { id: String(brand.id) }
    for (const who of [lead, viewer])
      await expect(call(put, ctx(db, who, params, { ads: true }))).rejects.toThrow(/super admins/)
    expect(dashboards(db, brand.id).ads).toBe(false)
    await call(put, ctx(db, owner, params, { ads: true, ads_country: 'ro' }))
    expect(dashboards(db, brand.id)).toEqual({ competition: true, ads: true, ads_country: 'RO' })
    await expect(call(put, ctx(db, owner, params, { ads_country: 'Moldova' }))).rejects.toThrow(
      /two-letter/,
    )
    const row = listAudit(db, { brands: null }).rows.find((r) => r.event === 'dashboards.changed')
    expect(row?.brand_id).toBeNull()
    // A brand admin's activity view never shows it.
    expect(
      listAudit(db, { brands: [brand.id] }).rows.some((r) => r.event === 'dashboards.changed'),
    ).toBe(false)
  })
})

describe('the Ads dashboard is for super admins only', () => {
  it('refuses a brand admin and a viewer on every route, switch on or off', async () => {
    const { db, brand, owner, lead, viewer } = setup()
    setDashboards(db, brand.id, { ads: true }, owner.id)
    for (const [method, path] of ADS_ROUTES) {
      const route = find(method, path)
      expect(route, `${method} ${path}`).toBeDefined()
      const params = { id: String(brand.id), adv: '1' }
      for (const who of [lead, viewer]) {
        let status = 0
        try {
          await call(route, ctx(db, who, params, { page: '111111111111' }))
        } catch (e) {
          status = (e as { status?: number }).status ?? 0
        }
        expect(status, `${method} ${path} as ${who.email}`).toBe(403)
      }
      expect(() => guard(route, ctx(db, null, params))).toThrow(/Sign in/)
    }
  })

  it('answers a super admin only while the brand’s switch is on', async () => {
    const { db, brand, owner } = setup()
    const get = find('GET', '/api/brands/1/ads')
    const params = { id: String(brand.id) }
    await expect(call(get, ctx(db, owner, params))).rejects.toThrow(/off for this brand/)
    setDashboards(db, brand.id, { ads: true }, owner.id)
    const view = (await call(get, ctx(db, owner, params))) as { advertisers: unknown[] }
    expect(view.advertisers).toEqual([])
  })

  it('never names the Ads switch to a brand’s own people in the brand list', async () => {
    const { db, brand, owner, lead, viewer } = setup()
    setDashboards(db, brand.id, { ads: true }, owner.id)
    const list = find('GET', '/api/brands')
    for (const who of [lead, viewer]) {
      const [row] = (await call(list, ctx(db, who, {}))) as Record<string, unknown>[]
      expect(row).not.toHaveProperty('ads')
      expect(row).not.toHaveProperty('ads_country')
      expect(row!.competition).toBe(true)
      expect(tabsFor(row as never, false).map(([k]) => k)).not.toContain('ads')
    }
    const [mine] = (await call(list, ctx(db, owner, {}))) as Record<string, unknown>[]
    expect(mine!.ads).toBe(true)
    expect(tabsFor(mine as never, true).map(([k]) => k)).toContain('ads')
    // Even a brand row that claims Ads shows no tab to someone who is not a super admin.
    expect(tabsFor({ my_role: 'admin', ads: true }, false).map(([k]) => k)).not.toContain('ads')
    expect(tabsFor({ my_role: 'admin', ads: false }, true).map(([k]) => k)).not.toContain('ads')
  })
})

describe('Share of voice behind its switch', () => {
  it('leaves the tab, the routes and the rivals’ reads when off, for everyone', async () => {
    const { db, brand, rival, owner, lead } = setup()
    const voice = find('GET', '/api/brands/1/voice')
    const rivals = find('GET', '/api/brands/1/competitors')
    const params = { id: String(brand.id) }
    await call(voice, ctx(db, lead, params))
    expect(withCompetitors(db, [brand.id])).toEqual([brand.id, rival.id])
    setDashboards(db, brand.id, { competition: false }, owner.id)
    for (const who of [lead, owner]) {
      await expect(call(voice, ctx(db, who, params))).rejects.toThrow(/off for this brand/)
      await expect(call(rivals, ctx(db, who, params))).rejects.toThrow(/off for this brand/)
      expect(tabsFor({ my_role: 'admin', competition: false }, who.super === 1)).not.toContainEqual(
        ['voice', 'Share of voice'],
      )
    }
    expect(withCompetitors(db, [brand.id])).toEqual([brand.id])
  })
})

describe('advertisers and their ads', () => {
  it('takes Page IDs and Ad Library links, once each', () => {
    const { db, brand } = setup()
    const a = addAdvertiser(db, brand.id, {
      page: 'https://www.facebook.com/ads/library/?country=MD&view_all_page_id=493563500503276',
      own: true,
    })
    expect(a).toMatchObject({ page_id: '493563500503276', own: 1 })
    expect(() => addAdvertiser(db, brand.id, { page: '493563500503276' })).toThrow(/already/)
    expect(() => addAdvertiser(db, brand.id, { page: 'https://www.facebook.com/Tavelo' })).toThrow(
      /Page ID/,
    )
  })

  it('keeps every ad, with when it was first and last seen, and counts by advertiser', () => {
    const { db, brand } = setup()
    addAdvertiser(db, brand.id, { page: '111111111111', own: true })
    const today = new Date('2026-11-01T12:00:00Z')
    expect(
      saveAds(
        db,
        [
          ad(),
          ad({
            library_id: '1002',
            active: false,
            started_on: '2026-05-02',
            ended_on: '2026-05-20',
          }),
        ],
        'MD',
      ),
    ).toEqual({ read: 2, fresh: 2 })
    const first = db.prepare("SELECT first_seen_at FROM ads WHERE library_id = '1001'").get() as {
      first_seen_at: string
    }
    // The next read finds the first ad stopped and the second gone from the Library: both stay.
    expect(saveAds(db, [ad({ active: false, ended_on: '2026-10-31' })], 'MD')).toEqual({
      read: 1,
      fresh: 0,
    })
    const rows = db.prepare('SELECT * FROM ads ORDER BY library_id').all() as {
      library_id: string
      active: number
      first_seen_at: string
    }[]
    expect(rows.map((r) => [r.library_id, r.active])).toEqual([
      ['1001', 0],
      ['1002', 0],
    ])
    expect(rows[0]!.first_seen_at).toBe(first.first_seen_at)
    const v = adsView(db, brand.id, {}, today)
    expect(v.advertisers[0]).toMatchObject({ total: 2, active: 0, new_week: 1 })
    expect(v.advertisers[0]!.months.at(-1)).toBe(0)
    expect(v.advertisers[0]!.months.at(-2)).toBe(1)
    expect(adsView(db, brand.id, { status: 'active' }, today).ads).toHaveLength(0)
    expect(
      adsView(db, brand.id, { platform: 'instagram', since: '2026-10-01' }, today).ads,
    ).toHaveLength(1)
  })

  it('stops the read at a login wall and says so', async () => {
    const { db, brand, owner } = setup()
    setDashboards(db, brand.id, { ads: true }, owner.id)
    addAdvertiser(db, brand.id, { page: '111111111111' })
    addAdvertiser(db, brand.id, { page: '222222222222' })
    const asked: string[] = []
    let closed = false
    startAdsRead(db, brand.id, owner.id, {
      open: async () =>
        ({
          context: { newPage: async () => ({}) },
          close: async () => void (closed = true),
        }) as never,
      read: async (_page, pageId) => {
        asked.push(pageId)
        throw new Challenge('Ad Library', 'Meta asked for a login', 'Try again later.')
      },
    })
    await adsIdle()
    const run = db.prepare('SELECT status, stats FROM ad_runs').get() as {
      status: string
      stats: string
    }
    expect(run.status).toBe('login')
    expect(JSON.parse(run.stats)).toMatchObject({ wall: 'login', read: 0 })
    expect(asked).toEqual(['111111111111'])
    expect(closed).toBe(true)
  })
})

const creative = (position: number, over: Partial<LibraryMedia> = {}): LibraryMedia => ({
  position,
  kind: 'image',
  image_url: `https://scontent.example/${position}.jpg`,
  original_url: null,
  video_url: null,
  video_hd_url: null,
  title: null,
  body: null,
  link_url: null,
  caption: null,
  cta: null,
  cta_type: null,
  link_description: null,
  ...over,
})

describe('creatives, filters and sorting', () => {
  function seeded() {
    const s = setup()
    addAdvertiser(s.db, s.brand.id, { page: '111111111111', own: true })
    addAdvertiser(s.db, s.brand.id, { page: '222222222222' })
    saveAds(
      s.db,
      [
        ad({
          library_id: 'v1',
          format: 'VIDEO',
          media_type: 'video',
          media_set: 'single',
          cta_type: 'LEARN_MORE',
          cta: 'Learn more',
          media: [
            creative(0, {
              kind: 'video',
              video_url: 'https://video.example.fbcdn.net/v.mp4?oe=6AEDB260',
            }),
          ],
          files: [{ path: '/media/ads/v1.jpg', width: 1080, height: 1920 }],
          started_on: '2026-10-01',
          versions: 5,
        }),
        ad({
          library_id: 'c1',
          page_id: '222222222222',
          active: false,
          started_on: '2026-06-01',
          ended_on: '2026-08-30',
          platforms: ['facebook'],
          body: 'Fibre at home',
          format: 'CAROUSEL',
          media_type: 'carousel',
          media_set: 'carousel',
          cta_type: 'SHOP_NOW',
          cta: 'Shop now',
          media: [creative(0, { title: 'First card' }), creative(1, { title: 'Router 100%_off' })],
          files: [{ path: '/media/ads/c1.jpg', width: 600, height: 600 }, null],
        }),
        // Read before creatives were kept: no media, a call to action in words only.
        ad({ library_id: 'old', cta: 'Learn more', started_on: '2026-10-20' }),
      ],
      'MD',
    )
    return s
  }
  const today = new Date('2026-11-01T12:00:00Z')

  it('keeps each creative with its own words, size and the video link’s expiry', () => {
    const { db, brand } = seeded()
    const v = adsView(db, brand.id, {}, today)
    const video = v.ads.find((a) => a.library_id === 'v1')!
    expect(video).toMatchObject({ media_type: 'video', media_width: 1080, media_height: 1920 })
    expect(video.media[0]).toMatchObject({ kind: 'video', width: 1080, height: 1920 })
    expect(video.media[0]!.expires_at).toBe(new Date(0x6aedb260 * 1000).toISOString())
    const carousel = v.ads.find((a) => a.library_id === 'c1')!
    expect(carousel.media.map((m) => [m.position, m.title, m.path])).toEqual([
      [0, 'First card', '/media/ads/c1.jpg'],
      [1, 'Router 100%_off', null],
    ])
    // A later read that brings no creatives keeps what the row has.
    saveAds(db, [ad({ library_id: 'c1', page_id: '222222222222' })], 'MD')
    const again = adsView(db, brand.id, {}, today).ads.find((a) => a.library_id === 'c1')!
    expect(again.media).toHaveLength(2)
    expect(again.media_type).toBe('carousel')
    // An old row without a saved picture has no creatives, and still lists.
    expect(v.ads.find((a) => a.library_id === 'old')!.media).toEqual([])
  })

  it('filters by advertisers, status, media, call to action, words and dates, with counts', () => {
    const { db, brand } = seeded()
    const ids = (f: Parameters<typeof adsView>[2]) =>
      adsView(db, brand.id, f, today)
        .ads.map((a) => a.library_id)
        .sort()
    expect(ids({ pages: ['222222222222'] })).toEqual(['c1'])
    expect(ids({ pages: ['111111111111', '222222222222'] })).toEqual(['c1', 'old', 'v1'])
    // A Page that is not this brand's is ignored, never read.
    expect(ids({ pages: ['999999999999'] })).toEqual(['c1', 'old', 'v1'])
    expect(ids({ status: 'stopped' })).toEqual(['c1'])
    expect(ids({ status: 'active' })).toEqual(['old', 'v1'])
    expect(ids({ media: 'video' })).toEqual(['v1'])
    expect(ids({ media: 'carousel' })).toEqual(['c1'])
    expect(ids({ media: 'text' })).toEqual(['old'])
    // Old rows match by their call to action's words.
    expect(ids({ cta: 'LEARN_MORE' })).toEqual(['old', 'v1'])
    expect(ids({ cta: 'learn more; DROP TABLE ads' })).toEqual(['c1', 'old', 'v1'])
    expect(ids({ q: 'fibre' })).toEqual(['c1'])
    // A card's own title is searched, and % and _ are plain characters.
    expect(ids({ q: '100%_' })).toEqual(['c1'])
    expect(ids({ q: '_' })).toEqual(['c1'])
    expect(ids({ since: '2026-09-01', until: '2026-10-10' })).toEqual(['v1'])

    const f = adsView(db, brand.id, { media: 'video', status: 'active' }, today).facets
    // Each filter's counts leave out its own choice and keep the others.
    expect(f.media).toEqual({ video: 1, text: 1 })
    expect(f.status).toEqual({ active: 1, stopped: 0 })
    expect(f.pages).toEqual({ '111111111111': 1 })
    expect(f.platform).toEqual({ facebook: 1, instagram: 1 })
    expect(f.cta).toEqual([{ type: 'LEARN_MORE', text: 'Learn more', n: 1 }])
  })

  it('sorts by newest start, longest running and most versions', () => {
    const { db, brand } = seeded()
    const order = (sort: string) =>
      adsView(db, brand.id, { sort }, today).ads.map((a) => [a.library_id, a.days])
    expect(order('newest').map(([id]) => id)).toEqual(['old', 'v1', 'c1'])
    // A running ad counts to today; a stopped one to its end; both days count.
    expect(order('longest')).toEqual([
      ['c1', 91],
      ['v1', 32],
      ['old', 13],
    ])
    expect(order('versions').map(([id]) => id)).toEqual(['v1', 'c1', 'old'])
  })

  it('answers the route with the new filters, for super admins only', async () => {
    const { db, brand, owner, lead, viewer } = seeded()
    setDashboards(db, brand.id, { ads: true }, owner.id)
    const get = find('GET', '/api/brands/1/ads')
    const params = { id: String(brand.id) }
    const q =
      'page=222222222222,abc&status=stopped&media=carousel&cta=SHOP_NOW&q=fibre&sort=longest'
    const v = (await call(get, ctx(db, owner, params, {}, q))) as {
      ads: { library_id: string }[]
      matching: number
    }
    expect(v.ads.map((a) => a.library_id)).toEqual(['c1'])
    expect(v.matching).toBe(1)
    // A linked ad comes back beside the list, filtered out or not; another brand's never.
    const linked = (await call(get, ctx(db, owner, params, {}, `${q}&ad=v1`))) as {
      focus: { library_id: string; media: unknown[] } | null
    }
    expect(linked.focus?.library_id).toBe('v1')
    expect(linked.focus?.media).toHaveLength(1)
    saveAds(db, [ad({ library_id: '777', page_id: '333333333333' })], 'MD')
    const other = (await call(get, ctx(db, owner, params, {}, 'ad=777'))) as { focus: unknown }
    expect(other.focus).toBeNull()
    for (const who of [lead, viewer])
      await expect(call(get, ctx(db, who, params, {}, q))).rejects.toMatchObject({ status: 403 })
  })
})

describe('ad pictures on disk', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'sm-media-')), 'media')
  mkdirSync(join(root, 'ads', 'pages'), { recursive: true })
  mkdirSync(join(root, 'instagram'), { recursive: true })
  writeFileSync(join(root, 'ads', '1001-2.jpg'), 'x')
  writeFileSync(join(root, 'ads', 'pages', '111111111111.jpg'), 'x')
  writeFileSync(join(root, 'instagram', 'p.jpg'), 'x')
  writeFileSync(join(root, '..', 'outside.txt'), 'x')

  it('go to super admins only, the Pages’ pictures included, by any spelling', () => {
    const ads = [
      '/media/ads/1001-2.jpg',
      '/media/ads/pages/111111111111.jpg',
      '/media/instagram/../ads/1001-2.jpg',
      '/media/instagram/..%2Fads%2F1001-2.jpg',
      '/media/./ads/1001-2.jpg',
      '/media/ads//pages/111111111111.jpg',
    ]
    for (const p of ads) {
      expect(mediaFile(root, p, false), p).toBeNull()
      expect(mediaFile(root, p, true), p).not.toBeNull()
    }
    expect(mediaFile(root, '/media/instagram/p.jpg', false)).toBe(join(root, 'instagram', 'p.jpg'))
  })

  it('never leave the media folder, nor answer folders or broken paths', () => {
    for (const p of [
      '/media/../outside.txt',
      '/media/..%2Foutside.txt',
      '/media/%2e%2e/outside.txt',
      '/media/ads/..%2F..%2Foutside.txt',
      '/media/ads',
      '/media/ads/pages',
      '/media/%E0%A4%A',
      '/media/ads/1001-2.jpg%00.png',
    ])
      for (const isSuper of [false, true]) expect(mediaFile(root, p, isSuper), p).toBeNull()
  })
})
