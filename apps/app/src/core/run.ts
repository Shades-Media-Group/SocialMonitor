import { mkdirSync, writeFileSync } from 'node:fs'
import type { Page } from 'playwright'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR, now } from './db.ts'
import * as store from './store.ts'
import type { Network, Profile, RunScope } from './types.ts'
import { NETWORKS } from './types.ts'
import { collectors } from './collect/index.ts'
import { Challenge, closeBrowser, openBrowser, pause } from './collect/browser.ts'
import { describePost, pickEngine, sortComments } from './analyze.ts'
import { getSettings } from './settings.ts'
import { buildReport } from './report.ts'

/** Comment text comes from a signed-in session on these; their updates keep the gap. */
const SIGNED_IN: Network[] = ['instagram', 'facebook', 'tiktok']
const MAX_COMMENTS = 300

type Trigger = 'manual' | 'schedule' | 'mcp'
const queue: { scope: RunScope; trigger: Trigger; runId: number }[] = []
let busy = false

/** Queues an update and returns its run id. Updates run one at a time: the browser profile is shared. */
export function queueRun(db: DB, scope: RunScope, trigger: Trigger): number {
  if (!scope.brandIds.length) throw new Error('Choose at least one brand.')
  if (!scope.networks.length) throw new Error('Choose at least one network.')
  const runId = store.startRun(db, trigger, scope)
  store.logRun(db, runId, busy ? 'Waiting for the update before it to finish.' : 'Starting.')
  queue.push({ scope, trigger, runId })
  void drain(db)
  return runId
}

async function drain(db: DB) {
  if (busy) return
  busy = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      await execute(db, job.runId, job.scope).catch((e: Error) => {
        store.logRun(db, job.runId, `Stopped: ${e.message}`)
        store.finishRun(db, job.runId, 'error', {}, `The update stopped: ${e.message}`)
      })
    }
  } finally {
    busy = false
    await closeBrowser()
  }
}

/** When the gap since the last signed-in read of this profile ends, or null if it has. */
function gapUntil(db: DB, p: Profile): string | null {
  if (!SIGNED_IN.includes(p.network) || !p.last_session_at) return null
  const hours = getSettings(db).gap_hours
  const next = new Date(new Date(p.last_session_at).getTime() + hours * 3600_000)
  return next.getTime() > Date.now() ? next.toISOString() : null
}

async function saveThumb(network: Network, id: string, url: string | null): Promise<string | null> {
  if (!url || url.startsWith('/media/')) return url
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
    if (!r.ok) return null
    const dir = join(DATA_DIR, 'media', network)
    mkdirSync(dir, { recursive: true })
    const file = `${id.replace(/[^\w-]/g, '')}.jpg`
    writeFileSync(join(dir, file), Buffer.from(await r.arrayBuffer()))
    return `/media/${network}/${file}`
  } catch {
    return null
  }
}

async function execute(db: DB, runId: number, scope: RunScope) {
  const log = (line: string) => store.logRun(db, runId, line)
  const since = now()
  const settings = getSettings(db)
  const engine = pickEngine(settings)
  const touched: { postId: number; brand: string }[] = []
  const problems: string[] = []
  const skipped: string[] = []
  let page: Page | null = null

  for (const brandId of scope.brandIds) {
    const brand = store.getBrand(db, brandId)
    if (!brand) continue
    const profiles = store
      .listProfiles(db, brandId)
      .filter((p) => scope.networks.includes(p.network))
    // Networks in a fixed order, so a pattern of requests looks the same as a person's habit.
    for (const p of profiles.sort(
      (a, b) => NETWORKS.indexOf(a.network) - NETWORKS.indexOf(b.network),
    )) {
      const waitUntil = gapUntil(db, p)
      const readComments = !waitUntil
      if (waitUntil) {
        const at = new Date(waitUntil).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        })
        skipped.push(
          `${brand.name} on ${p.network}: comments wait until ${at} (the ${settings.gap_hours}-hour gap); counts were refreshed.`,
        )
        log(
          `${p.network}: inside the ${settings.gap_hours}-hour gap, so only counts are refreshed.`,
        )
      }
      try {
        page ??= (await openBrowser()).pages()[0] ?? (await (await openBrowser()).newPage())
        log(`${brand.name}: reading ${p.network} @${p.handle}.`)
        const opt = {
          range: scope.range,
          limit: Math.max(1, Math.min(50, scope.limit)),
          known: store.knownPostIds(db, p.id),
          comments: readComments,
          maxComments: MAX_COMMENTS,
          usedSession: false,
          log,
        }
        const posts = await collectors[p.network].collect(page, p, opt)
        for (const cp of posts) {
          cp.thumb_url = await saveThumb(p.network, cp.ext_id, cp.thumb_url)
          const { post, newComments } = store.savePost(db, p, cp)
          touched.push({ postId: post.id, brand: brand.name })
          if (newComments) log(`  ${newComments} new comments on ${post.url}`)
        }
        store.markProfile(db, p.id, 'ok', null, opt.usedSession)
      } catch (e) {
        const msg = (e as Error).message
        store.markProfile(db, p.id, 'error', msg)
        problems.push(`${brand.name} on ${p.network}: ${msg}`)
        log(`Stopped ${p.network}: ${msg}`)
        if (e instanceof Challenge) continue
      }
      await pause(4000, 9000)
    }
  }
  await closeBrowser()

  // The AI step: describe new posts, sort new comments.
  if (!engine) {
    problems.push(
      'Comments were kept but not sorted: install Claude Code, or set ANTHROPIC_API_KEY in .env.',
    )
  } else {
    for (const { postId, brand } of touched) {
      const post = store.getPost(db, postId)!
      const unsorted = store.listComments(db, { postId, unsorted: true, limit: 2000 })
      try {
        if (unsorted.length) {
          log(`Sorting ${unsorted.length} comments on ${post.url}`)
          const verdicts = await sortComments(
            engine,
            brand,
            post.caption,
            unsorted.map((c) => ({ id: c.id, text: c.text })),
          )
          for (const [id, v] of verdicts) store.setVerdict(db, id, v.label, v.needsReply, v.reason)
        }
        if (!post.description) {
          const top = store.listComments(db, { postId, limit: 5 }).map((c) => c.text)
          const image = post.thumb_url?.startsWith('/media/')
            ? join(DATA_DIR, post.thumb_url)
            : null
          store.setDescription(
            db,
            postId,
            await describePost(engine, brand, post.caption, top, image),
          )
        }
      } catch (e) {
        problems.push(`AI: ${(e as Error).message}`)
        log(`AI step failed: ${(e as Error).message}`)
        break
      }
    }
  }

  // Retention: comments older than the setting are deleted after every update.
  const cutoff = new Date(Date.now() - settings.keep_days * 86400_000).toISOString()
  const purged = db
    .prepare('DELETE FROM comments WHERE coalesce(posted_at, fetched_at) < ?')
    .run(cutoff).changes
  if (purged) log(`Deleted ${purged} comments older than ${settings.keep_days} days.`)

  const { text, stats } = buildReport(
    db,
    scope,
    since,
    touched.map((t) => t.postId),
    problems,
    skipped,
  )
  const status = problems.length ? (touched.length ? 'partial' : 'error') : 'ok'
  store.finishRun(db, runId, status, stats, text)
  log('Done.')
}
