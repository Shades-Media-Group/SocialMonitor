import type { Brand, Comment, Network, Post, Profile, Schedule } from '../core/types.ts'
export type { Tracker } from '../core/types.ts'

export type BrandRow = Brand & {
  profiles: Profile[]
  counts: Record<string, number>
  /** What the signed-in person may do here. */
  my_role: 'viewer' | 'admin'
}
export type PostRow = Post & {
  brand_id: number
  handle: string
  stored_comments: number
  flagged: number
  /** What people said under it, by type, and how many still wait for an answer. */
  n_complaint: number
  n_question: number
  n_suggestion: number
  n_praise: number
  n_other: number
  waiting: number
  /** Likes, comments and shares gained in the last 7 days, and views; null without history. */
  grew_7d: number | null
  views_7d: number | null
  /** JSON: the ids of the campaigns it is in. */
  campaign_ids: string
}
export type CommentRow = Comment & {
  network: Network
  post_url: string
  brand_id: number
  overdue: 0 | 1
  /** The post the comment is under: its picture and what it is about. */
  post_thumb: string | null
  post_about: string | null
}
export interface RunRow {
  id: number
  trigger: string
  scope: string
  started_at: string
  finished_at: string | null
  status: string
  stats: string | null
  log?: string
  report?: string | null
  /** JSON: where a running update is (step, brand, network, done, total). */
  progress?: string | null
}

/** GET /api/ai/status: whether Claude is at its usage limit, and what waits for it. */
export interface AiStatus {
  paused: boolean
  /** When Claude is tried again. */
  until: string | null
  /** When waiting updates and sorting start (a couple of minutes after until). */
  resumes_at: string | null
  /** 'usage': the subscription's limit; 'busy': a rate limit or an overloaded service. */
  kind: 'usage' | 'busy' | null
  reason: string | null
  set_at: string | null
  reset_known: boolean | null
  /** Brands with comments a limit left unsorted, sorted after this time. */
  waiting: { after: string; brands: number[] } | null
}

import { lang, locale, t } from './i18n.ts'

/** An error from the server, with whatever else it sent beside the message. */
export class ApiError extends Error {
  data: Record<string, unknown>
  constructor(message: string, data: Record<string, unknown>) {
    super(message)
    this.data = data
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    // Sign-in requests carry the language, so emails arrive in it.
    body: body
      ? JSON.stringify(
          path.startsWith('/api/auth/') || path.startsWith('/api/users')
            ? { lang, ...(body as object) }
            : body,
        )
      : undefined,
  })
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status}.` }))
  // The session ended (signed out elsewhere, expired, blocked): back to the sign-in screen.
  if (res.status === 401 && !path.startsWith('/api/auth/'))
    dispatchEvent(new Event('sm-signed-out'))
  if (!res.ok) {
    // Claude's usage limit names when it can be tried again, shown in the reader's own clock.
    const until = (data as { until?: string }).until
    throw new ApiError(
      t((data as { error?: string }).error ?? 'The server answered {status}.', {
        status: res.status,
        time: until
          ? new Date(until).toLocaleString(locale, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '',
      }),
      data as Record<string, unknown>,
    )
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
}

export type { Network, Schedule, Profile }
