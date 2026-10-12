import type { Page } from 'playwright'
import type { CollectedComment, CollectedPost, Profile } from '../types.ts'
import type { CollectOptions, Collector } from './index.ts'
import type { Item, RawComment } from './tiktok-public.ts'
import { publicComments, publicPosts, toComment } from './tiktok-public.ts'
import {
  Challenge,
  capture,
  findAll,
  isoFromUnix,
  num,
  pause,
  readScroll,
} from './browser.ts'

async function checkWall(page: Page) {
  if (
    await page
      .locator('#captcha-verify-container, .captcha_verify_container, [id*="captcha"]')
      .count()
  )
    throw new Challenge('TikTok', 'a captcha appeared')
}

/**
 * TikTok: the profile page lists posts with their counts without signing in. Comment text
 * needs a signed-in session; without one the posts are kept and comments are skipped.
 */
export const tiktok: Collector = {
  network: 'tiktok',
  /** Public pages first: no account at stake. The browser only when TikTok refuses them. */
  async collect(page: Page, profile: Profile, opt: CollectOptions) {
    try {
      return await viaPublic(profile, opt)
    } catch (e) {
      opt.log(`TikTok public pages: ${(e as Error).message}. Reading through the browser instead.`)
      return viaBrowser.collect(page, profile, opt)
    }
  },
}

/** Posts and comments from TikTok's public pages, as anyone sees them. */
async function viaPublic(profile: Profile, opt: CollectOptions): Promise<CollectedPost[]> {
  const items = await publicPosts(profile.handle, opt.range === 'new' ? opt.limit + 30 : opt.limit)
  const picked = (opt.range === 'new' ? items.filter((i) => !opt.known.has(i.id)) : items).slice(
    0,
    opt.limit,
  )
  const posts: CollectedPost[] = []
  for (const it of picked) {
    // Public comments need no session, so the signed-in gap does not apply here.
    const raw = await publicComments(it.id, opt.maxComments)
    posts.push(toPost(profile, it, [...raw.values()].map(toComment)))
    opt.log(`TikTok: ${it.id} · ${raw.size} comments read`)
  }
  return posts
}

const toPost = (profile: Profile, it: Item, comments: CollectedComment[]): CollectedPost => {
  const s = it.statsV2 ?? it.stats ?? {}
  return {
    ext_id: it.id,
    url: `https://www.tiktok.com/@${profile.handle}/${it.imagePost ? 'photo' : 'video'}/${it.id}`,
    posted_at: isoFromUnix(it.createTime),
    kind: it.imagePost ? 'photo' : 'video',
    caption: it.desc ?? '',
    thumb_url: it.video?.cover ?? it.video?.originCover ?? null,
    likes: num(s.diggCount),
    comments_count: num(s.commentCount),
    shares: num(s.shareCount),
    views: num(s.playCount),
    comments,
  }
}

const viaBrowser = {
  async collect(page: Page, profile: Profile, opt: CollectOptions) {
    const lists = await capture<{ itemList?: Item[] }>(
      page,
      (u) => u.includes('/api/post/item_list'),
      async () => {
        await page.goto(profile.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await pause(3000, 6000)
        await checkWall(page)
        if (opt.limit > 12) await readScroll(page, Math.ceil(opt.limit / 12))
      },
    )
    // The first page of posts often ships inside the HTML instead of an API call.
    const ssr = await page
      .locator('#__UNIVERSAL_DATA_FOR_REHYDRATION__')
      .textContent({ timeout: 3000 })
      .then((t) => (t ? JSON.parse(t) : null))
      .catch(() => null)
    const items = new Map<string, Item>()
    for (const it of [...findAll<Item>(lists, isItem), ...findAll<Item>(ssr, isItem)])
      items.set(it.id, it)
    if (!items.size) {
      if (await page.locator('[data-e2e="user-page"], [data-e2e="user-title"]').count())
        opt.log(`TikTok @${profile.handle}: no posts visible.`)
      else throw new Challenge('TikTok', `the profile @${profile.handle} did not load`)
    }

    const newest = [...items.values()].sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0))
    const picked =
      opt.range === 'new'
        ? newest.filter((i) => !opt.known.has(i.id)).slice(0, opt.limit)
        : newest.slice(0, opt.limit)
    const signedIn = await isSignedIn(page)
    if (signedIn && opt.comments) opt.usedSession = true
    if (!signedIn)
      opt.log(
        'TikTok: not signed in, so only posts and counts are read. Sign in once in Settings to read comments.',
      )

    const posts: CollectedPost[] = []
    for (const it of picked) {
      const url = `https://www.tiktok.com/@${profile.handle}/${it.imagePost ? 'photo' : 'video'}/${it.id}`
      const comments = signedIn && opt.comments ? await readComments(page, url, opt) : []
      const s = it.statsV2 ?? it.stats ?? {}
      posts.push({
        ext_id: it.id,
        url,
        posted_at: isoFromUnix(it.createTime),
        kind: it.imagePost ? 'photo' : 'video',
        caption: it.desc ?? '',
        thumb_url: it.video?.cover ?? it.video?.originCover ?? null,
        likes: num(s.diggCount),
        comments_count: num(s.commentCount),
        shares: num(s.shareCount),
        views: num(s.playCount),
        comments,
      })
      opt.log(`TikTok: ${url.split('/').pop()} · ${comments.length} comments read`)
    }
    return posts
  },
}

const isItem = (o: Record<string, unknown>) =>
  typeof o.id === 'string' &&
  /^\d{15,}$/.test(o.id) &&
  ('stats' in o || 'statsV2' in o) &&
  'desc' in o

async function isSignedIn(page: Page) {
  const cookies = await page.context().cookies('https://www.tiktok.com')
  return cookies.some((c) => c.name === 'sessionid' && c.value)
}

async function readComments(
  page: Page,
  url: string,
  opt: CollectOptions,
): Promise<CollectedComment[]> {
  await pause()
  const raw = await capture<{ comments?: RawComment[] }>(
    page,
    (u) => u.includes('/api/comment/list'),
    async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await pause(3000, 6000)
      await checkWall(page)
      // Comments load in the side panel as it scrolls; read a few screens, like a person would.
      const panel = '[class*="DivCommentListContainer"], [data-e2e="comment-list"]'
      for (let i = 0; i < Math.min(8, Math.ceil(opt.maxComments / 20)); i++)
        await readScroll(page, 1, panel)
    },
  )
  const seen = new Map<string, CollectedComment>()
  for (const c of findAll<RawComment>(
    raw,
    (o) => typeof o.cid === 'string' && typeof o.text === 'string',
  )) {
    if (seen.size >= opt.maxComments) break
    seen.set(c.cid, toComment(c))
  }
  return [...seen.values()]
}
