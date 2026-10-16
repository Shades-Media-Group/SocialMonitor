import type { DB } from './db.ts'
import { now } from './db.ts'
import { getBrand } from './store.ts'
import { labelTotals, watched } from './insights.ts'
import { pickEngine, writeSummary } from './analyze.ts'
import type { Kind } from './analyze.ts'
import { getSettings } from './settings.ts'
import type { Tracker } from './types.ts'

/**
 * The weekly summary: a few lines per brand on what people said in the last seven days, what
 * changed against the seven before, and what to answer first. Claude writes it from compact
 * counts and a handful of clipped comments, and only the latest one is kept.
 */
export interface WeekSummary {
  /** Paragraphs split by newlines. */
  text: string
  /** The days it covers, YYYY-MM-DD. */
  from: string
  to: string
  created_at: string
}

const DAY = 86400_000
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The brand's latest summary, or null. For the Overview and the report email. */
export function latestSummary(db: DB, brandId: number): WeekSummary | null {
  return (
    (db
      .prepare(
        'SELECT text, from_day AS "from", to_day AS "to", created_at FROM week_summaries WHERE brand_id = ?',
      )
      .get(brandId) as WeekSummary | undefined) ?? null
  )
}

/** A summary is written again once it is a day old, or when its week has moved on. */
export function summaryDue(s: WeekSummary | null, at = Date.now()) {
  return !s || at - new Date(s.created_at).getTime() > 23 * 3600_000 || s.to !== day(at)
}

const CUSTOMER = `FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
  WHERE pr.brand_id = ? AND lower(c.author) != lower(pr.handle)`
const AT = 'coalesce(c.posted_at, c.fetched_at)'

/** What Claude reads: counts this week against the week before, then the comments that matter. */
export function summaryInput(db: DB, brandId: number, at = Date.now()): string | null {
  const brand = getBrand(db, brandId)
  if (!brand) return null
  const week = { brandId, days: 7 }
  const cur = labelTotals(db, week)
  const prev = labelTotals(db, { ...week, previous: true })
  if (!cur.total && !prev.total) return null
  const n = (r: Record<string, number>, k: string) => r[k] ?? 0
  const weekAgo = new Date(at - 7 * DAY).toISOString()
  const twoAgo = new Date(at - 14 * DAY).toISOString()

  const lines = [
    `This week: ${day(at - 6 * DAY)} to ${day(at)}. Numbers in brackets are the week before.`,
    `Comments: ${cur.total} (${prev.total}); ${(
      [
        ['complaint', 'complaints'],
        ['question', 'questions'],
        ['suggestion', 'suggestions'],
        ['praise', 'praise'],
      ] as const
    )
      .map(([k, name]) => `${name} ${n(cur, k)} (${n(prev, k)})`)
      .join(', ')}${cur.unsorted ? `; not sorted yet ${cur.unsorted}` : ''}.`,
  ]

  const open = db
    .prepare(
      `SELECT count(*) AS n, coalesce(sum(c.urgency = 2), 0) AS urgent ${CUSTOMER}
       AND c.needs_reply = 1 AND c.reply_status = 'open'`,
    )
    .get(brandId) as { n: number; urgent: number }
  lines.push(
    `Waiting for an answer now: ${open.n}${open.urgent ? `, ${open.urgent} of them urgent` : ''}.`,
  )

  const kinds = JSON.parse(brand.categories || '[]') as Kind[]
  const byKind = db
    .prepare(
      `SELECT c.category AS key, sum(${AT} >= ?) AS cur, sum(${AT} < ?) AS prev ${CUSTOMER}
       AND c.category IS NOT NULL AND ${AT} >= ? GROUP BY c.category ORDER BY cur DESC LIMIT 8`,
    )
    .all(weekAgo, weekAgo, brandId, twoAgo) as { key: string; cur: number; prev: number }[]
  const named = byKind.flatMap((k) => {
    const kind = kinds.find((x) => x.key === k.key)
    return kind ? [`${kind.name} (${kind.sentiment}) ${k.cur} (${k.prev})`] : []
  })
  if (named.length) lines.push(`Kinds of comment: ${named.join('; ')}.`)

  const words = watched(db, week, JSON.parse(brand.trackers || '[]') as Tracker[]).filter(
    (w) => w.n || w.before,
  )
  if (words.length)
    lines.push(
      `Watched words: ${words
        .map(
          (w) =>
            `"${w.term}" (${w.kind}) ${w.n} (${w.before ?? 0}), ${w.complaints} unhappy, ${w.praise} happy`,
        )
        .join('; ')}.`,
    )

  // The comments behind the numbers: urgent and most liked first, clipped.
  const top = db
    .prepare(
      `SELECT c.label, c.text, c.likes, c.urgency, p.network,
         (c.needs_reply = 1 AND c.reply_status = 'open') AS waiting ${CUSTOMER}
       AND c.label IN ('complaint', 'question') AND ${AT} >= ?
       ORDER BY coalesce(c.urgency, 0) DESC, coalesce(c.likes, 0) DESC LIMIT 40`,
    )
    .all(brandId, weekAgo) as {
    label: string
    text: string
    likes: number | null
    urgency: number | null
    network: string
    waiting: number
  }[]
  const pick = (label: string, max: number) =>
    top
      .filter((c) => c.label === label)
      .slice(0, max)
      .map(
        (c) =>
          `- ${c.network}${c.likes ? `, ${c.likes} likes` : ''}${c.urgency === 2 ? ', urgent' : ''}${c.waiting ? ', not answered' : ''}: "${c.text.replace(/\s+/g, ' ').trim().slice(0, 160)}"`,
      )
  const complaints = pick('complaint', 5)
  const questions = pick('question', 4)
  if (complaints.length) lines.push('Top complaints:', ...complaints)
  if (questions.length) lines.push('Top questions:', ...questions)
  return lines.join('\n')
}

/**
 * Writes the brand's summary again when it is due (or always, with `force`) and keeps it.
 * Returns null when there is nothing to write about: no comments in the last two weeks.
 */
export async function refreshSummary(db: DB, brandId: number, force = false) {
  if (!force && !summaryDue(latestSummary(db, brandId))) return latestSummary(db, brandId)
  const brand = getBrand(db, brandId)
  if (!brand) throw new Error('No such brand.')
  const engine = pickEngine(getSettings(db))
  if (!engine)
    throw new Error(
      'No AI to write with: sign in to Claude Code, or set ANTHROPIC_API_KEY in .env.',
    )
  const at = Date.now()
  const input = summaryInput(db, brandId, at)
  if (!input) return null
  const about = [brand.industry, brand.description].filter(Boolean).join('; ')
  const paragraphs = await writeSummary(engine, brand.name, about, input, {
    db,
    task: 'summary',
    brandId,
  })
  if (!paragraphs.length) throw new Error('Claude did not write a summary. Try again.')
  db.prepare(
    `INSERT INTO week_summaries (brand_id, from_day, to_day, text, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (brand_id) DO UPDATE SET from_day = excluded.from_day, to_day = excluded.to_day,
       text = excluded.text, created_at = excluded.created_at`,
  ).run(brandId, day(at - 6 * DAY), day(at), paragraphs.join('\n'), now())
  return latestSummary(db, brandId)
}
