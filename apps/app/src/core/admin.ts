import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR } from './db.ts'
import { withCompetitors } from './store.ts'

/**
 * The Admin tab: what a brand's AI work used, in tokens and API-equivalent USD, next to how much
 * data it holds, and every brand side by side. A brand counts with the rivals it watches, since
 * their posts are read and sorted for it. Usage exists only from the release that records it.
 */

const DAY = 86_400_000

export interface UsageTotals {
  calls: number
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost_usd: number
  items: number
}

const SUMS = `count(*) AS calls, coalesce(sum(input_tokens), 0) AS input,
  coalesce(sum(output_tokens), 0) AS output, coalesce(sum(cache_read_tokens), 0) AS cache_read,
  coalesce(sum(cache_write_tokens), 0) AS cache_write, coalesce(sum(cost_usd), 0) AS cost_usd,
  coalesce(sum(items), 0) AS items`

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Bytes on disk of the /media/ files these paths name; missing files count as nothing. */
function mediaBytes(paths: string[]) {
  let bytes = 0
  for (const p of new Set(paths)) {
    try {
      bytes += statSync(join(DATA_DIR, p)).size
    } catch {
      // Not saved, or removed since.
    }
  }
  return bytes
}

export function adminUsage(db: DB, brandId: number, at = Date.now()) {
  const ids = JSON.stringify(withCompetitors(db, [brandId]))
  const inBrand = `brand_id IN (SELECT value FROM json_each(?))`
  const since30 = new Date(at - 30 * DAY).toISOString()
  const monthStart = `${isoDay(at).slice(0, 7)}-01T00:00:00.000Z`
  const totals = (from: string | null) =>
    db
      .prepare(`SELECT ${SUMS} FROM ai_usage WHERE ${inBrand} AND (? IS NULL OR at >= ?)`)
      .get(ids, from, from) as unknown as UsageTotals
  const last30 = totals(since30)

  const group = (col: 'task' | 'network') =>
    db
      .prepare(
        `SELECT ${col} AS key, ${SUMS} FROM ai_usage WHERE ${inBrand} AND at >= ?
         GROUP BY ${col} ORDER BY cost_usd DESC`,
      )
      .all(ids, since30) as unknown as (UsageTotals & { key: string | null })[]

  // One row per day for the last 30, empty days included, oldest first.
  const perDay = new Map(
    (
      db
        .prepare(
          `SELECT substr(at, 1, 10) AS day, count(*) AS calls,
             sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
             sum(cost_usd) AS cost_usd
           FROM ai_usage WHERE ${inBrand} AND at >= ? GROUP BY day`,
        )
        .all(ids, isoDay(at - 29 * DAY)) as {
        day: string
        calls: number
        tokens: number
        cost_usd: number
      }[]
    ).map((r) => [r.day, r]),
  )
  const daily = Array.from({ length: 30 }, (_, i) => {
    const day = isoDay(at - (29 - i) * DAY)
    return perDay.get(day) ?? { day, calls: 0, tokens: 0, cost_usd: 0 }
  })

  const one = <T>(sql: string, ...args: (string | number | null)[]) =>
    db.prepare(sql).get(...args) as T
  const ofBrand = `FROM posts p JOIN profiles pr ON pr.id = p.profile_id WHERE pr.${inBrand}`
  const counts = one<{ posts: number }>(`SELECT count(*) AS posts ${ofBrand}`, ids)
  const comments = one<{ comments: number; sorted: number }>(
    `SELECT count(*) AS comments, count(c.label) AS sorted
     FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
     WHERE pr.${inBrand}`,
    ids,
  )
  const runs = one<{ runs: number; avg_seconds: number | null }>(
    `SELECT count(*) AS runs,
       avg(CASE WHEN finished_at IS NOT NULL
         THEN (julianday(finished_at) - julianday(started_at)) * 86400 END) AS avg_seconds
     FROM runs WHERE EXISTS (
       SELECT 1 FROM json_each(json_extract(runs.scope, '$.brandIds')) WHERE value = ?)`,
    brandId,
  )
  const files = db
    .prepare(
      `SELECT p.thumb_url AS path ${ofBrand} AND p.thumb_url LIKE '/media/%'
       UNION SELECT c.media_url FROM comments c JOIN posts p ON p.id = c.post_id
         JOIN profiles pr ON pr.id = p.profile_id WHERE pr.${inBrand} AND c.media_url LIKE '/media/%'
       UNION SELECT c.author_avatar FROM comments c JOIN posts p ON p.id = c.post_id
         JOIN profiles pr ON pr.id = p.profile_id WHERE pr.${inBrand} AND c.author_avatar LIKE '/media/%'`,
    )
    .all(ids, ids, ids) as { path: string }[]
  const reports = one<{ bytes: number }>(
    `SELECT coalesce(sum(size), 0) AS bytes FROM saved_reports WHERE brand_id = ?`,
    brandId,
  )

  const sorted30 = group('task').find((r) => r.key === 'sort-comments')?.items ?? 0
  // A month at the pace of the recorded days: fewer than 30 when recording began recently.
  const first = (
    db
      .prepare(`SELECT min(at) AS at FROM ai_usage WHERE ${inBrand} AND at >= ?`)
      .get(ids, since30) as {
      at: string | null
    }
  ).at
  const days = first ? Math.min(30, Math.max(1, (at - Date.parse(first)) / DAY)) : 0
  return {
    rivals: (
      db.prepare('SELECT count(*) AS n FROM brands WHERE competitor_of = ?').get(brandId) as {
        n: number
      }
    ).n,
    periods: { last30, month: totals(monthStart), all: totals(null) },
    by_task: group('task'),
    by_network: group('network'),
    daily,
    volume: {
      posts: counts.posts,
      comments: comments.comments,
      sorted: comments.sorted,
      runs: runs.runs,
      avg_run_seconds: runs.avg_seconds,
      media_bytes: mediaBytes(files.map((f) => f.path)),
      report_bytes: reports.bytes,
    },
    // All of the brand's AI work over the comments it sorted, and the last 30 days' pace.
    derived: {
      usd_per_1000_sorted: sorted30 ? (last30.cost_usd / sorted30) * 1000 : null,
      projected_month_usd: days ? (last30.cost_usd / days) * 30 : null,
      recorded_days: Math.ceil(days),
    },
    brands: allBrands(db, since30),
  }
}

/** Every brand (its rivals folded in) over the last 30 days, the most expensive first. */
function allBrands(db: DB, since: string) {
  const rows = db
    .prepare(
      `SELECT coalesce(b.competitor_of, b.id) AS id,
         coalesce(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens), 0) AS tokens,
         coalesce(sum(u.cost_usd), 0) AS cost_usd,
         coalesce(sum(CASE WHEN u.task = 'sort-comments' THEN u.items END), 0) AS comments,
         count(u.id) AS calls
       FROM brands b LEFT JOIN ai_usage u ON u.brand_id = b.id AND u.at >= ?
       GROUP BY coalesce(b.competitor_of, b.id)`,
    )
    .all(since) as {
    id: number
    tokens: number
    cost_usd: number
    comments: number
    calls: number
  }[]
  const names = new Map(
    (
      db.prepare('SELECT id, name FROM brands WHERE competitor_of IS NULL').all() as {
        id: number
        name: string
      }[]
    ).map((b) => [b.id, b.name]),
  )
  return rows
    .filter((r) => names.has(r.id))
    .map((r) => ({ ...r, name: names.get(r.id)! }))
    .sort((a, b) => b.cost_usd - a.cost_usd || a.name.localeCompare(b.name))
}
