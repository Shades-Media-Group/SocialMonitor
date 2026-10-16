import { randomBytes } from 'node:crypto'
import type { DB } from './db.ts'
import { now } from './db.ts'
import { pick } from './collect/index.ts'
import type { CollectOptions } from './collect/index.ts'
import type { CollectedComment, CollectedPost, Profile } from './types.ts'

/**
 * Meta's official API, for a brand whose admin connects the brand's own Facebook Page (and the
 * Instagram business account linked to it) through Facebook's sign-in. With it, posts and
 * comments are read through the Graph API instead of a signed-in browser. Pages the person does
 * not manage are still read from the web.
 *
 * Keys come from .env: META_APP_ID and META_APP_SECRET. Facebook returns people to a fixed https
 * address, the website's /connect/meta/ page, which hands the one-time code back to the dashboard.
 */

const GRAPH = 'https://graph.facebook.com/v23.0'
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'business_management',
  'instagram_basic',
  'instagram_manage_comments',
  // Business Discovery (other brands' public Instagram posts) asks for it with the two above.
  'instagram_manage_insights',
]
const REDIRECT = process.env.META_REDIRECT_URI ?? 'https://socialmonitor.shades.md/connect/meta/'

export const metaReady = () =>
  !!process.env.META_APP_ID?.trim() && !!process.env.META_APP_SECRET?.trim()

const DASHBOARD_ORIGIN =
  /^(http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?|https:\/\/(([a-z0-9-]+\.)*socialmonitor|socialmonitor-app)\.shades\.md)$/

const pending = new Map<string, { brandId: number; at: number }>()

/** The Facebook sign-in address for one brand, valid for ten minutes. */
export function authorizeUrl(brandId: number, origin: string) {
  if (!metaReady()) throw new Error('Add META_APP_ID and META_APP_SECRET to .env first.')
  if (!DASHBOARD_ORIGIN.test(origin))
    throw new Error('This address cannot receive Facebook sign-ins.')
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k)
  const nonce = randomBytes(24).toString('base64url')
  pending.set(nonce, { brandId, at: Date.now() })
  const q = new URLSearchParams({
    client_id: process.env.META_APP_ID!.trim(),
    redirect_uri: REDIRECT,
    state: `${nonce}.${Buffer.from(origin).toString('base64url')}`,
    scope: META_SCOPES.join(','),
    response_type: 'code',
  })
  return `https://www.facebook.com/v23.0/dialog/oauth?${q}`
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number }
}

/** Meta answered that the app or the person used up their calls for now (codes 4, 17, 32, 613). */
export class MetaLimit extends Error {}
/** Meta refused the request itself: a missing permission, a feature not approved, a wrong id. */
export class MetaRefused extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly subcode: number | undefined,
  ) {
    super(message)
  }
}

const LIMIT_CODES = new Set([4, 17, 32, 613])

export async function graph<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = path.startsWith('https://') ? path : `${GRAPH}${path}?${new URLSearchParams(params)}`
  const r = await fetch(url)
  const d = (await r.json()) as T & GraphError
  if (!r.ok || d.error) {
    const code = d.error?.code
    if (code === 190)
      throw new Error('The Facebook connection expired: connect again on the About tab.')
    if (code !== undefined && LIMIT_CODES.has(code))
      throw new MetaLimit(
        "Meta's hourly limit for this app is reached; the next update tries again.",
      )
    throw new MetaRefused(`Meta: ${d.error?.message ?? r.status}`, code, d.error?.error_subcode)
  }
  return d
}

/** Every page of a Graph list, up to a number of items. */
export async function list<T>(path: string, params: Record<string, string>, max: number) {
  const out: T[] = []
  let page = await graph<{ data: T[]; paging?: { next?: string } }>(path, params)
  for (;;) {
    out.push(...page.data)
    if (out.length >= max || !page.paging?.next) break
    page = await graph(page.paging.next, {})
  }
  return out.slice(0, max)
}

interface Page {
  id: string
  name: string
  username?: string
  link?: string
  access_token: string
  instagram_business_account?: { id: string; username?: string }
}

