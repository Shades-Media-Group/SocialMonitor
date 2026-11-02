import type { DB } from './db.ts'
import { now } from './db.ts'
import { changed } from './events.ts'
import { saveImage, savedImageSize } from './media.ts'
import { beginSideJob, endSideJob } from './run.ts'
import { Challenge, openLoggedOut, pause } from './collect/browser.ts'
import type { LibraryAd } from './collect/ad-library.ts'
import { country, linkExpiry, pageIdFrom, readAdvertiser } from './collect/ad-library.ts'

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

/** What the reader added after the first release; a saved ad may come without it. */
type Later =
  | 'page_avatar_url'
  | 'page_url'
  | 'page_likes'
  | 'page_categories'
  | 'cta_type'
  | 'link_description'
  | 'disclaimer'
  | 'digital_media'
  | 'countries'
  | 'media'
  | 'media_set'
  | 'media_type'

/** A saved picture: its /media/ path and size, where the file could be measured. */
export interface SavedFile {
  path: string
  width: number | null
  height: number | null
}

/** One ad to keep, with its pictures saved: files[i] belongs to media[i]. */
export type SavedAd = Omit<LibraryAd, Later> &
  Partial<Pick<LibraryAd, Later>> & {
    media_path?: string | null
    page_avatar?: string | null
    files?: (SavedFile | null)[]
  }

/**
 * Keeps what one read found. New ads are added; known ones get today's status, dates and text,
 * and last_seen_at moves. Nothing is deleted: an ad that stops keeps its row and its history.
 */
