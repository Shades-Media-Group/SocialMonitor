import type { Page, Response } from 'playwright'
import { Challenge, findAll, num, pause } from './browser.ts'

/**
 * Meta's public Ad Library, read the way any visitor reads it: logged out, in a throwaway browser
 * with no account, no saved cookies and no API token. One Page's ads at a time, from the JSON the
 * page itself loads (its first answer sits in the HTML, the next ones come as it scrolls).
 */

/** One ad as the Ad Library shows it to anyone. Dates are YYYY-MM-DD. */
export interface LibraryAd {
  library_id: string
  page_id: string
  page_name: string | null
  active: boolean
  started_on: string | null
  ended_on: string | null
  /** facebook, instagram, messenger, audience_network, whatsapp, threads */
  platforms: string[]
  body: string
  title: string | null
  caption: string | null
  link_url: string | null
  cta: string | null
  /** IMAGE, VIDEO, DCO, CAROUSEL, MULTI_IMAGES, TEXT… as Meta names it. */
  format: string | null
  media_kind: 'image' | 'video' | null
  media_url: string | null
  /** How many ads use this creative, where Meta groups them. */
  versions: number | null
  categories: string[]
  /** Shown publicly only for some ads (political and issue ads, the EU): kept as Meta words them. */
  reach: string | null
  spend: string | null
  impressions: string | null
}

const PAGE_ID = /^\d{5,20}$/

/**
 * The numeric Page ID in what someone pasted: the ID itself, an Ad Library link
 * (view_all_page_id=…), or a Page link that carries it (profile.php?id=…, /people/Name/123…,
 * /pages/Name/123…). Null when there is none: a named Page link (facebook.com/Name) has no ID in it.
 */
