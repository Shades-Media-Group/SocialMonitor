import type { Get } from './tiktok-public.ts'
import { checkBody, parseJson, rehydrationIn } from './tiktok-public.ts'
import { num } from './browser.ts'

/**
 * TikTok stories as anyone sees them, logged out: the profile page says whether the account has a
 * story up now (UserStoryStatus), and the web app's own story list (/api/story/item_list/) gives
 * each story with its media, stickers, music and counts. Nothing here signs in; `get` is the same
 * cookie-less or logged-out-browser fetch the post reader uses.
 */

interface Addr {
  UrlList?: string[]
  url_list?: string[]
  Width?: number
  Height?: number
  DataSize?: number | string
}
interface Bitrate {
  GearName?: string
  Bitrate?: number
  CodecType?: string
  PlayAddr?: Addr
}
interface ImageUrl {
  urlList?: string[]
  url_list?: string[]
}
export interface RawStory {
  id: string
  createTime?: number | string
  desc?: string
  story?: { ExpiredAt?: number | string }
  author?: { uniqueId?: string; id?: string }
  video?: {
    width?: number
    height?: number
    duration?: number
    playAddr?: string
    downloadAddr?: string
    cover?: string
    originCover?: string
    codecType?: string
    bitrateInfo?: Bitrate[]
  }
  imagePost?: {
    images?: { imageWidth?: number; imageHeight?: number; imageURL?: ImageUrl }[]
    cover?: { imageWidth?: number; imageHeight?: number; imageURL?: ImageUrl }
  }
  music?: {
    title?: string
    authorName?: string
    original?: boolean
    id?: string
  }
  stickersOnItem?: { stickerText?: string[]; stickerType?: number }[]
  textExtra?: { userUniqueId?: string; hashtagName?: string; type?: number }[]
  anchors?: { keyword?: string; schema?: string; url?: string }[]
  stats?: { diggCount?: number; commentCount?: number; shareCount?: number; playCount?: number }
  statsV2?: { diggCount?: string; commentCount?: string; shareCount?: string; playCount?: string }
  isAd?: boolean
}

/** One file a story shows, at the best quality TikTok offers for it. */
export interface StoryMediaSource {
  kind: 'video' | 'image'
  /** Mirrors of the same file, best first. */
  urls: string[]
  width: number | null
  height: number | null
  duration: number | null
  /** What the source says the file weighs, where it says. */
  bytes: number | null
  codec: string | null
  /** A still of a video (TikTok's own cover), used until the app makes its own. */
  cover: string | null
}

/** A story as SocialMonitor keeps it, before its files are saved. */
export interface ReadStory {
  network: 'tiktok' | 'instagram' | 'facebook'
  ext_id: string
  handle: string
  posted_at: string | null
  expires_at: string | null
  caption: string
  media: StoryMediaSource[]
  /** Words on stickers, in order. */
  stickers: string[]
  /** @handles in the caption, on stickers and in TikTok's own tags, lower case, no @. */
  mentions: string[]
  links: string[]
  music: { title: string; author: string | null } | null
  views: number | null
  likes: number | null
  shares: number | null
  replies: number | null
  /** Story insights from the network's official API (Instagram, Facebook), when connected. */
  insights: Record<string, number> | null
  permalink: string | null
  is_ad: boolean
}

