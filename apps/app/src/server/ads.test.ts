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
  setDashboards,
  startAdsRead,
} from '../core/ads.ts'
import type { LibraryAd } from '../core/collect/ad-library.ts'
import { Challenge } from '../core/collect/browser.ts'
import { listAudit } from '../core/audit.ts'
import { tabsFor } from '../web/tabs.ts'
import type { Ctx, Route } from './routes.ts'
import { guard, routes } from './routes.ts'
import { adsRoutes } from './ads-routes.ts'

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

const ad = (over: Partial<LibraryAd> = {}): LibraryAd => ({
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
