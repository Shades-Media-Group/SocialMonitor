import { randomBytes } from 'node:crypto'
import type { DB } from './db.ts'
import { now } from './db.ts'
import type { CollectedPost, Profile } from './types.ts'

/**
 * TikTok's official API, for a brand that connects its own TikTok account through TikTok's
 * sign-in (Login Kit). It gives that account's profile, follower figures and its videos with
 * exact counts (Display API). Other accounts are still read from public pages.
 *
 * Keys come from .env: TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET (the sandbox pair while the
 * app waits for review). TikTok only returns people to a fixed https address, so it sends them
 * to the website's /connect/tiktok/ page, which hands the one-time code back to this dashboard.
 */

export const TIKTOK_SCOPES = [
  'user.info.basic',
  'user.info.profile',
  'user.info.stats',
  'video.list',
]
const REDIRECT =
  process.env.TIKTOK_REDIRECT_URI ?? 'https://socialmonitor.shades.md/connect/tiktok/'

export const tiktokReady = () =>
  !!process.env.TIKTOK_CLIENT_KEY?.trim() && !!process.env.TIKTOK_CLIENT_SECRET?.trim()

/** Where the website's hand-back page may return people: this computer or our own domain. */
export const DASHBOARD_ORIGIN =
  /^(http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?|https:\/\/([a-z0-9-]+\.)*socialmonitor\.shades\.md)$/

const pending = new Map<string, { brandId: number; userId: number; at: number }>()

/** The TikTok sign-in address for one brand, valid for ten minutes. */
export function authorizeUrl(brandId: number, userId: number, origin: string) {
  if (!tiktokReady())
    throw new Error('Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to .env first.')
  if (!DASHBOARD_ORIGIN.test(origin))
    throw new Error('This address cannot receive TikTok sign-ins.')
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k)
  const nonce = randomBytes(24).toString('base64url')
  pending.set(nonce, { brandId, userId, at: Date.now() })
  const q = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!.trim(),
    response_type: 'code',
    scope: TIKTOK_SCOPES.join(','),
    redirect_uri: REDIRECT,
    state: `${nonce}.${Buffer.from(origin).toString('base64url')}`,
    disable_auto_auth: '1',
  })
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`
}

interface Tokens {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_expires_in: number
  open_id: string
  scope: string
}

async function token(body: Record<string, string>): Promise<Tokens> {
  const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY!.trim(),
      client_secret: process.env.TIKTOK_CLIENT_SECRET!.trim(),
      ...body,
    }),
  })
  const d = (await r.json()) as Tokens & { error?: string; error_description?: string }
  if (!r.ok || d.error) throw new Error(`TikTok: ${d.error_description || d.error || r.status}`)
  return d
}

async function api<T>(path: string, accessToken: string, body?: unknown): Promise<T> {
  const r = await fetch(`https://open.tiktokapis.com${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const d = (await r.json()) as { data?: T; error?: { code?: string; message?: string } }
  if (!r.ok || (d.error?.code && d.error.code !== 'ok'))
    throw new Error(`TikTok: ${d.error?.message || d.error?.code || r.status}`)
  return d.data as T
}

export interface TikTokUser {
  open_id: string
  username?: string
  display_name?: string
  avatar_url?: string
  follower_count?: number
  following_count?: number
  likes_count?: number
  video_count?: number
}

const USER_FIELDS =
  'open_id,username,display_name,avatar_url,follower_count,following_count,likes_count,video_count'

const store = (db: DB, brandId: number, t: Tokens, user: TikTokUser) => {
  const at = Date.now()
  db.prepare(
    `INSERT INTO network_tokens (brand_id, network, open_id, access_token, refresh_token, expires_at,
       refresh_expires_at, scope, account, connected_at)
     VALUES (?, 'tiktok', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (brand_id, network) DO UPDATE SET open_id = excluded.open_id,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, refresh_expires_at = excluded.refresh_expires_at,
       scope = excluded.scope, account = excluded.account`,
  ).run(
    brandId,
    t.open_id,
    t.access_token,
    t.refresh_token,
    new Date(at + t.expires_in * 1000).toISOString(),
    new Date(at + t.refresh_expires_in * 1000).toISOString(),
    t.scope,
    JSON.stringify(user),
    now(),
  )
}

