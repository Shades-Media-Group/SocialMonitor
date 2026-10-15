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
