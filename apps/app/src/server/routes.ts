import type { DB } from '../core/db.ts'
import * as store from '../core/store.ts'
import type { Label, Network, Tracker } from '../core/types.ts'
import { LABELS, NETWORKS } from '../core/types.ts'
import { exportAll, importAll } from '../core/transfer.ts'
import { TEMPLATES, validCategories } from '../core/categories.ts'
import type { Dump } from '../core/transfer.ts'
import { openSignInWindow, signInStatus } from '../core/collect/browser.ts'
import { readSettings, writeSettings } from '../core/settings.ts'
import { deleteAccount, listAccounts, revealPassword, saveAccount } from '../core/vault.ts'
import type { Account } from '../core/vault.ts'
import { gaps, queueRun, sortPending } from '../core/run.ts'
import type { CollectedPost, Range } from '../core/types.ts'
import {
  byNetwork,
  compare,
  heatmap,
  daily,
  bestTimes,
  fansAndCritics,
  profileStats,
  topAuthors,
  topWords,
  watched,
  labelTotals,
  postEngagement,
  reach,
  reputation,
  responses,
  timeline,
} from '../core/insights.ts'
import { workbook } from '../core/xlsx.ts'
import { brandPdf, uiOrigin } from '../core/pdf.ts'
import { badPdf, sendBad, setAlerts, setNotify } from '../core/alerts.ts'
import {
  authorizeUrl,
  connection,
  disconnect,
  finishSignIn,
  tiktokReady,
} from '../core/tiktok-api.ts'
import * as meta from '../core/meta-api.ts'
import { deleteSaved, getSaved, listSaved, readSaved, saveReport } from '../core/saved.ts'
import { draftFromSaved, draftReply, pickEngine, translate } from '../core/analyze.ts'
import {
  addReply,
  candidates,
  deleteReply,
  fillReply,
  listReplies,
  updateReply,
} from '../core/replies.ts'
import { latestIdeas, suggestIdeas } from '../core/ideas.ts'
import { getSettings } from '../core/settings.ts'
import { latestSummary, refreshSummary } from '../core/summary.ts'
import type { User } from '../core/auth.ts'
import { roleFor, signSession, visibleBrands } from '../core/auth.ts'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface Ctx {
  db: DB
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  /** The request came from this computer, not through the tunnel. */
  local: boolean
  /** The signed-in person; null only on public routes. */
  user: User | null
  /** Set-Cookie headers to send back. */
  cookies: string[]
  /** The request arrived over HTTPS (the tunnel), so cookies are marked Secure. */
  secure: boolean
  /** Who is asking: Cloudflare's client address through the tunnel, else this computer. */
  ip: string
}
type Signed = Ctx & { user: User }
/**
 * Who may call a route: anyone ('public'), anyone signed in ('user'), super admins ('super'),
 * or a check that throws for everyone else. Every route names one, so nothing is open by default.
 */
export type Need = 'public' | 'user' | 'super' | ((c: Signed) => void)
interface Route {
  method: string
  path: RegExp
  need: Need
  handle: (c: Ctx) => unknown
}