/** Finishes a sign-in: checks the state, trades the code for tokens, keeps them for the brand. */
export async function finishSignIn(db: DB, code: string, state: string) {
  const nonce = state.split('.')[0] ?? ''
  const p = pending.get(nonce)
  pending.delete(nonce)
  if (!p || Date.now() - p.at > 600_000) throw new Error('This TikTok sign-in expired. Try again.')
  const t = await token({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT })
  const user = await api<{ user: TikTokUser }>(
    `/v2/user/info/?fields=${USER_FIELDS}`,
    t.access_token,
  )
  store(db, p.brandId, t, user.user)
  return { brandId: p.brandId, userId: p.userId, user: user.user }
}

/** A working access token for the brand's TikTok, refreshed when it has run out. */
async function access(db: DB, brandId: number) {
  const row = db
    .prepare("SELECT * FROM network_tokens WHERE brand_id = ? AND network = 'tiktok'")
    .get(brandId) as
    { access_token: string; refresh_token: string; expires_at: string; account: string } | undefined
  if (!row) return null
  if (Date.parse(row.expires_at) - Date.now() > 60_000) return row.access_token
  const t = await token({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
  store(db, brandId, t, JSON.parse(row.account) as TikTokUser)
  return t.access_token
}

export function connection(db: DB, brandId: number) {
  const row = db
    .prepare(
      "SELECT account, connected_at, refresh_expires_at FROM network_tokens WHERE brand_id = ? AND network = 'tiktok'",
    )
    .get(brandId) as
    { account: string; connected_at: string; refresh_expires_at: string } | undefined
  return row
    ? {
        ...(JSON.parse(row.account) as TikTokUser),
        connected_at: row.connected_at,
        until: row.refresh_expires_at,
      }
    : null
}

export const disconnect = (db: DB, brandId: number) =>
  db.prepare("DELETE FROM network_tokens WHERE brand_id = ? AND network = 'tiktok'").run(brandId)

interface Video {
  id: string
  create_time?: number
  cover_image_url?: string
  share_url?: string
  video_description?: string
  title?: string
  like_count?: number
  comment_count?: number
  share_count?: number
  view_count?: number
}
const VIDEO_FIELDS =
  'id,create_time,cover_image_url,share_url,video_description,title,like_count,comment_count,share_count,view_count'

/**
 * With a connected account, the exact figures of its newest videos replace the public ones,
 * and the account's profile and follower counts are refreshed. Without one, nothing changes.
 */
export async function officialFigures(
  db: DB,
  profile: Profile,
  posts: CollectedPost[],
  log: (line: string) => void,
) {
  const accessToken = await access(db, profile.brand_id).catch((e: Error) => {
    log(`TikTok connection: ${e.message}`)
    return null
  })
  if (!accessToken) return
  const user = await api<{ user: TikTokUser }>(`/v2/user/info/?fields=${USER_FIELDS}`, accessToken)
  if (user.user.username && user.user.username.toLowerCase() !== profile.handle.toLowerCase()) {
    log(
      `TikTok connection is @${user.user.username}, not @${profile.handle}: its figures are not used.`,
    )
    return
  }
  db.prepare("UPDATE network_tokens SET account = ? WHERE brand_id = ? AND network = 'tiktok'").run(
    JSON.stringify(user.user),
    profile.brand_id,
  )
  const videos = new Map<string, Video>()
  let cursor: number | undefined
  for (let page = 0; page < 5; page++) {
    const d = await api<{ videos?: Video[]; cursor?: number; has_more?: boolean }>(
      `/v2/video/list/?fields=${VIDEO_FIELDS}`,
      accessToken,
      { max_count: 20, ...(cursor ? { cursor } : {}) },
    )
    for (const v of d.videos ?? []) videos.set(v.id, v)
    if (!d.has_more || !d.cursor) break
    cursor = d.cursor
  }
  let n = 0
  for (const p of posts) {
    const v = videos.get(p.ext_id)
    if (!v) continue
    p.likes = v.like_count ?? p.likes
    p.comments_count = v.comment_count ?? p.comments_count
    p.shares = v.share_count ?? p.shares
    p.views = v.view_count ?? p.views
    n++
  }
  log(
    `TikTok (connected account): exact figures for ${n} posts, ${user.user.follower_count ?? '–'} followers.`,
  )
}
