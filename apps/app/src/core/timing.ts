/**
 * When posts do best, from stored posts alone. Shared by the Posts tab (in the reader's local
 * time) and the post ideas (in this computer's local time). No database, no AI.
 */

export interface Timed {
  posted_at: string | null
  likes: number | null
  comments_count: number | null
  shares: number | null
  views: number | null
}

export interface Slot {
  /** The hour (0–23) or weekday (0 Sunday) the posts went out. */
  key: number
  posts: number
  /** Engagement per view when most posts report views, else interactions per post. */
  score: number
}

export interface Slots {
  metric: 'rate' | 'interactions'
  /** Posts the ranking was made from. */
  total: number
  /** Slots with fewer posts than this are left out: one lucky post is not a pattern. */
  min: number
  /** True when there are enough posts and slots to rank at all. */
  enough: boolean
  slots: Slot[]
}

export const interactions = (p: Timed) => (p.likes ?? 0) + (p.comments_count ?? 0) + (p.shares ?? 0)

/** Rank by engagement per view when at least half the posts report views (videos), else per post. */
export const byRate = (posts: Timed[]) => {
  const seen = posts.filter((p) => p.views).length
  return seen > 0 && seen * 2 >= posts.length
}

/**
 * Ranks the slots posts went out in by how well they did, so photo-only accounts still rank by
 * interactions per post. Slots with fewer than `min` posts are left out.
 */
export function rankSlots(
  posts: Timed[],
  slotOf: (iso: string) => number,
  { min = 3, total = 12 } = {},
): Slots {
  const timed = posts.filter((p) => p.posted_at)
  const rate = byRate(timed)
  const pool = rate ? timed.filter((p) => p.views) : timed
  const groups = new Map<number, { posts: number; acts: number; views: number }>()
  for (const p of pool) {
    const k = slotOf(p.posted_at!)
    const g = groups.get(k) ?? { posts: 0, acts: 0, views: 0 }
    g.posts++
    g.acts += interactions(p)
    g.views += p.views ?? 0
    groups.set(k, g)
  }
  const slots = [...groups]
    .filter(([, g]) => g.posts >= min)
    .map(([key, g]) => ({ key, posts: g.posts, score: rate ? g.acts / g.views : g.acts / g.posts }))
    .sort((a, b) => b.score - a.score || b.posts - a.posts)
  return {
    metric: rate ? 'rate' : 'interactions',
    total: pool.length,
    min,
    enough: pool.length >= total && slots.length >= 2,
    slots,
  }
}

/** The hour of the day, in this machine's local time. */
export const localHour = (iso: string) => new Date(iso).getHours()
/** The weekday, 0 Sunday, in this machine's local time. */
export const localDay = (iso: string) => new Date(iso).getDay()