export function saveAds(db: DB, ads: SavedAd[], cc: string) {
  const at = now()
  let fresh = 0
  const known = db.prepare('SELECT 1 FROM ads WHERE library_id = ?')
  const put = db.prepare(
    `INSERT INTO ads (library_id, page_id, page_name, active, started_on, ended_on, platforms, body,
       title, caption, link_url, cta, format, media_kind, media_path, versions, categories, reach,
       spend, impressions, country, first_seen_at, last_seen_at, media_type, media_set, media_width,
       media_height, page_avatar, page_url, page_likes, page_categories, cta_type, link_description,
       disclaimer, digital_media, countries)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?)
     ON CONFLICT (library_id) DO UPDATE SET page_name = coalesce(excluded.page_name, ads.page_name),
       media_type = coalesce(excluded.media_type, ads.media_type),
       media_set = coalesce(excluded.media_set, ads.media_set),
       media_width = coalesce(excluded.media_width, ads.media_width),
       media_height = coalesce(excluded.media_height, ads.media_height),
       page_avatar = coalesce(excluded.page_avatar, ads.page_avatar),
       page_url = coalesce(excluded.page_url, ads.page_url),
       page_likes = coalesce(excluded.page_likes, ads.page_likes),
       page_categories = excluded.page_categories,
       cta_type = coalesce(excluded.cta_type, ads.cta_type),
       link_description = coalesce(excluded.link_description, ads.link_description),
       disclaimer = coalesce(excluded.disclaimer, ads.disclaimer),
       digital_media = excluded.digital_media, countries = excluded.countries,
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
  const clear = db.prepare('DELETE FROM ad_media WHERE library_id = ?')
  const putMedia = db.prepare(
    `INSERT INTO ad_media (library_id, position, kind, path, width, height, image_url, video_url,
       video_hd_url, expires_at, title, body, link_url, caption, cta, cta_type, link_description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.exec('BEGIN')
  try {
    for (const a of ads) {
      if (!known.get(a.library_id)) fresh++
      const media = a.media ?? []
      const files = a.files ?? []
      const first = files[0] ?? null
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
        // A read from before creatives were kept says nothing; the row keeps what it has.
        a.media ? (a.media_type ?? null) : null,
        a.media_set ?? null,
        first?.width ?? null,
        first?.height ?? null,
        a.page_avatar ?? null,
        a.page_url ?? null,
        a.page_likes ?? null,
        JSON.stringify(a.page_categories ?? []),
        a.cta_type ?? null,
        a.link_description ?? null,
        a.disclaimer ?? null,
        a.digital_media ? 1 : 0,
        JSON.stringify(a.countries ?? []),
      )
      if (!media.length) continue
      clear.run(a.library_id)
      for (const [i, m] of media.entries())
        putMedia.run(
          a.library_id,
          m.position,
          m.kind,
          files[i]?.path ?? null,
          files[i]?.width ?? null,
          files[i]?.height ?? null,
          m.image_url,
          m.video_url,
          m.video_hd_url,
          linkExpiry(m.video_url),
          m.title,
          m.body,
          m.link_url,
          m.caption,
          m.cta,
          m.cta_type,
          m.link_description,
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
  media_type: string | null
  media_set: string | null
  media_width: number | null
  media_height: number | null
  page_avatar: string | null
  page_url: string | null
  page_likes: number | null
  /** JSON list */
  page_categories: string
  cta_type: string | null
  link_description: string | null
  disclaimer: string | null
  digital_media: number
  /** JSON list */
  countries: string
  /** Days it ran: to its end, or to today while it runs. */
  days: number | null
  media: AdMediaRow[]
}

export interface AdMediaRow {
  position: number
  kind: string
  path: string | null
  width: number | null
  height: number | null
  video_url: string | null
  video_hd_url: string | null
  expires_at: string | null
  title: string | null
  body: string | null
  link_url: string | null
  caption: string | null
  cta: string | null
  cta_type: string | null
  link_description: string | null
}

export const MEDIA_TYPES = ['image', 'video', 'carousel', 'text'] as const
export const SORTS = ['newest', 'longest', 'versions'] as const

export interface AdFilter {
  /** Some of the brand's advertisers by Page ID; none: all of them. */
  pages?: string[]
  /** One Page ID (the first release's filter); joins pages. */
  page?: string
  /** active: running at the last read; stopped: not. */
  status?: 'active' | 'stopped' | 'all'
  platform?: string
  media?: string
  /** Started on or after, and on or before (YYYY-MM-DD). */
  since?: string
  until?: string
  /** A call to action's kind: LEARN_MORE, SHOP_NOW… */
  cta?: string
  /** Words in the headline, text, caption or link, the cards' included. */
  q?: string
  sort?: string
  limit?: number
  /** One ad to return beside the list, by its Library ID. */
  ad?: string
}

const PLATFORMS = ['facebook', 'instagram', 'messenger', 'audience_network', 'whatsapp', 'threads']
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** What an ad mostly is, for rows read before media_type was kept. */
const MEDIA_SQL = `coalesce(media_type, CASE media_kind WHEN 'video' THEN 'video' WHEN 'image' THEN 'image' ELSE 'text' END)`
/** The call to action's kind, from its words for rows read before cta_type was kept. */
const CTA_SQL = `coalesce(cta_type, upper(replace(trim(cta), ' ', '_')))`

type Facet = 'pages' | 'status' | 'platform' | 'media' | 'cta'

/**
 * The WHERE clause of a filter. `skip` leaves one filter out, so its own choices can be counted
 * against everything else that is chosen.
 */
function whereOf(f: AdFilter, pages: string[], skip?: Facet) {
  const asked = [...(f.pages ?? []), ...(f.page ? [f.page] : [])].filter((p) => pages.includes(p))
  const want = skip !== 'pages' && asked.length ? asked : pages
  const where = [`page_id IN (${want.map(() => '?').join(',') || "''"})`]
  const args: (string | number)[] = [...want]
  if (skip !== 'status' && f.status === 'active') where.push('active = 1')
  if (skip !== 'status' && f.status === 'stopped') where.push('active = 0')
  if (skip !== 'platform' && f.platform && PLATFORMS.includes(f.platform)) {
    where.push('EXISTS (SELECT 1 FROM json_each(ads.platforms) WHERE value = ?)')
    args.push(f.platform)
  }
  if (skip !== 'media' && f.media && (MEDIA_TYPES as readonly string[]).includes(f.media)) {
    where.push(`${MEDIA_SQL} = ?`)
    args.push(f.media)
  }
  if (skip !== 'cta' && f.cta && /^[A-Z_]{2,40}$/.test(f.cta)) {
    where.push(`${CTA_SQL} = ?`)
    args.push(f.cta)
  }
  if (f.since && DAY.test(f.since)) {
    where.push('started_on >= ?')
    args.push(f.since)
  }
  if (f.until && DAY.test(f.until)) {
    where.push('started_on <= ?')
    args.push(f.until)
  }
  const q = f.q?.trim().slice(0, 100)
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const has = (col: string) => `${col} LIKE ? ESCAPE '\\'`
    const cols = ['title', 'body', 'caption', 'link_url'].map(has)
    const card = ['m.title', 'm.body', 'm.link_url'].map(has)
    where.push(
      `(${cols.join(' OR ')} OR EXISTS (SELECT 1 FROM ad_media m WHERE m.library_id = ads.library_id AND (${card.join(' OR ')})))`,
    )
    for (let i = 0; i < cols.length + card.length; i++) args.push(like)
  }
  return { sql: where.join(' AND '), args }
}

/** The brand's advertisers with their figures, and the ads that match the filters. */
export function adsView(db: DB, brandId: number, f: AdFilter = {}, today = new Date()) {
  const advertisers = listAdvertisers(db, brandId)
  const week = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  const day = today.toISOString().slice(0, 10)
  // Twelve calendar months, oldest first, ending with this one.
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11 + i, 1))
    return d.toISOString().slice(0, 7)
  })
  const per = advertisers.map((a) => {
    const n = db
      .prepare(
        `SELECT count(*) AS total, coalesce(sum(active), 0) AS active,
           coalesce(sum(started_on >= ?), 0) AS week, min(started_on) AS first, max(started_on) AS last,
           max(page_avatar) AS avatar
         FROM ads WHERE page_id = ?`,
      )
      .get(week, a.page_id) as {
      total: number
      active: number
      week: number
      first: string | null
      last: string | null
      avatar: string | null
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
      avatar: n.avatar,
      months: months.map((m) => byMonth.get(m) ?? 0),
    }
  })
  const pages = advertisers.map((a) => a.page_id)
  const { sql, args } = whereOf(f, pages)
  const matching = (
    db.prepare(`SELECT count(*) AS n FROM ads WHERE ${sql}`).get(...args) as { n: number }
  ).n
  const limit = Math.max(1, Math.min(500, f.limit ?? 200))
  const order =
    f.sort === 'longest'
      ? 'days IS NULL, days DESC, library_id DESC'
      : f.sort === 'versions'
        ? `coalesce(versions, 1) DESC,
           (SELECT count(*) FROM ad_media m WHERE m.library_id = ads.library_id) DESC,
           coalesce(started_on, '') DESC, library_id DESC`
        : "coalesce(started_on, '') DESC, active DESC, library_id DESC"
  const ads = db
    .prepare(`SELECT *, ${DAYS_SQL} AS days FROM ads WHERE ${sql} ORDER BY ${order} LIMIT ?`)
    .all(day, ...args, limit) as unknown as AdRow[]
  // One ad asked for by its Library ID (a linked pop-up), wherever it falls in the list, if it
  // belongs to one of this brand's advertisers.
  const focus =
    f.ad && /^[\w-]{1,40}$/.test(f.ad)
      ? ((db
          .prepare(
            `SELECT *, ${DAYS_SQL} AS days FROM ads WHERE library_id = ?
             AND page_id IN (${pages.map(() => '?').join(',') || "''"})`,
          )
          .get(day, f.ad, ...pages) as unknown as AdRow | undefined) ?? null)
      : null
  withMedia(db, focus ? [...ads, focus] : ads)
  return { advertisers: per, months, ads, matching, focus, facets: facets(db, f, pages) }
}

