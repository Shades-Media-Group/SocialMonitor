import type { Page } from 'playwright'
import type { CollectedComment, CollectedPost, Profile } from '../types.ts'
import type { CollectOptions, Collector } from './index.ts'
import { Challenge, capture, findAll, isoFromUnix, num, pause, readScroll } from './browser.ts'

interface Story {
  post_id?: string
  url?: string
  creation_time?: number
  message?: { text?: string }
  comet_sections?: unknown
}
interface RawComment {
  __typename: 'Comment'
  legacy_fbid?: string
  id: string
  body?: { text?: string }
  author?: { name?: string }
  created_time?: number
  comment_parent?: { legacy_fbid?: string } | null
  feedback?: { reactors?: { count?: number }; reactors_count?: number }
}

const isGraphql = (u: string) => u.includes('/api/graphql')

async function checkWall(page: Page) {
  const u = page.url()
  if (u.includes('/checkpoint') || u.includes('/two_step_verification'))
    throw new Challenge('Facebook', 'a security check appeared')
}

/**
 * Facebook: posts and comments come from the GraphQL responses the page loads while it is
 * read. Facebook shows almost nothing signed out, so this network needs a signed-in session.
 */
export const facebook: Collector = {
  network: 'facebook',
  async collect(page: Page, profile: Profile, opt: CollectOptions) {
    const signedIn = (await page.context().cookies('https://www.facebook.com')).some(
      (c) => c.name === 'c_user' && c.value,
    )
    if (!signedIn) throw new Challenge('Facebook', 'not signed in')
    if (opt.comments) opt.usedSession = true

    const feed = await capture(page, isGraphql, async () => {
      await page.goto(profile.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await pause(4000, 7000)
      await checkWall(page)
      await readScroll(page, Math.min(10, 2 + opt.limit))
    })
    const stories = new Map<string, Story>()
    for (const s of findAll<Story>(
      feed,
      (o) => typeof o.post_id === 'string' && typeof o.url === 'string' && 'comet_sections' in o,
    ))
      if (!stories.has(s.post_id!)) stories.set(s.post_id!, s)
    if (!stories.size) opt.log(`Facebook ${profile.handle}: no posts found on the page.`)

    const list = [...stories.values()]
      .map((s) => ({
        s,
        time:
          findAll<{ creation_time: number }>(s, (o) => typeof o.creation_time === 'number')[0]
            ?.creation_time ?? 0,
      }))
      .sort((a, b) => b.time - a.time)
    const picked = (
      opt.range === 'new' ? list.filter((x) => !opt.known.has(x.s.post_id!)) : list
    ).slice(0, opt.limit)

    const posts: CollectedPost[] = []
    for (const { s, time } of picked) {
      const text =
        findAll<{ text: string }>(s, (o) => typeof o.text === 'string' && 'ranges' in o)[0]?.text ??
        ''
      const counts =
        findAll<Record<string, unknown>>(
          s,
          (o) => 'reaction_count' in o || 'i18n_reaction_count' in o,
        )[0] ?? {}
      const comments = opt.comments ? await readComments(page, s.url!, opt) : []
      posts.push({
        ext_id: s.post_id!,
        url: s.url!,
        posted_at: isoFromUnix(time),
        kind: 'post',
        caption: text,
        thumb_url:
          findAll<{ uri: string }>(
            s,
            (o) => typeof o.uri === 'string' && /scontent/.test(o.uri as string),
          )[0]?.uri ?? null,
        likes: num(
          (counts.reaction_count as { count?: number })?.count ?? counts.i18n_reaction_count,
        ),
        comments_count: num(
          findAll<{ total_count: number }>(s, (o) => typeof o.total_count === 'number')[0]
            ?.total_count,
        ),
        shares: num(
          findAll<{ share_count: { count: number } }>(
            s,
            (o) => typeof (o.share_count as { count?: number })?.count === 'number',
          )[0]?.share_count.count,
        ),
        views: null,
        comments,
      })
      opt.log(`Facebook: ${s.post_id} · ${comments.length} comments read`)
    }
    return posts
  },
}

async function readComments(
  page: Page,
  url: string,
  opt: CollectOptions,
): Promise<CollectedComment[]> {
  await pause()
  const raw = await capture(page, isGraphql, async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await pause(3000, 6000)
    await checkWall(page)
    await readScroll(page, 3)
  })
  const out = new Map<string, CollectedComment>()
  for (const c of findAll<RawComment>(
    raw,
    (o) => o.__typename === 'Comment' && typeof (o.body as { text?: string })?.text === 'string',
  )) {
    const id = c.legacy_fbid ?? c.id
    if (out.has(id) || out.size >= opt.maxComments) continue
    out.set(id, {
      ext_id: id,
      parent_ext_id: c.comment_parent?.legacy_fbid ?? null,
      author: c.author?.name ?? 'unknown',
      text: c.body!.text!,
      likes: num(c.feedback?.reactors?.count ?? c.feedback?.reactors_count),
      posted_at: isoFromUnix(c.created_time),
    })
  }
  return [...out.values()]
}
