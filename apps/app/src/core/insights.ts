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
  /** The window of the same length just before this one, for comparing. */
  previous?: boolean
}

const since = (days?: number, previous?: boolean) =>
  days ? new Date(Date.now() - days * (previous ? 2 : 1) * 86400_000).toISOString() : null
const until = (s: Scope) =>
  s.days && s.previous ? new Date(Date.now() - s.days * 86400_000).toISOString() : null

/** Shared WHERE for comments joined to posts (p) and profiles (pr). Customer comments only. */
function where(s: Scope) {
  return {
    sql: `(? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR p.network = ?)
          AND (? IS NULL OR coalesce(c.posted_at, c.fetched_at) >= ?)
          AND (? IS NULL OR coalesce(c.posted_at, c.fetched_at) < ?)
          AND lower(c.author) != lower(pr.handle)`,
    args: [
      s.brandId ?? null,
      s.brandId ?? null,
      s.network ?? null,
      s.network ?? null,
      since(s.days, s.previous),
      since(s.days, s.previous),
      until(s),
      until(s),
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
           AND (? IS NULL OR p.posted_at < ?)
         ORDER BY p.posted_at DESC LIMIT ?`,
      )
      .all(
        s.brandId ?? null,
        s.brandId ?? null,
        s.network ?? null,
        s.network ?? null,
        since(s.days, s.previous),
        since(s.days, s.previous),
        until(s),
        until(s),
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

/** One row per brand, side by side, for the comparison on the home page. Only `only` when given. */
export function compare(db: DB, days = 30, only: number[] | null = null) {
  const brands = (
    db.prepare('SELECT id, name FROM brands ORDER BY name').all() as { id: number; name: string }[]
  ).filter((b) => !only || only.includes(b.id))
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

const FROM = `FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id`

/** Customer comments per network, split by label. */
export function byNetwork(db: DB, s: Scope) {
  const w = where(s)
  const rows = db
    .prepare(
      `SELECT p.network, c.label, count(*) AS n ${FROM} WHERE ${w.sql} GROUP BY p.network, c.label`,
    )
    .all(...w.args) as { network: Network; label: string | null; n: number }[]
  const out = new Map<Network, Record<string, number>>()
  for (const r of rows) {
    const d = out.get(r.network) ?? {
      total: 0,
      complaint: 0,
      question: 0,
      suggestion: 0,
      praise: 0,
      other: 0,
    }
    const k = (LABELS as readonly string[]).includes(r.label ?? '') ? r.label! : 'other'
    d[k] = (d[k] ?? 0) + r.n
    d.total! += r.n
    out.set(r.network, d)
  }
  return [...out]
    .map(([network, d]) => ({ network, ...d }) as { network: Network } & Record<string, number>)
    .sort((a, b) => b.total! - a.total!)
}

/** Comments by weekday (0 Sunday) and hour, in UTC. */
// ponytail: UTC hours; shift by the viewer's offset if a brand's audience is far from UTC.
export function heatmap(db: DB, s: Scope) {
  const w = where(s)
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%w', coalesce(c.posted_at, c.fetched_at)) AS INTEGER) AS d,
              CAST(strftime('%H', coalesce(c.posted_at, c.fetched_at)) AS INTEGER) AS h, count(*) AS n
       ${FROM} WHERE ${w.sql} GROUP BY d, h`,
    )
    .all(...w.args) as { d: number; h: number; n: number }[]
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[])
  for (const r of rows) grid[r.d]![r.h] = r.n
  return grid
}

/** The people who comment most, with how their comments were labelled. */
export function topAuthors(db: DB, s: Scope, limit = 8) {
  const w = where(s)
  return db
    .prepare(
      `SELECT c.author, p.network, count(*) AS n,
              sum(c.label = 'complaint') AS complaints, sum(c.label = 'praise') AS praise,
              max(coalesce(c.posted_at, c.fetched_at)) AS last
       ${FROM} WHERE ${w.sql} GROUP BY lower(c.author), p.network ORDER BY n DESC, last DESC LIMIT ?`,
    )
    .all(...w.args, limit) as {
    author: string
    network: Network
    n: number
    complaints: number
    praise: number
    last: string
  }[]
}

// Words too common to say anything, in the languages comments usually come in.
const STOP = new Set(
  `the and for are but not you all any can her was one our out has have this that with what from they will your just like get its it's there their them then than been were when which would about more some very also into only over such http https www com
şi si sa să la de cu pe in în nu ce un o a ai am are as au din este e ca că mai pentru se ne va vă ve care sunt fost fi daca dacă cum cand când tot toti toți acest aceasta asta ăsta foarte doar
и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это
les des une est pas pour que qui dans sur avec par plus vous nous mais ont sont tout bien fait comme`.split(
    /\s+/,
  ),
)

/** The words people use most, without the brand's own name and everyday filler. */
export function topWords(db: DB, s: Scope, brandName = '', limit = 24) {
  const w = where(s)
  const rows = db.prepare(`SELECT c.text ${FROM} WHERE ${w.sql}`).all(...w.args) as {
    text: string
  }[]
  const own = new Set(brandName.toLowerCase().split(/[^\p{L}\p{N}]+/u))
  const counts = new Map<string, number>()
  for (const r of rows) {
    // Each word counts once per comment, so one long comment can't top the list alone.
    const seen = new Set(
      (r.text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]{2,}/gu) ?? []).filter(
        (x) => !STOP.has(x) && !own.has(x),
      ),
    )
    for (const x of seen) counts.set(x, (counts.get(x) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, n]) => ({ word, n }))
}
