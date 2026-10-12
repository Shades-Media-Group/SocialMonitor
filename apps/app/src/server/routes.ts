import type { DB } from '../core/db.ts'
import * as store from '../core/store.ts'
import type { Label, Network } from '../core/types.ts'
import { LABELS, NETWORKS } from '../core/types.ts'
import { exportAll, importAll } from '../core/transfer.ts'
import type { Dump } from '../core/transfer.ts'
import { openSignInWindow } from '../core/collect/browser.ts'
import { readSettings, writeSettings } from '../core/settings.ts'
import { queueRun } from '../core/run.ts'
import type { Range } from '../core/types.ts'

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
  r('POST', '/api/import', (c) => importAll(c.db, c.body as Dump)),
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
    const { name, links } = b(c) as { name?: string; links?: string[] }
    const brandId = id(c.params.id)
    if (name) store.renameBrand(c.db, brandId, name)
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
      limit: Number(query.get('limit') ?? 100),
      offset: Number(query.get('offset') ?? 0),
    }),
  ),

  r('GET', '/api/runs', ({ db }) => store.listRuns(db)),
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
