import type { DB } from './db.ts'
import { now } from './db.ts'

/**
 * A brand's campaigns and the posts in them. A post joins a campaign three ways: its caption
 * carries one of the campaign's hashtags or keywords inside its dates ('rule'), Claude picks it
 * for a post the hints did not place ('ai'), or a person sets it ('you'). A person's choice,
 * in or out, is never overwritten.
 */

export interface Campaign {
  id: number
  brand_id: number
  name: string
  starts_on: string | null
  ends_on: string | null
  /** JSON: string[], lower case, without # */
  hashtags: string
  /** JSON: string[], lower case */
  keywords: string
  about: string | null
  created_at: string
  updated_at: string
}

/** What the matching reads of a campaign. */
export interface Rule {
  id: number
  starts_on: string | null
  ends_on: string | null
  hashtags: string[]
  keywords: string[]
}

export const toRule = (c: Campaign): Rule => ({
  id: c.id,
  starts_on: c.starts_on,
  ends_on: c.ends_on,
  hashtags: JSON.parse(c.hashtags || '[]') as string[],
  keywords: JSON.parse(c.keywords || '[]') as string[],
})

/** The hashtags in a text, lower case and without #, in any alphabet. */
export const hashtagsOf = (text: string) =>
  new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!.toLowerCase()))

/** The word or phrase on its own in the text, not inside a longer word; any alphabet. */
const hasWord = (text: string, word: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
    'iu',
  ).test(text)

/** Whether a post published at `at` falls inside the campaign's dates (none: always). */
export function inRange(c: Pick<Rule, 'starts_on' | 'ends_on'>, at: string | null) {
  if (!c.starts_on && !c.ends_on) return true
  if (!at) return false
  const day = at.slice(0, 10)
  return (!c.starts_on || day >= c.starts_on) && (!c.ends_on || day <= c.ends_on)
}

/**
 * The campaigns whose hints a post carries, inside their dates. A campaign without hashtags or
 * keywords never matches by rule; Claude or a person places posts in it.
 */
export function ruleMatches(post: { caption: string; posted_at: string | null }, rules: Rule[]) {
  const tags = hashtagsOf(post.caption)
  return rules
    .filter(
      (c) =>
        inRange(c, post.posted_at) &&
        (c.hashtags.some((h) => tags.has(h)) || c.keywords.some((k) => hasWord(post.caption, k))),
    )
    .map((c) => c.id)
}

const list = (v: unknown, hash: boolean) =>
  [
    ...new Set(
      (Array.isArray(v) ? v.map(String) : String(v ?? '').split(hash ? /[\s,]+/ : /[,\n]+/))
        .map((s) =>
          s
            .trim()
            .replace(hash ? /^#+/ : /^$/, '')
            .toLowerCase(),
        )
        .filter((s) => s.length >= 2 && s.length <= 80),
    ),
  ].slice(0, 20)
const day = (v: unknown) => {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))
    throw new Error('Dates are YYYY-MM-DD.')
  return s
}

export interface CampaignInput {
  name?: unknown
  starts_on?: unknown
  ends_on?: unknown
  hashtags?: unknown
  keywords?: unknown
  about?: unknown
}

/** Checks and tidies what a person typed: hashtags split on spaces or commas, keywords on commas. */
export function cleanCampaign(x: CampaignInput) {
  const name = String(x.name ?? '').trim()
  if (!name) throw new Error('Name the campaign.')
  if (name.length > 80) throw new Error('A campaign name is at most 80 characters.')
  const starts_on = day(x.starts_on)
  const ends_on = day(x.ends_on)
  if (starts_on && ends_on && starts_on > ends_on) throw new Error('The start is after the end.')
  return {
    name,
    starts_on,
    ends_on,
    hashtags: list(x.hashtags, true),
    keywords: list(x.keywords, false),
    about:
      String(x.about ?? '')
        .trim()
        .slice(0, 300) || null,
  }
}

export const getCampaign = (db: DB, id: number) =>
  db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined

/** The brand's campaigns, newest first, with how many posts each holds. */
export const listCampaigns = (db: DB, brandId: number) =>
  db
    .prepare(
      `SELECT c.*, (SELECT count(*) FROM post_campaigns pc WHERE pc.campaign_id = c.id AND pc.member = 1) AS posts
       FROM campaigns c WHERE c.brand_id = ? ORDER BY coalesce(c.starts_on, c.created_at) DESC, c.id DESC`,
    )
    .all(brandId) as unknown as (Campaign & { posts: number })[]

