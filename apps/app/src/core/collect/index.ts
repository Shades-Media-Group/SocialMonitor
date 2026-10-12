import type { Page } from 'playwright'
import type { CollectedPost, Network, Profile, Range } from '../types.ts'
import { tiktok } from './tiktok.ts'
import { instagram } from './instagram.ts'
import { facebook } from './facebook.ts'

export interface CollectOptions {
  range: Range
  /** Most posts to read, newest first. */
  limit: number
  /** Post ids already stored: with range 'new' they are skipped. */
  known: Set<string>
  /** Stored posts due for fresh numbers, with the comment count last seen (range 'due'). */
  due: Map<string, number | null>
  /** Read comment text (false when the signed-in gap has not passed yet). */
  comments: boolean
  maxComments: number
  /** Set by the collector when it read through the signed-in session: only then does the gap start. */
  usedSession: boolean
  log: (line: string) => void
}

/**
 * Which listed posts to read: everything newest-first ('all'), or posts not read before up to
 * the limit, plus, with 'due', the stored posts whose numbers are due for a fresh read.
 */
export function pick<T>(list: T[], id: (x: T) => string, opt: CollectOptions): T[] {
  if (opt.range === 'all') return list.slice(0, opt.limit)
  const fresh = list.filter((x) => !opt.known.has(id(x))).slice(0, opt.limit)
  const due =
    opt.range === 'due' ? list.filter((x) => opt.due.has(id(x)) && !fresh.includes(x)) : []
  return [...fresh, ...due]
}

export interface Collector {
  network: Network
  collect(page: Page, profile: Profile, opt: CollectOptions): Promise<CollectedPost[]>
}

export const collectors: Record<Network, Collector> = { tiktok, instagram, facebook }
