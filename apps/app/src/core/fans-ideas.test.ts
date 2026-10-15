import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import {
  addBrand,
  listComments,
  listProfiles,
  savePost,
  setSentiment,
  setVerdict,
} from './store.ts'
import { fansAndCritics } from './insights.ts'
import { localDay, localHour, rankSlots } from './timing.ts'
import { ideaInput, latestIdeas, parseIdeas } from './ideas.ts'
import type { Label } from './types.ts'
import { toComment } from './collect/tiktok-public.ts'

const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString()

describe('fans and critics', () => {
  it('ranks people who comment mostly well or mostly badly, with reach only when known', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    const said: [string, string, Label, number | null][] = [
      ['ana', 'a1', 'praise', 5200],
      ['Ana', 'a2', 'praise', null],
      ['ana', 'a3', 'question', null],
      ['bob', 'b1', 'complaint', null],
      ['bob', 'b2', 'complaint', null],
      ['bob', 'b3', 'praise', null],
      ['cid', 'c1', 'praise', null], // once only: not a fan yet
      ['dan', 'd1', 'praise', null], // even: neither
      ['dan', 'd2', 'complaint', null],
      ['eve', 'e1', 'praise', null], // rated negative by a person: the rating wins
      ['eve', 'e2', 'praise', null],
      ['test', 't1', 'praise', null], // the brand itself
      ['test', 't2', 'praise', null],
    ]
    savePost(db, profile!, {
      ext_id: '1',
      url: 'u',
      posted_at: ago(3),
      kind: 'video',
      caption: 'c',
      thumb_url: null,
      likes: 1,
      comments_count: said.length,
      shares: 0,
      views: 9,
      comments: said.map(([author, ext_id, , followers], i) => ({
        ext_id,
        parent_ext_id: null,
        author,
        text: 'x',
        likes: 0,
        posted_at: ago(i % 2 ? 1 : 10),
        author_followers: followers,
      })),
    })
    for (const c of listComments(db, { limit: 100 })) {
      setVerdict(db, c.id, said.find((s) => s[1] === c.ext_id)![2], false, '')
      if (c.author === 'eve') setSentiment(db, c.id, 'negative', null, 'you')
    }
    const { fans, critics, weeks } = fansAndCritics(db, { brandId: brand.id, days: 30 })
    expect(fans.map((p) => p.author)).toEqual(['Ana'])
    expect(fans[0]).toMatchObject({ n: 3, positive: 2, negative: 0, followers: 5200 })
    expect(fans[0]!.networks).toEqual(['tiktok'])
    expect(fans[0]!.weeks).toHaveLength(weeks)
    expect(fans[0]!.weeks.reduce((a, b) => a + b, 0)).toBe(3)
    expect(critics.map((p) => p.author)).toEqual(['bob', 'eve'])
    expect(critics[0]).toMatchObject({ negative: 2, positive: 1, followers: null })
    expect(listComments(db, { author: 'ANA' })).toHaveLength(3)
  })
})

describe('reach', () => {
  it('keeps a TikTok follower count only when TikTok gives a real one', () => {
    const c = (follower_count?: number) =>
      toComment({ cid: '1', user: { unique_id: 'a', follower_count } }).author_followers
    expect(c(12400)).toBe(12400)
    expect(c(0)).toBeNull()
    expect(c()).toBeNull()
  })
})

describe('best hour to post', () => {
  const post = (day: number, hour: number, likes: number, views: number | null) => ({
    posted_at: new Date(2026, 0, day, hour, 15).toISOString(),
    likes,
    comments_count: 0,
    shares: 0,
    views,
  })

  it('ranks hours by engagement per view and leaves out hours with too few posts', () => {
    const posts = [
      ...[5, 6, 7, 8].map((d) => post(d, 18, 50, 1000)), // 5%
      ...[5, 6, 7, 8].map((d) => post(d, 9, 10, 1000)), // 1%
      ...[5, 6, 7].map((d) => post(d, 12, 30, 1000)), // 3%
      post(9, 3, 900, 1000), // one lucky post at 3:00
      post(10, 3, 900, 1000),
    ]
    const r = rankSlots(posts, localHour)
    expect(r.metric).toBe('rate')
    expect(r.total).toBe(13)
    expect(r.enough).toBe(true)
    expect(r.slots.map((s) => s.key)).toEqual([18, 12, 9])
    expect(r.slots[0]!.score).toBeCloseTo(0.05)
  })

  it('falls back to interactions per post without views, and says when there is too little', () => {
    const posts = [5, 6, 7, 12, 13, 14].map((d) => post(d, d < 10 ? 8 : 20, d, null))
    const r = rankSlots(posts, localHour)
    expect(r.metric).toBe('interactions')
    expect(r.slots.map((s) => s.key)).toEqual([20, 8])
    expect(r.enough).toBe(false)
    expect(rankSlots(posts, localDay, { min: 1 }).slots.length).toBeGreaterThan(0)
  })
})

describe('post ideas', () => {
  it('reads valid idea lines and drops the rest', () => {
    const ideas = parseIdeas(
      [
        '1. Behind the scenes of the new store|TikTok video|Tuesday|18|Store tours drew 4.1% engagement, twice the average',
        '- 5 tips for setting up the router|Instagram reel|fri|9:00|People asked 12 times how to set it up|again',
        'Nothing useful here',
        'A topic|Facebook post|Someday|10|bad day',
        'A topic|Facebook post|Monday|25|bad hour',
      ].join('\n'),
    )
    expect(ideas).toEqual([
      {
        topic: 'Behind the scenes of the new store',
        format: 'TikTok video',
        day: 2,
        hour: 18,
        why: 'Store tours drew 4.1% engagement, twice the average',
      },
      {
        topic: '5 tips for setting up the router',
        format: 'Instagram reel',
        day: 5,
        hour: 9,
        why: 'People asked 12 times how to set it up|again',
      },
    ])
    expect(parseIdeas(Array(8).fill('T|F|Monday|9|why').join('\n'))).toHaveLength(5)
  })

  it('needs a few posts before asking, and gives Claude compact lines', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    const add = (i: number) =>
      savePost(db, profile!, {
        ext_id: String(i),
        url: `u${i}`,
        posted_at: ago(i + 1),
        kind: 'video',
        caption: `caption ${i}`,
        thumb_url: null,
        likes: i * 10,
        comments_count: 1,
        shares: 0,
        views: 1000,
        comments: [
          {
            ext_id: `c${i}`,
            parent_ext_id: null,
            author: 'x',
            text: `when is it back ${i}?`,
            likes: 0,
            posted_at: ago(i),
          },
        ],
      })
    for (let i = 0; i < 4; i++) add(i)
    expect(ideaInput(db, brand.id)).toBeNull()
    add(4)
    for (const c of listComments(db)) setVerdict(db, c.id, 'question', true, '')
    const input = ideaInput(db, brand.id)!
    expect(input.split('\n')[1]).toMatch(/^best\|tiktok video\|\w{3} \d+:00\|40 likes/)
    expect(input).toContain('question|when is it back')
    expect(latestIdeas(db, brand.id)).toBeNull()
  })
})
