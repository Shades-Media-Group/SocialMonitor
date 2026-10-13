import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import {
  addBrand,
  labelCounts,
  listComments,
  parseProfile,
  savePost,
  setVerdict,
  setSentiment,
  listProfiles,
} from './store.ts'
import { parseVerdicts } from './analyze.ts'
import { nextRun } from './schedule.ts'
import { exportAll, importAll } from './transfer.ts'
import { compare, watched } from './insights.ts'
import { badCount, setAlerts } from './alerts.ts'
import { knownPostIds } from './store.ts'
import { setTrackers } from './store.ts'
import type { Schedule } from './types.ts'

describe('profile links', () => {
  it('reads the network and handle from each kind of link', () => {
    expect(parseProfile('https://www.tiktok.com/@example.shop?lang=ro')).toEqual({
      network: 'tiktok',
      handle: 'example.shop',
    })
    expect(parseProfile('https://instagram.com/brand_sa/')).toEqual({
      network: 'instagram',
      handle: 'brand_sa',
    })
    expect(parseProfile('https://m.facebook.com/BrandSA')).toEqual({
      network: 'facebook',
      handle: 'BrandSA',
    })
    expect(() => parseProfile('https://example.com/x')).toThrow()
  })
})

describe('AI answers', () => {
  it('keeps valid lines and drops the rest', () => {
    const v = parseVerdicts(
      '1|complaint|1|internet down for three days\n2|Praise|0|thanks\nnoise\n3|weird|1|x',
    )
    expect(v.get(1)).toEqual({
      label: 'complaint',
      needsReply: true,
      reason: 'internet down for three days',
    })
    expect(v.get(2)?.label).toBe('praise')
    expect(v.has(3)).toBe(false)
  })

  it('reads urgency and feeling when given, and still reads the older lines', () => {
    const v = parseVerdicts('1|complaint|1|2|angry|no internet for a week|again\n2|praise|0|thanks')
    expect(v.get(1)).toEqual({
      label: 'complaint',
      needsReply: true,
      urgency: 2,
      emotion: 'angry',
      reason: 'no internet for a week|again',
    })
    expect(v.get(2)).toEqual({ label: 'praise', needsReply: false, reason: 'thanks' })
    const k = parseVerdicts(
      '1|complaint|1|1|frustrated|slow-internet|drops every evening\n2|praise|0|0|happy|-|thanks',
    )
    expect(k.get(1)).toMatchObject({ category: 'slow-internet', reason: 'drops every evening' })
    expect(k.get(2)?.category).toBeUndefined()
  })
})

describe('schedules', () => {
  const base: Schedule = {
    id: 1,
    brand_id: 1,
    kind: 'times',
    every_hours: null,
    times: ['09:00', '18:00'],
    networks: ['tiktok'],
    range: 'new',
    enabled: 1,
    next_run_at: null,
  }
  it('picks the next set time, a few minutes late at most', () => {
    const from = new Date(2026, 9, 12, 10, 0)
    const next = nextRun(base, from)!
    expect(next.getHours()).toBe(18)
    expect(next.getMinutes()).toBeLessThanOrEqual(12)
  })
  it('rolls over to tomorrow', () => {
    const next = nextRun(base, new Date(2026, 9, 12, 19, 0))!
    expect(next.getDate()).toBe(13)
    expect(next.getHours()).toBe(9)
  })
})

describe('storage', () => {
  it('keeps labels when a post is read again, and survives export and import', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    const post = {
      ext_id: '1',
      url: 'u',
      posted_at: null,
      kind: 'video',
      caption: 'c',
      thumb_url: null,
      likes: 1,
      comments_count: 1,
      shares: 0,
      views: 9,
      comments: [
        {
          ext_id: 'a',
          parent_ext_id: null,
          author: 'x',
          text: 'bad service',
          likes: 3,
          posted_at: null,
        },
      ],
    }
    savePost(db, profile!, post)
    const [c] = listComments(db)
    setVerdict(db, c!.id, 'complaint', true, 'service')
    expect(savePost(db, profile!, post).newComments).toBe(0)
    expect(listComments(db)[0]!.label).toBe('complaint')
    expect(labelCounts(db, brand.id).complaint).toBe(1)

    const other = openDb(':memory:')
    importAll(other, exportAll(db))
    importAll(other, exportAll(db))
    expect(listComments(other)).toHaveLength(1)
    expect(listComments(other)[0]!.label).toBe('complaint')
  })
})

