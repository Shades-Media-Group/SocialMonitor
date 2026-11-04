import type { DB } from './db.ts'
import { ownerOf } from './plan.ts'
import { STORY_KINDS } from './analyze.ts'

/**
 * What the Stories screen reads: the brand's kept stories with their files, filtered, and the
 * figures over them. `scope` says whose stories the person may see (core/stories.ts storyScope);
 * a brand's people never get a rival's story unless the plan lets them.
 */

export interface Scope {
  own: boolean
  rivals: boolean
}

export interface StoryFilter {
  /** Some of the accounts' brands by id; none: every one the scope allows. */
  brands?: number[]
  network?: string
  kind?: string
  /** Posted on or after, and on or before (YYYY-MM-DD). */
  since?: string
  until?: string
  /** mentions: names or tags an account; reposts: shares another account's content. */
  has?: 'mentions' | 'reposts'
  state?: 'live' | 'expired'
  limit?: number
}

export interface StoryFile {
  position: number
  kind: string
  width: number | null
  height: number | null
  duration: number | null
  /** The compact copy to play or show; null while it is being made, or when it failed. */
  src: string | null
  poster: string | null
  status: string
  /** Whether the original can still be downloaded, and until when. */
  original: boolean
  original_until: string | null
  original_bytes: number | null
  compact_bytes: number | null
}

