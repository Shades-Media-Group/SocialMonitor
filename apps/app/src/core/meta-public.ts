import type { DB } from './db.ts'
import { pick } from './collect/index.ts'
import type { CollectOptions } from './collect/index.ts'
import type { CollectedPost, Profile } from './types.ts'
import {
  FB_POST_FIELDS,
  MetaRefused,
  fbPost,
  graph,
  igPost,
  list,
  metaCollect,
  metaConnected,
} from './meta-api.ts'
import type { FbPost, IgMedia } from './meta-api.ts'

/**
 * Official Meta routes for brands whose accounts nobody here manages.
 *
 * - Instagram, Business Discovery: any Instagram professional account connected to SocialMonitor
 *   (through the Page of any brand) may look up another professional account by its username and
 *   read its public posts with their counts. Meta gives no comment text this way.
 * - Facebook, Page Public Content Access (PPCA): a feature Meta grants after App Review and
 *   business verification. With it, a public Page's posts and counts can be read. Off until
 *   META_PPCA=on in .env, because without Meta's approval every call is refused.
 *
 * Which route reads a profile is decided by metaRoute; the browser stays the fallback.
 */

export type MetaRoute = 'connected' | 'discovery' | 'ppca' | 'browser'

export const ppcaOn = () => process.env.META_PPCA?.trim().toLowerCase() === 'on'

type Source = { brand_id: number; open_id: string; access_token: string; account: string }

/** The most recently connected Instagram account or Facebook Page, of any brand. */
const source = (db: DB, network: 'instagram' | 'facebook') =>
  db
    .prepare(
      `SELECT brand_id, open_id, access_token, account FROM network_tokens
       WHERE network = ? ORDER BY connected_at DESC LIMIT 1`,
    )
    .get(network) as Source | undefined

/** How an update reads this profile. */
export function metaRoute(db: DB, p: Pick<Profile, 'brand_id' | 'network'>): MetaRoute {
  if (p.network !== 'instagram' && p.network !== 'facebook') return 'browser'
  if (metaConnected(db, p.brand_id, p.network)) return 'connected'
  if (p.network === 'instagram') return source(db, 'instagram') ? 'discovery' : 'browser'
  return ppcaOn() && source(db, 'facebook') ? 'ppca' : 'browser'
}

/** Whose account the official route reads through, for the About tab; never the token. */
export function routeVia(db: DB, route: MetaRoute) {
  const s =
    route === 'discovery'
      ? source(db, 'instagram')
      : route === 'ppca'
        ? source(db, 'facebook')
        : undefined
  if (!s) return null
  const a = JSON.parse(s.account) as { name?: string; username?: string | null }
  return route === 'discovery' && a.username ? `@${a.username}` : (a.name ?? null)
}

/** The media fields Business Discovery returns for another professional account. Meta refuses
 * `shortcode` here (#100), so the website id is worked out from the permalink. */
export const DISCOVERY_MEDIA_FIELDS =
  'id,caption,timestamp,permalink,media_type,media_product_type,media_url,thumbnail_url,like_count,comments_count,view_count'

interface Discovered {
  business_discovery?: {
    username?: string
    followers_count?: number
    media_count?: number
    media?: { data?: IgMedia[]; paging?: { cursors?: { after?: string } } }
  }
}

const USERNAME = /^[A-Za-z0-9._]{1,30}$/

/** Business Discovery's field expansion for one page of a username's posts. */
export const discoveryFields = (username: string, per: number, after = '') =>
  `business_discovery.username(${username}){username,followers_count,media_count,media${
    after ? `.after(${after})` : ''
  }.limit(${per}){${DISCOVERY_MEDIA_FIELDS}}}`

