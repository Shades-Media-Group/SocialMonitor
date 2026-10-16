import type { DB } from './db.ts'
import { getSetting, setSetting } from './store.ts'

/**
 * Claude's usage limits. Claude Code says nothing about how much of the subscription is left; it
 * only fails once the limit is hit, usually naming when it resets. A failed answer is read here
 * as a limit, a sign-out or anything else, and a limit pauses the AI until the reset (or, when no
 * time is given, for an hour, then two, then four if it is hit again right after). Updates wait
 * out the pause instead of failing, and comments left unsorted are sorted once it ends.
 */

/** 'usage': the subscription's limit. 'busy': a rate limit or an overloaded service (429, 529). */
export type LimitKind = 'usage' | 'busy'

/** The message templates, also the keys the dashboard translates. */
export const LIMIT_TEXT: Record<LimitKind, string> = {
  usage: 'Claude is at its usage limit until {time}.',
  busy: 'Claude is busy. It is tried again at {time}.',
}

/** A short clock time on this computer: "15:40", or "17 Oct, 09:00" when not today. */
export function clock(at: Date | string, from = new Date()) {
  const d = new Date(at)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === from.toDateString()
    ? time
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`
}

export class AiLimitError extends Error {
  kind: LimitKind
  /** When Claude said the limit resets; null when it did not say. */
  resetAt: Date | null
  /** When the AI is tried again: the reset, or the pause chosen for an unknown reset. */
  until: Date
  /** What Claude answered, clipped. */
  detail: string
  /** Verdicts already made before the limit, so they are kept (set by sortComments). */
  partial?: Map<number, unknown>
  constructor(kind: LimitKind, resetAt: Date | null, detail: string, until?: Date) {
    super('')
    this.name = 'AiLimitError'
    this.kind = kind
    this.resetAt = resetAt
    this.detail = detail.slice(0, 200)
    this.until = until ?? resetAt ?? new Date(Date.now() + 3600_000)
    this.message = this.text()
  }
  /** Moves the retry time (once the pause is known) and the message with it. */
  setUntil(until: Date) {
    this.until = until
    this.message = this.text()
  }
  private text() {
    return LIMIT_TEXT[this.kind].replace('{time}', clock(this.until))
  }
}

// Parsing what Claude Code answers

/** The Claude Code JSON fields that say why a call failed. */
export interface ClaudeAnswer {
  is_error?: boolean
  subtype?: string
  result?: string
  api_error_status?: number | null
}

export type Failure =
  | { kind: 'limit'; limit: LimitKind; resetAt: Date | null }
  | { kind: 'signed-out' }
  | { kind: 'other' }

const USAGE =
  /usage limit|(\d+[- ]hour|weekly|daily|session|opus|sonnet|haiku) limit|hit your (usage )?limit|limit (reached|exceeded|hit)|out of (extra )?usage|usage (is )?exhausted|quota/i
const BUSY = /rate[ _-]?limit|too many requests|overloaded|capacity/i
const SIGNED_OUT = /authenticat|oauth|log ?in|credential|invalid api key|unauthori[sz]ed/i

/** A failed Claude Code answer: a limit (with its reset when given), a sign-out, or something else. */
export function classify(d: ClaudeAnswer, at = new Date(), tz = localZone()): Failure {
  const text = `${d.result ?? ''}`
  const status = d.api_error_status ?? null
  if (USAGE.test(text)) return { kind: 'limit', limit: 'usage', resetAt: parseReset(text, at, tz) }
  if (status === 429 || status === 529 || BUSY.test(text))
    return { kind: 'limit', limit: 'busy', resetAt: parseReset(text, at, tz) }
  if (status === 401 || status === 403 || SIGNED_OUT.test(text)) return { kind: 'signed-out' }
  return { kind: 'other' }
}

/** The server's own time zone, used when Claude names a clock time without one. */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
/** A reset further away than this is not believed. */
const MAX_AHEAD = 8 * 86400_000
/** A clock time just passed means the reset is due now, not tomorrow: it counts as unknown. */
const JUST_PASSED = 30 * 60_000

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The wall clock in a time zone at a moment. */
function wall(t: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>
  return {
    y: Number(p.year),
    mo: Number(p.month) - 1,
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
    wd: DAYS.indexOf(p.weekday!.slice(0, 3).toLowerCase()),
  }
}

/** The moment a wall-clock time happens in a time zone (DST included). */
function inZone(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, mo, d, h, mi)
  const offset = (t: number) => {
    const w = wall(t, tz)
    return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000
  }
  const first = guess - offset(guess)
  return guess - offset(first)
}

/**
 * When the limit resets, from Claude's message: a unix time ("…limit reached|1760637600"), an ISO
 * time, or a clock time ("resets 3pm", "resets 15:00", "resets 6pm (Europe/Chisinau)", "resets
 * Oct 17, 9am", "resets Mon 9am"), as its next occurrence in the named zone or this computer's.
 * Null when there is none, or it is in the past or more than a week away.
 */
export function parseReset(text: string, at = new Date(), tz = localZone()): Date | null {
  const t0 = at.getTime()
  const ok = (ms: number) => (ms > t0 && ms - t0 <= MAX_AHEAD ? new Date(ms) : null)

  const unix = /(?<![\d.])(\d{13}|\d{10})(?![\d.])/.exec(text)
  if (unix) {
    const n = Number(unix[1])
    return ok(unix[1]!.length === 13 ? n : n * 1000)
  }
  const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/.exec(text)
  if (iso) {
    const ms = Date.parse(iso[0].replace(' ', 'T'))
    if (Number.isFinite(ms)) return ok(ms)
  }

  // The words after "resets", else the whole message.
  const after = /\bresets?\b(.*)$/is.exec(text)?.[1] ?? text
  const zone = /\(\s*([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\s*\)/.exec(after)?.[1]
  const where = zone && validZone(zone) ? zone : validZone(tz) ? tz : 'UTC'

  let h: number | null = null
  let mi = 0
  const ampm = /(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\b\.?/i.exec(after)
  const h24 = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/.exec(after)
  if (ampm) {
    const n = Number(ampm[1])
    if (n >= 1 && n <= 12) {
      h = (n % 12) + (ampm[3]!.toLowerCase() === 'p' ? 12 : 0)
      mi = Number(ampm[2] ?? 0)
    }
  } else if (h24) {
    h = Number(h24[1])
    mi = Number(h24[2])
  }
  const monthDay =
    new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?!\\d|:|\\s*[ap]\\.?m)`, 'i').exec(after) ?? null
  const dayMonth = monthDay ? null : new RegExp(`\\b(\\d{1,2})\\s+${MONTH}\\b`, 'i').exec(after)
  const weekday =
    /\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i.exec(
      after,
    )
  if (h === null && !monthDay && !dayMonth) return null

  const today = wall(t0, where)
  const hour = h ?? 0
  if (monthDay || dayMonth) {
    const mo = MONTHS.indexOf((monthDay ? monthDay[1]! : dayMonth![2]!).toLowerCase().slice(0, 3))
    const d = Number(monthDay ? monthDay[2] : dayMonth![1])
    let ms = inZone(today.y, mo, d, hour, mi, where)
    if (ms <= t0 - JUST_PASSED) ms = inZone(today.y + 1, mo, d, hour, mi, where)
    return ok(ms)
  }
  const target = weekday ? DAYS.indexOf(weekday[1]!.toLowerCase().slice(0, 3)) : -1
  for (let k = 0; k <= 7; k++) {
    if (target >= 0 && (today.wd + k) % 7 !== target) continue
    const ms = inZone(today.y, today.mo, today.d + k, hour, mi, where)
    if (ms > t0) return ok(ms)
    // "resets 3pm" read at 3:10pm: the reset is due now; when exactly is unknown.
    if (ms > t0 - JUST_PASSED) return null
  }
  return null
}

