import type { Page } from 'playwright'
import type { CollectedComment, CollectedPost, Profile } from '../types.ts'
import type { CollectOptions, Collector } from './index.ts'
import { pick } from './index.ts'
import { Challenge, imageIn, isoFromUnix, num, pause } from './browser.ts'

// The id Instagram's own web app sends with its API calls.
const APP_ID = '936619743392459'

interface Node {
  id: string
  shortcode: string
  taken_at_timestamp?: number
  is_video?: boolean
  product_type?: string
  display_url?: string
  thumbnail_src?: string
  video_view_count?: number
  edge_liked_by?: { count?: number }
  edge_media_preview_like?: { count?: number }
  edge_media_to_comment?: { count?: number }
  edge_media_to_caption?: { edges?: { node?: { text?: string } }[] }
}
interface RawComment {
  pk: string | number
  text: string
  created_at?: number
  comment_like_count?: number
  user?: { username?: string; profile_pic_url?: string }
  parent_comment_id?: string | number
  giphy_media_info?: unknown
  media?: unknown
}

/** Calls Instagram's web API from inside the page, with the page's own cookies and headers. */
async function api<T>(page: Page, path: string): Promise<{ status: number; data: T | null }> {
  return page.evaluate(
    async ({ path, appId }) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? ''
      const r = await fetch(path, {
        headers: {
          'x-ig-app-id': appId,
          'x-csrftoken': csrf,
          'x-requested-with': 'XMLHttpRequest',
        },
        credentials: 'include',
      })
      const text = await r.text()
      try {
        return { status: r.status, data: JSON.parse(text) }
      } catch {
        return { status: r.status, data: null }
      }
    },
    { path, appId: APP_ID },
  ) as Promise<{ status: number; data: T | null }>
}

const challenged = (status: number, data: unknown) =>
  status === 401 ||
  status === 429 ||
  (data as { message?: string } | null)?.message === 'checkpoint_required' ||
  (data as { require_login?: boolean } | null)?.require_login

/**
 * Instagram: the profile's latest posts come from the same API the website uses, which
 * works signed out for public profiles. Comments need a signed-in session.
 */
export const instagram: Collector = {
  network: 'instagram',
  async collect(page: Page, profile: Profile, opt: CollectOptions) {
    await page.goto(profile.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await pause(3000, 6000)
    if (page.url().includes('/challenge') || page.url().includes('/accounts/suspended'))
      throw new Challenge('Instagram', 'a security check appeared')

    const info = await api<{
      data?: { user?: { edge_owner_to_timeline_media?: { edges?: { node: Node }[] } } }
    }>(page, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(profile.handle)}`)
    if (challenged(info.status, info.data))
      throw new Challenge('Instagram', `the profile answered ${info.status}`)
    const nodes = (info.data?.data?.user?.edge_owner_to_timeline_media?.edges ?? []).map(
      (e) => e.node,
    )
    if (!info.data?.data?.user)
      throw new Challenge('Instagram', `the profile @${profile.handle} did not load`)

    const newest = nodes.sort((a, b) => (b.taken_at_timestamp ?? 0) - (a.taken_at_timestamp ?? 0))
    const picked = pick(newest, (n) => n.id, opt)
    const signedIn = (await page.context().cookies('https://www.instagram.com')).some(
      (c) => c.name === 'sessionid' && c.value,
    )
    if (signedIn && opt.comments) opt.usedSession = true
    if (!signedIn)
      opt.log(
        'Instagram: not signed in, so only posts and counts are read. Sign in once in Settings to read comments.',
      )

    const posts: CollectedPost[] = []
    for (const n of picked) {
      const comments = signedIn && opt.comments ? await readComments(page, n.id, opt) : []
      posts.push({
        ext_id: n.id,
        url: `https://www.instagram.com/${n.product_type === 'clips' ? 'reel' : 'p'}/${n.shortcode}/`,
        posted_at: isoFromUnix(n.taken_at_timestamp),
        kind: n.product_type === 'clips' ? 'reel' : n.is_video ? 'video' : 'photo',
        caption: n.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
        thumb_url: n.thumbnail_src ?? n.display_url ?? null,
        likes: num(n.edge_liked_by?.count ?? n.edge_media_preview_like?.count),
        comments_count: num(n.edge_media_to_comment?.count),
        shares: null,
        views: num(n.video_view_count),
        comments,
      })
      opt.log(`Instagram: ${n.shortcode} · ${comments.length} comments read`)
    }
    return posts
  },
}

async function readComments(
  page: Page,
  mediaId: string,
  opt: CollectOptions,
): Promise<CollectedComment[]> {
  const out = new Map<string, CollectedComment>()
  let cursor = ''
  for (let i = 0; i < 6 && out.size < opt.maxComments; i++) {
    await pause()
    const r = await api<{
      comments?: RawComment[]
      next_min_id?: string
      has_more_headload_comments?: boolean
    }>(
      page,
      `/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false${cursor ? `&min_id=${encodeURIComponent(cursor)}` : ''}`,
    )
    if (challenged(r.status, r.data))
      throw new Challenge('Instagram', `comments answered ${r.status}`)
    for (const c of r.data?.comments ?? []) {
      out.set(String(c.pk), {
        ext_id: String(c.pk),
        parent_ext_id: c.parent_comment_id ? String(c.parent_comment_id) : null,
        author: c.user?.username ?? 'unknown',
        text: c.text,
        likes: num(c.comment_like_count),
        posted_at: isoFromUnix(c.created_at),
        author_avatar: c.user?.profile_pic_url ?? null,
        author_url: c.user?.username ? `https://www.instagram.com/${c.user.username}/` : null,
        media_url: imageIn({ g: c.giphy_media_info, m: c.media }, /url|still|first_frame/i),
      })
    }
    cursor = r.data?.next_min_id ?? ''
    if (!cursor) break
  }
  return [...out.values()].slice(0, opt.maxComments)
}