const handleOf = (url: string) =>
  url.replace(/\/+$/, '').split('/').pop()?.replace(/^@/, '').toLowerCase() ?? ''

/**
 * Finishes a sign-in: trades the code for a long-lived token, finds the brand's Page among the
 * ones the person manages and keeps that Page's token, for Facebook and for its Instagram.
 */
export async function finishSignIn(db: DB, code: string, state: string) {
  const nonce = state.split('.')[0] ?? ''
  const p = pending.get(nonce)
  pending.delete(nonce)
  if (!p || Date.now() - p.at > 600_000)
    throw new Error('This Facebook sign-in expired. Try again.')
  try {
    return { brandId: p.brandId, ...(await keepPage(db, p.brandId, code)), error: null }
  } catch (e) {
    return { brandId: p.brandId, error: (e as Error).message }
  }
}

async function keepPage(db: DB, brandId: number, code: string) {
  const app = {
    client_id: process.env.META_APP_ID!.trim(),
    client_secret: process.env.META_APP_SECRET!.trim(),
  }
  const short = await graph<{ access_token: string }>('/oauth/access_token', {
    ...app,
    redirect_uri: REDIRECT,
    code,
  })
  // A long-lived person token gives Page tokens that do not expire.
  const long = await graph<{ access_token: string }>('/oauth/access_token', {
    ...app,
    grant_type: 'fb_exchange_token',
    fb_exchange_token: short.access_token,
  })
  const pages = await list<Page>(
    '/me/accounts',
    {
      access_token: long.access_token,
      fields: 'id,name,username,link,access_token,instagram_business_account{id,username}',
      limit: '100',
    },
    200,
  )
  const profiles = db
    .prepare('SELECT network, handle, url FROM profiles WHERE brand_id = ?')
    .all(brandId) as { network: string; handle: string; url: string }[]
  const fb = profiles.find((x) => x.network === 'facebook')
  const ig = profiles.find((x) => x.network === 'instagram')
  const want = fb ? [fb.handle.toLowerCase(), handleOf(fb.url)] : []
  const page =
    pages.find((pg) =>
      [pg.id, pg.username?.toLowerCase(), pg.link && handleOf(pg.link)].some(
        (v) => v && want.includes(v),
      ),
    ) ??
    (ig
      ? pages.find(
          (pg) =>
            pg.instagram_business_account?.username?.toLowerCase() === ig.handle.toLowerCase(),
        )
      : undefined) ??
    (pages.length === 1 && !fb ? pages[0] : undefined)
  if (!page)
    throw new Error(
      pages.length
        ? `This Facebook account manages ${pages.map((x) => x.name).join(', ')}, not this brand's Page. Check the Facebook link on the About tab.`
        : 'This Facebook account manages no Page.',
    )
  const keep = (network: 'facebook' | 'instagram', id: string, account: object) =>
    db
      .prepare(
        `INSERT INTO network_tokens (brand_id, network, open_id, access_token, refresh_token, expires_at,
           refresh_expires_at, scope, account, connected_at)
         VALUES (?, ?, ?, ?, '', '9999-12-31T00:00:00.000Z', '9999-12-31T00:00:00.000Z', ?, ?, ?)
         ON CONFLICT (brand_id, network) DO UPDATE SET open_id = excluded.open_id,
           access_token = excluded.access_token, scope = excluded.scope, account = excluded.account,
           connected_at = excluded.connected_at`,
      )
      .run(
        brandId,
        network,
        id,
        page.access_token,
        META_SCOPES.join(','),
        JSON.stringify(account),
        now(),
      )
  keep('facebook', page.id, { name: page.name, username: page.username ?? null })
  const insta = page.instagram_business_account
  if (insta) keep('instagram', insta.id, { name: page.name, username: insta.username ?? null })
  return { page: page.name, instagram: insta?.username ?? null }
}

type Row = { open_id: string; access_token: string; account: string; connected_at: string }
const row = (db: DB, brandId: number, network: 'facebook' | 'instagram') =>
  db
    .prepare(
      'SELECT open_id, access_token, account, connected_at FROM network_tokens WHERE brand_id = ? AND network = ?',
    )
    .get(brandId, network) as Row | undefined

