import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR } from './db.ts'
import type { Tally } from './store.ts'
import { withCompetitors } from './store.ts'
import type { Network } from './types.ts'
import { NETWORKS } from './types.ts'

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
    updates: adminUpdates(db, brandId),
  }
}

/** One update in the brand's history. Null figures were not recorded (updates before run_id). */
export interface UpdateRow {
  id: number
  started_at: string
  finished_at: string | null
  seconds: number | null
  /** As runs.trigger records it: manual, schedule or mcp. */
  trigger: string
  /** As runs.status records it: ok, partial, error, stopped, running, or a newer one. */
  status: string
  networks: Network[]
  /** False for updates from before their reads and AI calls were tied to them. */
  recorded: boolean
  posts: number | null
  comments: number | null
  new_comments: number | null
  sorted: number | null
  calls: number | null
  tokens: number | null
  input: number | null
  output: number | null
  cache_read: number | null
  cache_write: number | null
  cost_usd: number | null
  by_task: (UsageTotals & { key: string })[]
}

export interface UpdateEstimate {
  tokens: number
  cost_usd: number
  /** How many recent updates the median is taken from (at most 5). */
  from: number
  networks: Network[]
  /** False when no recent update used these networks, so updates on others stood in. */
  same_networks: boolean
}

const HISTORY = 50
const ESTIMATE_FROM = 5

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const inOrder = (nets: Network[]) => NETWORKS.filter((n) => nets.includes(n))
const sameSet = (a: Network[], b: Network[]) => inOrder(a).join() === inOrder(b).join()

/**
 * The brand's last 50 updates, newest first, each with what it read and what its AI calls used
 * for the brand and its rivals, and what the next update would take: the median of the last five
 * updates that used AI on the networks the next one reads.
 */
export function adminUpdates(db: DB, brandId: number) {
  const brands = withCompetitors(db, [brandId])
  const ids = JSON.stringify(brands)
  const runs = db
    .prepare(
      `SELECT id, trigger, scope, started_at, finished_at, status, tally FROM runs
       WHERE EXISTS (SELECT 1 FROM json_each(json_extract(runs.scope, '$.brandIds'))
         WHERE value IN (SELECT value FROM json_each(?)))
       ORDER BY id DESC LIMIT ?`,
    )
    .all(ids, HISTORY) as {
    id: number
    trigger: string
    scope: string
    started_at: string
    finished_at: string | null
    status: string
    tally: string | null
  }[]
  const usage = db
    .prepare(
      `SELECT run_id, task AS key, ${SUMS} FROM ai_usage
       WHERE run_id IN (SELECT value FROM json_each(?)) AND brand_id IN (SELECT value FROM json_each(?))
       GROUP BY run_id, task ORDER BY cost_usd DESC`,
    )
    .all(JSON.stringify(runs.map((r) => r.id)), ids) as unknown as (UsageTotals & {
    run_id: number
    key: string
  })[]

  const rows: UpdateRow[] = runs.map((r) => {
    const scope = JSON.parse(r.scope) as { networks?: Network[] }
    const base = {
      id: r.id,
      started_at: r.started_at,
      finished_at: r.finished_at,
      seconds: r.finished_at ? (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000 : null,
      trigger: r.trigger,
      status: r.status,
      networks: inOrder(scope.networks ?? []),
    }
    if (r.tally == null)
      return {
        ...base,
        recorded: false,
        posts: null,
        comments: null,
        new_comments: null,
        sorted: null,
        calls: null,
        tokens: null,
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        cost_usd: null,
        by_task: [],
      }
    const tally = JSON.parse(r.tally) as Record<string, Partial<Tally>>
    const read = (k: keyof Tally) => brands.reduce((s, id) => s + (tally[id]?.[k] ?? 0), 0)
    const by_task = usage.filter((u) => u.run_id === r.id).map(({ run_id: _, ...u }) => u)
    const sum = (k: keyof UsageTotals) => by_task.reduce((s, u) => s + u[k], 0)
    return {
      ...base,
      recorded: true,
      posts: read('posts'),
      comments: read('comments'),
      new_comments: read('new'),
      sorted: by_task.find((u) => u.key === 'sort-comments')?.items ?? 0,
      calls: sum('calls'),
      tokens: sum('input') + sum('output') + sum('cache_read') + sum('cache_write'),
      input: sum('input'),
      output: sum('output'),
      cache_read: sum('cache_read'),
      cache_write: sum('cache_write'),
      cost_usd: sum('cost_usd'),
      by_task,
    }
  })
  return { runs: rows, estimate: estimate(db, brandId, rows) }
}

/**
 * What the next update would take: it reads the networks of the brand's next scheduled update,
 * else those of its latest one. The median of the last five updates that used AI on that same set
 * of networks; when none did, of the last five that used AI at all. Null before any did. Running
 * and stopped updates are left out.
 */
function estimate(db: DB, brandId: number, rows: UpdateRow[]): UpdateEstimate | null {
  // A running or stopped update used only part of what a whole one takes.
  const withAi = rows.filter(
    (r) => r.recorded && (r.calls ?? 0) > 0 && r.status !== 'running' && r.status !== 'stopped',
  )
  if (!withAi.length) return null
  const scheduled = db
    .prepare(
      `SELECT networks FROM schedules WHERE brand_id = ? AND enabled = 1
       ORDER BY next_run_at IS NULL, next_run_at LIMIT 1`,
    )
    .get(brandId) as { networks: string } | undefined
  const networks = inOrder(
    scheduled ? (JSON.parse(scheduled.networks) as Network[]) : (rows[0]?.networks ?? []),
  )
  const same = withAi.filter((r) => sameSet(r.networks, networks))
  const basis = (same.length ? same : withAi).slice(0, ESTIMATE_FROM)
  return {
    tokens: Math.round(median(basis.map((r) => r.tokens ?? 0))),
    cost_usd: median(basis.map((r) => r.cost_usd ?? 0)),
    from: basis.length,
    networks,
    same_networks: same.length > 0,
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
