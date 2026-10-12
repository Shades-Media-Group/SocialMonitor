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
  /** Read comment text (false when the signed-in gap has not passed yet). */
  comments: boolean
  maxComments: number
  /** Set by the collector when it read through the signed-in session: only then does the gap start. */
  usedSession: boolean
  log: (line: string) => void
}

export interface Collector {
  network: Network
  collect(page: Page, profile: Profile, opt: CollectOptions): Promise<CollectedPost[]>
}

export const collectors: Record<Network, Collector> = { tiktok, instagram, facebook }
