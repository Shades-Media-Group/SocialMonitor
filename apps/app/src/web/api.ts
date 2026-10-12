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

import { lang, t } from './i18n.ts'

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
  if (!res.ok)
    throw new Error(
      t((data as { error?: string }).error ?? 'The server answered {status}.', {
        status: res.status,
      }),
    )
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
