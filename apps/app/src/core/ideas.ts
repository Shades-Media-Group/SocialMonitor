import type { DB } from './db.ts'
import { now } from './db.ts'
import { viaApi, viaClaude } from './analyze.ts'
import type { pickEngine } from './analyze.ts'
import { byRate, interactions, localDay, localHour, rankSlots } from './timing.ts'

/**
 * Ideas for a brand's next posts. The figures come from stored posts first (what format, hour
 * and day did best); Claude then reads the best and worst posts and what commenters ask for,
 * and proposes a few concrete posts. Made on request and kept, latest only, per brand.
 */

export interface Idea {
  topic: string
  format: string
  /** 0 Sunday … 6 Saturday. */
  day: number
  /** 0–23, this computer's local time. */
  hour: number
  why: string
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY = (d: number) => DAYS[d]![0]!.toUpperCase() + DAYS[d]!.slice(1, 3)

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

const PROMPT = (brand: string) =>
  `Brand: ${brand}. From what worked on its social accounts, suggest 3 to 5 concrete ideas for its next posts.
The data: its best and worst posts of the last 90 days (network and format, weekday and hour it went out in local time, figures, what it showed), the formats, hours and days that did best, and what commenters ask for or suggest.
Reply with one line per idea, "topic|format|day|hour|why":
topic: what the post shows or says, specific to this brand, at most 14 words.
format: a network and format from the data, like "TikTok video".
day: a weekday in English, like Tuesday. hour: 0 to 23, local time.
why: one line citing the data (a figure, a post or what people ask), at most 25 words.
Write in English. Output only these lines.`

interface Row {
  network: string
  kind: string
  posted_at: string
  likes: number | null
  comments_count: number | null
  shares: number | null
  views: number | null
  about: string
}

/** The compact text Claude reads, or null when there are too few posts to learn from. */
export function ideaInput(db: DB, brandId: number) {
  const since = new Date(Date.now() - 90 * 86400_000).toISOString()
  const posts = db
    .prepare(
      `SELECT p.network, p.kind, p.posted_at, p.likes, p.comments_count, p.shares, p.views,
              coalesce(p.description, p.caption) AS about
       FROM posts p JOIN profiles pr ON pr.id = p.profile_id
       WHERE pr.brand_id = ? AND p.posted_at >= ?`,
    )
    .all(brandId, since) as unknown as Row[]
  if (posts.length < 5) return null
  const rate = byRate(posts)
  const scored = (rate ? posts.filter((p) => p.views) : posts)
    .map((p) => ({ p, score: rate ? interactions(p) / p.views! : interactions(p) }))
    .sort((a, b) => b.score - a.score)
  const line = (tag: string, { p, score }: (typeof scored)[number]) => {
    const at = new Date(p.posted_at)
    const figures = [
      p.likes != null && `${p.likes} likes`,
      p.comments_count != null && `${p.comments_count} comments`,
      p.shares != null && `${p.shares} shares`,
      p.views != null && `${p.views} views`,
    ].filter(Boolean)
    return `${tag}|${p.network} ${p.kind}|${DAY(at.getDay())} ${at.getHours()}:00|${figures.join(', ')}${rate ? `, ${(score * 100).toFixed(1)}% engagement` : ''}|${clip(p.about || '(no caption)', 180)}`
  }
  const top = scored.slice(0, 6)
  const bottom = scored.slice(6).slice(-4)
  const metric = rate ? 'engagement per view' : 'interactions per post'
  const show = (s: ReturnType<typeof rankSlots>, name: (k: number) => string) =>
    s.slots
      .slice(0, 3)
      .map((x) => `${name(x.key)} (${x.posts} posts)`)
      .join(', ') || 'not enough posts yet'
  const kinds = new Map<string, { n: number; sum: number }>()
  for (const { p, score } of scored) {
    const k = `${p.network} ${p.kind}`
    const g = kinds.get(k) ?? { n: 0, sum: 0 }
    g.n++
    g.sum += score
    kinds.set(k, g)
  }
  const asks = db
    .prepare(
      `SELECT c.label, c.text FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
       WHERE pr.brand_id = ? AND c.label IN ('question', 'suggestion') AND lower(c.author) != lower(pr.handle)
         AND coalesce(c.posted_at, c.fetched_at) >= ?
       ORDER BY coalesce(c.likes, 0) DESC, c.id DESC LIMIT 40`,
    )
    .all(brandId, since) as { label: string; text: string }[]
  return [
    `Ranked by ${metric}.`,
    ...top.map((x) => line('best', x)),
    ...bottom.map((x) => line('worst', x)),
    `Formats, best first: ${[...kinds]
      .sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)
      .map(([k, g]) => `${k} (${g.n} posts)`)
      .join(', ')}`,
    `Best hours: ${show(rankSlots(posts, localHour), (h) => `${h}:00`)}`,
    `Best days: ${show(rankSlots(posts, localDay, { min: 2 }), DAY)}`,
    ...asks.map((c) => `${c.label}|${clip(c.text, 160)}`),
  ].join('\n')
}

/** Reads "topic|format|day|hour|why" lines; anything else is dropped. At most five ideas. */
export function parseIdeas(text: string): Idea[] {
  const out: Idea[] = []
  for (const raw of text.split('\n')) {
    const [topic, format, day, hour, ...why] = raw
      .trim()
      .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
      .split('|')
      .map((x) => x.trim())
    const d = DAYS.findIndex((x) => day && day.length >= 3 && x.startsWith(day.toLowerCase()))
    const h = Number((hour ?? '').replace(/:00$/, ''))
    if (!topic || !format || d < 0 || !Number.isInteger(h) || h < 0 || h > 23 || !why.length)
      continue
    out.push({
      topic: clip(topic, 160),
      format: clip(format, 60),
      day: d,
      hour: h,
      why: clip(why.join('|'), 240),
    })
    if (out.length === 5) break
  }
  return out
}

/** The latest ideas kept for the brand, or null before anyone asked. */
export function latestIdeas(db: DB, brandId: number) {
  const r = db
    .prepare('SELECT ideas, created_at FROM post_ideas WHERE brand_id = ?')
    .get(brandId) as { ideas: string; created_at: string } | undefined
  return r ? { ideas: JSON.parse(r.ideas) as Idea[], created_at: r.created_at } : null
}

/** Asks Claude for new ideas and keeps them in place of the last ones. */
export async function suggestIdeas(
  db: DB,
  brandId: number,
  engine: NonNullable<ReturnType<typeof pickEngine>>,
) {
  const brand = db
    .prepare('SELECT name, industry, description FROM brands WHERE id = ?')
    .get(brandId) as { name: string; industry: string | null; description: string | null }
  const input = ideaInput(db, brandId)
  if (!input) throw new Error('Ideas need at least 5 posts from the last 90 days. Run an update.')
  const about = [brand.industry, brand.description].filter(Boolean).join('; ')
  const prompt = PROMPT(`${brand.name}${about ? ` (${clip(about, 240)})` : ''}`)
  const text = engine === 'claude' ? await viaClaude(prompt, input) : await viaApi(prompt, input)
  const ideas = parseIdeas(text)
  if (!ideas.length) throw new Error('Claude answered without ideas. Try again.')
  const at = now()
  db.prepare(
    `INSERT INTO post_ideas (brand_id, ideas, created_at) VALUES (?, ?, ?)
     ON CONFLICT (brand_id) DO UPDATE SET ideas = excluded.ideas, created_at = excluded.created_at`,
  ).run(brandId, JSON.stringify(ideas), at)
  return { ideas, created_at: at }
}
