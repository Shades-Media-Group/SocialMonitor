import type { DB } from './db.ts'
import { closeAnswered, now } from './db.ts'
import { changed } from './events.ts'
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
  Tracker,
} from './types.ts'
import { NETWORKS, scheduleRange } from './types.ts'
import { TEMPLATES } from './categories.ts'
import { placeBrand, placePost } from './campaigns.ts'

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
  f: {
    name?: string
    website?: string | null
    industry?: string | null
    description?: string | null
    notes?: string | null
    reply_target_hours?: number
    ai_sort?: boolean
    campaign_auto?: boolean
  },
) {
  const { reply_target_hours: hours, ai_sort: ai, campaign_auto: auto, ...text } = f
  if (ai !== undefined) db.prepare('UPDATE brands SET ai_sort = ? WHERE id = ?').run(ai ? 1 : 0, id)
  if (auto !== undefined) {
    db.prepare('UPDATE brands SET campaign_auto = ? WHERE id = ?').run(auto ? 1 : 0, id)
    placeBrand(db, id)
  }
  if (hours !== undefined) {
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30)
      throw new Error('The reply target is between 1 hour and 30 days.')
    db.prepare('UPDATE brands SET reply_target_hours = ? WHERE id = ?').run(hours, id)
  }
  for (const [col, v] of Object.entries(text)) {
    if (v === undefined || !['name', 'website', 'industry', 'description', 'notes'].includes(col))
      continue
    if (col === 'name' && !String(v).trim()) throw new Error('A brand needs a name.')
    db.prepare(`UPDATE brands SET ${col} = ? WHERE id = ?`).run(
      v === null ? null : String(v).trim().slice(0, 4000) || null,
      id,
    )
  }
}

export const renameBrand = (db: DB, id: number, name: string) =>
  db.prepare('UPDATE brands SET name = ? WHERE id = ?').run(name.trim(), id)

export const deleteBrand = (db: DB, id: number) =>
  db.prepare('DELETE FROM brands WHERE id = ?').run(id)

export const listBrands = (db: DB) => all<Brand>(db, 'SELECT * FROM brands ORDER BY name')

/** The rivals a brand watches, by name. */
export const listCompetitors = (db: DB, brandId: number) =>
  all<Brand>(db, 'SELECT * FROM brands WHERE competitor_of = ? ORDER BY name', brandId)

/** Brands with the rivals each one watches, for updates: reading a brand reads its rivals too. */
export const withCompetitors = (db: DB, brandIds: number[]) => [
  ...new Set(brandIds.flatMap((id) => [id, ...listCompetitors(db, id).map((c) => c.id)])),
]

/**
 * Adds a rival to a brand from its public profile links. It takes the brand's categories, so
 * comments on both are sorted the same way. Five at most: the charts have six colours.
 */
export function addCompetitor(db: DB, brandId: number, name: string, links: string[]) {
  const owner = getBrand(db, brandId)
  if (!owner || owner.competitor_of) throw new Error('Rivals belong to one of your brands.')
  if (!name.trim()) throw new Error('Name the rival.')
  if (!links.filter(Boolean).length) throw new Error('Add at least one profile link.')
  if (listCompetitors(db, brandId).length >= 5)
    throw new Error('A brand watches five rivals at most.')
  if (one(db, 'SELECT id FROM brands WHERE lower(name) = lower(?)', name.trim()))
    throw new Error('There is already a brand with this name.')
  for (const link of links.filter(Boolean)) parseProfile(link)
  const brand = addBrand(db, name, links, null, JSON.parse(owner.categories || '[]'))
  db.prepare('UPDATE brands SET competitor_of = ? WHERE id = ?').run(brandId, brand.id)
  return { ...brand, competitor_of: brandId }
}
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

/**
 * Posts an update can skip: those whose comments were already read with photos and pictures,
 * or that have none. Older posts are read once more so their comments get them too.
 */