/** A refusal said in plain words, with what to do about it. */
export function gentle(e: unknown, route: MetaRoute, handle: string): string {
  if (!(e instanceof MetaRefused)) return (e as Error).message
  if (route === 'discovery') {
    // 110 / 2207013: no professional account by that name (personal, private, age-gated or gone).
    if (
      e.code === 110 ||
      e.subcode === 2207013 ||
      /cannot be found|not a business/i.test(e.message)
    )
      return `Meta shows only Instagram business and creator accounts, and @${handle} is not one it can show (it may be personal, age-restricted or renamed).`
    // 10 and 200–299: a permission the token does not carry.
    if (e.code === 10 || (e.code ?? 0) >= 200)
      return 'Meta refused Business Discovery for the connected account. Add instagram_manage_insights to the app, then connect the Page again (docs/meta.md).'
  }
  if (route === 'ppca' && (e.code === 10 || (e.code ?? 0) >= 200))
    return 'Meta has not granted Page Public Content Access to this app. It needs App Review first (docs/meta.md); until then set META_PPCA=off.'
  return e.message
}

/** Business Discovery: another professional account's latest posts and their counts. */
async function discovery(db: DB, profile: Profile, opt: CollectOptions) {
  const src = source(db, 'instagram')
  if (!src) return null
  const handle = profile.handle.replace(/^@/, '')
  if (!USERNAME.test(handle)) throw new Error(`@${handle} is not an Instagram username.`)
  const max = Math.max(opt.limit, 25)
  const media: IgMedia[] = []
  let after = ''
  let followers: number | undefined
  while (media.length < max) {
    const per = Math.min(25, max - media.length)
    const d = await graph<Discovered>(`/${src.open_id}`, {
      access_token: src.access_token,
      fields: discoveryFields(handle, per, after),
    })
    const bd = d.business_discovery
    followers ??= bd?.followers_count
    const page = bd?.media?.data ?? []
    media.push(...page)
    after = bd?.media?.paging?.cursors?.after ?? ''
    // A short page is the last one; each further page is one more call against the hour's limit.
    if (!after || page.length < per || opt.stopped?.()) break
  }
  const posts = pick(media.map(igPost), (x) => x.ext_id, opt)
  opt.step?.(posts.length, posts.length)
  opt.log(
    `Instagram @${handle}: ${posts.length} posts and their counts read through Meta's official API (Business Discovery)${
      followers !== undefined ? `, ${followers} followers` : ''
    }. Meta gives no comment text this way, so comments are not read.`,
  )
  return posts
}

/** The Page's id or name from its link: profile.php?id=… links carry the id. */
function pageRef(profile: Profile) {
  if (profile.handle !== 'profile.php') return profile.handle
  try {
    return new URL(profile.url).searchParams.get('id') ?? ''
  } catch {
    return ''
  }
}

/** Page Public Content Access: a public Page's latest posts and their counts. */
async function ppca(db: DB, profile: Profile, opt: CollectOptions) {
  const src = source(db, 'facebook')
  if (!src) return null
  const ref = pageRef(profile)
  if (!/^[\w.-]{1,100}$/.test(ref)) throw new Error(`${profile.url} is not a Facebook Page link.`)
  const max = Math.max(opt.limit, 25)
  const all = await list<FbPost>(
    `/${ref}/posts`,
    { access_token: src.access_token, fields: FB_POST_FIELDS, limit: String(Math.min(max, 100)) },
    max,
  )
  const posts = pick(all.map(fbPost), (x) => x.ext_id, opt)
  opt.step?.(posts.length, posts.length)
  opt.log(
    `Facebook ${ref}: ${posts.length} posts and their counts read through Meta's official API (Page Public Content Access). Comments are not read this way yet.`,
  )
  return posts
}

/**
 * Reads a profile through the official route metaRoute picked, or returns null for the browser.
 * Refusals come back as plain sentences; the caller decides whether the browser takes over.
 */
export async function officialCollect(
  db: DB,
  profile: Profile,
  opt: CollectOptions,
  route: MetaRoute = metaRoute(db, profile),
): Promise<CollectedPost[] | null> {
  if (route === 'connected') return metaCollect(db, profile, opt)
  try {
    if (route === 'discovery') return await discovery(db, profile, opt)
    if (route === 'ppca') return await ppca(db, profile, opt)
  } catch (e) {
    if (e instanceof MetaRefused) throw new Error(gentle(e, route, profile.handle), { cause: e })
    throw e
  }
  return null
}