export const r = (
  method: string,
  path: string,
  need: Need,
  handle: (c: Signed) => unknown,
): Route => ({
  method,
  path: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'),
  need,
  handle: handle as Route['handle'],
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

const sees = (c: Signed, brandId: number) => {
  if (!roleFor(c.db, c.user, brandId))
    throw new HttpError(403, 'You do not have access to this brand.')
}
const runs = (c: Signed, brandId: number) => {
  if (roleFor(c.db, c.user, brandId) !== 'admin')
    throw new HttpError(403, "Only this brand's admins can do that.")
}
const brandOf = (db: DB, sql: string, key: number) =>
  (db.prepare(sql).get(key) as { brand_id: number } | undefined)?.brand_id ?? 0
const commentBrand = (db: DB, commentId: number) =>
  brandOf(
    db,
    'SELECT pr.brand_id FROM comments c JOIN posts p ON p.id = c.post_id JOIN profiles pr ON pr.id = p.profile_id WHERE c.id = ?',
    commentId,
  )
const runBrands = (db: DB, runId: number) =>
  (JSON.parse(store.getRun(db, runId)?.scope ?? '{}') as { brandIds?: number[] }).brandIds ?? []
/** The brand in the path. */
const seeBrand = (c: Signed) => sees(c, id(c.params.id))
const adminBrand = (c: Signed) => runs(c, id(c.params.id))
/** The brand in ?brand= (or the post in ?post=); only super admins may leave it out. */
const scoped = (c: Signed) => {
  const brand = c.query.get('brand')
  const post = c.query.get('post')
  if (brand) sees(c, id(brand))
  if (post)
    sees(
      c,
      brandOf(
        c.db,
        'SELECT pr.brand_id FROM posts p JOIN profiles pr ON pr.id = p.profile_id WHERE p.id = ?',
        id(post),
      ),
    )
  if (!brand && !post && !c.user.super) throw new HttpError(403, 'Choose a brand.')
}
/** The brand in ?brand=; only super admins may leave it out. For routes that filter by brand only. */
const byBrand = (c: Signed) => {
  const brand = c.query.get('brand')
  if (brand) sees(c, id(brand))
  else if (!c.user.super) throw new HttpError(403, 'Choose a brand.')
}
const seeComment = (c: Signed) => sees(c, commentBrand(c.db, id(c.params.id)))
const adminComment = (c: Signed) => runs(c, commentBrand(c.db, id(c.params.id)))
const seeRun = (c: Signed) => {
  const ids = runBrands(c.db, id(c.params.id))
  if (!c.user.super && !ids.length)
    throw new HttpError(403, 'You do not have access to this update.')
  for (const brandId of ids) sees(c, brandId)
}
const adminSchedule = (c: Signed) =>
  runs(c, brandOf(c.db, 'SELECT brand_id FROM schedules WHERE id = ?', id(c.params.id)))
/** Keeps only what the user may see. */
const visible = <T>(c: Signed, rows: T[], brandOfRow: (row: T) => number | number[]) => {
  const ids = visibleBrands(c.db, c.user)
  if (!ids) return rows
  return rows.filter((row) => {
    const own = brandOfRow(row)
    return Array.isArray(own)
      ? own.length > 0 && own.every((x) => ids.includes(x))
      : ids.includes(own)
  })
}

export const routes: Route[] = [
  r('GET', '/api/settings', 'user', ({ db }) => readSettings(db)),
  // Which AI sorts comments on this computer: Claude Code, an API key, or none yet.
  r('GET', '/api/ai', 'user', ({ db }) => {
    const last = store.getSetting(db, 'ai_error')
    return {
      engine: pickEngine(getSettings(db)),
      error: last ? (JSON.parse(last) as { at: string; message: string }) : null,
    }
  }),
  r('PATCH', '/api/settings', 'super', (c) => writeSettings(c.db, b(c))),
  r(
    'GET',
    '/api/export',
    (c) => (c.query.get('brand') ? runs(c, id(c.query.get('brand')!)) : c.user.super || runs(c, 0)),
    ({ db, query }) => ({
      __download: `socialmonitor-${new Date().toISOString().slice(0, 10)}.json`,
      data: exportAll(db, query.get('brand') ? id(query.get('brand')!) : undefined),
    }),
  ),
  r('GET', '/api/comments.csv', byBrand, (c) => {
    const { db, query } = c
    const rows = store.listComments(db, {
      brandId: query.get('brand') ? id(query.get('brand')!) : undefined,
      network: net(query.get('network')),
      label: label(query.get('label')),
      needsReply: query.get('reply') === '1',
      overdue: query.get('overdue') === '1',
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
    const out = {
      __download: `socialmonitor-comments-${new Date().toISOString().slice(0, 10)}.csv`,
      type: 'text/csv; charset=utf-8',
      data: '\ufeff' + csv,
    }
    saveReport(db, {
      brandId: query.get('brand') ? id(query.get('brand')!) : null,
      kind: 'csv',
      filename: out.__download,
      type: out.type,
      data: out.data,
      params: Object.fromEntries(query),
      userId: c.user.id,
    })
    return out
  }),
  r('POST', '/api/import', 'super', (c) => importAll(c.db, c.body as Dump)),
  r('GET', '/api/browser/status', 'user', async () => signInStatus()),
  r('GET', '/api/gaps', 'user', (c) => visible(c, gaps(c.db), (g) => g.brand_id)),
  // Accounts: kept encrypted for the person's own reference. Passwords leave the server only on
  // this computer, one at a time, on an explicit Reveal.
  r('GET', '/api/accounts', 'super', ({ db }) => listAccounts(db)),
  r('POST', '/api/accounts', 'super', (c) => saveAccount(c.db, b(c) as Partial<Account>)),
  r('DELETE', '/api/accounts/:key', 'super', (c) => void deleteAccount(c.db, c.params.key!)),
  r('POST', '/api/accounts/:key/reveal', 'super', (c) => {
    if (!c.local) throw new Error('Passwords are shown only on the computer SocialMonitor runs on.')
    return { password: revealPassword(c.db, c.params.key!) }
  }),
  r('GET', '/api/remote', 'user', (c) => ({
    local: c.local,
    host: process.env.SOCIALMONITOR_PUBLIC_HOST || null,
  })),
  r('POST', '/api/browser/sign-in', 'super', async (c) => {
    if (!c.local)
      throw new Error(
        'Signing in opens a window on the computer SocialMonitor runs on; do it there.',
      )
    await openSignInWindow()
  }),

  r('GET', '/api/brands', 'user', (c) =>
    visible(
      c,
      store.listBrands(c.db).filter((br) => !br.competitor_of),
      (br) => br.id,
    ).map((brand) => ({
      my_role: roleFor(c.db, c.user, brand.id),
      ...brand,
      profiles: store.listProfiles(c.db, brand.id),
      counts: store.labelCounts(c.db, brand.id),
    })),
  ),
  r('POST', '/api/brands', 'super', (c) => {
    const { name, links, website } = b(c) as { name?: string; links?: string[]; website?: string }
    if (!name?.trim()) throw new Error('Name the brand.')
    return store.addBrand(c.db, name, links ?? [], website ?? null)
  }),
  r('PATCH', '/api/brands/:id', adminBrand, (c) => {
    const x = b(c) as {
      name?: string
      links?: string[]
      website?: string | null
      industry?: string | null
      description?: string | null
      notes?: string | null
      reply_target_hours?: number
      ai_sort?: boolean
    }
    const brandId = id(c.params.id)
    const { links, ...details } = x
    store.updateBrand(c.db, brandId, details)
    for (const link of links ?? []) store.setProfile(c.db, brandId, link)
  }),
  r('DELETE', '/api/brands/:id', 'super', (c) => void store.deleteBrand(c.db, id(c.params.id))),
  r('DELETE', '/api/brands/:id/profiles/:network', adminBrand, (c) => {
    const n = net(c.params.network)
    if (!n) throw new Error('Unknown network.')
    store.removeProfile(c.db, id(c.params.id), n)
  }),

  r('GET', '/api/posts', byBrand, ({ db, query }) =>
    store.listPosts(db, {
      brandId: query.get('brand') ? id(query.get('brand')!) : undefined,
      network: net(query.get('network')),
      sort: (['top', 'growth'] as const).find((v) => v === query.get('sort')) ?? 'new',
      limit: Number(query.get('limit') ?? 50),
      offset: Number(query.get('offset') ?? 0),
    }),
  ),
  // A post's numbers over time, for its evolution chart.
  r('GET', '/api/post-history', byBrand, ({ db, query }) =>
    store.brandHistory(db, id(query.get('brand') ?? '0'), net(query.get('network'))),
  ),
  r('GET', '/api/post-metrics', scoped, ({ db, query }) =>
    store.postMetrics(db, id(query.get('post')!)),
  ),
  r('GET', '/api/comments', scoped, ({ db, query }) =>
    store.listComments(db, {
      brandId: query.get('brand') ? id(query.get('brand')!) : undefined,
      postId: query.get('post') ? id(query.get('post')!) : undefined,
      network: net(query.get('network')),
      label: label(query.get('label')),
      needsReply: query.get('reply') === '1',
      overdue: query.get('overdue') === '1',
      day: query.get('day') ?? undefined,
      urgent: query.get('urgent') === '1',
      bad: query.get('bad') === '1',
      threads: query.get('threads') === '1',
      from: query.get('from') ?? undefined,
      readSince: query.get('since') ?? undefined,
      author: query.get('author') ?? undefined,
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

  r('GET', '/api/templates', 'user', () => TEMPLATES),
  r('PUT', '/api/brands/:id/categories', adminBrand, (c) => {
    const list = validCategories((b(c) as { categories?: unknown }).categories)
    store.setCategories(c.db, id(c.params.id), list)
    return list
  }),
  r('PUT', '/api/brands/:id/trackers', adminBrand, (c) =>
    store.setTrackers(c.db, id(c.params.id), (b(c) as { trackers?: unknown }).trackers),
  ),
  // Saved replies: any member reads them, the brand's admins keep them.
  r('GET', '/api/brands/:id/replies', seeBrand, (c) => listReplies(c.db, id(c.params.id))),
  r('POST', '/api/brands/:id/replies', adminBrand, (c) => addReply(c.db, id(c.params.id), c.body)),
  r('PUT', '/api/brands/:id/replies/:reply', adminBrand, (c) =>
    updateReply(c.db, id(c.params.id), id(c.params.reply), c.body),
  ),
  r('DELETE', '/api/brands/:id/replies/:reply', adminBrand, (c) =>
    deleteReply(c.db, id(c.params.id), id(c.params.reply)),
  ),
  r('GET', '/api/sentiment', byBrand, ({ db, query }) =>
    store.sentimentCounts(db, query.get('brand') ? id(query.get('brand')!) : undefined),
  ),
  // Sets or clears sentiment on one or many comments. `by` is 'ai' when Claude sets it.
  r(
    'POST',
    '/api/comments/sentiment',
    (c) => {
      for (const n of ((b(c).ids ?? []) as unknown[]).map(Number)) runs(c, commentBrand(c.db, n))
    },
    (c) => {
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
    },
  ),
  r('PATCH', '/api/comments/:id', adminComment, (c) => {
    const x = b(c) as {
      label?: string
      needs_reply?: boolean
      reason?: string
      reply_status?: string
    }
    if (x.reply_status) {
      if (!['open', 'done', 'ignored'].includes(x.reply_status)) throw new Error('Unknown status.')
      store.setReplyStatus(
        c.db,
        id(c.params.id),
        x.reply_status as 'open' | 'done' | 'ignored',
        c.user?.id,
      )
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
  r(
    'POST',
    '/api/ingest',
    (c) => {
      const x = b(c)
      const brand = store
        .listBrands(c.db)
        .find((br) => br.id === Number(x.brand) || br.name === x.brand)
      runs(c, brand?.id ?? 0)
    },
    (c) => {
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
    },
  ),
  r('POST', '/api/sort', 'super', async ({ db }) => ({ sorted: await sortPending(db) })),
  // One brand at a glance, optionally for one network: what the brand page's overview reads.
  r('GET', '/api/brands/:id/summary', seeBrand, ({ db, params, query }) => {
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
  // The weekly summary Claude wrote at the end of an update, and writing it again on request.
  r('GET', '/api/brands/:id/week', seeBrand, ({ db, params }) => ({
    summary: latestSummary(db, id(params.id)),
  })),
  r('POST', '/api/brands/:id/week', adminBrand, async ({ db, params }) => {
    const brandId = id(params.id)
    if (store.getBrand(db, brandId)?.ai_sort === 0)
      throw new Error('The AI is off for this brand. Turn it on in Settings first.')
    const summary = await refreshSummary(db, brandId, true)
    if (!summary) throw new Error('Nothing to sum up: no comments in the last two weeks.')
    return { summary }
  }),
  r('GET', '/api/brands/:id/insights', seeBrand, ({ db, params, query }) => {
    const s = {
      brandId: id(params.id),
      network: net(query.get('network')),
      days: Number(query.get('days') ?? 30) || 0,
    }
    const labels = labelTotals(db, s)
    const posts = postEngagement(db, s, 1000)
    // The window before this one, so each figure can show how it moved.
    const p = { ...s, previous: true }
    const pLabels = labelTotals(db, p)
    const pPosts = postEngagement(db, p, 1000)
    const brand = store.getBrand(db, s.brandId)
    return {
      timeline: timeline(db, s),
      posts: posts.slice(-30),
      responses: responses(db, s),
      labels,
      reputation: reputation(labels),
      reach: reach(posts),
      interactions: posts.reduce(
        (n, x) => n + (x.likes ?? 0) + (x.comments ?? 0) + (x.shares ?? 0),
        0,
      ),
      previous: s.days
        ? {
            labels: pLabels,
            responses: responses(db, p),
            reputation: reputation(pLabels),
            reach: reach(pPosts),
            posts: pPosts.length,
            interactions: pPosts.reduce(
              (n, x) => n + (x.likes ?? 0) + (x.comments ?? 0) + (x.shares ?? 0),
              0,
            ),
          }
        : null,
      networks: byNetwork(db, s),
      profiles: profileStats(db, s),
      best_times: bestTimes(db, s),
      heatmap: heatmap(db, s),
      authors: topAuthors(db, s),
      words: topWords(db, s, brand?.name ?? ''),
      watched: watched(db, s, JSON.parse(brand?.trackers ?? '[]') as Tracker[]),
    }
  }),
  // The brand's fans and critics in the window, with their reach where a network shows it.
  r('GET', '/api/brands/:id/people', seeBrand, ({ db, params, query }) =>
    fansAndCritics(db, {
      brandId: id(params.id),
      network: net(query.get('network')),
      days: Number(query.get('days') ?? 30) || 0,
    }),
  ),
  // Ideas for the next post: the latest kept, and new ones on an admin's request.
  r(
    'GET',
    '/api/brands/:id/ideas',
    seeBrand,
    ({ db, params }) => latestIdeas(db, id(params.id)) ?? { ideas: [], created_at: null },
  ),
  r('POST', '/api/brands/:id/ideas', adminBrand, ({ db, params }) => {
    const engine = pickEngine(getSettings(db))
    if (!engine)
      throw new Error('No AI to ask: sign in to Claude Code, or set ANTHROPIC_API_KEY in .env.')
    return suggestIdeas(db, id(params.id), engine)
  }),
  r('GET', '/api/brands/:id/daily', seeBrand, ({ db, params, query }) => {
    const day = (k: string, fallback: string) => {
      const v = query.get(k) ?? fallback
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Dates are YYYY-MM-DD.')
      return v
    }
    const today = new Date().toISOString().slice(0, 10)
    const from = day('from', new Date(Date.now() - 89 * 86400_000).toISOString().slice(0, 10))
    const to = day('to', today)
    if (from > to) throw new Error('The start is after the end.')
    if (Date.parse(to) - Date.parse(from) > 3 * 366 * 86400_000)
      throw new Error('Choose at most three years.')
    return daily(db, id(params.id), from, to, net(query.get('network')))
  }),
  // Reports and exports made before, to open again.
  r('GET', '/api/brands/:id/saved', seeBrand, ({ db, params }) => listSaved(db, id(params.id))),
  r(
    'GET',
    '/api/saved/:id/file',
    (c) => {
      const s = getSaved(c.db, id(c.params.id))
      if (!s) throw new HttpError(404, 'No such report.')
      if (s.brand_id == null ? !c.user.super : !roleFor(c.db, c.user, s.brand_id))
        throw new HttpError(403, 'You do not have access to this brand.')
    },
    ({ db, params }) => {
      const s = getSaved(db, id(params.id))!
      return { __download: s.filename, type: s.type, data: new Uint8Array(readSaved(s)) }
    },
  ),
  r(
    'DELETE',
    '/api/saved/:id',
    (c) => {
      const s = getSaved(c.db, id(c.params.id))
      if (!s) throw new HttpError(404, 'No such report.')
      if (s.brand_id == null ? !c.user.super : roleFor(c.db, c.user, s.brand_id) !== 'admin')
        throw new HttpError(403, "Only this brand's admins can do that.")
    },
    ({ db, params }) => void deleteSaved(db, id(params.id)),
  ),
  // The rivals a brand watches, with their profiles: its people see them, its admins change them.
  r('GET', '/api/brands/:id/competitors', seeBrand, ({ db, params }) =>
    store.listCompetitors(db, id(params.id)).map((c) => ({
      ...c,
      profiles: store.listProfiles(db, c.id),
    })),
  ),
  r('POST', '/api/brands/:id/competitors', adminBrand, (c) => {
    const x = b(c) as { name?: string; links?: string[] }
    return store.addCompetitor(c.db, id(c.params.id), String(x.name ?? ''), x.links ?? [])
  }),
  r('DELETE', '/api/brands/:id/competitors/:rival', adminBrand, ({ db, params }) => {
    const rival = store.getBrand(db, id(params.rival))
    if (rival?.competitor_of !== id(params.id)) throw new HttpError(404, 'No such rival.')
    store.deleteBrand(db, rival.id)
  }),
  // Share of voice: the brand first, then its rivals, over the same window and network.
  r('GET', '/api/brands/:id/voice', seeBrand, ({ db, params, query }) => {
    const brandId = id(params.id)
    const ids = [brandId, ...store.listCompetitors(db, brandId).map((c) => c.id)]
    const rows = compare(db, Number(query.get('days') ?? 30) || 0, ids, net(query.get('network')))
    return ids.map((n) => rows.find((r) => r.id === n)!)
  }),
  // Brands side by side; ?brands=1,2 narrows to those, never past the ones this person sees.
  r('GET', '/api/compare', 'user', (c) => {
    const seen = visibleBrands(c.db, c.user)
    const want = (c.query.get('brands') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => n > 0)
    const only = want.length ? want.filter((n) => !seen || seen.includes(n)) : seen
    return compare(c.db, Number(c.query.get('days') ?? 30) || 0, only)
  }),
  r('GET', '/api/brands/:id/export.xlsx', seeBrand, (c) => {
    const { db, params, query } = c
    const brand = store.getBrand(db, id(params.id))
    if (!brand) throw new Error('No such brand.')
    const s = {
      brandId: brand.id,
      network: net(query.get('network')),
      days: Number(query.get('days') ?? 0) || 0,
    }
    const labels = labelTotals(db, s)
    const r = responses(db, s)
    const since = s.days ? new Date(Date.now() - s.days * 86400_000).toISOString() : ''
    const comments = store
      .listComments(db, { brandId: brand.id, network: s.network, limit: 100000 })
      .filter((c) => !since || (c.posted_at ?? '') >= since)
    const posts = postEngagement(db, s, 100000)
    const day = new Date().toISOString().slice(0, 10)
    const out = {
      __download: `${brand.name.replace(/[^\w-]+/g, '-')}-socialmonitor-${day}.xlsx`,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: workbook([
        {
          name: 'Summary',
          rows: [
            ['Measure', 'Value'],
            ['Brand', brand.name],
            ['Period', s.days ? `Last ${s.days} days` : 'All time'],
            ['Network', s.network ?? 'All'],
            ['Exported', day],
            ['Customer comments', labels.total ?? 0],
            ...['complaint', 'question', 'suggestion', 'praise', 'neutral', 'spam', 'unsorted'].map(
              (k) => [`  ${k}`, labels[k] ?? 0],
            ),
            ['Answered by the brand', r.answered],
            ['Response rate', r.rate === null ? '' : Math.round(r.rate * 100) / 100],
            ['Median minutes to reply', r.median_minutes ?? ''],
            ['Posts', posts.length],
          ],
        },
        {
          name: 'Comments',
          rows: [
            [
              'Network',
              'Published',
              'Author',
              'Comment',
              'English',
              'Likes',
              'Label',
              'Needs reply',
              'Reply status',
              'AI reason',
              'Sentiment',
              'Kind',
              'Rated by',
              'Post',
            ],
            ...comments.map((c) => [
              c.network,
              c.posted_at,
              c.author,
              c.text,
              c.translation,
              c.likes,
              c.label,
              c.needs_reply === 1,
              c.reply_status,
              c.reason,
              c.sentiment,
              c.category,
              c.sentiment_by,
              c.post_url,
            ]),
          ],
        },
        {
          name: 'Posts',
          rows: [
            ['Network', 'Published', 'Likes', 'Comments', 'Shares', 'Views', 'About', 'URL'],
            ...posts.map((p) => [
              p.network,
              p.day,
              p.likes,
              p.comments,
              p.shares,
              p.views,
              p.about,
              p.url,
            ]),
          ],
        },
      ]),
    }
    saveReport(db, {
      brandId: brand.id,
      kind: 'xlsx',
      filename: out.__download,
      type: out.type,
      data: out.data,
      params: Object.fromEntries(query),
      userId: c.user.id,
    })
    return out
  }),
  // A brand's own TikTok, connected through TikTok's sign-in.
  r('GET', '/api/brands/:id/tiktok', seeBrand, (c) => ({
    ready: tiktokReady(),
    account: connection(c.db, id(c.params.id)),
  })),
  r('POST', '/api/brands/:id/tiktok/connect', adminBrand, (c) => ({
    url: authorizeUrl(
      id(c.params.id),
      c.user.id,
      String((b(c) as { origin?: string }).origin ?? ''),
    ),
  })),
  r('DELETE', '/api/brands/:id/tiktok', adminBrand, (c) => void disconnect(c.db, id(c.params.id))),
  // TikTok returns here through the website's hand-back page; the state proves who asked.
  r('GET', '/api/auth/tiktok/callback', 'public', async (c) => {
    const err = c.query.get('error')
    if (err) return { __redirect: `/?tiktok=${encodeURIComponent(err)}` }
    const { brandId } = await finishSignIn(
      c.db,
      c.query.get('code') ?? '',
      c.query.get('state') ?? '',
    )
    return { __redirect: `/b/${brandId}/about?tiktok=connected` }
  }),
  // A brand's own Facebook Page and its Instagram, connected through Facebook's sign-in.
  r('GET', '/api/brands/:id/meta', seeBrand, (c) => ({
    ready: meta.metaReady(),
    ...meta.connection(c.db, id(c.params.id)),
  })),
  r('POST', '/api/brands/:id/meta/connect', adminBrand, (c) => ({
    url: meta.authorizeUrl(id(c.params.id), String((b(c) as { origin?: string }).origin ?? '')),
  })),
  r(
    'DELETE',
    '/api/brands/:id/meta',
    adminBrand,
    (c) => void meta.disconnect(c.db, id(c.params.id)),
  ),
  // Facebook returns here through the website's hand-back page; the state proves who asked.
  r('GET', '/api/auth/meta/callback', 'public', async (c) => {
    const err = c.query.get('error_description') ?? c.query.get('error')
    if (err) return { __redirect: `/?meta=${encodeURIComponent(err)}` }
    const r = await meta.finishSignIn(c.db, c.query.get('code') ?? '', c.query.get('state') ?? '')
    return {
      __redirect: `/b/${r.brandId}/about?meta=${r.error ? encodeURIComponent(r.error) : 'connected'}`,
    }
  }),
  r('PUT', '/api/brands/:id/alerts', adminBrand, (c) => {
    const x = b(c) as { emails?: unknown; auto?: unknown }
    return setAlerts(c.db, id(c.params.id), x.emails, x.auto, c.user.lang)
  }),
  // Instant-alert triggers and the summary email; both go to the report's addresses.
  r('PUT', '/api/brands/:id/notify', adminBrand, (c) =>
    setNotify(c.db, id(c.params.id), b(c) as Parameters<typeof setNotify>[2]),
  ),
  r('GET', '/api/brands/:id/bad.pdf', seeBrand, async (c) => {
    const out = await badPdf(
      c.db,
      id(c.params.id),
      { days: Number(c.query.get('days')) || undefined, network: net(c.query.get('network')) },
      c.user,
    )
    return { __download: out.filename, type: 'application/pdf', data: out.data }
  }),
  r('POST', '/api/brands/:id/bad/send', adminBrand, async (c) => ({
    sent: await sendBad(
      c.db,
      id(c.params.id),
      { days: Number((b(c) as { days?: number }).days) || undefined },
      c.user,
    ),
  })),
  r('GET', '/api/brands/:id/report.pdf', seeBrand, async (c) => {
    const { db, params, query } = c
    const brand = store.getBrand(db, id(params.id))
    if (!brand) throw new Error('No such brand.')
    const ui = uiOrigin()
    const q = new URLSearchParams()
    for (const k of ['days', 'network']) if (query.get(k)) q.set(k, query.get(k)!)
    const out = {
      __download: `${brand.name.replace(/[^\w-]+/g, '-')}-report-${new Date().toISOString().slice(0, 10)}.pdf`,
      type: 'application/pdf',
      data: await brandPdf(ui, brand.id, q.toString(), signSession(c.user, 120)),
    }
    saveReport(db, {
      brandId: brand.id,
      kind: 'pdf',
      filename: out.__download,
      type: out.type,
      data: out.data,
      params: Object.fromEntries(query),
      userId: c.user.id,
    })
    return out
  }),
  // AI helpers on one comment. The app never posts: a draft is text to copy.
  r('POST', '/api/comments/:id/draft', adminComment, async ({ db, params }) => {
    const engine = pickEngine(getSettings(db))
    if (!engine)
      throw new Error(
        'No AI to write with: sign in to Claude Code, or set ANTHROPIC_API_KEY in .env.',
      )
    const c = db
      .prepare(
        `SELECT c.text, c.author, c.category, p.caption, b.id AS brand_id, b.name, b.industry, b.description
         FROM comments c JOIN posts p ON p.id = c.post_id
         JOIN profiles pr ON pr.id = p.profile_id JOIN brands b ON b.id = pr.brand_id WHERE c.id = ?`,
      )
      .get(id(params.id)) as
      | {
          text: string
          author: string
          category: string | null
          caption: string
          brand_id: number
          name: string
          industry: string | null
          description: string | null
        }
      | undefined
    if (!c) throw new Error('No such comment.')
    const about = [c.industry, c.description].filter(Boolean).join('; ')
    // With saved replies, Claude picks the one that fits and fills it in; else a fresh draft.
    const saved = candidates(listReplies(db, c.brand_id), c.category)
    if (!saved.length) return { draft: await draftReply(engine, c.name, about, c.caption, c.text) }
    const pick = await draftFromSaved(
      engine,
      c.name,
      about,
      c.caption,
      { text: c.text, author: c.author, kind: c.category },
      saved,
    )
    const name = c.author.replace(/^@/, '')
    return {
      draft: fillReply(pick.text, { name }),
      saved: pick.index === null ? null : saved[pick.index]!.title,
    }
  }),
  r('POST', '/api/comments/:id/translate', seeComment, async ({ db, params, body }) => {
    const engine = pickEngine(getSettings(db))
    if (!engine)
      throw new Error(
        'No AI to translate with: sign in to Claude Code, or set ANTHROPIC_API_KEY in .env.',
      )
    const commentId = id(params.id)
    const c = db.prepare('SELECT text, translation FROM comments WHERE id = ?').get(commentId) as
      { text: string; translation: string | null } | undefined
    if (!c) throw new Error('No such comment.')
    // The English translation is kept; other languages are made on request.
    const lang = String((body as { lang?: string }).lang ?? 'en')
    if (lang === 'en' && c.translation) return { translation: c.translation }
    const translation = await translate(engine, c.text, lang)
    if (lang === 'en')
      db.prepare('UPDATE comments SET translation = ? WHERE id = ?').run(translation, commentId)
    return { translation }
  }),
  // What an update would read: each profile, when it was last read, and how many older posts
  // are due for fresh numbers.
  r('GET', '/api/runs/preview', 'user', (c) => {
    const ids = (c.query.get('brands') ?? '').split(',').map(Number).filter(Boolean)
    for (const brandId of ids) sees(c, brandId)
    return ids.flatMap((brandId) =>
      store.listProfiles(c.db, brandId).map((p) => ({
        brand_id: brandId,
        brand: store.getBrand(c.db, brandId)?.name ?? '',
        network: p.network,
        handle: p.handle,
        last_run_at: p.last_run_at,
        last_status: p.last_status,
        due: store.duePosts(c.db, p.id).length,
      })),
    )
  }),
  r(
    'POST',
    '/api/runs/:id/stop',
    (c) => {
      for (const brandId of runBrands(c.db, id(c.params.id))) runs(c, brandId)
    },
    (c) => void store.askStop(c.db, id(c.params.id)),
  ),
  r('GET', '/api/runs', 'user', (c) => {
    const brand = c.query.get('brand')
    const list = visible(c, store.listRuns(c.db, 60), (r) => runBrands(c.db, r.id))
    return brand ? list.filter((r) => runBrands(c.db, r.id).includes(Number(brand))) : list
  }),
  r(
    'POST',
    '/api/runs',
    (c) => {
      const ids = ((b(c).brandIds ?? []) as unknown[]).map(Number)
      if (!ids.length && !c.user.super) throw new HttpError(403, 'Choose a brand.')
      for (const n of ids) runs(c, n)
    },
    (c) => {
      const x = b(c) as { brandIds?: number[]; networks?: string[]; range?: Range; limit?: number }
      const runId = queueRun(
        c.db,
        {
          brandIds: (x.brandIds ?? []).map(Number).filter(Boolean),
          networks: (x.networks ?? []).map((n) => net(n)).filter((n): n is Network => !!n),
          range: x.range === 'all' || x.range === 'new' ? x.range : 'due',
          limit: Number(x.limit) || 5,
        },
        'manual',
      )
      return { id: runId }
    },
  ),
  r('GET', '/api/runs/:id/report.md', seeRun, (c) => ({
    __download: `socialmonitor-report-${c.params.id}.md`,
    type: 'text/markdown; charset=utf-8',
    data: store.getRun(c.db, id(c.params.id))?.report ?? '',
  })),
  r('GET', '/api/runs/:id', seeRun, (c) => store.getRun(c.db, id(c.params.id))),

  r('GET', '/api/schedules', 'user', (c) =>
    visible(c, store.listSchedules(c.db), (x) => x.brand_id),
  ),
  r(
    'POST',
    '/api/schedules',
    (c) => runs(c, Number(b(c).brand_id)),
    (c) => store.saveSchedule(c.db, b(c) as unknown as store.ScheduleInput),
  ),
  r(
    'PUT',
    '/api/schedules/:id',
    (c) => {
      adminSchedule(c)
      runs(c, Number(b(c).brand_id))
    },
    (c) => store.saveSchedule(c.db, b(c) as unknown as store.ScheduleInput, id(c.params.id)),
  ),
  r(
    'DELETE',
    '/api/schedules/:id',
    adminSchedule,
    (c) => void store.deleteSchedule(c.db, id(c.params.id)),
  ),
]
