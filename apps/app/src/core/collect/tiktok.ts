import type { BrowserContext, Page } from 'playwright'
import type { CollectedComment, CollectedPost, Profile } from '../types.ts'
import type { CollectOptions, Collector } from './index.ts'
import { pick } from './index.ts'
import type { Get, Item } from './tiktok-public.ts'
import {
  TikTokWall,
  checkBody,
  isWafChallenge,
  nodeGet,
  rehydrationIn,
  publicComments,
  publicPosts,
  secUidFrom,
  toComment,
} from './tiktok-public.ts'
import { Challenge, isoFromUnix, num, openLoggedOut, pause } from './browser.ts'

const CAPTCHA = '#captcha-verify-container, .captcha_verify_container, [id*="captcha"]'
const NEXT = 'SocialMonitor stopped reading TikTok for this update; the next one tries again.'

/**
 * TikTok, logged out, as anyone sees it: a profile's posts with their likes, comments, shares
 * and views, and each post's comments with their replies. No account is ever used, so none can
 * be put at risk. First straight from Node; where TikTok's firewall answers that with its
 * "Please wait" check (some connections get it on every request), the same public calls run
 * from inside a throwaway logged-out browser page once the page has passed that check.
 */
export const tiktok: Collector = {
  network: 'tiktok',
  // The shared, possibly signed-in browser page is never used for TikTok.
  async collect(_page: Page, profile: Profile, opt: CollectOptions) {
    try {
      return await readPublic(profile, opt, nodeGet, false)
    } catch (e) {
      opt.log(
        `TikTok public pages: ${(e as Error).message}. Reading them through a logged-out browser instead.`,
      )
    }
    const browser = await openLoggedOut()
    try {
      const { get, secUid } = await openProfile(browser.context, profile, opt)
      return await readPublic(profile, opt, get, true, secUid)
    } finally {
      await browser.close()
    }
  },
}

/**
 * Opens the public profile in the logged-out browser and waits until TikTok's firewall check has
 * run and the real page is there. Returns a `Get` that fetches from inside that page, so the
 * visitor cookies the check handed out go with each request, and the profile's secUid.
 */
async function openProfile(context: BrowserContext, profile: Profile, opt: CollectOptions) {
  const page = await context.newPage()
  // The profile's HTML as it arrives. The check answers the first load with its own page, runs
  // its script and reloads; the HTML that comes after that carries the profile. Reading it from
  // the response, not the DOM, keeps this independent of how long the page takes to render.
  const seen: { data: unknown; walls: number } = { data: null, walls: 0 }
  page.on('response', (r) => {
    if (r.request().resourceType() !== 'document' || r.frame() !== page.mainFrame()) return
    r.text()
      .then((t) => {
        if (isWafChallenge(t)) seen.walls++
        else if (r.status() === 200 && !seen.data) seen.data = rehydrationIn(t)
      })
      .catch(() => {})
  })
  await page.goto(profile.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  for (const end = Date.now() + 60_000; !seen.data && Date.now() < end;) {
    if (await page.locator(CAPTCHA).count())
      throw new Challenge('TikTok', 'a captcha appeared', NEXT)
    await page.waitForTimeout(1000)
  }
  if (!seen.data)
    throw new Challenge(
      'TikTok',
      seen.walls
        ? 'its "Please wait" check did not let the browser through'
        : `the profile @${profile.handle} did not load`,
      NEXT,
    )
  const secUid = secUidFrom(seen.data)
  if (!secUid) throw new Error(`the profile @${profile.handle} did not load`)
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  opt.log(
    `TikTok: the public profile opened in a logged-out browser${seen.walls ? ', past TikTok’s "Please wait" check' : ''}.`,
  )
  // A person looks at the profile before opening anything.
  await pause(3000, 6000)
  return { get: pageGet(page), secUid }
}

/**
 * Fetches a public TikTok address from inside the open page, after a human pause, so the
 * visitor cookies TikTok's check handed this page go with it. If the page reloaded itself in the
 * meantime, it waits for the new page and asks once more.
 */
const pageGet =
  (page: Page): Get =>
  async (url) => {
    await pause(1500, 4000)
    if (await page.locator(CAPTCHA).count())
      throw new Challenge('TikTok', 'a captcha appeared', NEXT)
    const ask = () =>
      page.evaluate(async (u) => {
        const res = await fetch(u, { credentials: 'same-origin' })
        return { status: res.status, text: await res.text() }
      }, url)
    const r = await ask().catch(async (e: Error) => {
      if (!/context was destroyed|navigat/i.test(e.message)) throw e
      await page.waitForLoadState('domcontentloaded')
      await pause(1500, 3000)
      return ask()
    })
    if (isWafChallenge(r.text)) throw new TikTokWall()
    if (r.status !== 200) throw new Error(`TikTok answered ${r.status}`)
    return checkBody(r.text)
  }

/**
 * Posts and comments through `get`. On the last route (`last`), a comment list that fails for
 * one post keeps that post's counts and moves on, while TikTok's check or a captcha stops the
 * whole read there. Before that, any failure goes up, so the next route can take over.
 */
export async function readPublic(
  profile: Profile,
  opt: CollectOptions,
  get: Get,
  last: boolean,
  secUid?: string,
): Promise<CollectedPost[]> {
  // Due posts can be older than the newest page: read back far enough to reach them, at most
  // ten pages (150 posts), so a re-check stays cheap.
  const items = await publicPosts(
    profile.handle,
    opt.range === 'due' && opt.due.size
      ? 150
      : opt.range === 'new' || opt.range === 'due'
        ? opt.limit + 30
        : opt.limit,
    opt.range === 'due' && opt.due.size ? new Set(opt.due.keys()) : undefined,
    get,
    secUid,
  ).catch((e: Error) => {
    if (last && e instanceof TikTokWall) throw new Challenge('TikTok', e.message, NEXT)
    throw e
  })
  const picked = pick(items, (i) => i.id, opt)
  const posts: CollectedPost[] = []
  let rechecked = 0
  for (const [i, it] of picked.entries()) {
    if (opt.stopped?.()) break
    opt.step?.(i, picked.length)
    const known = opt.known.has(it.id) || opt.due.has(it.id)
    const s = it.statsV2 ?? it.stats ?? {}
    const before = opt.due.get(it.id)
    // A re-checked post brings its comments only when it has more than last time.
    const needComments =
      opt.comments && (!known || opt.range === 'all' || (num(s.commentCount) ?? 0) > (before ?? 0))
    let comments: CollectedComment[] = []
    if (needComments) {
      try {
        comments = [...(await publicComments(it.id, opt.maxComments, get)).values()].map(toComment)
      } catch (e) {
        if (!last) throw e
        if (e instanceof TikTokWall) throw new Challenge('TikTok', e.message, NEXT)
        if (e instanceof Challenge) throw e
        opt.log(
          `TikTok: ${it.id} · comments could not be read (${(e as Error).message}); counts kept.`,
        )
      }
    }
    posts.push(toPost(profile, it, comments))
    if (known && opt.range === 'due') rechecked++
    else opt.log(`TikTok: ${it.id} · ${comments.length} comments read`)
  }
  if (rechecked) opt.log(`TikTok: fresh numbers for ${rechecked} older posts.`)
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
