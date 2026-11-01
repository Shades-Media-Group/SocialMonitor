import type { DB } from './db.ts'
import { now } from './db.ts'
import { changed } from './events.ts'
import { saveImage } from './media.ts'
import { beginSideJob, endSideJob } from './run.ts'
import { Challenge, openLoggedOut, pause } from './collect/browser.ts'
import type { LibraryAd } from './collect/ad-library.ts'
import { country, pageIdFrom, readAdvertiser } from './collect/ad-library.ts'

/**
 * The Ads dashboard: what Meta's public Ad Library shows for a brand's own Facebook Page and its
 * competitors' Pages, read logged out and kept. Only super admins see it, and only on brands
 * whose Ads switch is on. Nothing here reaches a brand's own people: not /api/brands, exports,
 * reports, emails, MCP or search.
 */

export interface Dashboards {
  /** Share of voice and the rivals it compares: on unless a super admin turned it off. */
  competition: boolean
  /** The Ads dashboard: off unless a super admin turned it on. */
  ads: boolean
  /** Where the Ad Library is searched: an ISO country code, or ALL. */
  ads_country: string
}

const DEFAULTS: Dashboards = { competition: true, ads: false, ads_country: 'MD' }

export function dashboards(db: DB, brandId: number): Dashboards {
  const row = db
    .prepare('SELECT competition, ads, ads_country FROM brand_dashboards WHERE brand_id = ?')
    .get(brandId) as { competition: number; ads: number; ads_country: string } | undefined
  if (!row) return { ...DEFAULTS }
  return { competition: !!row.competition, ads: !!row.ads, ads_country: row.ads_country }
}