/** A file's mirrors: TikTok spells the list UrlList on videos and urlList on pictures. */
const urls = (u: ImageUrl | Addr | undefined) =>
  [
    ...((u as Addr)?.UrlList ?? []),
    ...((u as ImageUrl)?.urlList ?? []),
    ...((u as ImageUrl)?.url_list ?? []),
  ].filter((x) => typeof x === 'string' && /^https:\/\//.test(x))

/** The video file with the most pixels, then the highest bitrate, whatever its codec. */
export function bestVideo(v: RawStory['video']): StoryMediaSource | null {
  if (!v) return null
  const gears = (v.bitrateInfo ?? [])
    .map((b) => ({
      urls: urls(b.PlayAddr),
      w: num(b.PlayAddr?.Width) ?? v.width ?? 0,
      h: num(b.PlayAddr?.Height) ?? v.height ?? 0,
      rate: num(b.Bitrate) ?? 0,
      bytes: num(b.PlayAddr?.DataSize),
      codec: b.CodecType ?? null,
    }))
    .filter((g) => g.urls.length)
    .sort((a, b) => b.w * b.h - a.w * a.h || b.rate - a.rate)
  const cover = v.originCover || v.cover || null
  const top = gears[0]
  if (top)
    return {
      kind: 'video',
      urls: top.urls,
      width: top.w || null,
      height: top.h || null,
      duration: v.duration || null,
      bytes: top.bytes,
      codec: top.codec,
      cover,
    }
  const plain = [v.playAddr, v.downloadAddr].filter((x): x is string => !!x && /^https:/.test(x))
  return plain.length
    ? {
        kind: 'video',
        urls: plain,
        width: v.width || null,
        height: v.height || null,
        duration: v.duration || null,
        bytes: null,
        codec: v.codecType ?? null,
        cover,
      }
    : null
}

const HANDLE = /(?:^|[^\w.@])@([A-Za-z0-9_.]{2,30})/g
const LINK = /\bhttps?:\/\/[^\s"'<>]+/gi

/** @handles in a text, lower case and without the @; a trailing dot is not part of a handle. */
export const handlesIn = (text: string) =>
  [...text.matchAll(HANDLE)].map((m) => m[1]!.replace(/\.+$/, '').toLowerCase()).filter(Boolean)

const uniq = <T>(xs: T[]) => [...new Set(xs)]

/** One TikTok story in SocialMonitor's shape; null for an item with no file to keep. */
export function toStory(it: RawStory, handle: string): ReadStory | null {
  const images = (it.imagePost?.images ?? [])
    .map((im): StoryMediaSource => ({
      kind: 'image',
      urls: urls(im.imageURL),
      width: num(im.imageWidth) || null,
      height: num(im.imageHeight) || null,
      duration: null,
      bytes: null,
      codec: null,
      cover: null,
    }))
    .filter((m) => m.urls.length)
  const video = it.imagePost ? null : bestVideo(it.video)
  const media = images.length ? images : video ? [video] : []
  if (!media.length) return null
  const stickers = (it.stickersOnItem ?? [])
    .flatMap((s) => s.stickerText ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
  const caption = it.desc?.trim() ?? ''
  const text = [caption, ...stickers].join('\n')
  const s = it.statsV2 ?? it.stats ?? {}
  const expiry = num(it.story?.ExpiredAt)
  const at = num(it.createTime)
  const own = (it.author?.uniqueId ?? handle).toLowerCase()
  return {
    network: 'tiktok',
    ext_id: String(it.id),
    handle: it.author?.uniqueId ?? handle,
    posted_at: at ? new Date(at * 1000).toISOString() : null,
    expires_at: expiry ? new Date(expiry).toISOString() : null,
    caption,
    media,
    stickers,
    mentions: uniq([
      ...handlesIn(text),
      ...(it.textExtra ?? []).map((x) => x.userUniqueId?.toLowerCase() ?? '').filter(Boolean),
    ]).filter((h) => h !== own),
    links: uniq([
      ...(text.match(LINK) ?? []),
      ...(it.anchors ?? []).map((a) => a.url ?? '').filter((u) => /^https?:\/\//.test(u)),
    ]),
    music: it.music?.title
      ? { title: it.music.title, author: it.music.authorName?.trim() || null }
      : null,
    views: num(s.playCount),
    likes: num(s.diggCount),
    shares: num(s.shareCount),
    replies: num(s.commentCount),
    insights: null,
    permalink: null,
    is_ad: it.isAd === true,
  }
}

interface ProfileUser {
  id?: string
  uniqueId?: string
  secUid?: string
  UserStoryStatus?: number
}

/** The account's numeric id and whether it has a story up, from its profile page's HTML. */
export const storyStatusFrom = (html: string) => storyStatusOf(rehydrationIn(checkBody(html)))

/** The same from the profile page's JSON, already parsed. Null when the profile did not load. */
export function storyStatusOf(json: unknown): { id: string; live: boolean | null } | null {
  const data = json as {
    __DEFAULT_SCOPE__?: { 'webapp.user-detail'?: { userInfo?: { user?: ProfileUser } } }
  } | null
  const user = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user
  if (!user?.id) return null
  const flag = user.UserStoryStatus
  return { id: String(user.id), live: typeof flag === 'number' ? flag > 0 : null }
}

interface StoryPage {
  itemList?: RawStory[]
  HasMoreAfter?: boolean
  MaxCursor?: string
  TotalCount?: string
  statusCode?: number
}

export const storyListUrl = (authorId: string, cursor = '0') =>
  `https://www.tiktok.com/api/story/item_list/?aid=1988&app_language=en&app_name=tiktok_web&authorId=${encodeURIComponent(authorId)}&count=20&cursor=${encodeURIComponent(cursor)}&device_platform=web_pc&loadBackward=false&storyFeedScene=3`

/** Every story the account has up now, page after page (ten at most). */
export async function readStoryList(get: Get, authorId: string, handle: string) {
  const out = new Map<string, ReadStory>()
  let cursor = '0'
  for (let page = 0; page < 10; page++) {
    const d = parseJson<StoryPage>(
      await get(storyListUrl(authorId, cursor), `https://www.tiktok.com/@${handle}`),
    )
    for (const it of d.itemList ?? []) {
      const s = toStory(it, handle)
      if (s) out.set(s.ext_id, s)
    }
    if (!d.HasMoreAfter || !d.MaxCursor || d.MaxCursor === cursor || !d.itemList?.length) break
    cursor = d.MaxCursor
  }
  return [...out.values()]
}