describe('reply queue', () => {
  it('closes a comment the brand answered on the network, and flags the late ones', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    const comment = (ext_id: string, author: string, parent: string | null, at: string) => ({
      ext_id,
      parent_ext_id: parent,
      author,
      text: 'hi',
      likes: 0,
      posted_at: at,
    })
    const post = {
      ext_id: '1',
      url: 'u',
      posted_at: null,
      kind: 'video',
      caption: 'c',
      thumb_url: null,
      likes: 1,
      comments_count: 3,
      shares: 0,
      views: 9,
      comments: [
        comment('a', 'x', null, '2026-01-01T10:00:00Z'),
        comment('b', 'y', null, '2026-01-01T10:00:00Z'),
      ],
    }
    savePost(db, profile!, post)
    for (const c of listComments(db)) setVerdict(db, c.id, 'question', true, 'asks')
    expect(listComments(db, { overdue: true })).toHaveLength(2)

    post.comments.push(comment('r', 'TEST', 'a', '2026-01-01T13:00:00Z'))
    savePost(db, profile!, post)
    const a = listComments(db).find((c) => c.ext_id === 'a')!
    expect(a.reply_status).toBe('done')
    expect(a.answered_by).toBe('brand')
    expect(a.answered_at).toBe('2026-01-01T13:00:00Z')
    expect(listComments(db, { overdue: true }).map((c) => c.ext_id)).toEqual(['b'])
  })
})

describe('words to watch', () => {
  it('keeps clean words and counts mentions in any alphabet, ignoring case', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    const list = setTrackers(db, brand.id, [
      { term: 'VoLTE', kind: 'topic' },
      { term: 'volte', kind: 'product' },
      { term: 'x', kind: 'product' },
      { term: 'Интернет', kind: 'weird' },
    ])
    expect(list).toEqual([
      { term: 'VoLTE', kind: 'topic' },
      { term: 'Интернет', kind: 'topic' },
    ])
    savePost(db, profile!, {
      ext_id: '1',
      url: 'u',
      posted_at: null,
      kind: 'video',
      caption: 'c',
      thumb_url: null,
      likes: 0,
      comments_count: 2,
      shares: 0,
      views: 0,
      comments: [
        {
          ext_id: 'a',
          parent_ext_id: null,
          author: 'x',
          text: 'когда volte?',
          likes: 0,
          posted_at: null,
        },
        {
          ext_id: 'b',
          parent_ext_id: null,
          author: 'y',
          text: 'ИНТЕРНЕТ не работает',
          likes: 0,
          posted_at: null,
        },
      ],
    })
    const [c] = listComments(db).filter((r) => r.ext_id === 'b')
    setVerdict(db, c!.id, 'complaint', true, 'down')
    expect(watched(db, { brandId: brand.id }, list)).toEqual([
      { term: 'VoLTE', kind: 'topic', n: 1, before: null, complaints: 0, praise: 0 },
      { term: 'Интернет', kind: 'topic', n: 1, before: null, complaints: 1, praise: 0 },
    ])
  })
})

