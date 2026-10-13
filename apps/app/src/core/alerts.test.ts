import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db.ts'
import { addBrand, getBrand, listComments, listProfiles, savePost, setVerdict } from './store.ts'
import {
  digestDue,
  digestSlot,
  instantAlerts,
  pickInstant,
  sendDigests,
  setAlerts,
  setNotify,
} from './alerts.ts'
import { RUN } from './types.ts'

const row = (id: number, text: string, more: Record<string, unknown> = {}) => ({
  id,
  text,
  author: 'ana',
  network: 'tiktok',
  post_url: 'https://www.tiktok.com/@test/video/1',
  label: null,
  sentiment: null,
  urgency: null,
  needs_reply: null,
  reply_status: 'open' as const,
  ...more,
})
const ALL = { urgent: true, bad: true, watched: true }

describe('instant alert triggers', () => {
  it('sends urgent comments only while they wait for an answer', () => {
    const rows = [
      row(1, 'no signal', { urgency: 2, needs_reply: 1 }),
      row(2, 'no signal', { urgency: 2, needs_reply: 1, reply_status: 'done' }),
      row(3, 'later', { urgency: 1, needs_reply: 1 }),
    ]
    expect(pickInstant(rows, ALL, []).urgent.map((c) => c.id)).toEqual([1])
    expect(pickInstant(rows, { ...ALL, urgent: false }, []).urgent).toEqual([])
  })

  it('waits for a run of negative comments, then sends the whole run once', () => {
    const bad = (id: number) => row(id, 'bad', { label: 'complaint' })
    const few = Array.from({ length: RUN - 1 }, (_, i) => bad(i + 1))
    expect(pickInstant(few, ALL, []).bad).toEqual([])
    const urgent = row(99, 'down', { sentiment: 'negative', urgency: 2, needs_reply: 1 })
    const pick = pickInstant([...few, urgent], ALL, [])
    // The urgent one counts toward the run but is listed once, under urgent.
    expect(pick.run).toBe(RUN)
    expect(pick.urgent.map((c) => c.id)).toEqual([99])
    expect(pick.bad).toHaveLength(RUN - 1)
    expect(pickInstant([...few, urgent], { ...ALL, bad: false }, []).bad).toEqual([])
  })

  it('finds words to watch in any case and alphabet, and names them', () => {
    const rows = [row(1, 'Интернет не работает'), row(2, 'love the volte calls'), row(3, 'hi')]
    const pick = pickInstant(rows, ALL, [
      { term: 'интернет', kind: 'topic' },
      { term: 'VoLTE', kind: 'product' },
      { term: 'roaming', kind: 'topic' },
    ])
    expect(pick.watched.map((c) => c.id)).toEqual([1, 2])
    expect(pick.terms).toEqual(['интернет', 'VoLTE'])
    expect(
      pickInstant(rows, { ...ALL, watched: false }, [{ term: 'hi', kind: 'topic' }]).watched,
    ).toEqual([])
  })
})

