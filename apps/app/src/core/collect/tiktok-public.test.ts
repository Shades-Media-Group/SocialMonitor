import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db.ts'
import { addBrand, listProfiles, savePost } from '../store.ts'
import type { CollectOptions } from './index.ts'
import { Challenge } from './browser.ts'
import type { Get } from './tiktok-public.ts'
import {
  TikTokWall,
  checkBody,
  isWafChallenge,
  nodeGet,
  parseJson,
  publicComments,
  publicPosts,
  rehydrationIn,
  secUidFrom,
  toComment,
} from './tiktok-public.ts'
import { readPublic } from './tiktok.ts'

// Real logged-out answers for the public profile @moldtelecom.md, trimmed to the fields the
// collector reads. Commenters other than the brand carry placeholder handles.
const fx = (name: string) =>
  readFileSync(new URL(`./fixtures/tiktok/${name}`, import.meta.url), 'utf8')
const WAF = fx('waf.html')
const PROFILE = fx('profile.html')
const ITEMS = fx('item_list.json')
const COMMENTS = fx('comment_list.json')
const REPLIES = fx('comment_reply.json')
const POST = '7696861285295656213'
const PARENT = '7697145192738276103'

/** A `Get` that answers from the fixtures, as the logged-out page's fetch would. */
function fixtureGet(over: { comments?: string } = {}) {
  const urls: string[] = []
  const get: Get = async (url) => {
    urls.push(url)
    if (url.includes('/api/creator/item_list/')) return checkBody(ITEMS)
    if (url.includes('/api/comment/list/reply/'))
      return url.includes(`comment_id=${PARENT}`) ? REPLIES : '{"comments":[],"has_more":0}'
    if (url.includes('/api/comment/list/'))
      return checkBody(
        url.includes(`aweme_id=${POST}`)
          ? (over.comments ?? COMMENTS)
          : '{"comments":null,"has_more":0}',
      )
    if (url.includes('/@moldtelecom.md')) return checkBody(PROFILE)
    throw new Error(`unexpected ${url}`)
  }
  return { get, urls }
}

function setup() {
  const db = openDb(':memory:')
  const brand = addBrand(db, 'Moldtelecom', ['https://www.tiktok.com/@moldtelecom.md'])
  const profile = listProfiles(db, brand.id).find((p) => p.network === 'tiktok')!
  const lines: string[] = []
  const opt: CollectOptions = {
    range: 'all',
    limit: 3,
    known: new Set(),
    due: new Map(),
    comments: true,
    maxComments: 300,
    usedSession: false,
    log: (l) => lines.push(l),
  }
  return { db, profile, opt, lines }
}

describe("TikTok's firewall page", () => {
  it('is recognised in place of the profile or the data', () => {
    expect(isWafChallenge(WAF)).toBe(true)
    expect(isWafChallenge('<html><body>Please wait...</body></html>')).toBe(true)
    expect(isWafChallenge(PROFILE)).toBe(false)
    expect(isWafChallenge(ITEMS)).toBe(false)
    expect(isWafChallenge(COMMENTS)).toBe(false)
  })

  it('stops a read with TikTokWall, not a JSON error', () => {
    expect(() => checkBody(WAF)).toThrow(TikTokWall)
    expect(() => parseJson(WAF)).toThrow(TikTokWall)
    expect(() => parseJson(PROFILE)).toThrow('TikTok sent a page instead of data')
    expect(() => checkBody('  ')).toThrow('TikTok sent nothing back')
  })

  describe('from Node, with no cookies', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })
    it('names the firewall whether it answers 200 or 403', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      for (const status of [200, 403]) {
        const fetch = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(
            new Response(WAF, { status, headers: { 'content-type': 'text/html' } }),
          )
        const read = nodeGet('https://www.tiktok.com/@moldtelecom.md')
        const done = expect(read).rejects.toBeInstanceOf(TikTokWall)
        await vi.runAllTimersAsync()
        await done
        // Never with cookies: the request carries no session at all.
        expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' })
        fetch.mockRestore()
      }
    })
  })
})

describe('the public profile page', () => {
  it('gives the secUid from its rehydration JSON', () => {
    const secUid = secUidFrom(rehydrationIn(PROFILE))
    expect(secUid).toMatch(/^MS4wLjABAAAA/)
    expect(rehydrationIn(WAF)).toBeNull()
    expect(secUidFrom(null)).toBeUndefined()
  })
})

