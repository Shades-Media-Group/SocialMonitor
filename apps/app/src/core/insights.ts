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
  /** Only the posts in this campaign. */
  campaignId?: number
}

const IN_CAMPAIGN =
  '(? IS NULL OR p.id IN (SELECT post_id FROM post_campaigns WHERE campaign_id = ? AND member = 1))'

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
          AND lower(c.author) != lower(pr.handle) AND ${IN_CAMPAIGN}`,
    args: [
      s.brandId ?? null,
      s.brandId ?? null,
      s.network ?? null,
      s.network ?? null,
      since(s.days, s.previous),
      since(s.days, s.previous),
      until(s),
      until(s),
      s.campaignId ?? null,
      s.campaignId ?? null,
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
export function topAuthors(db: DB, s: Scope, limit = 25) {
  const w = where(s)
  return db
    .prepare(
      `SELECT c.author, p.network, count(*) AS n,
              sum(c.label = 'complaint') AS complaints, sum(c.label = 'praise') AS praise,
              max(coalesce(c.posted_at, c.fetched_at)) AS last,
              max(c.author_avatar) AS avatar, max(c.author_url) AS url
       ${FROM} WHERE ${w.sql} GROUP BY lower(c.author), p.network ORDER BY n DESC, last DESC LIMIT ?`,
    )
    .all(...w.args, limit) as {
    author: string
    network: Network
    n: number
    complaints: number
    praise: number
    last: string
    avatar: string | null
    url: string | null
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

/**
 * How often each watched word comes up in comments, now and in the window before, with how
 * many of those comments complain or praise. Matching ignores case in every alphabet.
 */
export function watched(db: DB, s: Scope, list: { term: string; kind: string }[]) {
  if (!list.length) return []
  const read = (scope: Scope) => {
    const w = where(scope)
    return db
      .prepare(`SELECT lower(c.text) AS text, c.label, c.sentiment ${FROM} WHERE ${w.sql}`)
      .all(...w.args) as { text: string; label: string | null; sentiment: string | null }[]
  }
  const now = read(s)
  const before = s.days ? read({ ...s, previous: true }) : null
  return list.map(({ term, kind }) => {
    const k = term.toLowerCase()
    const hits = now.filter((r) => r.text.toLowerCase().includes(k))
    return {
      term,
      kind,
      n: hits.length,
      before: before ? before.filter((r) => r.text.toLowerCase().includes(k)).length : null,
      complaints: hits.filter((r) => r.label === 'complaint' || r.sentiment === 'negative').length,
      praise: hits.filter((r) => r.label === 'praise' || r.sentiment === 'positive').length,
    }
  })
}

/** Each social account of the brand in the window: its posts, what they drew, and its trend. */
export function profileStats(db: DB, s: Scope) {
  const profiles = db
    .prepare(
      `SELECT id, network, handle, url, last_run_at, last_status, last_error FROM profiles
       WHERE (? IS NULL OR brand_id = ?) AND (? IS NULL OR network = ?) ORDER BY network`,
    )
    .all(s.brandId ?? null, s.brandId ?? null, s.network ?? null, s.network ?? null) as {
    id: number
    network: Network
    handle: string
    url: string
    last_run_at: string | null
    last_status: string | null
    last_error: string | null
  }[]
  return profiles.map((pr) => {
    const scope = { ...s, network: pr.network }
    const posts = postEngagement(db, scope, 1000)
    const labels = labelTotals(db, scope)
    const days = timeline(db, scope)
    const sum = (k: 'likes' | 'comments' | 'shares' | 'views') =>
      posts.reduce((n, p) => n + (p[k] ?? 0), 0)
    return {
      ...pr,
      posts: posts.length,
      comments: labels.total ?? 0,
      complaints: labels.complaint ?? 0,
      praise: labels.praise ?? 0,
      likes: sum('likes'),
      likes_avg: posts.length ? Math.round(sum('likes') / posts.length) : null,
      // Photo posts on Facebook and Instagram report no views: null, shown as "–", not 0.
      views: posts.some((p) => p.views != null) ? sum('views') : null,
      interactions: sum('likes') + sum('comments') + sum('shares'),
      last_post: posts.at(-1)?.day ?? null,
      series: days.map((d) => {
        const r = d as unknown as Record<string, number>
        return r.complaint! + r.question! + r.suggestion! + r.praise! + r.other!
      }),
    }
  })
}

export interface DayRow {
  day: string
  comments: number
  complaints: number
  questions: number
  praise: number
  posts: number
  likes: number
  views: number | null
  interactions: number
}

/** Every day between from and to (inclusive, YYYY-MM-DD), with what happened on it. */
export function daily(
  db: DB,
  brandId: number,
  from: string,
  to: string,
  network?: Network,
): DayRow[] {
  const end = `${to}T23:59:59.999Z`
  const c = db
    .prepare(
      `SELECT substr(coalesce(c.posted_at, c.fetched_at), 1, 10) AS day, count(*) AS comments,
              sum(c.label = 'complaint') AS complaints, sum(c.label = 'question') AS questions,
              sum(c.label = 'praise') AS praise
       FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
       WHERE pr.brand_id = ? AND (? IS NULL OR p.network = ?) AND lower(c.author) != lower(pr.handle)
         AND coalesce(c.posted_at, c.fetched_at) >= ? AND coalesce(c.posted_at, c.fetched_at) <= ?
       GROUP BY day`,
    )
    .all(brandId, network ?? null, network ?? null, from, end) as unknown as DayRow[]
  const p = db
    .prepare(
      `SELECT substr(p.posted_at, 1, 10) AS day, count(*) AS posts, sum(coalesce(p.likes, 0)) AS likes,
              sum(coalesce(p.views, 0)) AS views,
              sum(coalesce(p.likes, 0) + coalesce(p.comments_count, 0) + coalesce(p.shares, 0)) AS interactions
       FROM posts p JOIN profiles pr ON pr.id = p.profile_id
       WHERE pr.brand_id = ? AND (? IS NULL OR p.network = ?) AND p.posted_at >= ? AND p.posted_at <= ?
       GROUP BY day`,
    )
    .all(brandId, network ?? null, network ?? null, from, end) as unknown as DayRow[]
  const byDay = new Map<string, DayRow>()
  const blank = (day: string): DayRow => ({
    day,
    comments: 0,
    complaints: 0,
    questions: 0,
    praise: 0,
    posts: 0,
    likes: 0,
    views: 0,
    interactions: 0,
  })
  for (const r of [...c, ...p]) byDay.set(r.day, { ...(byDay.get(r.day) ?? blank(r.day)), ...r })
  const out: DayRow[] = []
  for (
    let d = new Date(`${from}T12:00:00Z`);
    d <= new Date(`${to}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const day = d.toISOString().slice(0, 10)
    out.push(byDay.get(day) ?? blank(day))
  }
  return out
}