describe('instant alerts after an update', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends each comment once, and only those read since the trigger went on', async () => {
    delete process.env.SMTP_HOST
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    db.prepare('UPDATE brands SET trackers = ? WHERE id = ?').run(
      JSON.stringify([{ term: 'roaming', kind: 'topic' }]),
      brand.id,
    )
    setAlerts(db, brand.id, ['a@x.com'], 0, 'en')
    expect(setNotify(db, brand.id, { urgent: true, watched: true }).instant_since).toBeTruthy()
    const [profile] = listProfiles(db, brand.id)
    const c = (ext_id: string, text: string) => ({
      ext_id,
      parent_ext_id: null,
      author: 'x',
      text,
      likes: 0,
      posted_at: null,
    })
    const post = {
      ext_id: '1',
      url: 'https://www.tiktok.com/@test/video/1',
      posted_at: null,
      kind: 'video',
      caption: 'c',
      thumb_url: null,
      likes: 0,
      comments_count: 3,
      shares: 0,
      views: 0,
      comments: [c('a', 'no signal at all'), c('b', 'Roaming is too dear'), c('c', 'nice')],
    }
    savePost(db, profile!, post)
    const urgent = listComments(db).find((x) => x.ext_id === 'a')!
    setVerdict(db, urgent.id, 'complaint', true, 'down', 2)
    db.prepare('UPDATE brands SET instant_since = ?').run('2000-01-01')

    const log: string[] = []
    await instantAlerts(db, [brand.id], (l) => log.push(l))
    expect(log).toEqual(['Sent an alert of 2 comments of Test to 1 addresses.'])
    const mail = printed.mock.calls.map((x) => String(x[0])).join('\n')
    expect(mail).toContain('To: a@x.com')
    expect(mail).toContain('Test: 2 comments need you now')
    expect(listComments(db).filter((x) => x.alerted_at)).toHaveLength(2)

    await instantAlerts(db, [brand.id], (l) => log.push(l))
    expect(log).toHaveLength(1)

    // Comments read before the trigger went on never go out.
    post.comments.push(c('d', 'roaming again'))
    savePost(db, profile!, post)
    db.prepare('UPDATE brands SET instant_since = ?').run('2999-01-01')
    await instantAlerts(db, [brand.id], (l) => log.push(l))
    expect(log).toHaveLength(1)
  })
})

describe('summary email', () => {
  // 12 October 2026 is a Monday.
  it('falls on Monday 08:00 or the 1st at 08:00, local time', () => {
    expect(digestSlot('weekly', new Date(2026, 9, 14, 9))).toEqual(new Date(2026, 9, 12, 8))
    expect(digestSlot('weekly', new Date(2026, 9, 12, 7, 59))).toEqual(new Date(2026, 9, 5, 8))
    expect(digestSlot('weekly', new Date(2026, 9, 12, 8))).toEqual(new Date(2026, 9, 12, 8))
    expect(digestSlot('monthly', new Date(2026, 9, 13))).toEqual(new Date(2026, 9, 1, 8))
    expect(digestSlot('monthly', new Date(2026, 9, 1, 7))).toEqual(new Date(2026, 8, 1, 8))
    expect(digestSlot('monthly', new Date(2026, 0, 1, 7))).toEqual(new Date(2025, 11, 1, 8))
  })

  it('is due once per period, never twice', () => {
    const wed = new Date(2026, 9, 14, 9)
    expect(digestDue('off', null, wed)).toBe(false)
    expect(digestDue('weekly', null, wed)).toBe(true)
    expect(digestDue('weekly', new Date(2026, 9, 11).toISOString(), wed)).toBe(true)
    expect(digestDue('weekly', new Date(2026, 9, 12, 8, 1).toISOString(), wed)).toBe(false)
    expect(digestDue('weekly', wed.toISOString(), new Date(2026, 9, 19, 8))).toBe(true)
    expect(digestDue('monthly', wed.toISOString(), new Date(2026, 9, 31, 23))).toBe(false)
  })

  it('starts at the next period when turned on, and marks what it sent', async () => {
    delete process.env.SMTP_HOST
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Test', ['https://www.tiktok.com/@test'])
    setAlerts(db, brand.id, ['a@x.com'], 0, 'en')
    const on = setNotify(db, brand.id, { digest: 'weekly' })
    expect(digestDue(on.digest, on.digest_sent_at, new Date())).toBe(false)
    expect(() => setNotify(db, brand.id, { digest: 'daily' })).toThrow()

    // Last sent long ago: due now. No super admin, so no PDF; the summary still goes, once.
    db.prepare("UPDATE brands SET digest_sent_at = '2000-01-01'").run()
    const log: string[] = []
    await sendDigests(db, new Date(), (l) => log.push(l))
    await sendDigests(db, new Date(), (l) => log.push(l))
    expect(log).toEqual(['Sent the weekly summary of Test to 1 addresses.'])
    expect(getBrand(db, brand.id)!.digest_sent_at! > '2000-01-01').toBe(true)
  })
})
