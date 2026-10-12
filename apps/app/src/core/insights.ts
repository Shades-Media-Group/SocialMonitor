import type { DB } from './db.ts'
import type { Network } from './types.ts'

/**
 * The numbers behind the charts, the comparison and the exports. Every query takes the same
 * scope: a brand, optionally one network, and a window of days counted back from today
 * (by when the comment or post was published).
 */
export interface Scope {
  brandId?: number
  network?: Network
  /** 0 or undefined: all time. */
  days?: number
}

const since = (days?: number) =>
  days ? new Date(Date.now() - days * 86400_000).toISOString() : null

/** Shared WHERE for comments joined to posts (p) and profiles (pr). Customer comments only. */
function where(s: Scope) {
  return {
    sql: `(? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR p.network = ?)
          AND (? IS NULL OR coalesce(c.posted_at, c.fetched_at) >= ?)
          AND lower(c.author) != lower(pr.handle)`,
    args: [
      s.brandId ?? null,
      s.brandId ?? null,
      s.network ?? null,
      s.network ?? null,
      since(s.days),
      since(s.days),
    ],
  }
}

const LABELS = ['complaint', 'question', 'suggestion', 'praise'] as const

/** Comments per day, split by label; neutral, spam and unsorted fold into "other". */
export function timeline(db: DB, s: Scope) {
  const w = where(s)
  const rows = db
    .prepare(
      `SELECT substr(coalesce(c.posted_at, c.fetched_at), 1, 10) AS day, c.label, count(*) AS n
       FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
       WHERE ${w.sql} GROUP BY day, c.label ORDER BY day`,
    )
    .all(...w.args) as { day: string; label: string | null; n: number }[]
  const byDay = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const d = byDay.get(r.day) ?? { complaint: 0, question: 0, suggestion: 0, praise: 0, other: 0 }
    const k = (LABELS as readonly string[]).includes(r.label ?? '') ? r.label! : 'other'
    d[k] = (d[k] ?? 0) + r.n
    byDay.set(r.day, d)
  }
  // Every day in the window, so quiet days show as gaps rather than disappearing.
  const days =
    s.days ||
    Math.max(
      1,
      byDay.size ? Math.ceil((Date.now() - Date.parse([...byDay.keys()][0]!)) / 86400_000) + 1 : 30,
    )
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10)
    out.push({
      day,
      ...(byDay.get(day) ?? { complaint: 0, question: 0, suggestion: 0, praise: 0, other: 0 }),
    })
  }
  return out
}

/** Each post's engagement, oldest first, for the engagement chart and the Posts sheet. */
export function postEngagement(db: DB, s: Scope, limit = 30) {
  return (
    db
      .prepare(
        `SELECT p.id, p.network, p.url, substr(p.posted_at, 1, 10) AS day, p.likes, p.comments_count AS comments, p.shares, p.views,
           coalesce(p.description, p.caption) AS about
         FROM posts p JOIN profiles pr ON pr.id = p.profile_id
         WHERE (? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR p.network = ?) AND (? IS NULL OR p.posted_at >= ?)
         ORDER BY p.posted_at DESC LIMIT ?`,
      )
      .all(
        s.brandId ?? null,
        s.brandId ?? null,
        s.network ?? null,
        s.network ?? null,
        since(s.days),
        since(s.days),
        limit,
      ) as {
      id: number
      network: Network
      url: string
      day: string | null
      likes: number | null
      comments: number | null
      shares: number | null
      views: number | null
      about: string
    }[]
  ).reverse()
}

/**
 * How the brand answers: the share of customer comments its own account replied to, and the
 * median time to that first reply. Works for any brand, since replies are public.
 */
export function responses(db: DB, s: Scope) {
  const w = where(s)
  const rows = db
    .prepare(
      `SELECT c.posted_at AS asked,
         (SELECT min(r.posted_at) FROM comments r
           WHERE r.post_id = c.post_id AND r.parent_ext_id = c.ext_id AND lower(r.author) = lower(pr.handle)) AS answered
       FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
       WHERE ${w.sql} AND c.parent_ext_id IS NULL`,
    )
    .all(...w.args) as { asked: string | null; answered: string | null }[]
  const answered = rows.filter((r) => r.answered)
  const waits = answered
    .filter((r) => r.asked)
    .map((r) => (Date.parse(r.answered!) - Date.parse(r.asked!)) / 60000)
    .filter((m) => m >= 0)
    .sort((a, b) => a - b)
  const median = waits.length ? waits[Math.floor((waits.length - 1) / 2)]! : null
  return {
    comments: rows.length,
    answered: answered.length,
    rate: rows.length ? answered.length / rows.length : null,
    median_minutes: median === null ? null : Math.round(median),
  }
}

/** Customer comment counts by label in the scope. */
export function labelTotals(db: DB, s: Scope) {
  const w = where(s)
  const rows = db
    .prepare(
      `SELECT c.label, count(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
       WHERE ${w.sql} GROUP BY c.label`,
    )
    .all(...w.args) as { label: string | null; n: number }[]
  const out: Record<string, number> = { total: 0 }
  for (const r of rows) {
    out.total! += r.n
    out[r.label ?? 'unsorted'] = r.n
  }
  return out
}

/** One row per brand, side by side, for the comparison on the home page. */
export function compare(db: DB, days = 30) {
  const brands = db.prepare('SELECT id, name FROM brands ORDER BY name').all() as {
    id: number
    name: string
  }[]
  const rows = brands.map((b) => {
    const s = { brandId: b.id, days }
    const posts = postEngagement(db, s, 1000)
    const labels = labelTotals(db, s)
    const sorted = labels.total! - (labels.unsorted ?? 0)
    const r = responses(db, s)
    const sum = (k: 'likes' | 'comments') => posts.reduce((n, p) => n + (p[k] ?? 0), 0)
    return {
      id: b.id,
      name: b.name,
      posts: posts.length,
      likes_per_post: posts.length ? Math.round(sum('likes') / posts.length) : null,
      comments_per_post: posts.length
        ? Math.round((sum('comments') / posts.length) * 10) / 10
        : null,
      complaint_share: sorted ? (labels.complaint ?? 0) / sorted : null,
      praise_share: sorted ? (labels.praise ?? 0) / sorted : null,
      response_rate: r.rate,
      median_reply_minutes: r.median_minutes,
      reputation: reputation(labels),
      reach: reach(posts),
      comments: labels.total ?? 0,
    }
  })
  // Share of voice: each brand's part of all the comments across the brands you watch.
  const all = rows.reduce((n, r) => n + r.comments, 0)
  return rows.map((r) => ({ ...r, share_of_voice: all ? r.comments / all : null }))
}

/**
 * Reputation, 0 to 100: 50 is even, praise pulls it up and complaints pull it down, weighted by
 * how many sorted comments there are. Null until something is sorted.
 */
export function reputation(labels: Record<string, number>) {
  const sorted = (labels.total ?? 0) - (labels.unsorted ?? 0)
  if (!sorted) return null
  return Math.round(50 + (50 * ((labels.praise ?? 0) - (labels.complaint ?? 0))) / sorted)
}

/** Reach: the views the networks report for the posts in scope (TikTok and Instagram videos). */
export const reach = (posts: { views: number | null }[]) =>
  posts.reduce((n, p) => n + (p.views ?? 0), 0)