export interface StoryRow {
  id: number
  brand_id: number
  own: boolean
  account: string
  network: string
  handle: string
  posted_at: string | null
  expires_at: string | null
  live: boolean
  first_seen_at: string
  last_seen_at: string
  caption: string
  stickers: string[]
  /** Accounts it names: from the network's own tags and from Claude's reading, once each. */
  mentions: string[]
  links: string[]
  music: { title: string; author: string | null } | null
  views: number | null
  likes: number | null
  shares: number | null
  replies: number | null
  insights: Record<string, number> | null
  permalink: string | null
  about: string | null
  kind: string | null
  text: string | null
  tone: string | null
  repost_of: string | null
  ai_error: string | null
  files: StoryFile[]
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** The brand ids a person may see stories of: the brand, its rivals (paused ones included). */
export function visibleBrands(db: DB, watcher: number, scope: Scope) {
  const rivals = (
    db.prepare('SELECT id FROM brands WHERE competitor_of = ?').all(watcher) as { id: number }[]
  ).map((r) => r.id)
  // Rivals removed since keep their stories, under the brand id they had.
  const gone = (
    db
      .prepare(
        `SELECT DISTINCT brand_id AS id FROM stories WHERE watcher_id = ? AND brand_id != ?
           AND brand_id NOT IN (SELECT id FROM brands WHERE competitor_of = ?)`,
      )
      .all(watcher, watcher, watcher) as { id: number }[]
  ).map((r) => r.id)
  return [...(scope.own ? [watcher] : []), ...(scope.rivals ? [...rivals, ...gone] : [])]
}

function where(watcher: number, ids: number[], f: StoryFilter, at: string) {
  const asked = (f.brands ?? []).filter((b) => ids.includes(b))
  const want = asked.length ? asked : ids
  const sql = ['s.watcher_id = ?', `s.brand_id IN (${want.map(() => '?').join(',') || 'NULL'})`]
  const args: (string | number)[] = [watcher, ...want]
  if (f.network && ['tiktok', 'instagram', 'facebook'].includes(f.network)) {
    sql.push('s.network = ?')
    args.push(f.network)
  }
  if (f.kind && (STORY_KINDS as readonly string[]).includes(f.kind)) {
    sql.push('s.ai_kind = ?')
    args.push(f.kind)
  }
  const posted = 'coalesce(s.posted_at, s.first_seen_at)'
  if (f.since && DAY_RE.test(f.since)) {
    sql.push(`${posted} >= ?`)
    args.push(f.since)
  }
  if (f.until && DAY_RE.test(f.until)) {
    sql.push(`substr(${posted}, 1, 10) <= ?`)
    args.push(f.until)
  }
  if (f.has === 'mentions') sql.push("(s.mentions != '[]' OR s.ai_accounts != '[]')")
  if (f.has === 'reposts') sql.push("(s.ai_repost_of IS NOT NULL OR s.ai_kind = 'repost')")
  if (f.state === 'live') {
    sql.push('s.expires_at > ?')
    args.push(at)
  }
  if (f.state === 'expired') {
    sql.push('(s.expires_at IS NULL OR s.expires_at <= ?)')
    args.push(at)
  }
  return { sql: sql.join(' AND '), args }
}

const list = (s: string | null) => {
  try {
    const v = JSON.parse(s || '[]') as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** The stories that match, newest first, each with its files, and the accounts they come from. */
export function storiesView(
  db: DB,
  watcher: number,
  scope: Scope,
  f: StoryFilter = {},
  at = new Date(),
) {
  const iso = at.toISOString()
  const ids = visibleBrands(db, watcher, scope)
  const names = new Map(
    (
      db
        .prepare(
          `SELECT id, name FROM brands WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`,
        )
        .all(...ids) as { id: number; name: string }[]
    ).map((b) => [b.id, b.name]),
  )
  const w = where(watcher, ids, f, iso)
  const limit = Math.max(1, Math.min(500, f.limit ?? 200))
  const matching = (
    db.prepare(`SELECT count(*) AS n FROM stories s WHERE ${w.sql}`).get(...w.args) as { n: number }
  ).n
  const rows = db
    .prepare(
      `SELECT s.* FROM stories s WHERE ${w.sql}
       ORDER BY coalesce(s.posted_at, s.first_seen_at) DESC, s.id DESC LIMIT ?`,
    )
    .all(...w.args, limit) as Record<string, string | number | null>[]
  const files = db.prepare(
    `SELECT position, kind, width, height, duration, compact_path, poster_path, status,
       original_path, original_until, original_bytes, compact_bytes
     FROM story_media WHERE story_id = ? ORDER BY position`,
  )
  const stories: StoryRow[] = rows.map((r) => {
    const mentions = [...new Set([...list(r.mentions as string), ...list(r.ai_accounts as string)])]
    const brand = r.brand_id as number
    return {
      id: r.id as number,
      brand_id: brand,
      own: brand === watcher,
      account: names.get(brand) ?? (r.handle as string),
      network: r.network as string,
      handle: r.handle as string,
      posted_at: r.posted_at as string | null,
      expires_at: r.expires_at as string | null,
      live: !!r.expires_at && (r.expires_at as string) > iso,
      first_seen_at: r.first_seen_at as string,
      last_seen_at: r.last_seen_at as string,
      caption: r.caption as string,
      stickers: list(r.stickers as string),
      mentions,
      links: list(r.links as string).filter((u) => /^https?:\/\//i.test(u)),
      music: r.music ? (JSON.parse(r.music as string) as StoryRow['music']) : null,
      views: r.views as number | null,
      likes: r.likes as number | null,
      shares: r.shares as number | null,
      replies: r.replies as number | null,
      insights: r.insights ? (JSON.parse(r.insights as string) as Record<string, number>) : null,
      permalink: r.permalink as string | null,
      about: r.ai_about as string | null,
      kind: r.ai_kind as string | null,
      text: r.ai_text as string | null,
      tone: r.ai_tone as string | null,
      repost_of: r.ai_repost_of as string | null,
      ai_error: r.ai_at ? null : (r.ai_error as string | null),
      files: (
        files.all(r.id as number) as {
          position: number
          kind: string
          width: number | null
          height: number | null
          duration: number | null
          compact_path: string | null
          poster_path: string | null
          status: string
          original_path: string | null
          original_until: string | null
          original_bytes: number | null
          compact_bytes: number | null
        }[]
      ).map((m) => ({
        position: m.position,
        kind: m.kind,
        width: m.width,
        height: m.height,
        duration: m.duration,
        src: m.status === 'done' ? m.compact_path : null,
        poster: m.status === 'done' ? m.poster_path : null,
        status: m.status,
        original: !!m.original_path,
        original_until: m.original_path ? m.original_until : null,
        original_bytes: m.original_bytes,
        compact_bytes: m.compact_bytes,
      })),
    }
  })
  return {
    accounts: accounts(db, watcher, ids, names),
    stories,
    matching,
    facets: facets(db, watcher, ids, f, iso),
  }
}

/** Each account's handles and how many stories it has kept. */
function accounts(db: DB, watcher: number, ids: number[], names: Map<number, string>) {
  return ids.map((id) => {
    const n = db
      .prepare(
        `SELECT count(*) AS total, max(coalesce(posted_at, first_seen_at)) AS last FROM stories
         WHERE watcher_id = ? AND brand_id = ?`,
      )
      .get(watcher, id) as { total: number; last: string | null }
    const handles = db
      .prepare('SELECT network, handle FROM profiles WHERE brand_id = ? ORDER BY network')
      .all(id) as { network: string; handle: string }[]
    return {
      brand_id: id,
      name: names.get(id) ?? `#${id}`,
      own: id === watcher,
      profiles: handles,
      total: n.total,
      last: n.last,
    }
  })
}

function facets(db: DB, watcher: number, ids: number[], f: StoryFilter, at: string) {
  const count = (skip: keyof StoryFilter, group: string) => {
    const w = where(watcher, ids, { ...f, [skip]: undefined }, at)
    return Object.fromEntries(
      (
        db
          .prepare(`SELECT ${group} AS k, count(*) AS n FROM stories s WHERE ${w.sql} GROUP BY k`)
          .all(...w.args) as { k: string | number | null; n: number }[]
      )
        .filter((r) => r.k != null)
        .map((r) => [String(r.k), r.n]),
    )
  }
  const w = where(watcher, ids, { ...f, state: undefined }, at)
  const state = db
    .prepare(
      `SELECT coalesce(sum(s.expires_at > ?), 0) AS live, coalesce(sum(s.expires_at IS NULL OR s.expires_at <= ?), 0) AS expired
       FROM stories s WHERE ${w.sql}`,
    )
    .get(at, at, ...w.args) as { live: number; expired: number }
  return {
    brands: count('brands', 's.brand_id'),
    network: count('network', 's.network'),
    kind: count('kind', 's.ai_kind'),
    state,
  }
}

const DAY = 86_400_000

/**
 * The figures over a brand's stories in the last `days` days: per account the stories and the
 * days they posted, per day and week, the hours they post at (weekday × hour, UTC), what kind
 * they are, the accounts they name and repost most, and the insights where the brand connected.
 */
export function storyStats(db: DB, watcher: number, scope: Scope, days = 30, at = new Date()) {
  const ids = visibleBrands(db, watcher, scope)
  const from = new Date(at.getTime() - (days - 1) * DAY).toISOString().slice(0, 10)
  const inIds = `s.brand_id IN (${ids.map(() => '?').join(',') || 'NULL'})`
  const base = `FROM stories s WHERE s.watcher_id = ? AND ${inIds} AND coalesce(s.posted_at, s.first_seen_at) >= ?`
  const args = [watcher, ...ids, from]
  const day = 'substr(coalesce(s.posted_at, s.first_seen_at), 1, 10)'
  const names = new Map(
    (
      db
        .prepare(
          `SELECT id, name FROM brands WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`,
        )
        .all(...ids) as { id: number; name: string }[]
    ).map((b) => [b.id, b.name]),
  )
  const dayList = Array.from({ length: days }, (_, i) =>
    new Date(at.getTime() - (days - 1 - i) * DAY).toISOString().slice(0, 10),
  )
  const perDay = db
    .prepare(`SELECT s.brand_id AS b, ${day} AS d, count(*) AS n ${base} GROUP BY b, d`)
    .all(...args) as { b: number; d: string; n: number }[]
  const series = ids.map((id) => {
    const byDay = new Map(perDay.filter((r) => r.b === id).map((r) => [r.d, r.n]))
    const values = dayList.map((d) => byDay.get(d) ?? 0)
    const total = values.reduce((a, b) => a + b, 0)
    return {
      brand_id: id,
      name: names.get(id) ?? `#${id}`,
      own: id === watcher,
      values,
      total,
      per_day: total / days,
      days_posted: values.filter(Boolean).length,
    }
  })
  // Weeks of seven days ending today, oldest first.
  const weeks = Math.ceil(days / 7)
  const weekly = series.map((s) => ({
    brand_id: s.brand_id,
    values: Array.from({ length: weeks }, (_, w) => {
      const end = s.values.length - w * 7
      return s.values.slice(Math.max(0, end - 7), end).reduce((a, b) => a + b, 0)
    }).reverse(),
  }))
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[])
  for (const r of db
    .prepare(
      `SELECT CAST(strftime('%w', coalesce(s.posted_at, s.first_seen_at)) AS INTEGER) AS d,
         CAST(strftime('%H', coalesce(s.posted_at, s.first_seen_at)) AS INTEGER) AS h, count(*) AS n
       ${base} GROUP BY d, h`,
    )
    .all(...args) as { d: number; h: number; n: number }[])
    grid[r.d]![r.h] = r.n
  const kinds = db
    .prepare(`SELECT s.ai_kind AS kind, count(*) AS n ${base} GROUP BY kind ORDER BY n DESC`)
    .all(...args) as { kind: string | null; n: number }[]
  // Named by the network's own tags or by Claude's reading: each story counts once per account.
  const tagged = (col: string) =>
    `SELECT s.id AS id, lower(j.value) AS handle FROM stories s, json_each(s.${col}) j
     WHERE s.watcher_id = ? AND ${inIds} AND coalesce(s.posted_at, s.first_seen_at) >= ?`
  const mentioned = db
    .prepare(
      `SELECT handle, count(DISTINCT id) AS n FROM (${tagged('mentions')} UNION ${tagged('ai_accounts')})
       GROUP BY handle ORDER BY n DESC, handle LIMIT 12`,
    )
    .all(...args, ...args) as { handle: string; n: number }[]
  const reposts = db
    .prepare(
      `SELECT lower(s.ai_repost_of) AS handle, count(*) AS n ${base} AND s.ai_repost_of IS NOT NULL
       GROUP BY handle ORDER BY n DESC LIMIT 10`,
    )
    .all(...args) as { handle: string; n: number }[]
  const insights = db
    .prepare(
      `SELECT count(*) AS stories, avg(json_extract(s.insights, '$.reach')) AS reach,
         avg(json_extract(s.insights, '$.replies')) AS replies,
         avg(json_extract(s.insights, '$.taps_forward')) AS taps_forward,
         avg(json_extract(s.insights, '$.exits')) AS exits,
         avg(json_extract(s.insights, '$.profile_visits')) AS profile_visits
       ${base} AND s.insights IS NOT NULL`,
    )
    .get(...args) as Record<string, number | null>
  const views = db
    .prepare(
      `SELECT s.brand_id AS brand_id, avg(s.views) AS views, avg(s.likes) AS likes ${base}
         AND s.views IS NOT NULL GROUP BY s.brand_id`,
    )
    .all(...args) as { brand_id: number; views: number; likes: number | null }[]
  return {
    days: dayList,
    series,
    weekly,
    heatmap: grid,
    kinds,
    mentioned,
    reposts,
    insights: insights.stories ? insights : null,
    views,
  }
}

/** The disk a brand's stories use: originals still held, compact copies, posters, what was saved. */
export function storyStorage(db: DB, brandId: number) {
  const watcher = ownerOf(db, brandId)
  const r = db
    .prepare(
      `SELECT count(DISTINCT s.id) AS stories, count(m.story_id) AS files,
         coalesce(sum(CASE WHEN m.original_path IS NOT NULL THEN m.original_bytes END), 0) AS originals_held,
         coalesce(sum(m.original_bytes), 0) AS originals_read,
         coalesce(sum(m.compact_bytes), 0) AS compact,
         coalesce(sum(m.poster_bytes), 0) AS posters,
         coalesce(sum(CASE WHEN m.original_removed_at IS NOT NULL THEN m.original_bytes END), 0) AS removed
       FROM stories s LEFT JOIN story_media m ON m.story_id = s.id WHERE s.watcher_id = ?`,
    )
    .get(watcher) as {
    stories: number
    files: number
    originals_held: number
    originals_read: number
    compact: number
    posters: number
    removed: number
  }
  return r
}
