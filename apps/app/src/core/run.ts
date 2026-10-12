import { autoSendBad } from './alerts.ts'
import { saveImage } from './media.ts'
import { fillTikTok } from './fill.ts'
import { officialFigures } from './tiktok-api.ts'
import type { Page } from 'playwright'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR, now } from './db.ts'
import * as store from './store.ts'
import type { Comment, Network, Profile, RunScope } from './types.ts'
import { NETWORKS } from './types.ts'
import { collectors } from './collect/index.ts'
import { Challenge, closeBrowser, openBrowser, pause } from './collect/browser.ts'
import { describePost, pickEngine, sortComments } from './analyze.ts'
import type { Kind } from './analyze.ts'
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

async function execute(db: DB, runId: number, scope: RunScope) {
  const log = (line: string) => store.logRun(db, runId, line)
  const since = now()
  const settings = getSettings(db)
  const touched: { postId: number; brand: string; brandId: number }[] = []
  const problems: string[] = []
  const skipped: string[] = []
  let page: Page | null = null
  const stopped = () => store.stopAsked(db, runId)
  // Every profile this update reads, for "2 of 5" in the progress notice.
  const all = scope.brandIds.flatMap((id) =>
    store.listProfiles(db, id).filter((p) => scope.networks.includes(p.network)),
  )
  let at = 0

  for (const brandId of scope.brandIds) {
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
        const posts = await collectors[p.network].collect(page, p, opt)
        if (p.network === 'tiktok')
          await officialFigures(db, p, posts, log).catch((e: Error) =>
            log(`TikTok connection: ${e.message}`),
          )
        for (const cp of posts) {
          cp.thumb_url = await saveImage(p.network, '', cp.ext_id, cp.thumb_url)
          for (const c of cp.comments) {
            c.author_avatar = await saveImage(p.network, 'people', c.author, c.author_avatar)
            c.media_url = await saveImage(p.network, 'comments', c.ext_id, c.media_url)
          }
          const { post, newComments } = store.savePost(db, p, cp)
          touched.push({ postId: post.id, brand: brand.name, brandId: brand.id })
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

  // The AI step: describe new posts and sort every comment still unsorted on these brands,
  // including ones an earlier update could not sort.
  try {
    const brands = new Set(touched.map((t) => t.brandId))
    const posts = new Map(touched.map((t) => [t.postId, t]))
    for (const p of pendingPosts(db))
      if (brands.has(p.brandId) && !posts.has(p.postId)) posts.set(p.postId, p)
    if (!stopped())
      await aiStep(db, [...posts.values()], log, (done, total) =>
        store.setProgress(db, runId, { step: 'sort', done, total }),
      )
  } catch (e) {
    problems.push((e as Error).message)
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
  const status = stopped()
    ? 'stopped'
    : problems.length
      ? touched.length
        ? 'partial'
        : 'error'
      : 'ok'
  if (status === 'stopped') log('Stopped on request; what was read so far is kept.')
  store.finishRun(db, runId, status, stats, text)
  log('Done.')
}

/** Describes posts without a description and sorts unsorted comments, post by post. */
async function aiStep(
  db: DB,
  touched: { postId: number; brand: string }[],
  log: (line: string) => void,
  step?: (done: number, total: number) => void,
) {
  const engine = pickEngine(getSettings(db))
  if (!engine)
    throw new Error(
      'Comments were kept but not sorted: install Claude Code, or set ANTHROPIC_API_KEY in .env.',
    )
  for (const [i, { postId, brand }] of touched.entries()) {
    step?.(i, touched.length)
    const post = store.getPost(db, postId)!
    const unsorted = store.listComments(db, { postId, unsorted: true, others: true, limit: 2000 })
    try {
      if (unsorted.length) {
        log(`Sorting ${unsorted.length} comments on ${post.url}`)
        const b = db
          .prepare('SELECT industry, description, categories FROM brands WHERE name = ?')
          .get(brand) as
          { industry: string | null; description: string | null; categories: string } | undefined
        const about = [b?.industry, b?.description].filter(Boolean).join('; ')
        const kinds = JSON.parse(b?.categories || '[]') as Kind[]
        const verdicts = await sortComments(
          engine,
          brand,
          post.caption,
          unsorted.map((c) => ({ id: c.id, text: c.text, ...conversation(db, post, c) })),
          about,
          kinds,
        )
        for (const [id, v] of verdicts) {
          store.setVerdict(db, id, v.label, v.needsReply, v.reason, v.urgency, v.emotion)
          // The brand's kind, unless a person already rated this comment.
          const kind = kinds.find((k) => k.key === v.category)
          const byPerson = unsorted.find((c) => c.id === id)?.sentiment_by === 'you'
          if (!byPerson)
            store.setSentiment(db, id, kind ? kind.sentiment : 'neutral', kind?.key ?? null, 'ai')
        }
      }
      if (!post.description) {
        const top = store.listComments(db, { postId, others: true, limit: 5 }).map((c) => c.text)
        const image = post.thumb_url?.startsWith('/media/') ? join(DATA_DIR, post.thumb_url) : null
        store.setDescription(
          db,
          postId,
          await describePost(engine, brand, post.caption, top, image),
        )
      }
    } catch (e) {
      throw new Error(`AI: ${(e as Error).message}`, { cause: e })
    }
  }
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

/** Posts with no description yet, or with comments nobody has sorted. */
const pendingPosts = (db: DB) =>
  db
    .prepare(
      `SELECT DISTINCT p.id AS postId, b.name AS brand, b.id AS brandId FROM posts p JOIN profiles pr ON pr.id = p.profile_id JOIN brands b ON b.id = pr.brand_id
       WHERE p.description IS NULL OR EXISTS (SELECT 1 FROM comments c WHERE c.post_id = p.id AND c.label IS NULL AND lower(c.author) != lower(pr.handle))`,
    )
    .all() as { postId: number; brand: string; brandId: number }[]

/** Sorts every unsorted comment and describes every post without a description. Returns how many comments it sorted. */
export async function sortPending(db: DB) {
  const rows = pendingPosts(db)
  const before = (
    db.prepare('SELECT count(*) AS n FROM comments WHERE label IS NULL').get() as { n: number }
  ).n
  await aiStep(db, rows, () => {})
  const after = (
    db.prepare('SELECT count(*) AS n FROM comments WHERE label IS NULL').get() as { n: number }
  ).n
  return before - after
}
