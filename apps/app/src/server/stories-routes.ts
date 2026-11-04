import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../core/db.ts'
import { DATA_DIR } from '../core/db.ts'
import * as store from '../core/store.ts'
import { roleFor } from '../core/auth.ts'
import type { User } from '../core/auth.ts'
import { audit } from '../core/audit.ts'
import { ORIGINAL_DAYS } from '../core/story-media.ts'
import { plan, rivalsInPlan, setPlan } from '../core/plan.ts'
import { lastStoryRun, startStoriesCheck, storyScope } from '../core/stories.ts'
import { storiesView, storyStats } from '../core/story-view.ts'
import { metaStoriesOn } from '../core/meta-stories.ts'
import { metaConnected } from '../core/meta-api.ts'
import type { Ctx, Route } from './routes.ts'
import { HttpError, by, r } from './routes.ts'

type Signed = Ctx & { user: User }

const id = (s: string | undefined) => {
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1) throw new Error('Bad id.')
  return n
}

/** A brand of one's own (never a rival), or 404. */
const brandOf = (c: Signed) => {
  const brand = store.getBrand(c.db, id(c.params.id))
  if (!brand || brand.competitor_of) throw new HttpError(404, 'No such brand.')
  return brand
}

/** The plan is the owner's: super admins read and change it, a brand's admins included in the refusal. */
const owner = (c: Signed) => {
  if (!c.user.super) throw new HttpError(403, 'Only super admins can do that.')
  brandOf(c)
}

/**
 * Stories: the brand's own people while its plan has Stories or Competitor stories; super admins
 * always. Everyone else, and anyone without the brand, is refused.
 */
const seeStories = (c: Signed) => {
  const brand = brandOf(c)
  if (!roleFor(c.db, c.user, brand.id))
    throw new HttpError(403, 'You do not have access to this brand.')
  if (c.user.super) return
  const p = plan(c.db, brand.id)
  if (!p.stories && !p.rival_stories)
    throw new HttpError(403, 'Stories are not in this brand’s plan.')
}
/** Checking now: super admins always; a brand's admins while the plan has Stories. */
const checkStories = (c: Signed) => {
  seeStories(c)
  if (!c.user.super && roleFor(c.db, c.user, id(c.params.id)) !== 'admin')
    throw new HttpError(403, "Only this brand's admins can do that.")
}

/** Whether this person may have this story's files: the brand, and the plan's part it falls in. */
export function maySeeStory(db: DB, user: User, watcher: number, brandId: number) {
  if (!roleFor(db, user, watcher)) return false
  const scope = storyScope(db, watcher, !!user.super)
  return brandId === watcher ? scope.own : scope.rivals
}

/** A story's brand and its watcher's, for the media and download checks. */
export function storyOwner(db: DB, storyId: number) {
  return (
    (db.prepare('SELECT watcher_id, brand_id FROM stories WHERE id = ?').get(storyId) as
      { watcher_id: number; brand_id: number } | undefined) ?? null
  )
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const EXT_TYPE: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
}

