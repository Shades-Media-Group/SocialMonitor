import type { DB } from '../core/db.ts'
import * as store from '../core/store.ts'
import type { Label, Network } from '../core/types.ts'
import { LABELS, NETWORKS } from '../core/types.ts'
import { exportAll, importAll } from '../core/transfer.ts'
import { TEMPLATES, validCategories } from '../core/categories.ts'
import type { Dump } from '../core/transfer.ts'
import { openSignInWindow, signInStatus } from '../core/collect/browser.ts'
import { readSettings, writeSettings } from '../core/settings.ts'
import { gaps, queueRun, sortPending } from '../core/run.ts'
import type { CollectedPost, Range } from '../core/types.ts'

interface Ctx {
  db: DB
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}
interface Route {
  method: string
  path: RegExp
  handle: (c: Ctx) => unknown
}

const r = (method: string, path: string, handle: Route['handle']): Route => ({
  method,
  path: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'),
  handle,
})
const id = (s: string | undefined) => {
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1) throw new Error('Bad id.')
  return n
}
const net = (s: string | null | undefined) =>
  s && (NETWORKS as readonly string[]).includes(s) ? (s as Network) : undefined
const label = (s: string | null) =>
  s && (LABELS as readonly string[]).includes(s) ? (s as Label) : undefined
const b = (c: Ctx) => c.body as Record<string, unknown>