/** An ad runs to its end day, or to today (the one parameter) while it runs; both days count. */
const DAYS_SQL = `CAST(julianday(CASE WHEN active = 1 OR ended_on IS NULL THEN ? ELSE ended_on END)
  - julianday(started_on) AS INTEGER) + 1`

/** Adds each ad's creatives, in order. */
function withMedia(db: DB, ads: AdRow[]) {
  const media = db.prepare(
    `SELECT position, kind, path, width, height, video_url, video_hd_url, expires_at, title, body,
       link_url, caption, cta, cta_type, link_description
     FROM ad_media WHERE library_id = ? ORDER BY position`,
  )
  for (const a of ads) {
    a.media = media.all(a.library_id) as unknown as AdMediaRow[]
    // A row read before creatives were kept: its one picture, measured from the file.
    if (!a.media.length && a.media_path) {
      const size = savedImageSize(a.media_path)
      a.media = [
        {
          position: 0,
          kind: a.media_kind === 'video' ? 'video' : 'image',
          path: a.media_path,
          width: size?.width ?? null,
          height: size?.height ?? null,
          video_url: null,
          video_hd_url: null,
          expires_at: null,
          title: null,
          body: null,
          link_url: null,
          caption: null,
          cta: null,
          cta_type: null,
          link_description: null,
        },
      ]
    }
  }
}

