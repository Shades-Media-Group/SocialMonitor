import type { DB } from './db.ts'
import { MetaRefused, graph, list, metaToken } from './meta-api.ts'
import type { ReadStory, StoryMediaSource } from './collect/tiktok-stories.ts'
import { handlesIn } from './collect/tiktok-stories.ts'

/**
 * Instagram and Facebook stories through Meta's official Graph API, for a brand that connected its
 * own Page on About, and only its own: Meta has no route to anyone else's stories. Instagram gives
 * each story's file, caption and insights (reach, replies, taps, exits, shares, follows, profile
 * visits); Facebook the Page's stories and their files.
 *
 * It stays off until Meta approves the app's review and META_STORIES=on is set in .env; the
 * Stories screen says so meanwhile.
 */
export const metaStoriesOn = (env: Record<string, string | undefined> = process.env) =>
  env.META_STORIES?.trim().toLowerCase() === 'on'

const DAY = 86_400_000

interface IgStory {
  id: string
  media_type?: string
  media_url?: string
  thumbnail_url?: string
  permalink?: string
  timestamp?: string
  caption?: string
  username?: string
}
interface Insight {
  name: string
  values?: { value?: number }[]
  total_value?: {
    value?: number
    breakdowns?: { results?: { dimension_values?: string[]; value?: number }[] }[]
  }
}

/** Graph's way of asking, replaceable in tests. */
export type GraphGet = <T>(path: string, params: Record<string, string>) => Promise<T>
const realGraph: GraphGet = (path, params) => graph(path, params)

/** Insight names as the dashboard shows them; navigation is split by what the viewer did. */
const METRICS = [
  'reach',
  'replies',
  'shares',
  'follows',
  'profile_visits',
  'total_interactions',
  'views',
]
const NAVIGATION: Record<string, string> = {
  tap_forward: 'taps_forward',
  tap_back: 'taps_back',
  tap_exit: 'exits',
  swipe_forward: 'swipes_forward',
}

/** One insight's number, from either of the shapes Meta answers with. */
const valueOf = (i: Insight) => i.total_value?.value ?? i.values?.[0]?.value ?? null

/**
 * A story's insights. Meta refuses a metric it does not have for an account (a newer metric on an
 * older account, say), so a refusal asks again with the two every story has.
 */
export async function igInsights(g: GraphGet, mediaId: string, token: string) {
  const out: Record<string, number> = {}
  const ask = (metric: string, extra: Record<string, string> = {}) =>
    g<{ data?: Insight[] }>(`/${mediaId}/insights`, { metric, access_token: token, ...extra })
  const main = await ask(METRICS.join(',')).catch((e: unknown) => {
    if (e instanceof MetaRefused) return ask('reach,replies').catch(() => ({ data: [] }))
    throw e
  })
  for (const i of main.data ?? []) {
    const v = valueOf(i)
    if (typeof v === 'number') out[i.name] = v
  }
  const nav = await ask('navigation', { breakdown: 'story_navigation_action_type' }).catch(() => ({
    data: [] as Insight[],
  }))
  for (const i of nav.data ?? [])
    for (const b of i.total_value?.breakdowns ?? [])
      for (const r of b.results ?? []) {
        const key = NAVIGATION[r.dimension_values?.[0] ?? '']
        if (key && typeof r.value === 'number') out[key] = r.value
      }
  return out
}

/** One Instagram story in SocialMonitor's shape. */
export function igStory(
  x: IgStory,
  handle: string,
  insights: Record<string, number> | null,
): ReadStory {
  const video = x.media_type === 'VIDEO'
  const media: StoryMediaSource[] = x.media_url
    ? [
        {
          kind: video ? 'video' : 'image',
          urls: [x.media_url],
          width: null,
          height: null,
          duration: null,
          bytes: null,
          codec: null,
          cover: video ? (x.thumbnail_url ?? null) : null,
        },
      ]
    : []
  const at = x.timestamp ? Date.parse(x.timestamp) : NaN
  const caption = x.caption?.trim() ?? ''
  return {
    network: 'instagram',
    ext_id: x.id,
    handle: x.username ?? handle,
    posted_at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    // A story lasts a day from when it went up.
    expires_at: Number.isFinite(at) ? new Date(at + DAY).toISOString() : null,
    caption,
    media,
    stickers: [],
    mentions: [...new Set(handlesIn(caption))],
    links: [],
    music: null,
    views: insights?.views ?? null,
    likes: null,
    shares: insights?.shares ?? null,
    replies: insights?.replies ?? null,
    insights,
    permalink: x.permalink ?? null,
    is_ad: false,
  }
}