/** Adds a campaign, or changes one, then places the brand's posts by the hints again. */
export function saveCampaign(db: DB, brandId: number, x: CampaignInput, id?: number) {
  const c = cleanCampaign(x)
  const t = now()
  const clash = db
    .prepare('SELECT id FROM campaigns WHERE brand_id = ? AND name = ? AND id != ?')
    .get(brandId, c.name, id ?? 0)
  if (clash) throw new Error('This brand already has a campaign with that name.')
  const args = [
    c.name,
    c.starts_on,
    c.ends_on,
    JSON.stringify(c.hashtags),
    JSON.stringify(c.keywords),
    c.about,
    t,
  ]
  const row = id
    ? (db
        .prepare(
          'UPDATE campaigns SET name = ?, starts_on = ?, ends_on = ?, hashtags = ?, keywords = ?, about = ?, updated_at = ? WHERE id = ? AND brand_id = ? RETURNING *',
        )
        .get(...args, id, brandId) as Campaign | undefined)
    : (db
        .prepare(
          'INSERT INTO campaigns (name, starts_on, ends_on, hashtags, keywords, about, updated_at, brand_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
        )
        .get(...args, brandId, t) as unknown as Campaign)
  if (!row) throw new Error('No such campaign.')
  placeBrand(db, brandId)
  return row
}

export const deleteCampaign = (db: DB, id: number) =>
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(id)

/** A post's campaigns: every campaign of its brand, and whether the post is in it and who said so. */
export function postCampaigns(db: DB, postId: number) {
  return db
    .prepare(
      `SELECT c.id, c.name, pc.set_by, coalesce(pc.member, 0) AS member
       FROM posts p JOIN profiles pr ON pr.id = p.profile_id JOIN campaigns c ON c.brand_id = pr.brand_id
         LEFT JOIN post_campaigns pc ON pc.post_id = p.id AND pc.campaign_id = c.id
       WHERE p.id = ? ORDER BY coalesce(c.starts_on, c.created_at) DESC, c.id DESC`,
    )
    .all(postId) as { id: number; name: string; set_by: string | null; member: 0 | 1 }[]
}

/** A person puts a post in a campaign or takes it out. Kept as theirs, so nothing undoes it. */
export function setPostCampaign(db: DB, postId: number, campaignId: number, member: boolean) {
  const same = db
    .prepare(
      `SELECT 1 FROM posts p JOIN profiles pr ON pr.id = p.profile_id JOIN campaigns c ON c.brand_id = pr.brand_id
       WHERE p.id = ? AND c.id = ?`,
    )
    .get(postId, campaignId)
  if (!same) throw new Error("That campaign is not this post's brand's.")
  db.prepare(
    `INSERT INTO post_campaigns (post_id, campaign_id, set_by, member) VALUES (?, ?, 'you', ?)
     ON CONFLICT (post_id, campaign_id) DO UPDATE SET set_by = 'you', member = excluded.member`,
  ).run(postId, campaignId, member ? 1 : 0)
}

const rulesOf = (db: DB, brandId: number) =>
  (
    db.prepare('SELECT * FROM campaigns WHERE brand_id = ?').all(brandId) as unknown as Campaign[]
  ).map(toRule)
const autoOn = (db: DB, brandId: number) =>
  (
    db.prepare('SELECT campaign_auto FROM brands WHERE id = ?').get(brandId) as
      { campaign_auto: number } | undefined
  )?.campaign_auto === 1
const add = (db: DB, postId: number, campaignId: number, by: 'rule' | 'ai') =>
  db
    .prepare(
      `INSERT INTO post_campaigns (post_id, campaign_id, set_by, member) VALUES (?, ?, ?, 1)
       ON CONFLICT (post_id, campaign_id) DO NOTHING`,
    )
    .run(postId, campaignId, by)

/** Places one post by the hints, when the brand assigns posts by itself. Runs as a post is saved. */
export function placePost(db: DB, postId: number) {
  const p = db
    .prepare(
      'SELECT p.id, p.caption, p.posted_at, pr.brand_id FROM posts p JOIN profiles pr ON pr.id = p.profile_id WHERE p.id = ?',
    )
    .get(postId) as
    { id: number; caption: string; posted_at: string | null; brand_id: number } | undefined
  if (!p || !autoOn(db, p.brand_id)) return
  for (const id of ruleMatches(p, rulesOf(db, p.brand_id))) add(db, p.id, id, 'rule')
}

/**
 * Places every post of a brand by the hints again, after its campaigns changed or the switch
 * turned on. With the switch off, what is placed stays as it is.
 */
