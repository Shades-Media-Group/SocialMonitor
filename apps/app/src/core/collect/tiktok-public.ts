import type { CollectedComment } from '../types.ts'
import { imageIn, isoFromUnix, num } from './browser.ts'

/**
 * TikTok as anyone sees it: a profile's posts and their comments come from TikTok's public
 * pages, with no account. Nothing here can touch a signed-in session: the requests go out
 * either from Node with no cookies, or from a logged-out browser page (see `Get`). Requests
 * are spaced out like a person scrolling.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'

export interface Item {
  id: string
  desc?: string
  createTime?: number
  video?: { cover?: string; originCover?: string }
  imagePost?: unknown
  stats?: { diggCount?: number; commentCount?: number; shareCount?: number; playCount?: number }
  statsV2?: { diggCount?: string; commentCount?: string; shareCount?: string; playCount?: string }
}

export interface RawComment {
  cid: string
  text?: string
  create_time?: number
  digg_count?: number
  reply_id?: string
  user?: { unique_id?: string; nickname?: string; avatar_thumb?: unknown; follower_count?: number }
  image_list?: unknown
  sticker?: unknown
  /** Stickers come here, not in `sticker`. */
  cmt_sticker_struct?: unknown
  reply_comment?: RawComment[] | null
  reply_comment_total?: number
}

/** A picture or sticker attached to a comment, if any. */
export const tiktokMedia = (c: RawComment) =>
  imageIn(
    {
      i: c.image_list,
      s: c.sticker,
      c: (c.cmt_sticker_struct as { static_url?: unknown })?.static_url ?? c.cmt_sticker_struct,
    },
    /url/,
  )

/**
 * A commenter's followers as TikTok's comment list gives them. TikTok often sends 0 for accounts
 * it hides the figure of, so only a positive count is kept; anything else stays unknown.
 */
export const tiktokFollowers = (c: RawComment) => {
  const n = c.user?.follower_count
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** One TikTok comment in SocialMonitor's shape. */
export const toComment = (c: RawComment): CollectedComment => ({
  ext_id: c.cid,
  parent_ext_id: c.reply_id && c.reply_id !== '0' ? c.reply_id : null,
  author: c.user?.unique_id ?? c.user?.nickname ?? 'unknown',
  text: c.text ?? '',
  likes: num(c.digg_count),
  posted_at: isoFromUnix(c.create_time),
  author_avatar: imageIn(c.user?.avatar_thumb, /url/),
  author_url: c.user?.unique_id ? `https://www.tiktok.com/@${c.user.unique_id}` : null,
  media_url: tiktokMedia(c),
  author_followers: tiktokFollowers(c),
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms + Math.random() * ms))

/**
 * Fetches one public TikTok address and returns the body. Two kinds exist: from Node with no
 * cookies at all (`nodeGet`), and from inside a logged-out browser page that already passed
 * TikTok's firewall (collect/tiktok.ts). Neither ever carries a signed-in session.
 */
export type Get = (url: string, referer?: string) => Promise<string>

/**
 * TikTok's firewall stopped the request: instead of data it sent its "Please wait..." page, a
 * script challenge only a real browser can pass. Some connections get it on every request.
 */
export class TikTokWall extends Error {
  constructor() {
    super('TikTok answered with its "Please wait" check instead of the page')
    this.name = 'TikTokWall'
  }
}

/** True for the firewall's challenge page (SlardarWAF), in place of the HTML or JSON asked for. */
export const isWafChallenge = (body: string) =>
  /SlardarWAF|_wafchallengeid|waforiginalreid/.test(body) ||
  (body.length < 5000 && /<body[^>]*>\s*Please wait\.\.\./i.test(body))

/** Throws on the firewall page or an empty answer; otherwise returns the body as it came. */
export function checkBody(body: string) {
  if (isWafChallenge(body)) throw new TikTokWall()
  if (!body.trim()) throw new Error('TikTok sent nothing back')
  return body
}

/** A JSON answer, or a clear error for anything else (a challenge, an HTML page). */
export function parseJson<T>(body: string): T {
  checkBody(body)
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error('TikTok sent a page instead of data')
  }
}

