import { autoSendBad, instantAlerts } from './alerts.ts'
import { saveImage } from './media.ts'
import { fillTikTok } from './fill.ts'
import { officialFigures } from './tiktok-api.ts'
import { metaRoute, officialCollect } from './meta-public.ts'
import type { Page } from 'playwright'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR, now } from './db.ts'
import * as store from './store.ts'
import type { Comment, Network, Profile, RunScope } from './types.ts'
import { NETWORKS } from './types.ts'
import { collectors } from './collect/index.ts'
import { Challenge, closeBrowser, openBrowser, pause } from './collect/browser.ts'
import { describePost, pickCampaigns, pickEngine, probeClaude, sortComments } from './analyze.ts'
import { placeByAi } from './campaigns.ts'
import type { Kind, Verdict } from './analyze.ts'
import {
  AiLimitError,
  MARGIN_MS,
  activePause,
  afterPause,
  clock,
  needCatchUp,
  pauseText,
  takeCatchUp,
} from './ai-limit.ts'
import type { AiPause } from './ai-limit.ts'
import { getSettings } from './settings.ts'
import { buildReport } from './report.ts'

/** Comment text comes from a signed-in session on these; their updates keep the gap. */
const SIGNED_IN: Network[] = ['instagram', 'facebook', 'tiktok']
const MAX_COMMENTS = 300

type Trigger = 'manual' | 'schedule' | 'mcp'
interface Job {
  scope: RunScope
  trigger: Trigger
  runId: number
  /** The schedule that started it, moved to the reset when Claude is at its limit. */
  scheduleId?: number
}
const queue: Job[] = []
let busy = false

/** Queues an update and returns its run id. Updates run one at a time: the browser profile is shared. */
export function queueRun(
  db: DB,
  scope: RunScope,
  trigger: Trigger,
  opts: { scheduleId?: number } = {},
): number {
  if (!scope.brandIds.length) throw new Error('Choose at least one brand.')
  if (!scope.networks.length) throw new Error('Choose at least one network.')
  const runId = store.startRun(db, trigger, scope)
  store.logRun(db, runId, busy ? 'Waiting for the update before it to finish.' : 'Starting.')
  queue.push({ scope, trigger, runId, scheduleId: opts.scheduleId })
  void drain(db)
  return runId
}

/** Resolves once no update or catch-up is running and none is queued (for tests). */
export async function idle() {
  while (busy || queue.length) await new Promise((r) => setTimeout(r, 5))
}