export const knownPostIds = (db: DB, profileId: number) =>
  new Set(
    all<{ ext_id: string }>(
      db,
      `SELECT ext_id FROM posts WHERE profile_id = ?
         AND (people_read_at IS NOT NULL OR coalesce(comments_count, 0) = 0)`,
      profileId,
    ).map((r) => r.ext_id),
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
  recordMetrics(db, post, t)
  placePost(db, post.id)
  const insert = db.prepare(
    `INSERT INTO comments (post_id, ext_id, parent_ext_id, author, text, likes, posted_at, fetched_at,
       author_avatar, author_url, media_url, author_followers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (post_id, ext_id) DO UPDATE SET likes = excluded.likes, text = excluded.text,
       author_avatar = coalesce(excluded.author_avatar, author_avatar),
       author_url = coalesce(excluded.author_url, author_url),
       media_url = coalesce(excluded.media_url, media_url),
       author_followers = coalesce(excluded.author_followers, author_followers)`,
  )
  let newComments = 0
  for (const c of p.comments) {
    const before = db
      .prepare('SELECT 1 FROM comments WHERE post_id = ? AND ext_id = ?')
      .get(post.id, c.ext_id)
    insert.run(
      post.id,
      c.ext_id,
      c.parent_ext_id,
      c.author,
      c.text,
      c.likes,
      c.posted_at,
      t,
      c.author_avatar ?? null,
      c.author_url ?? null,
      c.media_url ?? null,
      c.author_followers ?? null,
    )
    if (!before) newComments++
  }
  if (p.comments.length)
    db.prepare('UPDATE posts SET people_read_at = ? WHERE id = ?').run(t, post.id)
  closeAnswered(db, post.id)
  return { post, newComments }
}

