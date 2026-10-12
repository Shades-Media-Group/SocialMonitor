import type { Brand, Comment, Network, Post, Profile, Schedule } from '../core/types.ts'

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
}
export type CommentRow = Comment & { network: Network; post_url: string; brand_id: number }
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
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status}.` }))
  // The session ended (signed out elsewhere, expired, blocked): back to the sign-in screen.
  if (res.status === 401 && !path.startsWith('/api/auth/'))
    dispatchEvent(new Event('sm-signed-out'))
  if (!res.ok)
    throw new Error((data as { error?: string }).error ?? `The server answered ${res.status}.`)
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