export const routes: Route[] = [
  r('GET', '/api/settings', ({ db }) => readSettings(db)),
  r('PATCH', '/api/settings', (c) => writeSettings(c.db, b(c))),
  r('GET', '/api/export', ({ db, query }) => ({
    __download: `socialmonitor-${new Date().toISOString().slice(0, 10)}.json`,
    data: exportAll(db, query.get('brand') ? id(query.get('brand')!) : undefined),
  })),
  r('GET', '/api/comments.csv', ({ db, query }) => {
    const rows = store.listComments(db, {
      brandId: query.get('brand') ? id(query.get('brand')!) : undefined,
      network: net(query.get('network')),
      label: label(query.get('label')),
      needsReply: query.get('reply') === '1',
      search: query.get('q') ?? undefined,
      limit: 100000,
    })
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const head = [
      'network',
      'posted_at',
      'author',
      'text',
      'likes',
      'label',
      'needs_reply',
      'reply_status',
      'reason',
      'post_url',
    ]
    const csv = [
      head.join(','),
      ...rows.map((r) =>
        head.map((h) => cell((r as unknown as Record<string, unknown>)[h])).join(','),
      ),
    ].join('\r\n')
    return {
      __download: `socialmonitor-comments-${new Date().toISOString().slice(0, 10)}.csv`,
      type: 'text/csv; charset=utf-8',
      data: '\ufeff' + csv,
    }
  }),
  r('POST', '/api/import', (c) => importAll(c.db, c.body as Dump)),
  r('GET', '/api/browser/status', async () => signInStatus()),
  r('GET', '/api/gaps', ({ db }) => gaps(db)),
  r('POST', '/api/browser/sign-in', async () => {
    await openSignInWindow()
  }),

  r('GET', '/api/brands', ({ db }) =>
    store.listBrands(db).map((brand) => ({
      ...brand,
      profiles: store.listProfiles(db, brand.id),
      counts: store.labelCounts(db, brand.id),
    })),
  ),
  r('POST', '/api/brands', (c) => {
    const { name, links, website } = b(c) as { name?: string; links?: string[]; website?: string }
    if (!name?.trim()) throw new Error('Name the brand.')
    return store.addBrand(c.db, name, links ?? [], website ?? null)
  }),
  r('PATCH', '/api/brands/:id', (c) => {
    const x = b(c) as {
      name?: string
      links?: string[]
      website?: string | null
      industry?: string | null
      description?: string | null
      notes?: string | null
    }
    const brandId = id(c.params.id)
    const { links, ...details } = x
    store.updateBrand(c.db, brandId, details)
    for (const link of links ?? []) store.setProfile(c.db, brandId, link)
  }),
  r('DELETE', '/api/brands/:id', (c) => void store.deleteBrand(c.db, id(c.params.id))),
  r('DELETE', '/api/brands/:id/profiles/:network', (c) => {
    const n = net(c.params.network)
    if (!n) throw new Error('Unknown network.')
    store.removeProfile(c.db, id(c.params.id), n)
  }),

  r('GET', '/api/posts', ({ db, query }) =>
    store.listPosts(db, {
      brandId: query.get('brand') ? id(query.get('brand')!) : undefined,
      network: net(query.get('network')),
      sort: query.get('sort') === 'top' ? 'top' : 'new',
      limit: Number(query.get('limit') ?? 50),
      offset: Number(query.get('offset') ?? 0),
    }),
  ),
  r('GET', '/api/comments', ({ db, query }) =>
    store.listComments(db, {
      brandId: query.get('brand') ? id(query.get('brand')!) : undefined,
      postId: query.get('post') ? id(query.get('post')!) : undefined,
      network: net(query.get('network')),
      label: label(query.get('label')),
      needsReply: query.get('reply') === '1',
      search: query.get('q') ?? undefined,
      sentiment: (['positive', 'negative', 'neutral', 'none'] as const).find(
        (v) => v === query.get('sentiment'),
      ),
      category: query.get('category') ?? undefined,
      others: query.get('others') === '1',
      limit: Number(query.get('limit') ?? 100),
      offset: Number(query.get('offset') ?? 0),
    }),
  ),

  r('GET', '/api/templates', () => TEMPLATES),
  r('PUT', '/api/brands/:id/categories', (c) => {
    const list = validCategories((b(c) as { categories?: unknown }).categories)
    store.setCategories(c.db, id(c.params.id), list)
    return list
  }),
  r('GET', '/api/sentiment', ({ db, query }) =>
    store.sentimentCounts(db, query.get('brand') ? id(query.get('brand')!) : undefined),
  ),
  // Sets or clears sentiment on one or many comments. `by` is 'ai' when Claude sets it.
  r('POST', '/api/comments/sentiment', (c) => {
    const x = b(c) as {
      ids?: number[]
      sentiment?: string | null
      category?: string | null
      by?: string
    }
    const sentiment =
      (['positive', 'negative', 'neutral'] as const).find((v) => v === x.sentiment) ?? null
    if (x.sentiment && !sentiment)
      throw new Error('sentiment is positive, negative, neutral or null.')
    const ids = (x.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
    if (!ids.length) throw new Error('Give comment ids.')
    for (const commentId of ids)
      store.setSentiment(
        c.db,
        commentId,
        sentiment,
        x.category ?? null,
        x.by === 'ai' ? 'ai' : 'you',
      )
    return { updated: ids.length }
  }),
  r('PATCH', '/api/comments/:id', (c) => {
    const x = b(c) as {
      label?: string
      needs_reply?: boolean
      reason?: string
      reply_status?: string
    }
    if (x.reply_status) {
      if (!['open', 'done', 'ignored'].includes(x.reply_status)) throw new Error('Unknown status.')
      store.setReplyStatus(c.db, id(c.params.id), x.reply_status as 'open' | 'done' | 'ignored')
      if (!x.label) return
    }
    const l = label(x.label ?? null)
    if (!l) throw new Error('Unknown label.')
    store.setVerdict(
      c.db,
      id(c.params.id),
      l,
      !!x.needs_reply,
      (x.reason ?? 'Set by hand.').slice(0, 120),
    )
  }),
  // Posts read somewhere else, by Claude through the user's own browser for example, go into
  // the same tables as an update's. Unsorted comments are sorted by the next update or by sort.
  r('POST', '/api/ingest', (c) => {
    const x = b(c) as { brand?: string | number; network?: string; posts?: CollectedPost[] }
    const brand = store
      .listBrands(c.db)
      .find((br) => br.id === Number(x.brand) || br.name === x.brand)
    if (!brand) throw new Error('No such brand.')
    const n = net(x.network)
    const profile = store.listProfiles(c.db, brand.id).find((p) => p.network === n)
    if (!profile) throw new Error(`${brand.name} has no ${x.network} profile.`)
    let posts = 0
    let comments = 0
    for (const p of x.posts ?? []) {
      if (!p?.ext_id || !p.url) throw new Error('Every post needs ext_id and url.')
      const r = store.savePost(c.db, profile, {
        ...p,
        comments: (p.comments ?? []).filter((k) => k.ext_id && k.text),
      })
      posts++
      comments += r.newComments
    }
    store.markProfile(c.db, profile.id, 'ok', null, true)
    return { posts, new_comments: comments }
  }),
  r('POST', '/api/sort', async ({ db }) => ({ sorted: await sortPending(db) })),
  // One brand at a glance, optionally for one network: what the brand page's overview reads.
  r('GET', '/api/brands/:id/summary', ({ db, params, query }) => {
    const brandId = id(params.id)
    const brand = store.getBrand(db, brandId)
    if (!brand) throw new Error('No such brand.')
    const network = net(query.get('network'))
    const week = new Date(Date.now() - 7 * 86400_000).toISOString()
    return {
      brand,
      profiles: store.listProfiles(db, brandId),
      counts: store.labelCounts(db, brandId, undefined, network),
      week: store.labelCounts(db, brandId, week, network),
      sentiment: store.sentimentCounts(db, brandId, network),
      posts: (
        db
          .prepare(
            'SELECT count(*) AS n FROM posts p JOIN profiles pr ON pr.id = p.profile_id WHERE pr.brand_id = ? AND (? IS NULL OR p.network = ?)',
          )
          .get(brandId, network ?? null, network ?? null) as { n: number }
      ).n,
      brand_replies: (
        db
          .prepare(
            `SELECT count(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id WHERE pr.brand_id = ? AND c.author = pr.handle AND (? IS NULL OR p.network = ?)`,
          )
          .get(brandId, network ?? null, network ?? null) as { n: number }
      ).n,
    }
  }),
  r('GET', '/api/runs', ({ db, query }) => {
    const brand = query.get('brand')
    const runs = store.listRuns(db, 60)
    return brand
      ? runs.filter((r) =>
          (JSON.parse(r.scope) as { brandIds?: number[] }).brandIds?.includes(Number(brand)),
        )
      : runs
  }),
  r('POST', '/api/runs', (c) => {
    const x = b(c) as { brandIds?: number[]; networks?: string[]; range?: Range; limit?: number }
    const runId = queueRun(
      c.db,
      {
        brandIds: (x.brandIds ?? []).map(Number).filter(Boolean),
        networks: (x.networks ?? []).map((n) => net(n)).filter((n): n is Network => !!n),
        range: x.range === 'all' ? 'all' : 'new',
        limit: Number(x.limit) || 5,
      },
      'manual',
    )
    return { id: runId }
  }),
  r('GET', '/api/runs/:id/report.md', (c) => ({
    __download: `socialmonitor-report-${c.params.id}.md`,
    type: 'text/markdown; charset=utf-8',
    data: store.getRun(c.db, id(c.params.id))?.report ?? '',
  })),
  r('GET', '/api/runs/:id', (c) => store.getRun(c.db, id(c.params.id))),

  r('GET', '/api/schedules', ({ db }) => store.listSchedules(db)),
  r('POST', '/api/schedules', (c) =>
    store.saveSchedule(c.db, b(c) as unknown as store.ScheduleInput),
  ),
  r('PUT', '/api/schedules/:id', (c) =>
    store.saveSchedule(c.db, b(c) as unknown as store.ScheduleInput, id(c.params.id)),
  ),
  r('DELETE', '/api/schedules/:id', (c) => void store.deleteSchedule(c.db, id(c.params.id))),
]