export function pageIdFrom(input: string): string | null {
  const s = input.trim()
  if (PAGE_ID.test(s)) return s
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  if (!/(^|\.)facebook\.com$|(^|\.)fb\.com$/i.test(url.hostname)) return null
  for (const key of ['view_all_page_id', 'id', 'page_id']) {
    const v = url.searchParams.get(key)
    if (v && PAGE_ID.test(v)) return v
  }
  const tail = url.pathname
    .split('/')
    .filter(Boolean)
    .reverse()
    .find((p) => PAGE_ID.test(p))
  if (tail && /^\/(people|pages|p)\//i.test(url.pathname)) return tail
  // facebook.com/123456789 is a Page by its number.
  const only = url.pathname.split('/').filter(Boolean)
  if (only.length === 1 && PAGE_ID.test(only[0]!)) return only[0]!
  return null
}

/** Countries are ISO codes; ALL searches every country. */
export const country = (c: string | null | undefined) => {
  const v = String(c ?? '')
    .trim()
    .toUpperCase()
  return v === 'ALL' || /^[A-Z]{2}$/.test(v) ? v : null
}

/** The Ad Library page that lists every ad of one Page, active and stopped, in one country. */
export const libraryUrl = (pageId: string, cc: string) =>
  `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${encodeURIComponent(cc)}&view_all_page_id=${encodeURIComponent(pageId)}&media_type=all`

/** The public link to one ad. */
export const adUrl = (libraryId: string) =>
  `https://www.facebook.com/ads/library/?id=${encodeURIComponent(libraryId)}`

const day = (unix: unknown) => {
  const n = num(unix)
  // Meta's dates are midnight in California; the UTC date is the day the Library shows.
  return n ? new Date(n * 1000).toISOString().slice(0, 10) : null
}
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
/** Dynamic ads carry placeholders such as {{product.name}} where each version has its own text. */
const real = (v: unknown) => {
  const s = text(v)
  return s && !/\{\{[\w.]+\}\}/.test(s) ? s : null
}

type Raw = Record<string, unknown> & { snapshot: Record<string, unknown> }
type Card = Record<string, unknown>

/** One Ad Library result, flattened to what the dashboard keeps. */
export function toAd(r: Raw): LibraryAd {
  const s = r.snapshot
  const cards = (Array.isArray(s.cards) ? s.cards : []) as Card[]
  const card = cards[0] ?? {}
  const images = (Array.isArray(s.images) ? s.images : []) as Card[]
  const videos = (Array.isArray(s.videos) ? s.videos : []) as Card[]
  const body = real((s.body as { text?: unknown } | null)?.text) ?? real(card.body) ?? ''
  const video =
    text(videos[0]?.video_preview_image_url) ?? text(card.video_preview_image_url) ?? null
  const image =
    text(images[0]?.resized_image_url) ??
    text(images[0]?.original_image_url) ??
    text(card.resized_image_url) ??
    text(card.original_image_url) ??
    null
  const impressions = r.impressions_with_index as { impressions_text?: unknown } | null
  const amount = (v: unknown) =>
    typeof v === 'string'
      ? text(v)
      : v && typeof v === 'object'
        ? [num((v as Card).lower_bound), num((v as Card).upper_bound)]
            .filter((x) => x != null)
            .join('–') || null
        : null
  return {
    library_id: String(r.ad_archive_id),
    page_id: String(r.page_id ?? s.page_id ?? ''),
    page_name: text(r.page_name) ?? text(s.page_name),
    active: r.is_active === true,
    started_on: day(r.start_date),
    ended_on: day(r.end_date),
    platforms: ((Array.isArray(r.publisher_platform) ? r.publisher_platform : []) as unknown[])
      .map((p) => String(p).toLowerCase())
      .filter(Boolean),
    body: body.slice(0, 4000),
    title: real(s.title) ?? real(card.title),
    caption: real(s.caption) ?? real(card.caption),
    link_url: text(s.link_url) ?? text(card.link_url),
    cta: text(s.cta_text) ?? text(card.cta_text),
    format: text(s.display_format),
    media_kind: video ? 'video' : image ? 'image' : null,
    media_url: video ?? image,
    versions: num(r.collation_count),
    categories: ((Array.isArray(r.categories) ? r.categories : []) as unknown[])
      .map(String)
      .filter((c) => c && c !== 'UNKNOWN'),
    reach: amount(r.reach_estimate),
    // A worded range ("<€100") carries its currency; a numeric one gets it added.
    spend:
      typeof r.spend === 'string' || !amount(r.spend)
        ? amount(r.spend)
        : [amount(r.spend), text(r.currency)].filter(Boolean).join(' '),
    impressions: text(impressions?.impressions_text),
  }
}

/** Every ad result in a JSON tree, once each. */
export function adsIn(root: unknown): LibraryAd[] {
  const seen = new Set<string>()
  return findAll<Raw>(
    root,
    (o) => o.ad_archive_id != null && !!o.snapshot && typeof o.snapshot === 'object',
  )
    .map(toAd)
    .filter((a) => !seen.has(a.library_id) && !!seen.add(a.library_id))
}

/** The search's own answer: how many ads it counts and whether more pages follow. */
export function connectionIn(root: unknown): { count: number | null; more: boolean } | null {
  const c = findAll<Record<string, unknown>>(root, (o) => !!o.search_results_connection)[0]
    ?.search_results_connection as
    { count?: unknown; page_info?: { has_next_page?: unknown } } | undefined
  if (!c) return null
  return { count: num(c.count), more: c.page_info?.has_next_page === true }
}

/** The JSON blocks a server-rendered page carries in <script type="application/json">. */
export function scriptJson(html: string): unknown[] {
  const out: unknown[] = []
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = m[1]!
    if (!body.includes('ad_archive_id') && !body.includes('search_results_connection')) continue
    try {
      out.push(JSON.parse(body))
    } catch {
      /* not JSON */
    }
  }
  return out
}

