import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db.ts'
import {
  AiLimitError,
  activePause,
  backoff,
  classify,
  clearPause,
  lastPause,
  needCatchUp,
  notePause,
  parseReset,
  takeCatchUp,
} from './ai-limit.ts'
import type { AiPause } from './ai-limit.ts'
import { viaApi } from './analyze.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// Friday 16 October 2026, 13:00 in Chisinau (UTC+3 in summer time).
const NOW = new Date('2026-10-16T10:00:00Z')
const iso = (d: Date | null) => d?.toISOString() ?? null

describe("reading when Claude's limit resets", () => {
  it('reads a unix time, in seconds or milliseconds', () => {
    const at = Math.floor(NOW.getTime() / 1000) + 3 * 3600
    expect(iso(parseReset(`Claude AI usage limit reached|${at}`, NOW))).toBe(
      '2026-10-16T13:00:00.000Z',
    )
    expect(iso(parseReset(`limit reached, resets ${at * 1000}`, NOW))).toBe(
      '2026-10-16T13:00:00.000Z',
    )
    // A time already past, or weeks away, is not believed.
    expect(parseReset('Claude AI usage limit reached|1760637600', NOW)).toBeNull()
    expect(parseReset(`Claude AI usage limit reached|${at + 30 * 86400}`, NOW)).toBeNull()
  })

  it('reads an ISO time', () => {
    expect(iso(parseReset('Usage limit reached; resets at 2026-10-16T15:40:00Z', NOW))).toBe(
      '2026-10-16T15:40:00.000Z',
    )
  })

  it('reads a clock time as its next occurrence on this computer', () => {
    const tz = 'Europe/Chisinau'
    expect(iso(parseReset('5-hour limit reached ∙ resets 3pm', NOW, tz))).toBe(
      '2026-10-16T12:00:00.000Z',
    )
    expect(iso(parseReset('Session limit reached · resets 3:30 pm', NOW, tz))).toBe(
      '2026-10-16T12:30:00.000Z',
    )
    expect(iso(parseReset('Usage limit reached, resets 15:00', NOW, tz))).toBe(
      '2026-10-16T12:00:00.000Z',
    )
    expect(iso(parseReset('Usage limit reached, resets 12am', NOW, tz))).toBe(
      '2026-10-16T21:00:00.000Z',
    )
    // Past today's time: tomorrow's.
    expect(iso(parseReset('5-hour limit reached ∙ resets 9am', NOW, tz))).toBe(
      '2026-10-17T06:00:00.000Z',
    )
    // Without a zone of its own, the server's (UTC here).
    expect(iso(parseReset('5-hour limit reached ∙ resets 3pm', NOW, 'UTC'))).toBe(
      '2026-10-16T15:00:00.000Z',
    )
  })

  it('uses the zone Claude names', () => {
    expect(
      iso(parseReset("You've hit your limit · resets 6pm (Europe/Chisinau)", NOW, 'UTC')),
    ).toBe('2026-10-16T15:00:00.000Z')
    expect(iso(parseReset('Limit reached · resets 6pm (America/New_York)', NOW, 'UTC'))).toBe(
      '2026-10-16T22:00:00.000Z',
    )
    // A zone that does not exist falls back to the server's.
    expect(iso(parseReset('Limit reached · resets 6pm (Mars/Base)', NOW, 'UTC'))).toBe(
      '2026-10-16T18:00:00.000Z',
    )
  })

  it('reads a day with the time, across a change of summer time', () => {
    const tz = 'Europe/Chisinau'
    expect(iso(parseReset('Weekly limit reached ∙ resets Oct 17, 9am', NOW, tz))).toBe(
      '2026-10-17T06:00:00.000Z',
    )
    // Summer time ends on 25 October: 9am is then 07:00 UTC.
    const tuesday = new Date('2026-10-20T10:00:00Z')
    expect(iso(parseReset('Weekly limit reached ∙ resets Oct 26 at 9am', tuesday, tz))).toBe(
      '2026-10-26T07:00:00.000Z',
    )
    // More than a week away is not believed.
    expect(parseReset('Weekly limit reached ∙ resets Oct 26 at 9am', NOW, tz)).toBeNull()
    expect(iso(parseReset('Weekly limit reached ∙ resets Mon 9am', NOW, tz))).toBe(
      '2026-10-19T06:00:00.000Z',
    )
    expect(iso(parseReset('Weekly limit reached ∙ resets 19 October', NOW, tz))).toBe(
      '2026-10-18T21:00:00.000Z',
    )
  })

  it('knows nothing when no time is given, or the time has just passed', () => {
    expect(parseReset('Claude AI usage limit reached', NOW)).toBeNull()
    expect(parseReset('Overloaded', NOW)).toBeNull()
    // "resets 1pm" read at 1:10pm: due now, not tomorrow.
    const later = new Date('2026-10-16T10:10:00Z')
    expect(parseReset('5-hour limit reached ∙ resets 1pm', later, 'Europe/Chisinau')).toBeNull()
  })
})

