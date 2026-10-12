export const NETWORKS = ['instagram', 'facebook', 'tiktok'] as const
export type Network = (typeof NETWORKS)[number]

/** How the AI sorts a comment. Kept short: these strings are what Claude reads back. */
export const LABELS = ['praise', 'question', 'complaint', 'suggestion', 'neutral', 'spam'] as const
export type Label = (typeof LABELS)[number]

/** Which posts an update reads: only posts newer than the last update, or every post it can see. */
export type Range = 'new' | 'all'

export interface Brand {
  id: number
  name: string
  website: string | null
  created_at: string
}

export interface Profile {
  id: number
  brand_id: number
  network: Network
  url: string
  handle: string
  last_run_at: string | null
  last_session_at: string | null
  last_status: 'ok' | 'error' | null
  last_error: string | null
}

export interface Post {
  id: number
  profile_id: number
  network: Network
  ext_id: string
  url: string
  posted_at: string | null
  kind: string
  caption: string
  thumb_url: string | null
  likes: number | null
  comments_count: number | null
  shares: number | null
  views: number | null
  description: string | null
  fetched_at: string
}

export interface Comment {
  id: number
  post_id: number
  ext_id: string
  parent_ext_id: string | null
  author: string
  text: string
  likes: number | null
  posted_at: string | null
  label: Label | null
  needs_reply: 0 | 1 | null
  reason: string | null
}

/** What a collector returns for one post: the post and the comments it could read. */
export interface CollectedPost {
  ext_id: string
  url: string
  posted_at: string | null
  kind: string
  caption: string
  thumb_url: string | null
  likes: number | null
  comments_count: number | null
  shares: number | null
  views: number | null
  comments: CollectedComment[]
}

export interface CollectedComment {
  ext_id: string
  parent_ext_id: string | null
  author: string
  text: string
  likes: number | null
  posted_at: string | null
}

export interface RunScope {
  brandIds: number[]
  networks: Network[]
  range: Range
  /** Most posts per profile; the newest first. */
  limit: number
}

export type ScheduleKind = 'interval' | 'times'

export interface Schedule {
  id: number
  brand_id: number
  kind: ScheduleKind
  /** For 'interval': hours between updates. */
  every_hours: number | null
  /** For 'times': local times of day, "HH:MM". */
  times: string[]
  networks: Network[]
  range: Range
  enabled: 0 | 1
  next_run_at: string | null
}
