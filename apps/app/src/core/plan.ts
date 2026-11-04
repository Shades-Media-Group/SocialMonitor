import type { DB } from './db.ts'
import { now } from './db.ts'

/**
 * A brand's plan: what its own people may see, set by super admins in its Admin tab, so the owner
 * decides per brand which dashboards it has and how many competitors it tracks. Super admins see
 * every dashboard whatever the plan says. Kept apart from brands, so no SELECT * on brands carries
 * it to a brand's people; /api/brands names only what they may open.
 *
 * Brands from before the plan carry over what they had (db.ts): Share of voice and Ads as their
 * Dashboards switches stood, and room for at least as many competitors as they already track.
 */
export interface Plan {
  /** Share of voice and the rivals it compares. On unless a super admin turned it off. */
  competition: boolean
  /** The Ads dashboard, which only super admins ever see. Off until turned on. */
  ads: boolean
  /** Where the Ad Library is searched: an ISO country code, or ALL. */
  ads_country: string
  /** The brand's own stories, kept with their files. Off until turned on. */
  stories: boolean
  /** Its competitors' stories, within the competitor limit. Off until turned on. */
  rival_stories: boolean
  /** How many competitors it tracks; the ones added after that are kept but paused. */
  rival_limit: number
}

export const RIVAL_LIMIT_DEFAULT = 3
/** Share of voice draws six series: the brand and five competitors. */
export const RIVAL_LIMIT_MAX = 5

export const PLAN_DEFAULTS: Plan = {
  competition: true,
  ads: false,
  ads_country: 'MD',
  stories: false,
  rival_stories: false,
  rival_limit: RIVAL_LIMIT_DEFAULT,
}

interface Row {
  competition: number
  ads: number
  ads_country: string
  stories: number
  rival_stories: number
  rival_limit: number
}

/** The brand a rival answers for: its own id for a brand, its watcher's for a rival. */
export const ownerOf = (db: DB, brandId: number) =>
  (
    db.prepare('SELECT competitor_of FROM brands WHERE id = ?').get(brandId) as
      { competitor_of: number | null } | undefined
  )?.competitor_of ?? brandId

/** The brand's plan; a rival answers with the plan of the brand that watches it. */
export function plan(db: DB, brandId: number): Plan {
  const row = db
    .prepare(
      'SELECT competition, ads, ads_country, stories, rival_stories, rival_limit FROM brand_plans WHERE brand_id = ?',
    )
    .get(ownerOf(db, brandId)) as Row | undefined
  if (!row) return { ...PLAN_DEFAULTS }
  return {
    competition: !!row.competition,
    ads: !!row.ads,
    ads_country: row.ads_country,
    stories: !!row.stories,
    rival_stories: !!row.rival_stories,
    rival_limit: row.rival_limit,
  }
}

/** A two-letter country code in capitals, or ALL; null for anything else. */
export const country = (s: string) => {
  const v = s.trim().toUpperCase()
  return /^([A-Z]{2}|ALL)$/.test(v) ? v : null
}

/** Changes a brand's plan (super admins only, checked by the route). Unknown fields are ignored. */
export function setPlan(db: DB, brandId: number, patch: unknown, userId: number | null): Plan {
  const p = (patch ?? {}) as Record<string, unknown>
  const next = plan(db, brandId)
  for (const k of ['competition', 'ads', 'stories', 'rival_stories'] as const)
    if (p[k] !== undefined) next[k] = p[k] === true
  if (p.ads_country !== undefined) {
    const cc = country(String(p.ads_country))
    if (!cc) throw new Error('The country is a two-letter code, such as MD, or ALL.')
    next.ads_country = cc
  }
  if (p.rival_limit !== undefined) {
    const n = Number(p.rival_limit)
    if (!Number.isInteger(n) || n < 0 || n > RIVAL_LIMIT_MAX)
      throw new Error(`The competitor limit is a whole number from 0 to ${RIVAL_LIMIT_MAX}.`)
    next.rival_limit = n
  }
  db.prepare(
    `INSERT INTO brand_plans (brand_id, competition, ads, ads_country, stories, rival_stories,
       rival_limit, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (brand_id) DO UPDATE SET competition = excluded.competition, ads = excluded.ads,
       ads_country = excluded.ads_country, stories = excluded.stories,
       rival_stories = excluded.rival_stories, rival_limit = excluded.rival_limit,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(
    brandId,
    next.competition ? 1 : 0,
    next.ads ? 1 : 0,
    next.ads_country,
    next.stories ? 1 : 0,
    next.rival_stories ? 1 : 0,
    next.rival_limit,
    now(),
    userId,
  )
  return next
}

/**
 * The brand's rivals in the order they were added, each with whether the plan's limit leaves it
 * active. Rivals past the limit are paused: kept with everything read so far, but not read again
 * until the limit is raised or an earlier one is removed.
 */
export function rivalsInPlan(db: DB, brandId: number) {
  const limit = plan(db, brandId).rival_limit
  const ids = (
    db.prepare('SELECT id FROM brands WHERE competitor_of = ? ORDER BY id').all(brandId) as {
      id: number
    }[]
  ).map((r) => r.id)
  return ids.map((id, i) => ({ id, paused: i >= limit }))
}

/** The rivals the plan keeps active, in the order they were added. */
export const activeRivals = (db: DB, brandId: number) =>
  rivalsInPlan(db, brandId)
    .filter((r) => !r.paused)
    .map((r) => r.id)

/** The message at the limit; the dashboard shows its translation. */
export const LIMIT_REACHED =
  'Your plan tracks up to {n} competitors. Ask SocialMonitor to raise it.'