export const storiesRoutes: Route[] = [
  // The plan: super admins only. Each change is logged with no brand id, so a brand's own admins
  // never read it in their activity view.
  r('GET', '/api/brands/:id/plan', owner, (c) => ({
    ...plan(c.db, id(c.params.id)),
    rivals: rivalsInPlan(c.db, id(c.params.id)).length,
    original_days: ORIGINAL_DAYS,
  })),
  r('PUT', '/api/brands/:id/plan', owner, (c) => {
    const brandId = id(c.params.id)
    const before = plan(c.db, brandId)
    const after = setPlan(c.db, brandId, c.body, c.user.id)
    audit(c.db, {
      ...by(c),
      event: 'plan.changed',
      target: store.getBrand(c.db, brandId)?.name ?? null,
      detail: { before, after },
    })
    return after
  }),

  r('GET', '/api/brands/:id/stories', seeStories, (c) => {
    const brandId = id(c.params.id)
    const q = c.query
    const one = (k: string) => q.get(k)?.slice(0, 40) || undefined
    const scope = storyScope(c.db, brandId, !!c.user.super)
    const p = plan(c.db, brandId)
    const has = q.get('has')
    const state = q.get('state')
    return {
      scope,
      plan: c.user.super ? { stories: p.stories, rival_stories: p.rival_stories } : null,
      run: lastStoryRun(c.db, brandId),
      can_check: !!c.user.super || roleFor(c.db, c.user, brandId) === 'admin',
      original_days: ORIGINAL_DAYS,
      meta: {
        enabled: metaStoriesOn(),
        connected:
          metaConnected(c.db, brandId, 'instagram') || metaConnected(c.db, brandId, 'facebook'),
      },
      ...storiesView(c.db, brandId, scope, {
        brands: (q.get('account') ?? '')
          .split(',')
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
          .slice(0, 12),
        network: one('network'),
        kind: one('kind'),
        since: DAY.test(q.get('since') ?? '') ? q.get('since')! : undefined,
        until: DAY.test(q.get('until') ?? '') ? q.get('until')! : undefined,
        has: has === 'mentions' || has === 'reposts' ? has : undefined,
        state: state === 'live' || state === 'expired' ? state : undefined,
        limit: Number(q.get('limit')) || undefined,
      }),
    }
  }),
  r('GET', '/api/brands/:id/stories/stats', seeStories, (c) => {
    const brandId = id(c.params.id)
    const days = Number(c.query.get('days'))
    return storyStats(
      c.db,
      brandId,
      storyScope(c.db, brandId, !!c.user.super),
      [7, 30, 90, 365].includes(days) ? days : 30,
    )
  }),
  r('GET', '/api/brands/:id/stories/run', seeStories, (c) => lastStoryRun(c.db, id(c.params.id))),
  r('POST', '/api/brands/:id/stories/check', checkStories, (c) => ({
    // A super admin's check reads the brand and its active rivals whatever the plan says.
    id: startStoriesCheck(c.db, id(c.params.id), 'manual', c.user.id, { force: !!c.user.super }),
  })),

  // A story's file to keep: the original while it is held, else the compact copy.
  r(
    'GET',
    '/api/stories/:id/download',
    (c) => {
      const s = storyOwner(c.db, id(c.params.id))
      if (!s || !maySeeStory(c.db, c.user, s.watcher_id, s.brand_id))
        throw new HttpError(404, 'No such story.')
    },
    (c) => {
      const storyId = id(c.params.id)
      const pos = Math.max(0, Math.min(50, Number(c.query.get('pos')) || 0))
      const want = c.query.get('file') === 'original' ? 'original' : 'compact'
      const m = c.db
        .prepare(
          `SELECT m.original_path, m.compact_path, s.handle, s.network, s.posted_at FROM story_media m
           JOIN stories s ON s.id = m.story_id WHERE m.story_id = ? AND m.position = ?`,
        )
        .get(storyId, pos) as
        | {
            original_path: string | null
            compact_path: string | null
            handle: string
            network: string
            posted_at: string | null
          }
        | undefined
      if (!m) throw new HttpError(404, 'No such file.')
      const rel = want === 'original' ? m.original_path : m.compact_path
      if (!rel)
        throw new HttpError(
          404,
          want === 'original'
            ? 'The original is no longer kept. Download the compact copy instead.'
            : 'The compact copy is not ready yet.',
        )
      const file = join(DATA_DIR, rel)
      if (!existsSync(file)) throw new HttpError(404, 'No such file.')
      const ext = /\.[a-z0-9]+$/i.exec(file)?.[0]?.toLowerCase() ?? ''
      const day = (m.posted_at ?? '').slice(0, 10) || 'story'
      const name = `${m.handle.replace(/[^\w.-]+/g, '_')}-${m.network}-story-${day}-${storyId}${pos ? `-${pos + 1}` : ''}${want === 'original' ? '-original' : ''}${ext}`
      audit(c.db, {
        ...by(c),
        event: 'download',
        target: name,
        brandId: storyOwner(c.db, storyId)?.watcher_id ?? null,
        detail: { story: storyId, file: want },
      })
      return { __file: file, name, type: EXT_TYPE[ext] ?? 'application/octet-stream' }
    },
  ),
]
