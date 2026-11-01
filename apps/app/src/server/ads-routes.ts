import * as store from '../core/store.ts'
import {
  CAP,
  addAdvertiser,
  adsView,
  dashboards,
  lastAdRun,
  removeAdvertiser,
  setDashboards,
  startAdsRead,
  stopAdRun,
  updateAdvertiser,
} from '../core/ads.ts'
import { audit } from '../core/audit.ts'
import type { Ctx, Route } from './routes.ts'
import { HttpError, by, r } from './routes.ts'

type Signed = Ctx & { user: NonNullable<Ctx['user']> }

const id = (s: string | undefined) => {
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1) throw new Error('Bad id.')
  return n
}

/**
 * The owner's switches and the Ads dashboard. Every route here is for super admins alone, a
 * brand's own admins included in the refusal. The Ads routes also answer only while the brand's
 * Ads switch is on.
 */
const owner = (c: Signed) => {
  if (!c.user.super) throw new HttpError(403, 'Only super admins can do that.')
  const brand = store.getBrand(c.db, id(c.params.id))
  if (!brand || brand.competitor_of) throw new HttpError(404, 'No such brand.')
}
const ads = (c: Signed) => {
  owner(c)
  if (!dashboards(c.db, id(c.params.id)).ads)
    throw new HttpError(404, 'The Ads dashboard is off for this brand. Turn it on in Admin.')
}

export const adsRoutes: Route[] = [
  r('GET', '/api/brands/:id/dashboards', owner, ({ db, params }) => dashboards(db, id(params.id))),
  r('PUT', '/api/brands/:id/dashboards', owner, (c) => {
    const brandId = id(c.params.id)
    const before = dashboards(c.db, brandId)
    const after = setDashboards(c.db, brandId, c.body, c.user.id)
    // No brand id on the row: a brand's own admins read their brand's activity, and the Ads
    // switch is not theirs to see.
    audit(c.db, {
      ...by(c),
      event: 'dashboards.changed',
      target: store.getBrand(c.db, brandId)?.name ?? null,
      detail: { before, after },
    })
    return after
  }),
  r('GET', '/api/brands/:id/ads', ads, ({ db, params, query }) => {
    const brandId = id(params.id)
    const status = query.get('status') === 'active' ? 'active' : 'all'
    return {
      country: dashboards(db, brandId).ads_country,
      cap: CAP,
      run: lastAdRun(db, brandId),
      ...adsView(db, brandId, {
        page: query.get('page') ?? undefined,
        status,
        platform: query.get('platform') ?? undefined,
        since: query.get('since') ?? undefined,
        limit: Number(query.get('limit')) || undefined,
      }),
    }
  }),
  r('GET', '/api/brands/:id/ads/run', ads, ({ db, params }) => lastAdRun(db, id(params.id))),
  r('POST', '/api/brands/:id/ads/advertisers', ads, ({ db, params, body }) =>
    addAdvertiser(db, id(params.id), body),
  ),
  r('PUT', '/api/brands/:id/ads/advertisers/:adv', ads, ({ db, params, body }) =>
    updateAdvertiser(db, id(params.id), id(params.adv), body),
  ),
  r('DELETE', '/api/brands/:id/ads/advertisers/:adv', ads, ({ db, params }) =>
    removeAdvertiser(db, id(params.id), id(params.adv)),
  ),
  r('POST', '/api/brands/:id/ads/read', ads, (c) => ({
    id: startAdsRead(c.db, id(c.params.id), c.user.id),
  })),
  r('POST', '/api/brands/:id/ads/stop', ads, ({ db, params }) => stopAdRun(db, id(params.id))),
]