export function connection(db: DB, brandId: number) {
  const show = (r: Row | undefined) =>
    r
      ? {
          ...(JSON.parse(r.account) as { name: string; username: string | null }),
          connected_at: r.connected_at,
        }
      : null
  return {
    facebook: show(row(db, brandId, 'facebook')),
    instagram: show(row(db, brandId, 'instagram')),
  }
}

export const metaConnected = (db: DB, brandId: number, network: string) =>
  (network === 'facebook' || network === 'instagram') && !!row(db, brandId, network)

export const disconnect = (db: DB, brandId: number) =>
  db
    .prepare(
      "DELETE FROM network_tokens WHERE brand_id = ? AND network IN ('facebook', 'instagram')",
    )
    .run(brandId)

const SHORTCODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * The id Instagram's own website gives a post, from its shortcode (the part after /p/ or /reel/
 * in its link). Meta's API has its own ids; keeping the website's means a post read through the
 * API and later from the web (or the other way round) stays one post with one history.
 */
export function webMediaId(shortcode: string | undefined): string | null {
  const code = shortcode?.slice(0, 11)
  if (!code || ![...code].every((ch) => SHORTCODE.includes(ch))) return null
  let id = 0n
  for (const ch of code) id = id * 64n + BigInt(SHORTCODE.indexOf(ch))
  return id.toString()
}

const shortcodeOf = (permalink: string | undefined) =>
  permalink?.match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/)?.[1]

/** The website's kinds: reels, videos and photos (a carousel counts as photos there too). */
export const igKind = (x: { media_type?: string; media_product_type?: string }) =>
  x.media_product_type === 'REELS' ? 'reel' : x.media_type === 'VIDEO' ? 'video' : 'photo'

/** A Facebook Graph post id is "{page}_{post}"; the website reads the post part alone. */
export const fbPostId = (id: string) => id.split('_').pop() ?? id

export interface IgMedia {
  id: string
  caption?: string
  timestamp?: string
  permalink?: string
  shortcode?: string
  media_type?: string
  media_product_type?: string
  media_url?: string
  thumbnail_url?: string
  like_count?: number
  comments_count?: number
  view_count?: number
}

/** One Instagram post from the Graph API as SocialMonitor keeps it, without comments. */
export function igPost(x: IgMedia): CollectedPost {
  return {
    ext_id: webMediaId(x.shortcode ?? shortcodeOf(x.permalink)) ?? x.id,
    url: x.permalink ?? 'https://www.instagram.com/',
    posted_at: x.timestamp ? new Date(x.timestamp).toISOString() : null,
    kind: igKind(x),
    caption: x.caption ?? '',
    thumb_url: (x.media_type === 'VIDEO' ? x.thumbnail_url : x.media_url) ?? null,
    // Absent when the owner hides likes: unknown, never zero.
    likes: x.like_count ?? null,
    comments_count: x.comments_count ?? null,
    shares: null,
    views: x.view_count ?? null,
    comments: [],
  }
}

export interface FbPost {
  id: string
  message?: string
  created_time?: string
  permalink_url?: string
  full_picture?: string
  status_type?: string
  shares?: { count?: number }
  reactions?: { summary?: { total_count?: number } }
  comments?: { summary?: { total_count?: number } }
}

export const FB_POST_FIELDS =
  'id,message,created_time,permalink_url,full_picture,status_type,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)'

/** One Facebook Page post from the Graph API as SocialMonitor keeps it, without comments. */
export function fbPost(x: FbPost): CollectedPost {
  return {
    ext_id: fbPostId(x.id),
    url: x.permalink_url ?? `https://www.facebook.com/${x.id}`,
    posted_at: x.created_time ? new Date(x.created_time).toISOString() : null,
    kind: x.status_type?.includes('video') ? 'video' : 'post',
    caption: x.message ?? '',
    thumb_url: x.full_picture ?? null,
    likes: x.reactions?.summary?.total_count ?? null,
    comments_count: x.comments?.summary?.total_count ?? null,
    shares: x.shares?.count ?? 0,
    views: null,
    comments: [],
  }
}