describe('posts and comments through a Get', () => {
  it('reads the profile, then the post list with that secUid', async () => {
    const { get, urls } = fixtureGet()
    const items = await publicPosts('moldtelecom.md', 3, undefined, get)
    expect(items.map((i) => i.id)).toEqual(['7697258124079615252', '7697243915866459413', POST])
    const secUid = secUidFrom(rehydrationIn(PROFILE))!
    expect(urls[0]).toBe('https://www.tiktok.com/@moldtelecom.md')
    expect(urls[1]).toContain(`secUid=${encodeURIComponent(secUid)}`)
    // Known already (from the open page): the profile is not fetched again.
    const again = fixtureGet()
    await publicPosts('moldtelecom.md', 3, undefined, again.get, secUid)
    expect(again.urls.every((u) => u.includes('/api/creator/item_list/'))).toBe(true)
  })

  it('reads every comment, the replies inside the list and the rest from the reply list', async () => {
    const { get, urls } = fixtureGet()
    const all = [...(await publicComments(POST, 300, get)).values()].map(toComment)
    // 4 comments, each with one reply inline; the first has 3 replies, so its reply list is read.
    expect(all).toHaveLength(10)
    expect(all.filter((c) => !c.parent_ext_id)).toHaveLength(4)
    expect(all.filter((c) => c.parent_ext_id === PARENT)).toHaveLength(3)
    expect(urls.filter((u) => u.includes('/reply/'))).toEqual([
      expect.stringContaining(`comment_id=${PARENT}`),
    ])
    const brandReply = all.find((c) => c.ext_id === '7697189699925279494')!
    expect(brandReply).toMatchObject({
      parent_ext_id: PARENT,
      author: 'moldtelecom.md',
      author_url: 'https://www.tiktok.com/@moldtelecom.md',
      author_avatar: 'https://p16-sign-va.tiktokcdn.com/obj/avatar.jpeg',
      posted_at: new Date(1792141670 * 1000).toISOString(),
    })
    expect(all.find((c) => c.ext_id === PARENT)).toMatchObject({
      parent_ext_id: null,
      author: 'fan_1',
    })
  })

  it('stops at the firewall instead of reading it as an empty list', async () => {
    const { get } = fixtureGet({ comments: WAF })
    await expect(publicComments(POST, 300, get)).rejects.toBeInstanceOf(TikTokWall)
  })
})

describe('a logged-out TikTok read', () => {
  it('saves counts, a Statistics row and the comments for the AI to sort', async () => {
    const { db, profile, opt } = setup()
    const { get } = fixtureGet()
    const posts = await readPublic(profile, opt, get, true)
    expect(posts).toHaveLength(3)
    const post = posts.find((p) => p.ext_id === POST)!
    expect(post).toMatchObject({
      url: `https://www.tiktok.com/@moldtelecom.md/video/${POST}`,
      kind: 'video',
      likes: 238,
      comments_count: 17,
      shares: 12,
      views: 3998,
    })
    expect(post.comments).toHaveLength(10)
    expect(opt.usedSession).toBe(false)

    for (const p of posts) savePost(db, profile, p)
    const row = db.prepare('SELECT id, likes, views FROM posts WHERE ext_id = ?').get(POST) as {
      id: number
      likes: number
      views: number
    }
    expect(row).toMatchObject({ likes: 238, views: 3998 })
    expect(
      db
        .prepare('SELECT likes, comments, shares, views FROM post_metrics WHERE post_id = ?')
        .all(row.id),
    ).toEqual([{ likes: 238, comments: 17, shares: 12, views: 3998 }])
    const c = db
      .prepare(
        'SELECT count(*) n, sum(parent_ext_id IS NOT NULL) replies, sum(label IS NULL) unsorted FROM comments WHERE post_id = ?',
      )
      .get(row.id) as { n: number; replies: number; unsorted: number }
    expect(c).toEqual({ n: 10, replies: 6, unsorted: 10 })
  })

  it("stops the update at TikTok's check on the last route, and hands it on before that", async () => {
    const { profile, opt } = setup()
    const { get } = fixtureGet({ comments: WAF })
    await expect(readPublic(profile, opt, get, true)).rejects.toBeInstanceOf(Challenge)
    await expect(readPublic(profile, opt, get, false)).rejects.toBeInstanceOf(TikTokWall)
  })

  it('keeps the counts when one comment list fails for another reason', async () => {
    const { profile, opt, lines } = setup()
    const { get } = fixtureGet({ comments: '{"comments":' })
    const posts = await readPublic(profile, opt, get, true)
    expect(posts.find((p) => p.ext_id === POST)).toMatchObject({ likes: 238, comments: [] })
    expect(lines.some((l) => l.includes('comments could not be read'))).toBe(true)
  })
})