export function placeBrand(db: DB, brandId: number) {
  if (!autoOn(db, brandId)) return
  db.prepare(
    `DELETE FROM post_campaigns WHERE set_by = 'rule' AND campaign_id IN (SELECT id FROM campaigns WHERE brand_id = ?)`,
  ).run(brandId)
  const rules = rulesOf(db, brandId)
  if (!rules.length) return
  const posts = db
    .prepare(
      'SELECT p.id, p.caption, p.posted_at FROM posts p JOIN profiles pr ON pr.id = p.profile_id WHERE pr.brand_id = ?',
    )
    .all(brandId) as { id: number; caption: string; posted_at: string | null }[]
  for (const p of posts) for (const id of ruleMatches(p, rules)) add(db, p.id, id, 'rule')
}

/**
 * Reads "n|id" or "n|-" lines: the campaign Claude picked for post n, or null for none. Lines
 * naming a campaign that was not offered, or anything else, are ignored.
 */
export function parsePicks(text: string, offered: Set<number>): Map<number, number | null> {
  const out = new Map<number, number | null>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s*\|\s*(\d+|-)\s*$/.exec(line)
    if (!m) continue
    const pick = m[2] === '-' ? null : Number(m[2])
    if (pick === null || offered.has(pick)) out.set(Number(m[1]), pick)
  }
  return out
}

/** Asks the AI, for numbered posts against the brand's campaigns; returns its raw answer. */
export type AskCampaigns = (
  brand: string,
  campaigns: { id: number; name: string; hints: string }[],
  posts: { caption: string; about: string | null }[],
  brandId: number,
) => Promise<string>

/**
 * Claude's turn, for posts the hints placed nowhere and no person has decided on, in brands that
 * assign posts by themselves. A post is asked about once per version of the brand's campaigns.
 * A pick outside the campaign's dates is dropped. Returns how many posts it placed.
 */
export async function placeByAi(db: DB, postIds: number[], ask: AskCampaigns) {
  if (!postIds.length) return 0
  const rows = db
    .prepare(
      `SELECT p.id, p.caption, p.description AS about, p.posted_at, p.campaign_ai_at, pr.brand_id, b.name AS brand
       FROM posts p JOIN profiles pr ON pr.id = p.profile_id JOIN brands b ON b.id = pr.brand_id
       WHERE p.id IN (SELECT value FROM json_each(?)) AND b.campaign_auto = 1
         AND NOT EXISTS (SELECT 1 FROM post_campaigns pc WHERE pc.post_id = p.id)`,
    )
    .all(JSON.stringify(postIds)) as {
    id: number
    caption: string
    about: string | null
    posted_at: string | null
    campaign_ai_at: string | null
    brand_id: number
    brand: string
  }[]
  let placed = 0
  for (const brandId of new Set(rows.map((r) => r.brand_id))) {
    const campaigns = db
      .prepare('SELECT * FROM campaigns WHERE brand_id = ?')
      .all(brandId) as unknown as Campaign[]
    if (!campaigns.length) continue
    const changed = campaigns.reduce((m, c) => (c.updated_at > m ? c.updated_at : m), '')
    const todo = rows.filter(
      (r) => r.brand_id === brandId && !(r.campaign_ai_at && r.campaign_ai_at >= changed),
    )
    const offer = campaigns.map((c) => {
      const r = toRule(c)
      const dates = c.starts_on || c.ends_on ? `${c.starts_on ?? '…'} to ${c.ends_on ?? '…'}` : ''
      return {
        id: c.id,
        name: c.name,
        hints: [r.hashtags.map((h) => `#${h}`).join(' '), r.keywords.join(', '), dates, c.about]
          .filter(Boolean)
          .join('; '),
      }
    })
    const rules = new Map(campaigns.map((c) => [c.id, toRule(c)]))
    for (let i = 0; i < todo.length; i += 25) {
      const batch = todo.slice(i, i + 25)
      const picks = parsePicks(
        await ask(batch[0]!.brand, offer, batch, brandId),
        new Set(campaigns.map((c) => c.id)),
      )
      for (const [n, id] of picks) {
        const post = batch[n - 1]
        if (!post || id === null || !inRange(rules.get(id)!, post.posted_at)) continue
        if (add(db, post.id, id, 'ai').changes) placed++
      }
      const t = now()
      for (const p of batch)
        db.prepare('UPDATE posts SET campaign_ai_at = ? WHERE id = ?').run(t, p.id)
    }
  }
  return placed
}