/** When posts do best: average interactions per post by weekday and hour (UTC) they went out. */
export function bestTimes(db: DB, s: Scope) {
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%w', p.posted_at) AS INTEGER) AS d, CAST(strftime('%H', p.posted_at) AS INTEGER) AS h,
              count(*) AS posts,
              avg(coalesce(p.likes, 0) + coalesce(p.comments_count, 0) + coalesce(p.shares, 0)) AS avg
       FROM posts p JOIN profiles pr ON pr.id = p.profile_id
       WHERE (? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR p.network = ?) AND p.posted_at IS NOT NULL
       GROUP BY d, h ORDER BY avg DESC LIMIT 5`,
    )
    .all(s.brandId ?? null, s.brandId ?? null, s.network ?? null, s.network ?? null) as {
    d: number
    h: number
    posts: number
    avg: number
  }[]
  return rows.map((r) => ({ ...r, avg: Math.round(r.avg) }))
}

/** One reading of a post's numbers, from post_metrics. */
export interface Reading {
  post_id: number
  at: string
  likes: number | null
  comments: number | null
  shares: number | null
  views: number | null
}
/** How much a post grew in the period: what it gained, and the figure now. */
export interface Gain {
  post_id: number
  gained: number
  now: number
}

const interactions = (r: Reading) => (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0)

/**
 * The posts that grew most since `from` (null: all time), by likes + comments + shares and by
 * views. Growth is measured between two real readings: the last one before the period (or the
 * first one in it) and the latest. A post read only once in the period has no growth to show;
 * those are counted in `thin`, never guessed. `rows` are ordered by post, then time.
 */
export function rankGrowth(rows: Reading[], from: string | null, limit = 8) {
  const byPost = new Map<number, Reading[]>()
  for (const r of rows) byPost.set(r.post_id, [...(byPost.get(r.post_id) ?? []), r])
  const inter: Gain[] = []
  const views: Gain[] = []
  let thin = 0
  for (const [post_id, rs] of byPost) {
    const inside = from ? rs.filter((r) => r.at > from) : rs
    if (!inside.length) continue // not read in this period at all
    const start = (from ? rs.filter((r) => r.at <= from).at(-1) : undefined) ?? inside[0]!
    const end = inside.at(-1)!
    if (start === end) {
      thin++
      continue
    }
    const gained = interactions(end) - interactions(start)
    if (gained > 0) inter.push({ post_id, gained, now: interactions(end) })
    if (end.views != null && start.views != null && end.views > start.views)
      views.push({ post_id, gained: end.views - start.views, now: end.views })
  }
  const top = (list: Gain[]) => list.sort((a, b) => b.gained - a.gained).slice(0, limit)
  return { interactions: top(inter), views: top(views), thin }
}

/**
 * The posts that grew most in the scope's window (or since `from`, an ISO date, when given),
 * with what the report shows of each.
 */
export function postGrowth(db: DB, s: Scope, limit = 8, from?: string | null) {
  const rows = db
    .prepare(
      `SELECT m.post_id, m.at, m.likes, m.comments, m.shares, m.views FROM post_metrics m
         JOIN posts p ON p.id = m.post_id JOIN profiles pr ON pr.id = p.profile_id
       WHERE (? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR p.network = ?) AND ${IN_CAMPAIGN}
       ORDER BY m.post_id, m.at`,
    )
    .all(
      s.brandId ?? null,
      s.brandId ?? null,
      s.network ?? null,
      s.network ?? null,
      s.campaignId ?? null,
      s.campaignId ?? null,
    ) as unknown as Reading[]
  const ranked = rankGrowth(rows, from === undefined ? since(s.days) : from, limit)
  const ids = [...new Set([...ranked.interactions, ...ranked.views].map((g) => g.post_id))]
  const posts = new Map(
    (ids.length
      ? (db
          .prepare(
            `SELECT id, network, url, thumb_url, posted_at, coalesce(description, caption) AS about
             FROM posts WHERE id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids) as {
          id: number
          network: Network
          url: string
          thumb_url: string | null
          posted_at: string | null
          about: string
        }[])
      : []
    ).map((p) => [p.id, p]),
  )
  const withPost = (list: Gain[]) => list.map((g) => ({ ...g, ...posts.get(g.post_id)! }))
  return {
    interactions: withPost(ranked.interactions),
    views: withPost(ranked.views),
    thin: ranked.thin,
  }
}