// The pause

/** The AI pause, kept in settings as ai_pause. */
export interface AiPause {
  /** When the AI is tried again. */
  until: string
  set_at: string
  kind: LimitKind
  /** What Claude answered, clipped. */
  reason: string
  /** How many limits in a row, each hit right after the pause before it. */
  strikes: number
  /** Whether Claude named the reset time. */
  reset_known: boolean
}

const PAUSE = 'ai_pause'
const CATCH_UP = 'ai_catch_up'
/** Pauses for a limit with no reset time: an hour, then two, then four. */
const STEPS_HOURS = [1, 2, 4]
/** A limit within this long after a pause ends counts as hit again right after it. */
const AGAIN_MS = 60 * 60_000
/** Waiting work starts this long after the pause ends, so it does not race the reset. */
export const MARGIN_MS = 2 * 60_000

const read = <T>(db: DB, key: string): T | null => {
  const raw = getSetting(db, key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** The last pause, even one that has ended. */
export const lastPause = (db: DB) => read<AiPause>(db, PAUSE)

/** The pause now, or null when the AI may run. */
export function activePause(db: DB, at = new Date()): AiPause | null {
  const p = lastPause(db)
  return p && Date.parse(p.until) > at.getTime() ? p : null
}

/** How long to pause after a limit, given the pause before it. */
export function backoff(prev: AiPause | null, resetAt: Date | null, at = new Date()) {
  const t0 = at.getTime()
  const end = prev ? Date.parse(prev.until) : NaN
  const during = !!prev && end > t0
  const again = !!prev && !during && t0 - end < AGAIN_MS
  // A limit hit while paused (someone asked for a reply draft) changes nothing but a known reset.
  if (during && !resetAt) return { until: new Date(end), strikes: prev!.strikes }
  const strikes = again ? prev!.strikes + 1 : during ? prev!.strikes : 1
  if (resetAt) return { until: resetAt, strikes }
  const hours = STEPS_HOURS[Math.min(strikes, STEPS_HOURS.length) - 1]!
  return { until: new Date(t0 + hours * 3600_000), strikes }
}

/** Records a limit: pauses the AI and moves the error's retry time to the pause's end. */
export function notePause(db: DB, e: AiLimitError, at = new Date()): AiPause {
  const { until, strikes } = backoff(lastPause(db), e.resetAt, at)
  const pause: AiPause = {
    until: until.toISOString(),
    set_at: at.toISOString(),
    kind: e.kind,
    reason: e.detail,
    strikes,
    reset_known: !!e.resetAt,
  }
  setSetting(db, PAUSE, JSON.stringify(pause))
  e.setUntil(until)
  // Work already waiting for Claude waits for this pause too.
  const c = read<{ after: string; brands: number[] }>(db, CATCH_UP)
  if (c) setSetting(db, CATCH_UP, JSON.stringify({ ...c, after: afterPause(pause) }))
  return pause
}

/** A call went through: the limit has reset. */
export function clearPause(db: DB) {
  if (getSetting(db, PAUSE)) setSetting(db, PAUSE, '')
}

/** "Claude is at its usage limit until 15:40." */
export const pauseText = (p: AiPause) => LIMIT_TEXT[p.kind].replace('{time}', clock(p.until))

/** When work that waits for the pause starts. */
export const afterPause = (p: AiPause) => new Date(Date.parse(p.until) + MARGIN_MS).toISOString()

// Catch-up: comments a limit left unsorted, sorted once the pause ends

/** These brands have comments or posts waiting for the AI until the pause ends. */
export function needCatchUp(db: DB, brandIds: number[], after: string) {
  const c = read<{ after: string; brands: number[] }>(db, CATCH_UP)
  setSetting(
    db,
    CATCH_UP,
    JSON.stringify({
      after: c && c.after > after ? c.after : after,
      brands: [...new Set([...(c?.brands ?? []), ...brandIds])].sort((a, b) => a - b),
    }),
  )
}

/** The brands to catch up now (the pause is over), taken off the list: at most once per pause. */
export function takeCatchUp(db: DB, at = new Date()): number[] | null {
  const c = read<{ after: string; brands: number[] }>(db, CATCH_UP)
  if (!c?.brands.length || Date.parse(c.after) > at.getTime() || activePause(db, at)) return null
  setSetting(db, CATCH_UP, '')
  return c.brands
}

/** What is waiting for the AI, for the dashboard. */
export function catchUpState(db: DB) {
  return read<{ after: string; brands: number[] }>(db, CATCH_UP)
}
