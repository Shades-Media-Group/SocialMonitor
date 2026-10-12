import type { Page } from 'playwright'
import type { CollectedComment, CollectedPost, Profile } from '../types.ts'
import type { CollectOptions, Collector } from './index.ts'
import { Challenge, capture, findAll, isoFromUnix, num, pause, readScroll } from './browser.ts'

interface Item {
  id: string
  desc?: string
  createTime?: number
  video?: { cover?: string; originCover?: string }
  imagePost?: unknown
  stats?: { diggCount?: number; commentCount?: number; shareCount?: number; playCount?: number }
  statsV2?: { diggCount?: string; commentCount?: string; shareCount?: string; playCount?: string }
}
interface RawComment {
  cid: string
  text: string
  create_time?: number
  digg_count?: number
  reply_id?: string
  user?: { unique_id?: string; nickname?: string }
}

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
    seen.set(c.cid, {
      ext_id: c.cid,
      parent_ext_id: c.reply_id && c.reply_id !== '0' ? c.reply_id : null,
      author: c.user?.unique_id ?? c.user?.nickname ?? 'unknown',
      text: c.text,
      likes: num(c.digg_count),
      posted_at: isoFromUnix(c.create_time),
    })
  }
  return [...seen.values()]
}
