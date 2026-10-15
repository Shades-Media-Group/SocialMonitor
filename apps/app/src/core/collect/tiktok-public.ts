import type { CollectedComment } from '../types.ts'
import { imageIn, isoFromUnix, num } from './browser.ts'

/**
 * TikTok as anyone sees it: a profile's posts and their comments come from TikTok's public
 * pages, with no account, no cookies and no browser. Nothing here can touch a signed-in
 * session. Requests are spaced out like a person scrolling.
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

async function get(url: string, referer = 'https://www.tiktok.com/') {
  await wait(1500)
  const r = await fetch(url, { headers: { 'user-agent': UA, referer }, credentials: 'omit' })
  if (!r.ok) throw new Error(`TikTok answered ${r.status}`)
  const text = await r.text()
  if (!text.trim()) throw new Error('TikTok sent nothing back')
  return text
}

/** The profile's newest posts, up to `limit`, going back page by page. */
export async function publicPosts(
  handle: string,
  limit: number,
  /** With it, paging stops as soon as every wanted post was seen. */
  wanted?: Set<string>,
): Promise<Item[]> {
  const html = await get(`https://www.tiktok.com/@${encodeURIComponent(handle)}`)
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
  const secUid = m
    ? (
        JSON.parse(m[1]!) as {
          __DEFAULT_SCOPE__?: {
            'webapp.user-detail'?: { userInfo?: { user?: { secUid?: string } } }
          }
        }
      ).__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user?.secUid
    : undefined
  if (!secUid) throw new Error(`the profile @${handle} did not load`)
  const out: Item[] = []
  let cursor = Date.now()
  while (
    out.length < limit ||
    (wanted && [...wanted].some((id) => !out.some((i) => i.id === id)) && out.length < 150)
  ) {
    const d = JSON.parse(
      await get(
        `https://www.tiktok.com/api/creator/item_list/?aid=1988&type=1&count=15&secUid=${encodeURIComponent(secUid)}&cursor=${cursor}`,
        `https://www.tiktok.com/@${handle}`,
      ),
    ) as { itemList?: Item[]; hasMorePrevious?: boolean }
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
export async function publicComments(postId: string, max = 500) {
  const out = new Map<string, RawComment>()
  const add = (c: RawComment) => {
    out.set(c.cid, c)
    for (const r of c.reply_comment ?? []) out.set(r.cid, { ...r, reply_id: r.reply_id ?? c.cid })
  }
  let cursor = 0
  for (let page = 0; page < 10 && out.size < max; page++) {
    const d = JSON.parse(
      await get(
        `https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=${postId}&count=50&cursor=${cursor}`,
      ),
    ) as { comments?: RawComment[]; has_more?: number; cursor?: number }
    for (const c of d.comments ?? []) add(c)
    if (!d.has_more || !d.comments?.length) break
    cursor = d.cursor ?? cursor + 50
  }
  for (const c of [...out.values()]) {
    if (out.size >= max) break
    if ((c.reply_comment_total ?? 0) <= (c.reply_comment?.length ?? 0)) continue
    const d = JSON.parse(
      await get(
        `https://www.tiktok.com/api/comment/list/reply/?aid=1988&item_id=${postId}&comment_id=${c.cid}&count=50&cursor=0`,
      ),
    ) as { comments?: RawComment[] }
    for (const r of d.comments ?? []) out.set(r.cid, { ...r, reply_id: r.reply_id ?? c.cid })
  }
  return out
}