/** One answer of the page's GraphQL endpoint: JSON lines, sometimes behind "for (;;);". */
export function graphqlJson(body: string): unknown[] {
  const out: unknown[] = []
  for (const line of body.replace(/^for \(;;\);/, '').split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      /* not JSON */
    }
  }
  return out
}

/**
 * What stands between a logged-out visitor and the ads: a login wall, a captcha, or nothing.
 * The Library's own header has a "Log in" link on every page, so a link alone is not a wall.
 */
export function wallIn(url: string, html: string): 'login' | 'captcha' | null {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    /* not a URL */
  }
  if (/^\/(login|checkpoint)\b/.test(path) || path.startsWith('/login.php')) return 'login'
  if (/"xfb_ad_library_is_captcha_required"\s*:\s*true/.test(html)) return 'captcha'
  if (/\/captcha\/|id="captcha"/.test(html) && !html.includes('ad_library_main')) return 'captcha'
  if (!html.includes('ad_library_main') && /id="login_form"|name="login_source"/.test(html))
    return 'login'
  return null
}

export interface ReadOptions {
  /** Most ads to read for one Page. */
  cap: number
  log: (line: string) => void
  stopped?: () => boolean
}

/**
 * Reads one Page's ads into `page`, a tab of a logged-out browser. Stops at the cap, when the
 * Library says there are no more, or after three scrolls that bring nothing new. Throws a
 * Challenge, and reads nothing, when Meta answers with a login wall or a captcha.
 */
export async function readAdvertiser(
  page: Page,
  pageId: string,
  cc: string,
  opt: ReadOptions,
): Promise<{ ads: LibraryAd[]; total: number | null; pageName: string | null }> {
  const found = new Map<string, LibraryAd>()
  let more = true
  let total: number | null = null
  const pending: Promise<void>[] = []
  const take = (root: unknown) => {
    for (const ad of adsIn(root)) if (ad.page_id === pageId) found.set(ad.library_id, ad)
    const c = connectionIn(root)
    if (c) {
      more = c.more
      total ??= c.count
    }
  }
  const onResponse = (r: Response) => {
    if (!r.url().includes('/api/graphql')) return
    pending.push(
      r
        .text()
        .then((body) => graphqlJson(body).forEach(take))
        .catch(() => {}),
    )
  }
  page.on('response', onResponse)
  try {
    await page.goto(libraryUrl(pageId, cc), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await pause(3500, 6000)
    const wall = wallIn(page.url(), await page.content())
    if (wall)
      throw new Challenge(
        'Ad Library',
        wall === 'login' ? 'Meta asked for a login' : 'Meta asked for a captcha',
        'Nothing was read. Try again later.',
      )
    await declineCookies(page)
    for (const root of scriptJson(await page.content())) take(root)
    let still = 0
    while (more && found.size < opt.cap && still < 3 && !opt.stopped?.()) {
      const before = found.size
      await page.mouse.wheel(0, 1600 + Math.random() * 900)
      await pause(1800, 3600)
      await Promise.all(pending.splice(0))
      still = found.size > before ? 0 : still + 1
    }
    await Promise.all(pending.splice(0))
    // A wall that appears while scrolling ends the read, keeping what came before it.
    const late = wallIn(page.url(), '')
    if (late) opt.log(`Meta showed a ${late} wall after ${found.size} ads; keeping those.`)
  } finally {
    page.off('response', onResponse)
  }
  const ads = [...found.values()].slice(0, opt.cap)
  return { ads, total, pageName: ads.find((a) => a.page_name)?.page_name ?? null }
}

/** Meta's cookie choice, where it asks (the EU and the UK): the essential cookies only. */
async function declineCookies(page: Page) {
  const button = page
    .getByRole('button', {
      name: /decline optional cookies|only allow essential cookies|reject optional cookies/i,
    })
    .first()
  if (await button.isVisible().catch(() => false)) {
    await button.click().catch(() => {})
    await pause(800, 1600)
  }
}