interface FbStory {
  post_id?: string
  media_id?: string
  media_type?: string
  creation_time?: string | number
  url?: string
  status?: string
}

/** The biggest file Meta keeps of a Facebook story's photo or video. */
async function fbFile(
  g: GraphGet,
  story: FbStory,
  token: string,
): Promise<StoryMediaSource | null> {
  if (!story.media_id) return null
  const video = /video/i.test(story.media_type ?? '')
  if (video) {
    const v = await g<{ source?: string; picture?: string; length?: number }>(
      `/${story.media_id}`,
      {
        fields: 'source,picture,length',
        access_token: token,
      },
    )
    return v.source
      ? {
          kind: 'video',
          urls: [v.source],
          width: null,
          height: null,
          duration: v.length ?? null,
          bytes: null,
          codec: null,
          cover: v.picture ?? null,
        }
      : null
  }
  const p = await g<{ images?: { source?: string; width?: number; height?: number }[] }>(
    `/${story.media_id}`,
    { fields: 'images', access_token: token },
  )
  const best = [...(p.images ?? [])]
    .filter((i) => i.source)
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]
  return best?.source
    ? {
        kind: 'image',
        urls: [best.source],
        width: best.width ?? null,
        height: best.height ?? null,
        duration: null,
        bytes: null,
        codec: null,
        cover: null,
      }
    : null
}

const fbTime = (t: string | number | undefined) => {
  if (t == null) return NaN
  const n = Number(t)
  return Number.isFinite(n) ? n * 1000 : Date.parse(String(t))
}

/** A Facebook Page story in SocialMonitor's shape. */
export function fbStory(x: FbStory, handle: string, file: StoryMediaSource | null): ReadStory {
  const at = fbTime(x.creation_time)
  return {
    network: 'facebook',
    ext_id: x.post_id ?? x.media_id ?? '',
    handle,
    posted_at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    expires_at: Number.isFinite(at) ? new Date(at + DAY).toISOString() : null,
    caption: '',
    media: file ? [file] : [],
    stickers: [],
    mentions: [],
    links: [],
    music: null,
    views: null,
    likes: null,
    shares: null,
    replies: null,
    insights: null,
    permalink: x.url ?? null,
    is_ad: false,
  }
}

/**
 * The brand's own Instagram and Facebook stories up now, with their insights, through its
 * connected Page. Empty for a network it has not connected. Off while META_STORIES is not on.
 */
export async function readMetaStories(
  db: DB,
  brandId: number,
  handles: { instagram?: string; facebook?: string },
  g: GraphGet = realGraph,
  log: (line: string) => void = () => {},
): Promise<ReadStory[]> {
  if (!metaStoriesOn()) return []
  const out: ReadStory[] = []
  const ig = metaToken(db, brandId, 'instagram')
  if (ig) {
    const items = await listVia<IgStory>(g, `/${ig.id}/stories`, {
      access_token: ig.token,
      fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp,caption,username',
    })
    for (const x of items) {
      const insights = await igInsights(g, x.id, ig.token).catch((e: Error) => {
        log(`Instagram story ${x.id}: insights not read (${e.message}).`)
        return null
      })
      out.push(igStory(x, handles.instagram ?? '', insights))
    }
    log(`Instagram (connected account): ${items.length} stories up now.`)
  }
  const fb = metaToken(db, brandId, 'facebook')
  if (fb) {
    const items = await listVia<FbStory>(g, `/${fb.id}/stories`, { access_token: fb.token })
    for (const x of items.filter((s) => !s.status || s.status === 'PUBLISHED')) {
      const file = await fbFile(g, x, fb.token).catch(() => null)
      const s = fbStory(x, handles.facebook ?? '', file)
      if (s.ext_id) out.push(s)
    }
    log(`Facebook (connected Page): ${items.length} stories up now.`)
  }
  return out
}

/** A Graph list through `g` (so tests can answer it), first pages only: stories are few. */
async function listVia<T>(g: GraphGet, path: string, params: Record<string, string>) {
  if (g === realGraph) return list<T>(path, { ...params, limit: '50' }, 100)
  const page = await g<{ data?: T[] }>(path, { ...params, limit: '50' })
  return page.data ?? []
}
