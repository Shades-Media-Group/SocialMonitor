import type { DB } from './db.ts'
import { now } from './db.ts'
import type {
  Brand,
  CollectedPost,
  Comment,
  Label,
  Network,
  Post,
  Profile,
  Range,
  ReplyStatus,
  Schedule,
  ScheduleKind,
} from './types.ts'
import { NETWORKS } from './types.ts'
import { TEMPLATES } from './categories.ts'

type Row = Record<string, unknown>
const all = <T>(db: DB, sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).all(...args) as unknown as T[]
const one = <T>(db: DB, sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).get(...args) as unknown as T | undefined

/** The handle from a profile link: instagram.com/name, facebook.com/Name, tiktok.com/@name. */
export function parseProfile(url: string): { network: Network; handle: string } {
  const u = new URL(url.trim())
  const host = u.hostname.replace(/^(www|m|web)\./, '')
  const network = NETWORKS.find((n) => host === `${n}.com`)
  if (!network) throw new Error(`Not an Instagram, Facebook or TikTok link: ${url}`)
  const first = u.pathname.split('/').filter(Boolean)[0]
  if (!first) throw new Error(`The link has no profile name: ${url}`)
  return { network, handle: first.replace(/^@/, '') }
}

export const canonicalUrl = (network: Network, handle: string) =>
  network === 'tiktok'
    ? `https://www.tiktok.com/@${handle}`
    : `https://www.${network}.com/${handle}`

// Brands and their profiles

export function addBrand(
  db: DB,
  name: string,
  links: string[],
  website: string | null = null,
  categories: unknown[] = TEMPLATES.general!.categories,
): Brand {
  const brand = one<Brand>(
    db,
    'INSERT INTO brands (name, website, categories) VALUES (?, ?, ?) RETURNING *',
    name.trim(),
    website,
    JSON.stringify(categories),
  )!
  for (const link of links.filter(Boolean)) setProfile(db, brand.id, link)
  return brand
}

export function setProfile(db: DB, brandId: number, link: string): Profile {
  const { network, handle } = parseProfile(link)
  return one<Profile>(
    db,
    `INSERT INTO profiles (brand_id, network, url, handle) VALUES (?, ?, ?, ?)
     ON CONFLICT (brand_id, network) DO UPDATE SET url = excluded.url, handle = excluded.handle
     RETURNING *`,
    brandId,
    network,
    canonicalUrl(network, handle),
    handle,
  )!
}

export const removeProfile = (db: DB, brandId: number, network: Network) =>
  db.prepare('DELETE FROM profiles WHERE brand_id = ? AND network = ?').run(brandId, network)

/** Updates the brand's own details; fields left undefined keep their value. */
export function updateBrand(
  db: DB,
  id: number,
  f: { name?: string; website?: string | null; industry?: string | null; description?: string | null; notes?: string | null },
) {
  for (const [col, v] of Object.entries(f)) {
    if (v === undefined || !['name', 'website', 'industry', 'description', 'notes'].includes(col)) continue
    if (col === 'name' && !String(v).trim()) throw new Error('A brand needs a name.')
    db.prepare(`UPDATE brands SET ${col} = ? WHERE id = ?`).run(v === null ? null : String(v).trim().slice(0, 4000) || null, id)
  }
}

export const renameBrand = (db: DB, id: number, name: string) =>
  db.prepare('UPDATE brands SET name = ? WHERE id = ?').run(name.trim(), id)

export const deleteBrand = (db: DB, id: number) =>
  db.prepare('DELETE FROM brands WHERE id = ?').run(id)

export const listBrands = (db: DB) => all<Brand>(db, 'SELECT * FROM brands ORDER BY name')
export const getBrand = (db: DB, id: number) =>
  one<Brand>(db, 'SELECT * FROM brands WHERE id = ?', id)
export const listProfiles = (db: DB, brandId?: number) =>
  brandId
    ? all<Profile>(db, 'SELECT * FROM profiles WHERE brand_id = ? ORDER BY network', brandId)
    : all<Profile>(db, 'SELECT * FROM profiles ORDER BY brand_id, network')