describe('negative comments report', () => {
  it('keeps valid distinct addresses and counts only negative customer comments', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    expect(
      setAlerts(db, brand.id, ['A@x.com', 'a@x.com', 'nope', 'b@y.org', ' '], 1, 'ro'),
    ).toEqual({ emails: ['a@x.com', 'b@y.org'], auto: true })
    const [profile] = listProfiles(db, brand.id)
    const c = (ext_id: string, author: string, text: string) => ({
      ext_id,
      parent_ext_id: null,
      author,
      text,
      likes: 0,
      posted_at: null,
    })
    savePost(db, profile!, {
      ext_id: '1',
      url: 'u',
      posted_at: null,
      kind: 'video',
      caption: 'c',
      thumb_url: null,
      likes: 0,
      comments_count: 3,
      shares: 0,
      views: 0,
      comments: [c('a', 'x', 'bad'), c('b', 'y', 'great'), c('r', 'test', 'sorry')],
    })
    for (const row of listComments(db))
      setVerdict(db, row.id, row.text === 'great' ? 'praise' : 'complaint', false, '')
    expect(badCount(db, brand.id)).toBe(1)
    expect(badCount(db, brand.id, '2999-01-01')).toBe(0)
  })
})

describe('posts read before photos were kept', () => {
  it('are read once more, then skipped', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    db.prepare(
      `INSERT INTO posts (profile_id, network, ext_id, url, kind, caption, comments_count, fetched_at)
       VALUES (?, 'tiktok', 'old', 'u', 'video', '', 4, '2026-01-01'),
              (?, 'tiktok', 'quiet', 'u', 'video', '', 0, '2026-01-01')`,
    ).run(profile!.id, profile!.id)
    expect([...knownPostIds(db, profile!.id)]).toEqual(['quiet'])
    savePost(db, profile!, {
      ext_id: 'old',
      url: 'u',
      posted_at: null,
      kind: 'video',
      caption: '',
      thumb_url: null,
      likes: 0,
      comments_count: 4,
      shares: 0,
      views: 0,
      comments: [
        {
          ext_id: 'a',
          parent_ext_id: null,
          author: 'x',
          text: '',
          likes: 0,
          posted_at: null,
          author_avatar: '/media/tiktok/people/x.jpg',
          media_url: '/media/tiktok/comments/a.jpg',
        },
      ],
    })
    expect(knownPostIds(db, profile!.id).has('old')).toBe(true)
    const [c] = listComments(db)
    expect([c!.author_avatar, c!.media_url]).toEqual([
      '/media/tiktok/people/x.jpg',
      '/media/tiktok/comments/a.jpg',
    ])
  })
})

describe('threads under a filter', () => {
  it('returns the replies under each comment found, even when they do not match', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    const c = (ext_id: string, parent: string | null, author: string) => ({
      ext_id,
      parent_ext_id: parent,
      author,
      text: ext_id,
      likes: 0,
      posted_at: null,
    })
    savePost(db, profile!, {
      ext_id: '1',
      url: 'u',
      posted_at: null,
      kind: 'video',
      caption: '',
      thumb_url: null,
      likes: 0,
      comments_count: 3,
      shares: 0,
      views: 0,
      comments: [c('q', null, 'x'), c('r', 'q', 'test'), c('other', null, 'y')],
    })
    const q = listComments(db).find((r) => r.ext_id === 'q')!
    setVerdict(db, q.id, 'question', true, '')
    expect(listComments(db, { label: 'question' }).map((r) => r.ext_id)).toEqual(['q'])
    expect(listComments(db, { label: 'question', threads: true }).map((r) => r.ext_id)).toEqual([
      'q',
      'r',
    ])
  })
})

describe('TikTok sign-in hand-back', () => {
  it('returns people only to this computer or our own domain', async () => {
    const { DASHBOARD_ORIGIN } = await import('./tiktok-api.ts')
    for (const ok of [
      'http://127.0.0.1:4400',
      'http://localhost:4400',
      'https://app.socialmonitor.shades.md',
    ])
      expect(DASHBOARD_ORIGIN.test(ok)).toBe(true)
    for (const bad of [
      'https://evil.com',
      'http://app.socialmonitor.shades.md',
      'https://socialmonitor.shades.md.evil.com',
      'http://127.0.0.1.evil.com',
    ])
      expect(DASHBOARD_ORIGIN.test(bad)).toBe(false)
  })
})