async function drain(db: DB) {
  if (busy) return
  busy = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      await execute(db, job).catch((e: Error) => {
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

/** For each profile inside the gap, when its comments can be read again. */
export function gaps(db: DB) {
  return store
    .listProfiles(db)
    .map((p) => ({
      profile_id: p.id,
      brand_id: p.brand_id,
      network: p.network,
      until: gapUntil(db, p),
    }))
    .filter((g) => g.until)
}

async function execute(db: DB, { runId, scope, trigger, scheduleId }: Job) {
  const log = (line: string) => store.logRun(db, runId, line)
  const since = now()
  const settings = getSettings(db)
  const touched: { postId: number; brand: string; brandId: number }[] = []
  const problems: string[] = []
  const skipped: string[] = []
  const waiting: string[] = []
  let page: Page | null = null
  const stopped = () => store.stopAsked(db, runId)
  // Each brand's rivals are read with it, so its share of voice stays current.
  const brandIds = store.withCompetitors(db, scope.brandIds)

  // Before any work: can Claude take it? At its usage limit, a scheduled update moves to the
  // reset; one a person (or Claude through MCP) started reads now and leaves the sorting for later.
  const aiWait = await aiPreflight(db, brandIds)
  if (aiWait && trigger === 'schedule') {
    const at = afterPause(aiWait)
    if (scheduleId) store.setNextRun(db, scheduleId, at)
    const text = `${pauseText(aiWait)} This update moves to ${clock(at)}.`
    log(text)
    store.finishRun(db, runId, 'postponed', {}, `# Update postponed\n\n${text}\n`)
    return
  }
  if (aiWait)
    log(
      `${pauseText(aiWait)} Posts and comments are read now; Claude sorts them after ${clock(afterPause(aiWait))}.`,
    )
  // Every profile this update reads, for "2 of 5" in the progress notice.
  const all = brandIds.flatMap((id) =>
    store.listProfiles(db, id).filter((p) => scope.networks.includes(p.network)),
  )
  let at = 0

  for (const brandId of brandIds) {
    if (stopped()) break
    const brand = store.getBrand(db, brandId)
    if (!brand) continue
    const profiles = store
      .listProfiles(db, brandId)
      .filter((p) => scope.networks.includes(p.network))
    // Networks in a fixed order, so a pattern of requests looks the same as a person's habit.
    for (const p of profiles.sort(
      (a, b) => NETWORKS.indexOf(a.network) - NETWORKS.indexOf(b.network),
    )) {
      if (stopped()) break
      at++
      const progress = (done = 0, total = 0) =>
        store.setProgress(db, runId, {
          step: 'read',
          brand: brand.name,
          network: p.network,
          profile: at,
          profiles: all.length,
          done,
          total,
        })
      progress()
      // Meta's official API reads a connected Page, or another brand's public Instagram (Business
      // Discovery) and, once approved, Facebook Page (PPCA): no browser, no signed-in gap.
      const route = metaRoute(db, p)
      const viaMeta = route !== 'browser'
      const waitUntil = viaMeta ? null : gapUntil(db, p)
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
        if (!viaMeta)
          page ??= (await openBrowser()).pages()[0] ?? (await (await openBrowser()).newPage())
        log(`${brand.name}: reading ${p.network} @${p.handle}.`)
        const opt = {
          range: scope.range,
          limit: Math.max(1, Math.min(50, scope.limit)),
          known: store.knownPostIds(db, p.id),
          due:
            scope.range === 'due'
              ? new Map(store.duePosts(db, p.id).map((d) => [d.ext_id, d.comments_count]))
              : new Map<string, number | null>(),
          comments: readComments,
          maxComments: MAX_COMMENTS,
          usedSession: false,
          log,
          step: progress,
          stopped,
        }
        const official = viaMeta
          ? await officialCollect(db, p, opt, route).catch((e: Error) => {
              // A connected Page's errors are the brand's to fix; for the public routes, the
              // browser takes over for this update, as it read before.
              if (route === 'connected') throw e
              log(`${p.network} @${p.handle}: ${e.message} Reading it from the web this time.`)
              return null
            })
          : null
        if (!official && viaMeta && route !== 'connected') {
          const gap = gapUntil(db, p)
          opt.comments = !gap
          if (gap) log(`${p.network}: inside the ${settings.gap_hours}-hour gap, so only counts.`)
          page ??= (await openBrowser()).pages()[0] ?? (await (await openBrowser()).newPage())
        }
        const posts = official ?? (await collectors[p.network].collect(page!, p, opt))
        if (p.network === 'tiktok')
          await officialFigures(db, p, posts, log).catch((e: Error) =>
            log(`TikTok connection: ${e.message}`),
          )
        const read = { posts: posts.length, comments: 0, new: 0 }
        for (const cp of posts) {
          cp.thumb_url = await saveImage(p.network, '', cp.ext_id, cp.thumb_url)
          for (const c of cp.comments) {
            c.author_avatar = await saveImage(p.network, 'people', c.author, c.author_avatar)
            c.media_url = await saveImage(p.network, 'comments', c.ext_id, c.media_url)
          }
          const { post, newComments } = store.savePost(db, p, cp)
          touched.push({ postId: post.id, brand: brand.name, brandId: brand.id })
          read.comments += cp.comments.length
          read.new += newComments
          if (newComments) log(`  ${newComments} new comments on ${post.url}`)
        }
        // What this update read for the brand, for the Admin tab's history of updates.
        store.tallyRun(db, runId, brand.id, read)
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

  // The AI step: describe new posts and sort every comment still unsorted on these brands,
  // including ones an earlier update could not sort.
  const brands = new Set(touched.map((t) => t.brandId))
  const posts = new Map(touched.map((t) => [t.postId, t]))
  for (const p of pendingPosts(db))
    if (brands.has(p.brandId) && !posts.has(p.postId)) posts.set(p.postId, p)
  // Brands whose admins turned the AI off keep their comments unsorted.
  const off = aiOff(db)
  const todo = [...posts.values()].filter((p) => !off.has(p.brandId))
  const later = (after: string) => needCatchUp(db, [...new Set(todo.map((p) => p.brandId))], after)
  // Still paused (the limit was found before reading): no AI call is tried.
  const paused = aiWait && activePause(db)
  try {
    if (!stopped() && todo.length && paused) {
      const after = afterPause(paused)
      waiting.push(
        `${pauseText(paused)} ${todo.length} ${todo.length === 1 ? 'post waits' : 'posts wait'} to be described or have their comments sorted; Claude does it after ${clock(after)}.`,
      )
      log(`Sorting waits for Claude until ${clock(after)}.`)
      later(after)
    } else if (!stopped() && todo.length)
      await aiStep(
        db,
        todo,
        log,
        (done, total) => store.setProgress(db, runId, { step: 'sort', done, total }),
        runId,
      )
  } catch (e) {
    if (e instanceof AiLimitError) {
      // At the limit no further call is made: what was read and sorted so far is kept, and the
      // rest is sorted once the limit resets.
      const after = new Date(e.until.getTime() + MARGIN_MS).toISOString()
      waiting.push(
        `${e.message} Sorting stopped there; what was read is kept, and Claude sorts the rest after ${clock(after)}.`,
      )
      log(`Stopped sorting: ${e.message}`)
      later(after)
    } else problems.push((e as Error).message)
  }

  // Photos and stickers for TikTok comments read before they were kept, from public pages.
  await fillTikTok(db, log).catch((e) => log(`Could not fill photos: ${(e as Error).message}`))

  // The bad-comments report, to brands that asked for it after each update.
  await autoSendBad(
    db,
    touched.map((t) => t.brandId),
    since,
    log,
  )
  // Instant alerts: urgent comments, a run of complaints, words to watch.
  await instantAlerts(
    db,
    touched.map((t) => t.brandId),
    log,
  )

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
    waiting,
  )
  const status = stopped()
    ? 'stopped'
    : problems.length || waiting.length
      ? touched.length
        ? 'partial'
        : 'error'
      : 'ok'
  if (status === 'stopped') log('Stopped on request; what was read so far is kept.')
  store.finishRun(db, runId, status, stats, text)
  log('Done.')
}

/**
 * Describes posts without a description and sorts unsorted comments, post by post. Every AI call
 * carries runId, the update it is part of; the Sort now button passes none.
 */
export async function aiStep(
  db: DB,
  touched: { postId: number; brand: string }[],
  log: (line: string) => void,
  step?: (done: number, total: number) => void,
  runId?: number,
) {
  const engine = pickEngine(getSettings(db))
  if (!engine)
    throw new Error(
      'Comments were kept but not sorted: install Claude Code, or set ANTHROPIC_API_KEY in .env.',
    )
  for (const [i, { postId, brand }] of touched.entries()) {
    step?.(i, touched.length)
    const post = store.getPost(db, postId)!
    const use = {
      db,
      brandId: (
        db.prepare('SELECT brand_id FROM profiles WHERE id = ?').get(post.profile_id) as
          { brand_id: number } | undefined
      )?.brand_id,
      network: post.network,
      runId,
    }
    const unsorted = store.listComments(db, { postId, stale: true, others: true, limit: 2000 })
    let save: ((verdicts: Map<number, Verdict>) => void) | null = null
    try {
      // What the post shows comes first, so comments are read against it.
      let shows = post.description
      if (!shows) {
        const top = store.listComments(db, { postId, others: true, limit: 5 }).map((c) => c.text)
        const image = post.thumb_url?.startsWith('/media/') ? join(DATA_DIR, post.thumb_url) : null
        shows = await describePost(engine, brand, post.caption, top, image, {
          ...use,
          task: 'describe-post',
        })
        store.setDescription(db, postId, shows)
      }
      if (unsorted.length) {
        log(`Sorting ${unsorted.length} comments on ${post.url}`)
        const b = db
          .prepare('SELECT industry, description, categories FROM brands WHERE name = ?')
          .get(brand) as
          { industry: string | null; description: string | null; categories: string } | undefined
        const about = [b?.industry, b?.description].filter(Boolean).join('; ')
        const kinds = JSON.parse(b?.categories || '[]') as Kind[]
        save = (verdicts) => {
          for (const [id, v] of verdicts) {
            store.setVerdict(db, id, v.label, v.needsReply, v.reason, v.urgency, v.emotion)
            // The brand's kind, unless a person already rated this comment.
            const kind = kinds.find((k) => k.key === v.category)
            const byPerson = unsorted.find((c) => c.id === id)?.sentiment_by === 'you'
            if (!byPerson)
              store.setSentiment(db, id, kind ? kind.sentiment : 'neutral', kind?.key ?? null, 'ai')
          }
        }
        save(
          await sortComments(
            engine,
            brand,
            `${post.caption}${shows ? ` (What the post shows: ${shows})` : ''}`,
            unsorted.map((c) => ({ id: c.id, text: c.text, ...conversation(db, post, c) })),
            about,
            kinds,
            { ...use, task: 'sort-comments' },
          ),
        )
      }
    } catch (e) {
      // At Claude's limit the batches sorted before it are kept, and nothing more is asked.
      if (e instanceof AiLimitError) {
        if (e.partial && save) save(e.partial as Map<number, Verdict>)
        throw e
      }
      // Kept so Settings can say why the AI stopped; the comments stay for the next update.
      store.setSetting(db, 'ai_error', JSON.stringify({ at: now(), message: (e as Error).message }))
      throw new Error(`AI: ${(e as Error).message}`, { cause: e })
    }
  }
  // Campaigns last, once posts are described: Claude places what the hints did not.
  try {
    const placed = await placeByAi(
      db,
      touched.map((x) => x.postId),
      (brand, campaigns, posts, brandId) =>
        pickCampaigns(engine, brand, campaigns, posts, {
          db,
          task: 'campaign-tags',
          brandId,
          runId,
        }),
    )
    if (placed) log(`Claude placed ${placed} posts in campaigns.`)
  } catch (e) {
    if (e instanceof AiLimitError) throw e
    log(`Could not place posts in campaigns: ${(e as Error).message}`)
  }
  store.setSetting(db, 'ai_error', '')
}

/**
 * What surrounds a comment, for the AI to read it as a person would: the comment it answers,
 * up to three answers under it (the brand's own named as such) and its picture, if saved.
 */
function conversation(db: DB, post: { id: number; profile_id: number }, c: Comment) {
  const handle = (
    db.prepare('SELECT handle FROM profiles WHERE id = ?').get(post.profile_id) as {
      handle: string
    }
  ).handle.toLowerCase()
  const who = (author: string) => (author.toLowerCase() === handle ? 'the brand' : `@${author}`)
  const thread = db
    .prepare('SELECT ext_id, parent_ext_id, author, text FROM comments WHERE post_id = ?')
    .all(post.id) as {
    ext_id: string
    parent_ext_id: string | null
    author: string
    text: string
  }[]
  const parent = c.parent_ext_id ? thread.find((x) => x.ext_id === c.parent_ext_id) : undefined
  const answers = thread.filter((x) => x.parent_ext_id === c.ext_id).slice(0, 3)
  const parts = [
    parent && `answers ${who(parent.author)}: "${parent.text.slice(0, 160)}"`,
    ...answers.map((a) => `${who(a.author)} answered: "${a.text.slice(0, 160)}"`),
  ].filter(Boolean)
  return {
    context: parts.length ? parts.join('; ') : undefined,
    // Only formats the AI can read (AVIF is shown in the dashboard but not sent).
    image:
      c.media_url?.startsWith('/media/') && /\.(jpe?g|png|webp|gif)$/i.test(c.media_url)
        ? join(DATA_DIR, c.media_url)
        : undefined,
  }
}

/** Posts with no description yet, or with comments the current sort has not read. */
const pendingPosts = (db: DB) =>
  db
    .prepare(
      `SELECT DISTINCT p.id AS postId, b.name AS brand, b.id AS brandId FROM posts p JOIN profiles pr ON pr.id = p.profile_id JOIN brands b ON b.id = pr.brand_id
       WHERE p.description IS NULL OR EXISTS (SELECT 1 FROM comments c WHERE c.post_id = p.id AND ${store.STALE} AND lower(c.author) != lower(pr.handle))`,
    )
    .all() as { postId: number; brand: string; brandId: number }[]

/** Brands whose admins turned the AI sort off. */
const aiOff = (db: DB) =>
  new Set(
    (db.prepare('SELECT id FROM brands WHERE ai_sort = 0').all() as { id: number }[]).map(
      (b) => b.id,
    ),
  )

/**
 * Whether these brands' AI step runs on the Claude subscription, the one thing with a usage
 * limit: Claude Code is the engine and no API key is there to take over.
 */
function onSubscription(db: DB, brandIds: number[]) {
  if (process.env.ANTHROPIC_API_KEY) return false
  const off = aiOff(db)
  if (!brandIds.some((id) => !off.has(id))) return false
  return pickEngine(getSettings(db)) === 'claude'
}

/**
 * Before an update that will use Claude: the pause, when the AI is paused; else one tiny call to
 * see that Claude takes work, which pauses the AI when it is at its limit. Null when the update
 * may go ahead. Any other failure lets it go ahead: the AI step reports it as before.
 */
export async function aiPreflight(db: DB, brandIds: number[]): Promise<AiPause | null> {
  if (!onSubscription(db, brandIds)) return null
  const paused = activePause(db)
  if (paused) return paused
  try {
    await probeClaude(db)
    return null
  } catch (e) {
    return e instanceof AiLimitError ? activePause(db) : null
  }
}

/**
 * Once a pause has ended, sorts what a limit left waiting: the brands' undescribed posts and
 * unsorted comments, with the normal AI step, at most once per pause. A brand whose schedule
 * runs within the hour is left to that update. Never beside an update. Returns how many posts
 * it took on, or null when there was nothing to do yet.
 */
export async function catchUp(db: DB, at = new Date()): Promise<number | null> {
  if (busy) return null
  const brandIds = takeCatchUp(db, at)
  if (!brandIds) return null
  const soon = store.withCompetitors(
    db,
    store
      .listSchedules(db)
      .filter(
        (s) => s.enabled && s.next_run_at && Date.parse(s.next_run_at) - at.getTime() < 3600_000,
      )
      .map((s) => s.brand_id),
  )
  const off = aiOff(db)
  const rows = pendingPosts(db).filter(
    (p) => brandIds.includes(p.brandId) && !soon.includes(p.brandId) && !off.has(p.brandId),
  )
  if (!rows.length) return 0
  busy = true
  try {
    await aiStep(db, rows, () => {})
  } catch (e) {
    if (e instanceof AiLimitError)
      needCatchUp(
        db,
        [...new Set(rows.map((r) => r.brandId))],
        new Date(e.until.getTime() + MARGIN_MS).toISOString(),
      )
    else console.error(`Sorting after Claude's limit: ${(e as Error).message}`)
  } finally {
    busy = false
    if (queue.length) void drain(db)
  }
  return rows.length
}

/** Sorts every comment the current sort has not read and describes every post without a description. Returns how many comments it sorted. */
export async function sortPending(db: DB) {
  const off = aiOff(db)
  const rows = pendingPosts(db).filter((p) => !off.has(p.brandId))
  const left = () =>
    (db.prepare(`SELECT count(*) AS n FROM comments c WHERE ${store.STALE}`).get() as { n: number })
      .n
  const before = left()
  await aiStep(db, rows, () => {})
  return before - left()
}