/** Records an update of a profile. `session`: it read through the signed-in session, which starts the gap. */
export function markProfile(
  db: DB,
  id: number,
  status: 'ok' | 'error',
  error: string | null = null,
  session = false,
) {
  const t = now()
  db.prepare(
    'UPDATE profiles SET last_run_at = ?, last_status = ?, last_error = ?, last_session_at = CASE WHEN ? THEN ? ELSE last_session_at END WHERE id = ?',
  ).run(t, status, error, session ? 1 : 0, t, id)
}

/** The newest post already stored for a profile: an update with range 'new' stops there. */
export const latestPostId = (db: DB, profileId: number) =>
  one<{ ext_id: string }>(
    db,
    'SELECT ext_id FROM posts WHERE profile_id = ? ORDER BY posted_at DESC, id DESC LIMIT 1',
    profileId,
  )?.ext_id ?? null

export const knownPostIds = (db: DB, profileId: number) =>
  new Set(
    all<{ ext_id: string }>(db, 'SELECT ext_id FROM posts WHERE profile_id = ?', profileId).map(
      (r) => r.ext_id,
    ),
  )

// Posts and comments

/** Stores a collected post and its comments. Counts are refreshed; AI labels on known comments are kept. */
export function savePost(
  db: DB,
  profile: Profile,
  p: CollectedPost,
): { post: Post; newComments: number } {
  const t = now()
  const post = one<Post>(
    db,
    `INSERT INTO posts (profile_id, network, ext_id, url, posted_at, kind, caption, thumb_url, likes, comments_count, shares, views, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (network, ext_id) DO UPDATE SET
       url = excluded.url, caption = excluded.caption, thumb_url = coalesce(excluded.thumb_url, thumb_url),
       likes = coalesce(excluded.likes, likes), comments_count = coalesce(excluded.comments_count, comments_count),
       shares = coalesce(excluded.shares, shares), views = coalesce(excluded.views, views),
       posted_at = coalesce(excluded.posted_at, posted_at), fetched_at = excluded.fetched_at
     RETURNING *`,
    profile.id,
    profile.network,
    p.ext_id,
    p.url,
    p.posted_at,
    p.kind,
    p.caption,
    p.thumb_url,
    p.likes,
    p.comments_count,
    p.shares,
    p.views,
    t,
  )!
  const insert = db.prepare(
    `INSERT INTO comments (post_id, ext_id, parent_ext_id, author, text, likes, posted_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (post_id, ext_id) DO UPDATE SET likes = excluded.likes, text = excluded.text`,
  )
  let newComments = 0
  for (const c of p.comments) {
    const before = db
      .prepare('SELECT 1 FROM comments WHERE post_id = ? AND ext_id = ?')
      .get(post.id, c.ext_id)
    insert.run(post.id, c.ext_id, c.parent_ext_id, c.author, c.text, c.likes, c.posted_at, t)
    if (!before) newComments++
  }
  return { post, newComments }
}

export const setReplyStatus = (db: DB, commentId: number, status: ReplyStatus) =>
  db.prepare('UPDATE comments SET reply_status = ? WHERE id = ?').run(status, commentId)

/** Sets or clears a comment's sentiment and category. `by`: a person ('you') or Claude ('ai'). */
export function setSentiment(
  db: DB,
  commentId: number,
  sentiment: 'positive' | 'negative' | null,
  category: string | null,
  by: 'you' | 'ai',
) {
  db.prepare('UPDATE comments SET sentiment = ?, category = ?, sentiment_by = ? WHERE id = ?').run(
    sentiment,
    sentiment ? category : null,
    sentiment ? by : null,
    commentId,
  )
}

export const setCategories = (db: DB, brandId: number, categories: unknown[]) =>
  db
    .prepare('UPDATE brands SET categories = ? WHERE id = ?')
    .run(JSON.stringify(categories), brandId)

export const setDescription = (db: DB, postId: number, description: string) =>
  db.prepare('UPDATE posts SET description = ? WHERE id = ?').run(description, postId)

export function setVerdict(
  db: DB,
  commentId: number,
  label: Label,
  needsReply: boolean,
  reason: string,
) {
  db.prepare('UPDATE comments SET label = ?, needs_reply = ?, reason = ? WHERE id = ?').run(
    label,
    needsReply ? 1 : 0,
    reason,
    commentId,
  )
}

export interface PostFilter {
  brandId?: number
  network?: Network
  /** 'top': most likes + comments + shares first. Default: newest first. */
  sort?: 'new' | 'top'
  limit?: number
  offset?: number
}

