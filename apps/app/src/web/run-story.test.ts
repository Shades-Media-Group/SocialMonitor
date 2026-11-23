import { describe, expect, it } from 'vitest'
import { retell, took } from './run-story.ts'

const LOG = `10:09:10 Moldtelecom: reading instagram @moldtelecom_sa.
10:09:20 Stopped instagram: Instagram: the profile @moldtelecom_sa did not load. Open "Sign in to networks", check the account, then update again.
10:09:21 Moldtelecom: reading facebook @MoldtelecomSA.
10:09:21 Facebook MoldtelecomSA: 19 posts and their counts read through Meta's official API (Page Public Content Access). Meta gives comment counts but no comment text this way.
10:09:30 Moldtelecom: reading tiktok @moldtelecom.md.
10:09:34 TikTok public pages: TikTok answered with its "Please wait" check instead of the page. Reading them through a logged-out browser instead.
10:10:40 TikTok public pages: TikTok answered with its "Please wait" check instead of the page. Reading them through a logged-out browser instead.
10:10:43 TikTok: the public profile opened in a logged-out browser, past TikTok’s "Please wait" check.
10:10:44 TikTok: 7504261327641120055 · 0 comments read
10:10:50   3 new comments on https://www.tiktok.com/@moldtelecom.md/video/1
10:10:50 TikTok: 7532848158049635589 · 3 comments read
10:10:51   2 new comments on https://www.tiktok.com/@moldtelecom.md/video/2
10:10:51 TikTok: 7534722923844717829 · 2 comments read
10:10:52 TikTok: fresh numbers for 12 older posts.
10:12:00 Sorting 3 comments on https://www.tiktok.com/@moldtelecom.md/video/1
10:12:09 Sorting 2 comments on https://www.tiktok.com/@moldtelecom.md/video/2
10:13:47 Done.
`

describe('retelling an update', () => {
  const s = retell(LOG)
  it('keeps what matters to the person, in plain words', () => {
    expect(s.items.map((i) => [i.time, i.kind, i.text])).toEqual([
      ['10:09', 'step', 'Reading Moldtelecom on Instagram'],
      ['10:09', 'warn', 'Instagram could not be read this time'],
      ['10:09', 'step', 'Reading Moldtelecom on Facebook'],
      ['10:09', 'good', "19 Facebook posts and their numbers, from Meta's official data"],
      ['10:09', 'step', 'Reading Moldtelecom on TikTok'],
      [
        '10:09',
        'note',
        'TikTok asked for a pause, so its pages open in a private browser instead. Slower, but nothing is wrong.',
      ],
      ['10:12', 'step', 'AI sorts the new comments by topic and mood: 5 so far'],
      ['10:13', 'good', 'Finished'],
    ])
  })
  it('keeps the reason behind a problem and counts what happened', () => {
    expect(s.items[1]!.detail).toMatch(/did not load/)
    // Each TikTok post's line is folded under its account.
    expect(s.items[4]!.detail).toBe(
      'Posts checked for comments: 3 · Older posts with fresh numbers: 12 · New comments: 5',
    )
    expect(s).toMatchObject({ accounts: 3, newComments: 5, sorted: 5, problems: 1 })
  })
  it('says durations in words', () => {
    const from = '2026-11-23T10:00:00.000Z'
    expect(took(from, Date.parse('2026-11-23T10:00:35Z'))).toBe('35 s')
    expect(took(from, Date.parse('2026-11-23T10:04:10Z'))).toBe('4 min')
    expect(took(from, Date.parse('2026-11-23T11:05:00Z'))).toBe('1 h 5 min')
  })
})