/** How many ads each choice of each filter would show, with the other filters as they are. */
function facets(db: DB, f: AdFilter, pages: string[]) {
  type Row = { k: string | number | null; n: number }
  const map = (rows: Row[]) =>
    Object.fromEntries(rows.filter((r) => r.k != null).map((r) => [String(r.k), r.n]))
  const count = (skip: Facet, group: string) => {
    const { sql, args } = whereOf(f, pages, skip)
    return map(
      db
        .prepare(`SELECT ${group} AS k, count(*) AS n FROM ads WHERE ${sql} GROUP BY k`)
        .all(...args) as Row[],
    )
  }
  const status = count('status', 'active')
  const p = whereOf(f, pages, 'platform')
  const platform = map(
    db
      .prepare(
        `SELECT j.value AS k, count(*) AS n FROM ads, json_each(ads.platforms) j
         WHERE ${p.sql} GROUP BY k`,
      )
      .all(...p.args) as Row[],
  )
  const c = whereOf(f, pages, 'cta')
  const cta = (
    db
      .prepare(
        `SELECT ${CTA_SQL} AS type, max(cta) AS text, count(*) AS n FROM ads WHERE ${c.sql}
         GROUP BY type ORDER BY n DESC`,
      )
      .all(...c.args) as { type: string | null; text: string | null; n: number }[]
  ).filter((r) => !!r.type && /^[A-Z_]{2,40}$/.test(r.type))
  return {
    pages: count('pages', 'page_id'),
    status: { active: status['1'] ?? 0, stopped: status['0'] ?? 0 },
    platform,
    media: count('media', MEDIA_SQL),
    cta,
  }
}

// Reading

/**
 * A picture bigger than this is not kept. Meta's resized pictures are 20–80 KB and a video's
 * still up to about 250 KB; the full-size originals (up to 600 KB and more) are never fetched.
 */
export const MEDIA_MAX_BYTES = 1_500_000

/**
 * Saves an ad's pictures in data/media/ads: each creative's picture or video still (the first
 * under the ad's own id, as the first release saved it, the others as <id>-<n>), and the Page's
 * small picture once in pages/. Videos are not downloaded: they play from Meta's link while it
 * works, and the next read brings a fresh link.
 */
export async function saveCreatives(ad: LibraryAd): Promise<SavedAd> {
  const files: (SavedFile | null)[] = []
  for (const m of ad.media) {
    const id = m.position ? `${ad.library_id}-${m.position}` : ad.library_id
    const path = await saveImage('ads', '', id, m.image_url, MEDIA_MAX_BYTES)
    const size = path ? savedImageSize(path) : null
    files.push(path ? { path, width: size?.width ?? null, height: size?.height ?? null } : null)
  }
  return {
    ...ad,
    files,
    media_path:
      files[0]?.path ?? (await saveImage('ads', '', ad.library_id, ad.media_url, MEDIA_MAX_BYTES)),
    page_avatar: await saveImage('ads', 'pages', ad.page_id, ad.page_avatar_url, 200_000),
  }
}

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
        const withMedia: SavedAd[] = []
        for (const ad of got.ads) {
          if (stopped()) break
          withMedia.push(await saveCreatives(ad))
        }
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