describe('post history and re-check tiers', () => {
  it('keeps a row only when numbers change, and re-checks by age', async () => {
    const { duePosts, postMetrics } = await import('./store.ts')
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString()
    const post = (ext_id: string, age: number, likes: number) => ({
      ext_id,
      url: 'u',
      posted_at: day(age),
      kind: 'video',
      caption: '',
      thumb_url: null,
      likes,
      comments_count: 0,
      shares: 0,
      views: 10,
      comments: [],
    })
    const { post: p } = savePost(db, profile!, post('fresh', 3, 5))
    savePost(db, profile!, post('fresh', 3, 5))
    // Reads are minutes apart in real use; date the first row back so the next is distinct.
    db.prepare('UPDATE post_metrics SET at = ?').run(day(1))
    savePost(db, profile!, post('fresh', 3, 9))
    expect(postMetrics(db, p.id).map((m) => m.likes)).toEqual([5, 9])

    savePost(db, profile!, post('month', 20, 1))
    savePost(db, profile!, post('old', 200, 1))
    const read = (ext: string, ago: number) =>
      db.prepare('UPDATE posts SET metrics_at = ? WHERE ext_id = ?').run(day(ago), ext)
    read('month', 2)
    read('old', 10)
    expect(duePosts(db, profile!.id).map((d) => d.ext_id)).toEqual(['fresh'])
    read('month', 8)
    read('old', 40)
    expect(
      duePosts(db, profile!.id)
        .map((d) => d.ext_id)
        .sort(),
    ).toEqual(['fresh', 'month', 'old'])
    expect(duePosts(db, profile!.id, 1)).toHaveLength(1)
  })
})

describe('brands compared', () => {
  it('sums each brand in the window and keeps to the brands asked for', () => {
    const db = openDb(':memory:')
    const a = addBrand(db, 'Alpha', ['https://www.tiktok.com/@alpha'])
    const b = addBrand(db, 'Beta', ['https://www.tiktok.com/@beta'])
    const today = new Date().toISOString()
    const c = (ext_id: string, author: string, text: string, posted_at = today) => ({
      ext_id,
      parent_ext_id: null,
      author,
      text,
      likes: 0,
      posted_at,
    })
    const post = (brandId: number, ext_id: string, comments: ReturnType<typeof c>[]) =>
      savePost(db, listProfiles(db, brandId)[0]!, {
        ext_id,
        url: 'u',
        posted_at: today,
        kind: 'video',
        caption: '',
        thumb_url: null,
        likes: 10,
        comments_count: comments.length,
        shares: 0,
        views: 200,
        comments,
      })
    post(a.id, 'a1', [
      c('1', 'x', 'broken'),
      c('2', 'y', 'love it'),
      c('3', 'z', 'how much?'),
      c('4', 'alpha', 'thanks'),
      c('old', 'w', 'long ago', '2020-01-01T00:00:00Z'),
    ])
    post(b.id, 'b1', [c('5', 'v', 'meh')])
    const id = (ext: string) => listComments(db).find((r) => r.ext_id === ext)!.id
    setVerdict(db, id('1'), 'complaint', true, '')
    setVerdict(db, id('2'), 'praise', false, '')
    setVerdict(db, id('3'), 'question', true, '')
    setSentiment(db, id('1'), 'negative', null, 'ai')
    setSentiment(db, id('2'), 'positive', null, 'ai')

    const [alpha, ...rest] = compare(db, 7, [a.id])
    expect(rest).toEqual([])
    expect(alpha).toMatchObject({
      name: 'Alpha',
      comments: 3, // the brand's own reply and the old comment stay out
      complaints: 1,
      questions: 1,
      praise: 1,
      positive_share: 0.5,
      negative_share: 0.5,
      posts: 1,
      likes: 10,
      reach: 200,
      engagement_rate: (10 + 5) / 200,
      share_of_voice: 1,
    })
    expect(alpha!.per_day).toHaveLength(7)
    expect(alpha!.per_day.at(-1)).toEqual({ day: today.slice(0, 10), n: 3 })
    expect(compare(db, 7, []).length).toBe(0)
    expect(compare(db, 7).map((r) => r.share_of_voice)).toEqual([0.75, 0.25])
  })
})