export function listPosts(db: DB, f: PostFilter = {}) {
  const where: string[] = []
  const args: (string | number)[] = []
  if (f.brandId) {
    where.push('pr.brand_id = ?')
    args.push(f.brandId)
  }
  if (f.network) {
    where.push('p.network = ?')
    args.push(f.network)
  }
  return all<Post & { brand_id: number; handle: string; stored_comments: number; flagged: number }>(
    db,
    `SELECT p.*, pr.brand_id, pr.handle,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id) AS stored_comments,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND (c.label = 'complaint' OR c.needs_reply = 1)) AS flagged
     FROM posts p JOIN profiles pr ON pr.id = p.profile_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${f.sort === 'top' ? 'coalesce(p.likes,0) + 3 * coalesce(p.comments_count,0) + 5 * coalesce(p.shares,0) DESC,' : ''} p.posted_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    ...args,
    f.limit ?? 50,
    f.offset ?? 0,
  )
}

export const getPost = (db: DB, id: number) => one<Post>(db, 'SELECT * FROM posts WHERE id = ?', id)

export interface CommentFilter extends PostFilter {
  postId?: number
  label?: Label
  needsReply?: boolean
  unsorted?: boolean
  search?: string
  /** 'positive', 'negative', or 'none' for comments nobody has rated. */
  sentiment?: 'positive' | 'negative' | 'none'
  category?: string
}

export function listComments(db: DB, f: CommentFilter = {}) {
  const where: string[] = []
  const args: (string | number)[] = []
  if (f.postId) {
    where.push('c.post_id = ?')
    args.push(f.postId)
  }
  if (f.brandId) {
    where.push('pr.brand_id = ?')
    args.push(f.brandId)
  }
  if (f.network) {
    where.push('p.network = ?')
    args.push(f.network)
  }
  if (f.label) {
    where.push('c.label = ?')
    args.push(f.label)
  }
  if (f.needsReply) where.push("c.needs_reply = 1 AND c.reply_status = 'open'")
  if (f.unsorted) where.push('c.label IS NULL')
  if (f.sentiment === 'none') where.push('c.sentiment IS NULL')
  else if (f.sentiment) {
    where.push('c.sentiment = ?')
    args.push(f.sentiment)
  }
  if (f.category) {
    where.push('c.category = ?')
    args.push(f.category)
  }
  if (f.search) {
    where.push('c.text LIKE ?')
    args.push(`%${f.search}%`)
  }
  return all<Comment & { network: Network; post_url: string; brand_id: number }>(
    db,
    `SELECT c.*, p.network, p.url AS post_url, pr.brand_id
     FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (c.needs_reply = 1 AND c.reply_status = 'open') DESC, c.likes DESC, c.id DESC LIMIT ? OFFSET ?`,
    ...args,
    f.limit ?? 100,
    f.offset ?? 0,
  )
}

/** Counts per label for a brand (or all brands), optionally since a time. */
/** Rated comments per sentiment and category, for one brand or all. */
export function sentimentCounts(db: DB, brandId?: number, network?: Network) {
  return all<{ sentiment: string; category: string | null; n: number }>(
    db,
    `SELECT c.sentiment, c.category, count(*) AS n
     FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
     WHERE c.sentiment IS NOT NULL AND (? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR p.network = ?)
     GROUP BY c.sentiment, c.category ORDER BY n DESC`,
    brandId ?? null,
    brandId ?? null,
    network ?? null,
    network ?? null,
  )
}

export function labelCounts(db: DB, brandId?: number, since?: string, network?: Network) {
  const rows = all<{ label: string | null; n: number; replies: number }>(
    db,
    `SELECT c.label, count(*) AS n, sum(CASE WHEN c.needs_reply = 1 AND c.reply_status = 'open' THEN 1 ELSE 0 END) AS replies
     FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
     WHERE (? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR c.fetched_at >= ?) AND (? IS NULL OR p.network = ?)
     GROUP BY c.label`,
    brandId ?? null,
    brandId ?? null,
    since ?? null,
    since ?? null,
    network ?? null,
    network ?? null,
  )
  const out: Record<string, number> = { total: 0, needs_reply: 0, unsorted: 0 }
  for (const r of rows) {
    out.total! += r.n
    out.needs_reply! += r.replies ?? 0
    if (r.label) out[r.label] = r.n
    else out.unsorted = r.n
  }
  return out
}

// Runs

export function startRun(db: DB, trigger: 'manual' | 'schedule' | 'mcp', scope: unknown) {
  return one<{ id: number }>(
    db,
    'INSERT INTO runs (trigger, scope, started_at) VALUES (?, ?, ?) RETURNING id',
    trigger,
    JSON.stringify(scope),
    now(),
  )!.id
}

export const logRun = (db: DB, id: number, line: string) =>
  db
    .prepare('UPDATE runs SET log = log || ? || char(10) WHERE id = ?')
    .run(`${new Date().toISOString().slice(11, 19)} ${line}`, id)

export function finishRun(
  db: DB,
  id: number,
  status: 'ok' | 'error' | 'partial',
  stats: unknown,
  report: string,
) {
  db.prepare('UPDATE runs SET finished_at = ?, status = ?, stats = ?, report = ? WHERE id = ?').run(
    now(),
    status,
    JSON.stringify(stats),
    report,
    id,
  )
}

export interface RunRow {
  id: number
  trigger: string
  scope: string
  started_at: string
  finished_at: string | null
  status: string
  log: string
  stats: string | null
  report: string | null
}
export const listRuns = (db: DB, limit = 30) =>
  all<Omit<RunRow, 'log' | 'report'>>(
    db,
    'SELECT id, trigger, scope, started_at, finished_at, status, stats FROM runs ORDER BY id DESC LIMIT ?',
    limit,
  )
export const getRun = (db: DB, id: number) => one<RunRow>(db, 'SELECT * FROM runs WHERE id = ?', id)

/** Runs left "running" by a closed app are marked as interrupted when it starts again. */
export const closeStaleRuns = (db: DB) =>
  db
    .prepare(
      "UPDATE runs SET status = 'error', finished_at = ?, log = log || 'Interrupted: the app closed.' WHERE status = 'running'",
    )
    .run(now())

// Schedules

const toSchedule = (r: Row): Schedule => ({
  ...(r as unknown as Schedule),
  times: JSON.parse(r.times as string),
  networks: JSON.parse(r.networks as string),
})

export const listSchedules = (db: DB, brandId?: number) =>
  all<Row>(
    db,
    'SELECT * FROM schedules WHERE (? IS NULL OR brand_id = ?) ORDER BY id',
    brandId ?? null,
    brandId ?? null,
  ).map(toSchedule)

export interface ScheduleInput {
  brand_id: number
  kind: ScheduleKind
  every_hours?: number | null
  times?: string[]
  networks: Network[]
  range?: Range
  enabled?: boolean
}

export function saveSchedule(db: DB, s: ScheduleInput, id?: number): Schedule {
  if (s.kind === 'interval' && !(s.every_hours && s.every_hours >= 1))
    throw new Error('Every: at least 1 hour.')
  if (
    s.kind === 'times' &&
    !(s.times?.length && s.times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
  )
    throw new Error('Times: one or more, as HH:MM.')
  const args = [
    s.brand_id,
    s.kind,
    s.kind === 'interval' ? s.every_hours! : null,
    JSON.stringify(s.kind === 'times' ? [...new Set(s.times)].sort() : []),
    JSON.stringify(s.networks),
    s.range ?? 'new',
    s.enabled === false ? 0 : 1,
  ] as const
  const row = id
    ? one<Row>(
        db,
        'UPDATE schedules SET brand_id=?, kind=?, every_hours=?, times=?, networks=?, range=?, enabled=?, next_run_at=NULL WHERE id=? RETURNING *',
        ...args,
        id,
      )
    : one<Row>(
        db,
        'INSERT INTO schedules (brand_id, kind, every_hours, times, networks, range, enabled) VALUES (?,?,?,?,?,?,?) RETURNING *',
        ...args,
      )
  if (!row) throw new Error('No such schedule.')
  return toSchedule(row)
}

export const deleteSchedule = (db: DB, id: number) =>
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id)
export const setNextRun = (db: DB, id: number, at: string | null) =>
  db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(at, id)

// Settings

export const getSetting = (db: DB, key: string) =>
  one<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? null
export const setSetting = (db: DB, key: string, value: string) =>
  db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value)