/** Keeps the post's numbers in its history when they changed since the last row. */
function recordMetrics(db: DB, post: Post, at: string) {
  const nums = [post.likes, post.comments_count, post.shares, post.views]
  if (nums.every((n) => n == null)) return
  const last = db
    .prepare(
      'SELECT likes, comments, shares, views FROM post_metrics WHERE post_id = ? ORDER BY at DESC LIMIT 1',
    )
    .get(post.id) as { likes: number; comments: number; shares: number; views: number } | undefined
  if (!last || [last.likes, last.comments, last.shares, last.views].some((n, i) => n !== nums[i]))
    db.prepare(
      'INSERT OR REPLACE INTO post_metrics (post_id, at, likes, comments, shares, views) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(post.id, at, ...nums)
  db.prepare('UPDATE posts SET metrics_at = ? WHERE id = ?').run(at, post.id)
}

/**
 * Posts whose numbers are due for a fresh read, by age: under a week old, every update; under a
 * month, weekly; under a year, monthly; older, every three months. The most overdue come first,
 * at most `cap`, so an update stays light; the rest wait for the next one.
 */
export function duePosts(db: DB, profileId: number, cap = 20) {
  return all<{ ext_id: string; comments_count: number | null; posted_at: string | null }>(
    db,
    `SELECT ext_id, comments_count, posted_at FROM posts p,
       (SELECT julianday('now') - julianday(coalesce(p2.posted_at, p2.fetched_at)) AS age,
               julianday('now') - julianday(coalesce(p2.metrics_at, '1970-01-01')) AS since, p2.id AS pid
        FROM posts p2 WHERE p2.profile_id = ?) a
     WHERE a.pid = p.id
       AND (a.age < 7 OR (a.age < 30 AND a.since >= 7) OR (a.age < 365 AND a.since >= 30) OR a.since >= 90)
     ORDER BY a.since DESC LIMIT ?`,
    profileId,
    cap,
  )
}

/** A post's numbers over time, oldest first. */
/** Every reading of every post of a brand, oldest first: the history behind the Statistics tab. */
export const brandHistory = (db: DB, brandId: number, network?: Network) =>
  all<{
    post_id: number
    at: string
    likes: number | null
    comments: number | null
    shares: number | null
    views: number | null
  }>(
    db,
    `SELECT m.post_id, m.at, m.likes, m.comments, m.shares, m.views FROM post_metrics m
       JOIN posts p ON p.id = m.post_id JOIN profiles pr ON pr.id = p.profile_id
     WHERE pr.brand_id = ?${network ? ' AND p.network = ?' : ''} ORDER BY m.post_id, m.at`,
    ...(network ? [brandId, network] : [brandId]),
  )

export const postMetrics = (db: DB, postId: number) =>
  all<{
    at: string
    likes: number | null
    comments: number | null
    shares: number | null
    views: number | null
  }>(
    db,
    'SELECT at, likes, comments, shares, views FROM post_metrics WHERE post_id = ? ORDER BY at',
    postId,
  )

/** Marks a comment answered, skipped or open again, and who did it. */
export const setReplyStatus = (db: DB, commentId: number, status: ReplyStatus, userId?: number) =>
  db
    .prepare(
      `UPDATE comments SET reply_status = ?, done_by = ?,
         answered_at = CASE WHEN ? = 'done' THEN coalesce(answered_at, ?) ELSE NULL END,
         answered_by = CASE WHEN ? = 'done' THEN coalesce(answered_by, 'user') ELSE NULL END
       WHERE id = ?`,
    )
    .run(status, status === 'open' ? null : (userId ?? null), status, now(), status, commentId)

/** A waiting comment older than its brand's reply target, in SQL over c, b. */
const OVERDUE = `(c.needs_reply = 1 AND c.reply_status = 'open'
  AND (julianday('now') - julianday(coalesce(c.posted_at, c.fetched_at))) * 24 > b.reply_target_hours)`

/** Open comments that need a reply and are older than the brand's reply target. */
export function overdueCount(db: DB, brandId: number, network?: Network) {
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id
           JOIN profiles pr ON pr.id = p.profile_id JOIN brands b ON b.id = pr.brand_id
         WHERE pr.brand_id = ? AND (? IS NULL OR p.network = ?) AND ${OVERDUE}`,
      )
      .get(brandId, network ?? null, network ?? null) as { n: number }
  ).n
}

/** Sets or clears a comment's sentiment and category. `by`: a person ('you') or Claude ('ai'). */
export function setSentiment(
  db: DB,
  commentId: number,
  sentiment: 'positive' | 'negative' | 'neutral' | null,
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

/** Keeps up to 40 distinct words of 2–60 characters; anything else is dropped. */
export function setTrackers(db: DB, brandId: number, list: unknown): Tracker[] {
  const kinds = ['product', 'competitor', 'topic']
  const seen = new Set<string>()
  const clean: Tracker[] = []
  for (const x of Array.isArray(list) ? list : []) {
    const term = String((x as Tracker)?.term ?? '')
      .trim()
      .slice(0, 60)
    const kind = kinds.includes((x as Tracker)?.kind) ? (x as Tracker).kind : 'topic'
    if (term.length < 2 || seen.has(term.toLowerCase()) || clean.length >= 40) continue
    seen.add(term.toLowerCase())
    clean.push({ term, kind })
  }
  db.prepare('UPDATE brands SET trackers = ? WHERE id = ?').run(JSON.stringify(clean), brandId)
  return clean
}

export const setDescription = (db: DB, postId: number, description: string) =>
  db.prepare('UPDATE posts SET description = ? WHERE id = ?').run(description, postId)

/**
 * The AI sort's version. Raise it when the sort learns to read more (the thread, pictures, emoji,
 * the post), and every comment sorted by an older version is sorted again on the next update.
 */
export const SORT_VERSION = 3

/** A comment the AI has not read yet, or read with an older version of the sort. */
export const STALE = `(c.label IS NULL OR coalesce(c.sort_v, 0) < ${SORT_VERSION})`

export function setVerdict(
  db: DB,
  commentId: number,
  label: Label,
  needsReply: boolean,
  reason: string,
  urgency?: number | null,
  emotion?: string | null,
) {
  db.prepare(
    `UPDATE comments SET label = ?, needs_reply = ?, reason = ?,
       urgency = coalesce(?, urgency), emotion = coalesce(?, emotion), sort_v = ? WHERE id = ?`,
  ).run(
    label,
    needsReply ? 1 : 0,
    reason,
    urgency ?? null,
    emotion ?? null,
    SORT_VERSION,
    commentId,
  )
}

export interface PostFilter {
  brandId?: number
  network?: Network
  /** 'top': most likes + comments + shares first; 'growth': most gained in 7 days. Default: newest. */
  sort?: 'new' | 'top' | 'growth'
  /** Only posts in this campaign (and, for comments, only comments under them). */
  campaignId?: number
  limit?: number
  offset?: number
}

const IN_CAMPAIGN =
  'p.id IN (SELECT post_id FROM post_campaigns WHERE campaign_id = ? AND member = 1)'

const WEEK_AGO = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')"

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
  if (f.campaignId) {
    where.push(IN_CAMPAIGN)
    args.push(f.campaignId)
  }
  return all<
    Post & {
      brand_id: number
      handle: string
      stored_comments: number
      flagged: number
      n_complaint: number
      n_question: number
      n_suggestion: number
      n_praise: number
      n_other: number
      waiting: number
      /** Likes, comments and shares it gained in the last 7 days, and views; null with no history. */
      grew_7d: number | null
      views_7d: number | null
      /** JSON: the ids of the campaigns it is in. */
      campaign_ids: string
    }
  >(
    db,
    `SELECT p.*, pr.brand_id, pr.handle,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id) AS stored_comments,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND (c.label = 'complaint' OR c.needs_reply = 1)) AS flagged,
       -- What people said under the post, without the brand's own replies.
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND lower(c.author) != lower(pr.handle) AND c.label = 'complaint') AS n_complaint,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND lower(c.author) != lower(pr.handle) AND c.label = 'question') AS n_question,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND lower(c.author) != lower(pr.handle) AND c.label = 'suggestion') AS n_suggestion,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND lower(c.author) != lower(pr.handle) AND c.label = 'praise') AS n_praise,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND lower(c.author) != lower(pr.handle)
          AND (c.label IS NULL OR c.label NOT IN ('complaint', 'question', 'suggestion', 'praise'))) AS n_other,
       (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.needs_reply = 1 AND c.reply_status = 'open') AS waiting,
       -- Growth over 7 days: now against the last reading a week ago, or the first one since.
       coalesce(p.likes, 0) + coalesce(p.comments_count, 0) + coalesce(p.shares, 0) - coalesce(
         (SELECT coalesce(m.likes, 0) + coalesce(m.comments, 0) + coalesce(m.shares, 0) FROM post_metrics m
            WHERE m.post_id = p.id AND m.at <= ${WEEK_AGO} ORDER BY m.at DESC LIMIT 1),
         (SELECT coalesce(m.likes, 0) + coalesce(m.comments, 0) + coalesce(m.shares, 0) FROM post_metrics m
            WHERE m.post_id = p.id ORDER BY m.at LIMIT 1)) AS grew_7d,
       p.views - coalesce(
         (SELECT m.views FROM post_metrics m WHERE m.post_id = p.id AND m.at <= ${WEEK_AGO} ORDER BY m.at DESC LIMIT 1),
         (SELECT m.views FROM post_metrics m WHERE m.post_id = p.id ORDER BY m.at LIMIT 1)) AS views_7d,
       (SELECT json_group_array(pc.campaign_id) FROM post_campaigns pc WHERE pc.post_id = p.id AND pc.member = 1) AS campaign_ids
     FROM posts p JOIN profiles pr ON pr.id = p.profile_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${f.sort === 'top' ? 'coalesce(p.likes,0) + 3 * coalesce(p.comments_count,0) + 5 * coalesce(p.shares,0) DESC,' : f.sort === 'growth' ? 'grew_7d IS NULL, grew_7d DESC, views_7d DESC,' : ''} p.posted_at DESC, p.id DESC LIMIT ? OFFSET ?`,
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
  /** Not sorted yet, or sorted by an older version of the AI sort. */
  stale?: boolean
  search?: string
  /** 'positive', 'negative', 'neutral', or 'none' for comments nobody has rated. */
  sentiment?: 'positive' | 'negative' | 'neutral' | 'none'
  category?: string
  /** Leave out the brand's own replies (its account's comments). */
  others?: boolean
  /** Only comments waiting longer than the brand's reply target. */
  overdue?: boolean
  /** Only comments written on this day, YYYY-MM-DD (UTC). */
  day?: string
  /** Only waiting comments the AI marked urgent. */
  urgent?: boolean
  /** Also return the replies under every comment found, whatever the filters, so threads stay whole. */
  threads?: boolean
  /** Only negative comments: rated negative or sorted as complaints. */
  bad?: boolean
  /** Only comments written since, or read since (new in an update), ISO times. */
  from?: string
  readSince?: string
  /** Only comments by this person (their name or handle, any case). */
  author?: string
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
  if (f.campaignId) {
    where.push(IN_CAMPAIGN)
    args.push(f.campaignId)
  }
  if (f.label) {
    where.push('c.label = ?')
    args.push(f.label)
  }
  if (f.needsReply) where.push("c.needs_reply = 1 AND c.reply_status = 'open'")
  if (f.unsorted) where.push('c.label IS NULL')
  if (f.stale) where.push(STALE)
  if (f.overdue) where.push(OVERDUE)
  if (f.bad) where.push("(c.sentiment = 'negative' OR c.label = 'complaint')")
  if (f.from) {
    where.push('coalesce(c.posted_at, c.fetched_at) >= ?')
    args.push(f.from)
  }
  if (f.author) {
    where.push('lower(c.author) = lower(?)')
    args.push(f.author)
  }
  if (f.readSince) {
    where.push('c.fetched_at >= ?')
    args.push(f.readSince)
  }
  if (f.urgent) where.push("c.needs_reply = 1 AND c.reply_status = 'open' AND c.urgency = 2")
  if (f.day && /^\d{4}-\d{2}-\d{2}$/.test(f.day)) {
    where.push('substr(coalesce(c.posted_at, c.fetched_at), 1, 10) = ?')
    args.push(f.day)
  }
  if (f.others) where.push('lower(c.author) != lower(pr.handle)')
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
  type Row = Comment & {
    network: Network
    post_url: string
    brand_id: number
    overdue: 0 | 1
    post_thumb: string | null
    post_about: string | null
  }
  const SELECT = `SELECT c.*, p.network, p.url AS post_url, pr.brand_id, ${OVERDUE} AS overdue,
       p.thumb_url AS post_thumb, coalesce(p.description, p.caption) AS post_about
     FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
       JOIN brands b ON b.id = pr.brand_id`
  const rows = all<Row>(
    db,
    `${SELECT}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (c.needs_reply = 1 AND c.reply_status = 'open') DESC,
       (c.needs_reply = 1 AND c.reply_status = 'open') * coalesce(c.urgency, 0) DESC,
       c.likes DESC, c.id DESC LIMIT ? OFFSET ?`,
    ...args,
    f.limit ?? 100,
    f.offset ?? 0,
  )
  if (!f.threads || !rows.length) return rows
  // The replies under what was found, in the order they were written.
  const seen = new Set(rows.map((r) => r.id))
  const replies = all<Row>(
    db,
    `${SELECT} WHERE EXISTS (SELECT 1 FROM json_each(?) j
       WHERE json_extract(j.value, '$[0]') = c.post_id AND json_extract(j.value, '$[1]') = c.parent_ext_id)
     ORDER BY coalesce(c.posted_at, c.fetched_at)`,
    JSON.stringify(rows.map((r) => [r.post_id, r.ext_id])),
  ).filter((r) => !seen.has(r.id))
  return [...rows, ...replies]
}

/** Counts per label for a brand (or all brands), optionally since a time. */
/** Rated comments per sentiment and category, for one brand or all. */
export function sentimentCounts(db: DB, brandId?: number, network?: Network, campaignId?: number) {
  return all<{ sentiment: string; category: string | null; n: number }>(
    db,
    `SELECT c.sentiment, c.category, count(*) AS n
     FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
     WHERE c.sentiment IS NOT NULL AND (? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR p.network = ?)
       AND (? IS NULL OR ${IN_CAMPAIGN})
     GROUP BY c.sentiment, c.category ORDER BY n DESC`,
    brandId ?? null,
    brandId ?? null,
    network ?? null,
    network ?? null,
    campaignId ?? null,
    campaignId ?? null,
  )
}

export function labelCounts(db: DB, brandId?: number, since?: string, network?: Network) {
  const rows = all<{ label: string | null; n: number; replies: number }>(
    db,
    `SELECT c.label, count(*) AS n, sum(CASE WHEN c.needs_reply = 1 AND c.reply_status = 'open' THEN 1 ELSE 0 END) AS replies
     FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id
     WHERE (? IS NULL OR pr.brand_id = ?) AND (? IS NULL OR c.fetched_at >= ?) AND (? IS NULL OR p.network = ?)
       AND lower(c.author) != lower(pr.handle)
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

