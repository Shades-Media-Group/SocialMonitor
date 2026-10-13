import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { addBrand, listComments, listProfiles, savePost, setVerdict } from './store.ts'
import { parseSummary } from './analyze.ts'
import { latestSummary, summaryDue, summaryInput } from './summary.ts'

const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString()

describe('weekly summary', () => {
  it('reads plain paragraphs out of what the model wrote', () => {
    expect(
      parseSummary(
        '## This week\n\n**People** asked about prices.\n- Complaints rose from 3 to 7.\n1. Answer the outage first.\n',
      ),
    ).toEqual([
      'This week',
      'People asked about prices.',
      'Complaints rose from 3 to 7.',
      'Answer the outage first.',
    ])
    expect(parseSummary('a\nb\nc\nd\ne')).toHaveLength(4)
    expect(parseSummary('  \n')).toEqual([])
  })

  it('is due when missing, a day old, or when the week moved on', () => {
    const at = Date.parse('2026-10-13T12:00:00Z')
    const s = {
      text: 'x',
      from: '2026-10-07',
      to: '2026-10-13',
      created_at: '2026-10-13T08:00:00Z',
    }
    expect(summaryDue(null, at)).toBe(true)
    expect(summaryDue(s, at)).toBe(false)
    expect(summaryDue({ ...s, created_at: '2026-10-12T08:00:00Z' }, at)).toBe(true)
    expect(summaryDue(s, Date.parse('2026-10-14T00:30:00Z'))).toBe(true)
  })

  it('sends compact counts against the week before and the top comments, never raw rows', () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    const [profile] = listProfiles(db, brand.id)
    expect(summaryInput(db, brand.id)).toBeNull()
    expect(latestSummary(db, brand.id)).toBeNull()

    const c = (ext_id: string, text: string, days: number, likes = 0) => ({
      ext_id,
      parent_ext_id: null,
      author: `p${ext_id}`,
      text,
      likes,
      posted_at: ago(days),
    })
    savePost(db, profile!, {
      ext_id: '1',
      url: 'u',
      posted_at: ago(10),
      kind: 'video',
      caption: 'c',
      thumb_url: null,
      likes: 1,
      comments_count: 4,
      shares: 0,
      views: 9,
      comments: [
        c('a', 'No internet   since Monday '.repeat(20), 1, 12),
        c('b', 'How much is the new plan?', 2),
        c('c', 'Love it', 3),
        c('d', 'Slow again', 9),
      ],
    })
    const byExt = new Map(listComments(db).map((x) => [x.ext_id, x.id]))
    setVerdict(db, byExt.get('a')!, 'complaint', true, 'outage', 2, 'angry')
    setVerdict(db, byExt.get('b')!, 'question', true, 'price')
    setVerdict(db, byExt.get('c')!, 'praise', false, 'likes it')
    setVerdict(db, byExt.get('d')!, 'complaint', false, 'slow')

    const input = summaryInput(db, brand.id)!
    expect(input).toContain('Comments: 3 (1)')
    expect(input).toContain('complaints 1 (1)')
    expect(input).toContain('questions 1 (0)')
    expect(input).toContain('Waiting for an answer now: 2, 1 of them urgent.')
    expect(input).toMatch(
      /Top complaints:\n- tiktok, 12 likes, urgent, not answered: "No internet since Monday/,
    )
    expect(input).toContain('Top questions:\n- tiktok, not answered: "How much is the new plan?"')
    // Comment text is clipped, so a long comment never floods the prompt.
    expect(input.length).toBeLessThan(900)
    expect(input).not.toContain('Slow again')
  })
})
