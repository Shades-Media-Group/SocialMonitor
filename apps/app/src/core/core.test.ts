import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import {
  addBrand,
  labelCounts,
  listComments,
  parseProfile,
  savePost,
  setVerdict,
  listProfiles,
} from './store.ts'
import { parseVerdicts } from './analyze.ts'
import { nextRun } from './schedule.ts'
import { exportAll, importAll } from './transfer.ts'
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
