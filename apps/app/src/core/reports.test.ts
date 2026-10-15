import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { addBrand, listProfiles, savePost } from './store.ts'
import { contrast, textOn, validColor } from './color.ts'
import { sniff } from './branding.ts'
import { postGrowth, rankGrowth } from './insights.ts'

describe('report branding', () => {
  it('accepts hex colours only', () => {
    expect(validColor('#1A6BD6')).toBe('#1a6bd6')
    expect(validColor('abc')).toBe('#aabbcc')
    expect(validColor(' #0f0 ')).toBe('#00ff00')
    for (const bad of ['', 'red', '#12345', '#1234567', '#ggg000', 'rgb(0,0,0)', null, 42])
      expect(validColor(bad)).toBeNull()
  })

  it('puts text on the accent only where it reads at 4.5:1', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21)
    expect(textOn('#0a2a6b')).toBe('#ffffff')
    expect(textOn('#ffe600')).toBe('#16181d')
    // A mid grey reads with neither paper nor ink: rules and marks only.
    expect(textOn('#7c7c7c')).toBeNull()
    for (const c of ['#0a2a6b', '#ffe600', '#f9000a', '#00a86b', '#767676']) {
      const on = textOn(c)
      if (on) expect(contrast(on, c)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('knows a logo by its bytes, not its name', () => {
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png')
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniff(Buffer.from('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'))).toBe('svg')
    expect(sniff(Buffer.from(String.fromCharCode(0xfeff) + '<!-- logo --><svg xmlns="x">'))).toBe(
      'svg',
    )
    expect(sniff(Buffer.from('<html><svg></svg></html>'))).toBeNull()
    expect(sniff(Buffer.from('GIF89a'))).toBeNull()
  })
})

describe('posts that grew most', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString()
  const read = (post_id: number, day: number, likes: number, views: number | null = null) => ({
    post_id,
    at: at(day),
    likes,
    comments: 1,
    shares: 0,
    views,
  })

  it('measures between real readings and never guesses from one', () => {
    const rows = [
      // Read before the period and in it: grew 40 interactions and 900 views.
      read(1, 1, 10, 100),
      read(1, 6, 50, 1000),
      // Two readings inside the period: grew 5; no views the second time.
      read(2, 8, 20, 50),
      read(2, 9, 25, null),
      // One reading in the period only: no growth to show.
      read(3, 9, 500, 9000),
      // Read only before the period: not part of it.
      read(4, 1, 1, 1),
      read(4, 2, 99, 99),
      // Lost likes: not growth.
      read(5, 1, 30),
      read(5, 8, 20),
    ]
    const g = rankGrowth(rows, at(5))
    expect(g.interactions.map((x) => [x.post_id, x.gained, x.now])).toEqual([
      [1, 40, 51],
      [2, 5, 26],
    ])
    expect(g.views.map((x) => [x.post_id, x.gained, x.now])).toEqual([[1, 900, 1000]])
    expect(g.thin).toBe(1)
    // All time: from each post's first reading.
    expect(rankGrowth(rows, null).interactions[0]).toMatchObject({ post_id: 4, gained: 98 })
    expect(rankGrowth(rows, null, 1).interactions).toHaveLength(1)
  })

  it("reads one brand's history from the database", () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Grow', ['https://www.tiktok.com/@grow'])
    const other = addBrand(db, 'Other', ['https://www.tiktok.com/@other'])
    const post = (ext_id: string, likes: number, views: number) => ({
      ext_id,
      url: `https://www.tiktok.com/@grow/video/${ext_id}`,
      posted_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
      kind: 'video',
      caption: `About ${ext_id}`,
      thumb_url: null,
      likes,
      comments_count: 0,
      shares: 0,
      views,
      comments: [],
    })
    const [mine] = listProfiles(db, brand.id)
    const [theirs] = listProfiles(db, other.id)
    savePost(db, mine!, post('a', 5, 100))
    savePost(db, mine!, post('b', 5, 100))
    savePost(db, theirs!, post('c', 5, 100))
    // Reads are hours apart in real use; date the first ones back so the next are distinct.
    db.prepare('UPDATE post_metrics SET at = ?').run(
      new Date(Date.now() - 2 * 86400_000).toISOString(),
    )
    savePost(db, mine!, post('a', 30, 400))
    savePost(db, theirs!, post('c', 900, 9000))
    const g = postGrowth(db, { brandId: brand.id, days: 7 })
    expect(g.interactions).toEqual([
      expect.objectContaining({ gained: 25, now: 30, about: 'About a', network: 'tiktok' }),
    ])
    expect(g.views).toEqual([expect.objectContaining({ gained: 300, now: 400 })])
    expect(g.thin).toBe(1)
  })
})