/** Changes a brand's switches (super admins only, checked by the route). */
export function setDashboards(db: DB, brandId: number, patch: unknown, userId: number | null) {
  const p = (patch ?? {}) as Record<string, unknown>
  const next = dashboards(db, brandId)
  if (p.competition !== undefined) next.competition = p.competition === true
  if (p.ads !== undefined) next.ads = p.ads === true
  if (p.ads_country !== undefined) {
    const cc = country(String(p.ads_country))
    if (!cc) throw new Error('The country is a two-letter code, such as MD, or ALL.')
    next.ads_country = cc
  }
  db.prepare(
    `INSERT INTO brand_dashboards (brand_id, competition, ads, ads_country, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (brand_id) DO UPDATE SET competition = excluded.competition, ads = excluded.ads,
       ads_country = excluded.ads_country, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(brandId, next.competition ? 1 : 0, next.ads ? 1 : 0, next.ads_country, now(), userId)
  return next
}

// Advertisers

export interface Advertiser {
  id: number
  brand_id: number
  page_id: string
  label: string | null
  /** 1: the brand's own Page; 0: a competitor's. */
  own: number
  page_name: string | null
  last_read_at: string | null
  last_status: string | null
  last_error: string | null
  last_total: number | null
  created_at: string
}

/** Pages one brand watches at most: each read opens one Ad Library page after another. */
export const MAX_ADVERTISERS = 12

export const listAdvertisers = (db: DB, brandId: number) =>
  db
    .prepare('SELECT * FROM ad_advertisers WHERE brand_id = ? ORDER BY own DESC, id')
    .all(brandId) as unknown as Advertiser[]

export function addAdvertiser(db: DB, brandId: number, input: unknown) {
  const x = (input ?? {}) as { page?: unknown; label?: unknown; own?: unknown }
  const pageId = pageIdFrom(String(x.page ?? ''))
  if (!pageId)
    throw new Error(
      'Paste a numeric Page ID, or an Ad Library link with view_all_page_id in it. A Page link by name has no ID.',
    )
  if (listAdvertisers(db, brandId).length >= MAX_ADVERTISERS)
    throw new Error(`A brand watches ${MAX_ADVERTISERS} Pages at most.`)
  const label =
    String(x.label ?? '')
      .trim()
      .slice(0, 80) || null
  try {
    return db
      .prepare(
        'INSERT INTO ad_advertisers (brand_id, page_id, label, own, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
      )
      .get(brandId, pageId, label, x.own === true ? 1 : 0, now()) as unknown as Advertiser
  } catch (e) {
    if (/UNIQUE/.test((e as Error).message))
      throw new Error('This Page is already on the list.', { cause: e })
    throw e
  }
}

export function updateAdvertiser(db: DB, brandId: number, id: number, input: unknown) {
  const x = (input ?? {}) as { label?: unknown; own?: unknown }
  const row = db
    .prepare('SELECT id FROM ad_advertisers WHERE id = ? AND brand_id = ?')
    .get(id, brandId)
  if (!row) throw new Error('No such Page on this brand.')
  if (x.label !== undefined)
    db.prepare('UPDATE ad_advertisers SET label = ? WHERE id = ?').run(
      String(x.label ?? '')
        .trim()
        .slice(0, 80) || null,
      id,
    )
  if (x.own !== undefined)
    db.prepare('UPDATE ad_advertisers SET own = ? WHERE id = ?').run(x.own === true ? 1 : 0, id)
}

/** Takes a Page off the list. Its ads stay in the database, as every ad read does. */
export function removeAdvertiser(db: DB, brandId: number, id: number) {
  const r = db.prepare('DELETE FROM ad_advertisers WHERE id = ? AND brand_id = ?').run(id, brandId)
  if (!r.changes) throw new Error('No such Page on this brand.')
}

// Ads

/**
 * Keeps what one read found. New ads are added; known ones get today's status, dates and text,
 * and last_seen_at moves. Nothing is deleted: an ad that stops keeps its row and its history.
 */
export function saveAds(db: DB, ads: (LibraryAd & { media_path?: string | null })[], cc: string) {
  const at = now()
  let fresh = 0
  const known = db.prepare('SELECT 1 FROM ads WHERE library_id = ?')
  const put = db.prepare(
    `INSERT INTO ads (library_id, page_id, page_name, active, started_on, ended_on, platforms, body,
       title, caption, link_url, cta, format, media_kind, media_path, versions, categories, reach,
       spend, impressions, country, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (library_id) DO UPDATE SET page_name = coalesce(excluded.page_name, ads.page_name),
       active = excluded.active, started_on = coalesce(excluded.started_on, ads.started_on),
       ended_on = excluded.ended_on, platforms = excluded.platforms,
       body = CASE WHEN excluded.body != '' THEN excluded.body ELSE ads.body END,
       title = coalesce(excluded.title, ads.title), caption = coalesce(excluded.caption, ads.caption),
       link_url = coalesce(excluded.link_url, ads.link_url), cta = coalesce(excluded.cta, ads.cta),
       format = coalesce(excluded.format, ads.format),
       media_kind = coalesce(excluded.media_kind, ads.media_kind),
       media_path = coalesce(excluded.media_path, ads.media_path),
       versions = coalesce(excluded.versions, ads.versions), categories = excluded.categories,
       reach = coalesce(excluded.reach, ads.reach), spend = coalesce(excluded.spend, ads.spend),
       impressions = coalesce(excluded.impressions, ads.impressions), country = excluded.country,
       last_seen_at = excluded.last_seen_at`,
  )
  db.exec('BEGIN')
  try {
    for (const a of ads) {
      if (!known.get(a.library_id)) fresh++
      put.run(
        a.library_id,
        a.page_id,
        a.page_name,
        a.active ? 1 : 0,
        a.started_on,
        a.ended_on,
        JSON.stringify(a.platforms),
        a.body,
        a.title,
        a.caption,
        a.link_url,
        a.cta,
        a.format,
        a.media_kind,
        a.media_path ?? null,
        a.versions,
        JSON.stringify(a.categories),
        a.reach,
        a.spend,
        a.impressions,
        cc,
        at,
        at,
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { read: ads.length, fresh }
}

export interface AdRow {
  library_id: string
  page_id: string
  page_name: string | null
  active: number
  started_on: string | null
  ended_on: string | null
  /** JSON list */
  platforms: string
  body: string
  title: string | null
  caption: string | null
  link_url: string | null
  cta: string | null
  format: string | null
  media_kind: string | null
  media_path: string | null
  versions: number | null
  /** JSON list */
  categories: string
  reach: string | null
  spend: string | null
  impressions: string | null
  country: string | null
  first_seen_at: string
  last_seen_at: string
}

export interface AdFilter {
  /** One Page ID, or every advertiser of the brand. */
  page?: string
  /** 'active' keeps ads running at the last read. */
  status?: 'active' | 'all'
  platform?: string
  /** Started on or after (YYYY-MM-DD). */
  since?: string
  limit?: number
}

const PLATFORMS = ['facebook', 'instagram', 'messenger', 'audience_network', 'whatsapp', 'threads']

/** The brand's advertisers with their figures, and the ads that match the filters. */
export function adsView(db: DB, brandId: number, f: AdFilter = {}, today = new Date()) {
  const advertisers = listAdvertisers(db, brandId)
  const week = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  // Twelve calendar months, oldest first, ending with this one.
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11 + i, 1))
    return d.toISOString().slice(0, 7)
  })
  const per = advertisers.map((a) => {
    const n = db
      .prepare(
        `SELECT count(*) AS total, coalesce(sum(active), 0) AS active,
           coalesce(sum(started_on >= ?), 0) AS week, min(started_on) AS first, max(started_on) AS last
         FROM ads WHERE page_id = ?`,
      )
      .get(week, a.page_id) as {
      total: number
      active: number
      week: number
      first: string | null
      last: string | null
    }
    const byMonth = new Map(
      (
        db
          .prepare(
            'SELECT substr(started_on, 1, 7) AS m, count(*) AS n FROM ads WHERE page_id = ? AND started_on >= ? GROUP BY m',
          )
          .all(a.page_id, `${months[0]}-01`) as { m: string; n: number }[]
      ).map((r) => [r.m, r.n]),
    )
    return {
      ...a,
      total: n.total,
      active: n.active,
      new_week: n.week,
      first_start: n.first,
      last_start: n.last,
      months: months.map((m) => byMonth.get(m) ?? 0),
    }
  })
  const pages = advertisers.map((a) => a.page_id)
  const want = f.page && pages.includes(f.page) ? [f.page] : pages
  const where = [`page_id IN (${want.map(() => '?').join(',') || "''"})`]
  const args: (string | number)[] = [...want]
  if (f.status === 'active') where.push('active = 1')
  if (f.platform && PLATFORMS.includes(f.platform)) {
    where.push('EXISTS (SELECT 1 FROM json_each(ads.platforms) WHERE value = ?)')
    args.push(f.platform)
  }
  if (f.since && /^\d{4}-\d{2}-\d{2}$/.test(f.since)) {
    where.push('started_on >= ?')
    args.push(f.since)
  }
  const sql = where.join(' AND ')
  const matching = (
    db.prepare(`SELECT count(*) AS n FROM ads WHERE ${sql}`).get(...args) as { n: number }
  ).n
  const limit = Math.max(1, Math.min(500, f.limit ?? 200))
  const ads = db
    .prepare(
      `SELECT * FROM ads WHERE ${sql}
       ORDER BY active DESC, coalesce(started_on, '') DESC, library_id DESC LIMIT ?`,
    )
    .all(...args, limit) as unknown as AdRow[]
  return { advertisers: per, months, ads, matching }
}

// Reading

export interface AdRun {
  id: number
  brand_id: number
  started_by: number | null
  started_at: string
  finished_at: string | null
  /** running, ok, partial, login, error, stopped */
  status: string
  progress: string | null
  stop: number
  log: string
  stats: string | null
}

/** Ads read per Page at most in one read. */
export const CAP = 200

export const lastAdRun = (db: DB, brandId: number) =>
  (db
    .prepare('SELECT * FROM ad_runs WHERE brand_id = ? ORDER BY id DESC LIMIT 1')
    .get(brandId) as unknown as AdRun | undefined) ?? null

export const closeStaleAdRuns = (db: DB) =>
  db
    .prepare(
      "UPDATE ad_runs SET status = 'error', finished_at = ?, log = log || 'Interrupted: the app closed.' WHERE status = 'running'",
    )
    .run(now())

export function stopAdRun(db: DB, brandId: number) {
  db.prepare("UPDATE ad_runs SET stop = 1 WHERE brand_id = ? AND status = 'running'").run(brandId)
}

/** What a read uses, replaceable in tests: the reader and the logged-out browser. */
export interface Deps {
  read?: typeof readAdvertiser
  open?: typeof openLoggedOut
}

let reading = false

/**
 * Starts reading a brand's advertisers in the background and returns the read's id. One read at a
 * time on this computer, never beside an update (both open a browser).
 */
export function startAdsRead(db: DB, brandId: number, userId: number | null, deps: Deps = {}) {
  if (reading) throw new Error('Ads are being read already. Wait for that read to end.')
  if (!listAdvertisers(db, brandId).length) throw new Error('Add a Page to read first.')
  beginSideJob()
  reading = true
  const id = (
    db
      .prepare(
        'INSERT INTO ad_runs (brand_id, started_by, started_at, progress) VALUES (?, ?, ?, ?) RETURNING id',
      )
      .get(brandId, userId, now(), '{}') as { id: number }
  ).id
  const done = readAll(db, id, brandId, deps.read ?? readAdvertiser, deps.open ?? openLoggedOut)
    .catch((e: Error) => finish(db, id, 'error', {}, `Stopped: ${e.message}`))
    .finally(() => {
      reading = false
      endSideJob()
    })
  running = done
  return id
}

let running: Promise<unknown> | null = null
/** Resolves when the current read ends (for tests). */
export const adsIdle = async () => {
  await running
}

function log(db: DB, id: number, line: string) {
  db.prepare('UPDATE ad_runs SET log = log || ? || char(10) WHERE id = ?').run(
    `${new Date().toISOString().slice(11, 19)} ${line}`,
    id,
  )
}
function finish(db: DB, id: number, status: string, stats: unknown, line?: string) {
  if (line) log(db, id, line)
  db.prepare('UPDATE ad_runs SET status = ?, finished_at = ?, stats = ? WHERE id = ?').run(
    status,
    now(),
    JSON.stringify(stats),
    id,
  )
  changed()
}

async function readAll(
  db: DB,
  id: number,
  brandId: number,
  reader: typeof readAdvertiser,
  open: typeof openLoggedOut,
) {
  const cc = dashboards(db, brandId).ads_country
  const list = listAdvertisers(db, brandId)
  const stopped = () =>
    !!(db.prepare('SELECT stop FROM ad_runs WHERE id = ?').get(id) as { stop: number }).stop
  const stats = { pages: 0, read: 0, fresh: 0, failed: 0, wall: null as string | null }
  const browser = await open()
  try {
    const page = await browser.context.newPage()
    for (const [i, a] of list.entries()) {
      if (stopped()) break
      const name = a.label || a.page_name || a.page_id
      db.prepare('UPDATE ad_runs SET progress = ? WHERE id = ?').run(
        JSON.stringify({ at: i + 1, of: list.length, name, read: stats.read }),
        id,
      )
      changed()
      log(db, id, `Reading ${name} (${a.page_id}) in ${cc}.`)
      try {
        const got = await reader(page, a.page_id, cc, {
          cap: CAP,
          log: (l) => log(db, id, l),
          stopped,
        })
        const withMedia = []
        for (const ad of got.ads)
          withMedia.push({
            ...ad,
            media_path: await saveImage('ads', '', ad.library_id, ad.media_url),
          })
        const saved = saveAds(db, withMedia, cc)
        stats.pages++
        stats.read += saved.read
        stats.fresh += saved.fresh
        db.prepare(
          `UPDATE ad_advertisers SET page_name = coalesce(?, page_name), last_read_at = ?,
             last_status = 'ok', last_error = NULL, last_total = ? WHERE id = ?`,
        ).run(got.pageName, now(), got.total ?? saved.read, a.id)
        log(
          db,
          id,
          `${name}: ${saved.read} ads read${got.total != null ? ` of ${got.total}` : ''}, ${saved.fresh} new.`,
        )
      } catch (e) {
        const msg = (e as Error).message
        stats.failed++
        db.prepare(
          "UPDATE ad_advertisers SET last_read_at = ?, last_status = 'error', last_error = ? WHERE id = ?",
        ).run(now(), msg.slice(0, 500), a.id)
        log(db, id, `${name}: ${msg}`)
        // A login wall or a captcha ends the read: asking again only makes Meta stricter.
        if (e instanceof Challenge) {
          stats.wall = /captcha/i.test(msg) ? 'captcha' : 'login'
          break
        }
      }
      if (i < list.length - 1 && !stopped()) await pause(4000, 9000)
    }
  } finally {
    await browser.close()
  }
  const status = stopped()
    ? 'stopped'
    : stats.wall
      ? 'login'
      : stats.failed
        ? stats.pages
          ? 'partial'
          : 'error'
        : 'ok'
  finish(db, id, status, stats, 'Done.')
}