/** TikTok's public pages from Node: no browser, no cookies. */
export const nodeGet: Get = async (url, referer = 'https://www.tiktok.com/') => {
  await wait(1500)
  const r = await fetch(url, { headers: { 'user-agent': UA, referer }, credentials: 'omit' })
  const text = await r.text()
  // The firewall's page comes back as 200 or 403; name it either way.
  if (isWafChallenge(text)) throw new TikTokWall()
  if (!r.ok) throw new Error(`TikTok answered ${r.status}`)
  return checkBody(text)
}

interface Rehydration {
  __DEFAULT_SCOPE__?: {
    'webapp.user-detail'?: { statusCode?: number; userInfo?: { user?: { secUid?: string } } }
  }
}

/** The profile's secUid from the JSON TikTok's profile page ships for rehydration. */
export function secUidFrom(data: unknown): string | undefined {
  return (data as Rehydration | null)?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user
    ?.secUid
}

/** The rehydration JSON inside a profile page's HTML, if it is there. */
export function rehydrationIn(html: string): unknown {
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    return JSON.parse(m[1]!)
  } catch {
    return null
  }
}

/** The profile's newest posts, up to `limit`, going back page by page. */
export async function publicPosts(
  handle: string,
  limit: number,
  /** With it, paging stops as soon as every wanted post was seen. */
  wanted?: Set<string>,
  get: Get = nodeGet,
  /** Known already (read from the open page): the profile page is not fetched again. */
  knownSecUid?: string,
): Promise<Item[]> {
  const secUid =
    knownSecUid ??
    secUidFrom(
      rehydrationIn(checkBody(await get(`https://www.tiktok.com/@${encodeURIComponent(handle)}`))),
    )
  if (!secUid) throw new Error(`the profile @${handle} did not load`)
  const out: Item[] = []
  let cursor = Date.now()
  while (
    out.length < limit ||
    (wanted && [...wanted].some((id) => !out.some((i) => i.id === id)) && out.length < 150)
  ) {
    const d = parseJson<{ itemList?: Item[]; hasMorePrevious?: boolean }>(
      await get(
        `https://www.tiktok.com/api/creator/item_list/?aid=1988&type=1&count=15&secUid=${encodeURIComponent(secUid)}&cursor=${cursor}`,
        `https://www.tiktok.com/@${handle}`,
      ),
    )
    const items = d.itemList ?? []
    out.push(...items)
    if (wanted && [...wanted].every((id) => out.some((i) => i.id === id))) break
    const oldest = Math.min(...items.map((i) => i.createTime ?? Infinity))
    if (!items.length || !d.hasMorePrevious || !Number.isFinite(oldest)) break
    cursor = oldest * 1000 - 1
  }
  if (!out.length) throw new Error(`no posts came back for @${handle}`)
  return out.slice(0, limit)
}

/** Every comment and reply of a post the public pages show, up to `max`. */
export async function publicComments(postId: string, max = 500, get: Get = nodeGet) {
  const out = new Map<string, RawComment>()
  const add = (c: RawComment) => {
    out.set(c.cid, c)
    for (const r of c.reply_comment ?? []) out.set(r.cid, { ...r, reply_id: r.reply_id ?? c.cid })
  }
  let cursor = 0
  for (let page = 0; page < 10 && out.size < max; page++) {
    const d = parseJson<CommentPage>(
      await get(
        `https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=${postId}&count=50&cursor=${cursor}`,
      ),
    )
    for (const c of d.comments ?? []) add(c)
    if (!d.has_more || !d.comments?.length) break
    cursor = d.cursor ?? cursor + 50
  }
  // The list carries one reply per comment at most; the rest come from the reply list.
  for (const c of [...out.values()]) {
    if (out.size >= max) break
    if ((c.reply_comment_total ?? 0) <= (c.reply_comment?.length ?? 0)) continue
    let at = 0
    for (let page = 0; page < 5 && out.size < max; page++) {
      const d = parseJson<CommentPage>(
        await get(
          `https://www.tiktok.com/api/comment/list/reply/?aid=1988&item_id=${postId}&comment_id=${c.cid}&count=50&cursor=${at}`,
        ),
      )
      for (const r of d.comments ?? []) out.set(r.cid, { ...r, reply_id: r.reply_id ?? c.cid })
      if (!d.has_more || !d.comments?.length) break
      at = d.cursor ?? at + 50
    }
  }
  return out
}

interface CommentPage {
  comments?: RawComment[] | null
  has_more?: number
  cursor?: number
}