describe('telling a limit from other failures', () => {
  it('reads usage limits, rate limits, overload, sign-outs and the rest', () => {
    expect(
      classify({ is_error: true, result: 'Claude AI usage limit reached|1760637600' }),
    ).toEqual({ kind: 'limit', limit: 'usage', resetAt: null })
    expect(
      classify({ is_error: true, result: '5-hour limit reached ∙ resets 3pm' }, NOW, 'UTC'),
    ).toEqual({ kind: 'limit', limit: 'usage', resetAt: new Date('2026-10-16T15:00:00Z') })
    expect(classify({ is_error: true, result: "You've hit your limit · resets 6pm" }).kind).toBe(
      'limit',
    )
    expect(
      classify({ is_error: true, result: 'API Error: Request rejected', api_error_status: 429 }),
    ).toMatchObject({ kind: 'limit', limit: 'busy' })
    expect(
      classify({ is_error: true, result: 'API Error: Overloaded', api_error_status: 529 }),
    ).toMatchObject({ kind: 'limit', limit: 'busy' })
    expect(classify({ is_error: true, result: 'Repeated 529 Overloaded errors' }).kind).toBe(
      'limit',
    )
    expect(classify({ is_error: true, result: 'Invalid API key · Please run /login' })).toEqual({
      kind: 'signed-out',
    })
    expect(
      classify({ is_error: true, result: 'OAuth token has expired', api_error_status: 401 }),
    ).toEqual({ kind: 'signed-out' })
    expect(classify({ is_error: true, result: 'Prompt is too long' })).toEqual({ kind: 'other' })
  })

  it('stops at the API too when it is rate-limited or overloaded', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { type: 'rate_limit_error', message: 'Too many requests' } },
          { status: 429, headers: { 'retry-after': '120' } },
        ),
      ),
    )
    const e = await viaApi('Describe', 'x').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AiLimitError)
    expect((e as AiLimitError).kind).toBe('busy')
    expect((e as AiLimitError).resetAt!.getTime()).toBeGreaterThan(Date.now() + 100_000)
  })
})

describe('the AI pause', () => {
  const pause = (until: string, strikes = 1): AiPause => ({
    until,
    set_at: NOW.toISOString(),
    kind: 'usage',
    reason: '',
    strikes,
    reset_known: false,
  })
  const h = (n: number) => new Date(NOW.getTime() + n * 3600_000).toISOString()

  it('waits an hour, then two, then four, when no reset time is given', () => {
    expect(backoff(null, null, NOW)).toEqual({ until: new Date(h(1)), strikes: 1 })
    // Hit again right after a pause ended.
    const ended = new Date(NOW.getTime() - 5 * 60_000).toISOString()
    expect(backoff(pause(ended, 1), null, NOW)).toEqual({ until: new Date(h(2)), strikes: 2 })
    expect(backoff(pause(ended, 2), null, NOW)).toEqual({ until: new Date(h(4)), strikes: 3 })
    expect(backoff(pause(ended, 5), null, NOW)).toEqual({ until: new Date(h(4)), strikes: 6 })
    // Long after the last pause, it starts again at an hour.
    expect(backoff(pause(h(-3), 3), null, NOW)).toEqual({ until: new Date(h(1)), strikes: 1 })
    // Hit while still paused: the pause stays as it is.
    expect(backoff(pause(h(0.5), 2), null, NOW)).toEqual({ until: new Date(h(0.5)), strikes: 2 })
  })

  it('waits until the reset when Claude names it', () => {
    const reset = new Date(h(2.5))
    expect(backoff(null, reset, NOW)).toEqual({ until: reset, strikes: 1 })
  })

  it('is kept, read and cleared, and the error says until when', () => {
    const db = openDb(':memory:')
    const e = new AiLimitError('usage', null, 'Claude AI usage limit reached')
    const p = notePause(db, e, NOW)
    expect(p).toMatchObject({ until: h(1), kind: 'usage', strikes: 1, reset_known: false })
    expect(e.until.toISOString()).toBe(h(1))
    expect(e.message).toMatch(/^Claude is at its usage limit until /)
    expect(activePause(db, NOW)?.until).toBe(h(1))
    expect(activePause(db, new Date(h(1.01)))).toBeNull()
    // The next limit right after it waits two hours.
    const again = new Date(h(1.1))
    notePause(db, new AiLimitError('usage', null, ''), again)
    expect(lastPause(db)).toMatchObject({ strikes: 2 })
    expect(Date.parse(lastPause(db)!.until) - again.getTime()).toBe(2 * 3600_000)
    clearPause(db)
    expect(lastPause(db)).toBeNull()
  })

  it('catches up once, after the pause', () => {
    const db = openDb(':memory:')
    notePause(db, new AiLimitError('usage', new Date(h(1)), ''), NOW)
    needCatchUp(db, [3, 1], h(1.05))
    needCatchUp(db, [1, 2], h(1.05))
    expect(takeCatchUp(db, NOW)).toBeNull()
    expect(takeCatchUp(db, new Date(h(1.1)))).toEqual([1, 2, 3])
    expect(takeCatchUp(db, new Date(h(1.2)))).toBeNull()
  })
})