/** Where a running update is, for the notice every open dashboard shows. */
export function setProgress(db: DB, id: number, progress: Record<string, unknown>) {
  db.prepare('UPDATE runs SET progress = ? WHERE id = ?').run(JSON.stringify(progress), id)
  changed()
}

export const askStop = (db: DB, id: number) =>
  db.prepare("UPDATE runs SET stop = 1 WHERE id = ? AND status = 'running'").run(id)

export const stopAsked = (db: DB, id: number) =>
  !!(db.prepare('SELECT stop FROM runs WHERE id = ?').get(id) as { stop: number } | undefined)?.stop

export function logRun(db: DB, id: number, line: string) {
  db.prepare('UPDATE runs SET log = log || ? || char(10) WHERE id = ?').run(
    `${new Date().toISOString().slice(11, 19)} ${line}`,
    id,
  )
  changed()
}

export function finishRun(
  db: DB,
  id: number,
  status: 'ok' | 'error' | 'partial' | 'stopped' | 'postponed',
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
  changed()
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
    'SELECT id, trigger, scope, started_at, finished_at, status, stats, progress FROM runs ORDER BY id DESC LIMIT ?',
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
  range: scheduleRange(r.range),
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
  enabled?: boolean | 0 | 1
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
    // 'new' always ran as 'due' (new posts plus the numbers that are due); it is stored as such.
    scheduleRange(s.range),
    s.enabled === false || s.enabled === 0 ? 0 : 1,
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
/** Turns one schedule on or off, with the next start it now has (null when off). */
export const setScheduleEnabled = (db: DB, id: number, enabled: boolean, nextAt: string | null) =>
  db
    .prepare('UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, nextAt, id)

// Settings

export const getSetting = (db: DB, key: string) =>
  one<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? null
export const setSetting = (db: DB, key: string, value: string) =>
  db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value)