interface FbComment {
  id: string
  message?: string
  created_time?: string
  like_count?: number
  parent?: { id: string }
  from?: { id: string; name: string }
  attachment?: { media?: { image?: { src?: string } } }
}
interface IgComment {
  id: string
  text?: string
  timestamp?: string
  username?: string
  like_count?: number
  replies?: { data?: IgComment[] }
}

/**
 * Reads a connected Facebook Page or Instagram account through the Graph API, or returns null
 * when the brand has not connected it (the web reader takes over then).
 */
export async function metaCollect(
  db: DB,
  profile: Profile,
  opt: CollectOptions,
): Promise<CollectedPost[] | null> {
  if (profile.network !== 'facebook' && profile.network !== 'instagram') return null
  const r = row(db, profile.brand_id, profile.network)
  if (!r) return null
  const token = { access_token: r.access_token }
  const max = Math.max(opt.limit, 25)
  if (profile.network === 'facebook') {
    const posts = await list<FbPost>(
      `/${r.open_id}/posts`,
      { ...token, fields: FB_POST_FIELDS, limit: String(max) },
      max,
    )
    const chosen = pick(posts, (x) => fbPostId(x.id), opt)
    const out: CollectedPost[] = []
    for (const [i, x] of chosen.entries()) {
      if (opt.stopped?.()) break
      opt.step?.(i, chosen.length)
      const comments = opt.comments
        ? await list<FbComment>(
            `/${x.id}/comments`,
            {
              ...token,
              filter: 'stream',
              order: 'chronological',
              fields:
                'id,message,created_time,like_count,parent{id},from{id,name},attachment{media}',
              limit: '100',
            },
            opt.maxComments,
          )
        : []
      out.push({
        ...fbPost(x),
        comments: comments.map((c): CollectedComment => ({
          ext_id: c.id,
          parent_ext_id: c.parent?.id ?? null,
          author: c.from?.name ?? 'Facebook user',
          text: c.message ?? '',
          likes: c.like_count ?? null,
          posted_at: c.created_time ? new Date(c.created_time).toISOString() : null,
          author_url: c.from ? `https://www.facebook.com/${c.from.id}` : null,
          media_url: c.attachment?.media?.image?.src ?? null,
        })),
      })
    }
    opt.log(`Facebook (connected Page): ${out.length} posts read through Meta's API.`)
    return out
  }
  const media = await list<IgMedia>(
    `/${r.open_id}/media`,
    {
      ...token,
      fields:
        'id,caption,timestamp,permalink,shortcode,media_type,media_product_type,media_url,thumbnail_url,like_count,comments_count',
      limit: String(max),
    },
    max,
  )
  const chosen = pick(media, (x) => igPost(x).ext_id, opt)
  const out: CollectedPost[] = []
  for (const [i, x] of chosen.entries()) {
    if (opt.stopped?.()) break
    opt.step?.(i, chosen.length)
    const top = opt.comments
      ? await list<IgComment>(
          `/${x.id}/comments`,
          {
            ...token,
            fields:
              'id,text,timestamp,username,like_count,replies{id,text,timestamp,username,like_count}',
            limit: '50',
          },
          opt.maxComments,
        )
      : []
    const comment = (c: IgComment, parent: string | null): CollectedComment => ({
      ext_id: c.id,
      parent_ext_id: parent,
      author: c.username ?? 'Instagram user',
      text: c.text ?? '',
      likes: c.like_count ?? null,
      posted_at: c.timestamp ? new Date(c.timestamp).toISOString() : null,
      author_url: c.username ? `https://www.instagram.com/${c.username}/` : null,
    })
    out.push({
      ...igPost(x),
      comments: top.flatMap((c) => [
        comment(c, null),
        ...(c.replies?.data ?? []).map((rep) => comment(rep, c.id)),
      ]),
    })
  }
  opt.log(`Instagram (connected account): ${out.length} posts read through Meta's API.`)
  return out
}
