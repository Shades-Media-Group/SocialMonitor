import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext } from 'playwright'
import type { DB } from './db.ts'
import { DATA_DIR, now } from './db.ts'
import { changed } from './events.ts'
import { activeRivals, plan } from './plan.ts'
import { beginSideJob, endSideJob } from './run.ts'
import { adsReading } from './ads.ts'
import { Challenge, openLoggedOut, pause } from './collect/browser.ts'
import type { Get } from './collect/tiktok-public.ts'
import { TikTokWall, nodeGet } from './collect/tiktok-public.ts'
import { openProfile } from './collect/tiktok.ts'
import type { ReadStory } from './collect/tiktok-stories.ts'
import { readStoryList, storyStatusFrom, storyStatusOf } from './collect/tiktok-stories.ts'
import { metaStoriesOn, readMetaStories } from './meta-stories.ts'
import type { GraphGet } from './meta-stories.ts'
import { metaConnected } from './meta-api.ts'
import * as media from './story-media.ts'
import type { Fetcher } from './story-media.ts'
import { describeStory, pickEngine } from './analyze.ts'
import { AiLimitError, activePause } from './ai-limit.ts'
import { getSettings } from './settings.ts'
import type { Network } from './types.ts'

/**
 * Stories: what a brand and its competitors post for a day, kept for good. A check reads the
 * stories up now, keeps a row for each (never deleted), and saves its files at the best quality
 * offered; then, one at a time and at low priority, each file gets its compact copy and poster and
 * Claude reads what the story is about. The originals go after STORIES_ORIGINAL_DAYS days.
 *
 * TikTok is read logged out, the brand's own account and its active rivals'. Instagram and Facebook
 * come only through Meta's official API for the brand's own connected Page, behind META_STORIES.
 */

const HOUR = 3_600_000
/** Stories last a day: every brand with Stories in its plan is checked every three hours. */
export const CHECK_EVERY_MS = 3 * HOUR

export interface StoryAccount {
  brand_id: number
  name: string
  own: boolean
  network: Network
  handle: string
}

/** What one person may see of a brand's stories: its own, its rivals', by plan or as super admin. */
export function storyScope(db: DB, watcher: number, isSuper: boolean) {
  if (isSuper) return { own: true, rivals: true }
  const p = plan(db, watcher)
  return { own: p.stories, rivals: p.rival_stories }
}

/** The accounts a check reads: the brand's own TikTok and its active rivals', as `scope` says. */
export function storyAccounts(db: DB, watcher: number, scope: { own: boolean; rivals: boolean }) {
  const profiles = (brandId: number) =>
    db
      .prepare(
        `SELECT b.id AS brand_id, b.name, p.network, p.handle FROM profiles p
         JOIN brands b ON b.id = p.brand_id WHERE p.brand_id = ? ORDER BY p.network`,
      )
      .all(brandId) as { brand_id: number; name: string; network: Network; handle: string }[]
  const out: StoryAccount[] = []
  if (scope.own) out.push(...profiles(watcher).map((p) => ({ ...p, own: true })))
  if (scope.rivals)
    for (const id of activeRivals(db, watcher))
      out.push(...profiles(id).map((p) => ({ ...p, own: false })))
  return out
}

// Keeping what a check found

/**
 * Keeps one story: a new one gets its row and a pending row per file; a known one its latest
 * counts, insights and last_seen_at. Returns its id and whether it was new.
 */
export function saveStory(db: DB, watcher: number, brandId: number, s: ReadStory, at = now()) {
  const known = db
    .prepare('SELECT id FROM stories WHERE watcher_id = ? AND network = ? AND ext_id = ?')
    .get(watcher, s.network, s.ext_id) as { id: number } | undefined
  const json = (v: unknown[]) => JSON.stringify(v)
  if (known) {
    db.prepare(
      `UPDATE stories SET last_seen_at = ?, expires_at = coalesce(?, expires_at),
         views = coalesce(?, views), likes = coalesce(?, likes), shares = coalesce(?, shares),
         replies = coalesce(?, replies), insights = coalesce(?, insights),
         caption = CASE WHEN ? != '' THEN ? ELSE caption END,
         stickers = CASE WHEN ? != '[]' THEN ? ELSE stickers END,
         mentions = CASE WHEN ? != '[]' THEN ? ELSE mentions END,
         links = CASE WHEN ? != '[]' THEN ? ELSE links END,
         music = coalesce(?, music), permalink = coalesce(?, permalink)
       WHERE id = ?`,
    ).run(
      at,
      s.expires_at,
      s.views,
      s.likes,
      s.shares,
      s.replies,
      s.insights ? JSON.stringify(s.insights) : null,
      s.caption,
      s.caption,
      json(s.stickers),
      json(s.stickers),
      json(s.mentions),
      json(s.mentions),
      json(s.links),
      json(s.links),
      s.music ? JSON.stringify(s.music) : null,
      s.permalink,
      known.id,
    )
    return { id: known.id, fresh: false }
  }
  const { id } = db
    .prepare(
      `INSERT INTO stories (watcher_id, brand_id, network, ext_id, handle, posted_at, expires_at,
         first_seen_at, last_seen_at, caption, stickers, mentions, links, music, views, likes,
         shares, replies, insights, permalink, is_ad)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      watcher,
      brandId,
      s.network,
      s.ext_id,
      s.handle,
      s.posted_at,
      s.expires_at,
      at,
      at,
      s.caption,
      json(s.stickers),
      json(s.mentions),
      json(s.links),
      s.music ? JSON.stringify(s.music) : null,
      s.views,
      s.likes,
      s.shares,
      s.replies,
      s.insights ? JSON.stringify(s.insights) : null,
      s.permalink,
      s.is_ad ? 1 : 0,
    ) as { id: number }
  const put = db.prepare(
    `INSERT INTO story_media (story_id, position, kind, width, height, duration, codec)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const [i, f] of s.media.entries())
    put.run(id, i, f.kind, f.width, f.height, f.duration, f.codec)
  return { id, fresh: true }
}

/** The relative path of a story file under data/ (originals live outside data/media). */
const originalBase = (watcher: number, storyId: number, pos: number) =>
  join(media.originalsDir(watcher), `${storyId}-${pos}`)

/**
 * Saves the original of every file of a story that has none yet (a new story, or one whose
 * download failed the time before and is still up). Returns how many files it saved.
 */
export async function saveOriginals(
  db: DB,
  watcher: number,
  storyId: number,
  s: ReadStory,
  fetcher: Fetcher,
  at = new Date(),
) {
  const rows = db
    .prepare(
      `SELECT position FROM story_media WHERE story_id = ? AND original_path IS NULL
         AND original_removed_at IS NULL AND status IN ('pending', 'missing')`,
    )
    .all(storyId) as { position: number }[]
  let saved = 0
  const until = new Date(at.getTime() + media.ORIGINAL_DAYS * 24 * HOUR).toISOString()
  for (const { position } of rows) {
    const src = s.media[position]
    if (!src) continue
    const got = await media.download(
      fetcher,
      src.urls,
      originalBase(watcher, storyId, position),
      src.kind,
    )
    if ('error' in got) {
      db.prepare(
        "UPDATE story_media SET status = 'missing', error = ? WHERE story_id = ? AND position = ?",
      ).run(got.error.slice(0, 300), storyId, position)
      continue
    }
    db.prepare(
      `UPDATE story_media SET original_path = ?, original_bytes = ?, original_until = ?,
         status = 'pending', error = NULL WHERE story_id = ? AND position = ?`,
    ).run(got.path.slice(DATA_DIR.length + 1), got.bytes, until, storyId, position)
    saved++
  }
  return saved
}

// Checking

export interface StoryRun {
  id: number
  brand_id: number
  trigger: string
  started_by: number | null
  started_at: string
  finished_at: string | null
  /** running, ok, partial, error, wall */
  status: string
  log: string
  stats: string | null
}

export const lastStoryRun = (db: DB, brandId: number) =>
  (db
    .prepare('SELECT * FROM story_runs WHERE brand_id = ? ORDER BY id DESC LIMIT 1')
    .get(brandId) as unknown as StoryRun | undefined) ?? null

export const closeStaleStoryRuns = (db: DB) =>
  db
    .prepare(
      "UPDATE story_runs SET status = 'error', finished_at = ?, log = log || 'Interrupted: the app closed.' WHERE status = 'running'",
    )
    .run(now())

/** What a check uses, replaceable in tests. */
export interface Deps {
  /** TikTok from Node, no browser, no cookies. */
  get?: Get
  /** The throwaway logged-out browser. */
  open?: typeof openLoggedOut
  /** How a file is fetched outside a browser. */
  fetcher?: Fetcher
  /** Meta's Graph API. */
  graph?: GraphGet
}

let checking = false
let running: Promise<unknown> | null = null
/** Resolves when the check and the file work it started have ended (for tests). */
export const storiesIdle = async () => {
  await running
  await working
}
export const storiesChecking = () => checking

/**
 * Starts a stories check of one brand in the background and returns its id. One check at a time,
 * never beside an update or an Ads read (all three may open a browser). `force` (a super admin's
 * button) reads the brand and its active rivals whatever the plan says.
 */
export function startStoriesCheck(
  db: DB,
  watcher: number,
  trigger: 'manual' | 'schedule',
  userId: number | null,
  opts: { force?: boolean; deps?: Deps } = {},
) {
  if (checking) throw new Error('Stories are being checked already. Wait for that check to end.')
  if (adsReading()) throw new Error('Ads are being read. Try again when that read ends.')
  const scope = opts.force ? { own: true, rivals: true } : storyScope(db, watcher, false)
  const accounts = storyAccounts(db, watcher, scope)
  const meta = scope.own && metaStoriesOn()
  if (!accounts.some((a) => a.network === 'tiktok') && !(meta && hasMeta(db, watcher)))
    throw new Error('No TikTok profile to check: add one on the About tab.')
  beginSideJob()
  checking = true
  const id = (
    db
      .prepare(
        'INSERT INTO story_runs (brand_id, trigger, started_by, started_at) VALUES (?, ?, ?, ?) RETURNING id',
      )
      .get(watcher, trigger, userId, now()) as { id: number }
  ).id
  changed()
  running = checkAll(db, id, watcher, accounts, meta, opts.deps ?? {})
    .catch((e: Error) => finish(db, id, 'error', {}, `Stopped: ${e.message}`))
    .finally(() => {
      checking = false
      endSideJob()
      kickFiles(db)
    })
  return id
}

const hasMeta = (db: DB, brandId: number) =>
  metaConnected(db, brandId, 'instagram') || metaConnected(db, brandId, 'facebook')

function log(db: DB, id: number, line: string) {
  db.prepare('UPDATE story_runs SET log = log || ? || char(10) WHERE id = ?').run(
    `${new Date().toISOString().slice(11, 19)} ${line}`,
    id,
  )
}
function finish(db: DB, id: number, status: string, stats: unknown, line?: string) {
  if (line) log(db, id, line)
  db.prepare('UPDATE story_runs SET status = ?, finished_at = ?, stats = ? WHERE id = ?').run(
    status,
    now(),
    JSON.stringify(stats),
    id,
  )
  changed()
}

/** A file fetcher that goes through the logged-out browser's own request context (its cookies). */
const browserFetcher =
  (context: BrowserContext): Fetcher =>
  async (url) => {
    const r = await context.request.get(url, {
      headers: { referer: 'https://www.tiktok.com/' },
      timeout: 120_000,
    })
    return {
      ok: r.ok(),
      status: r.status(),
      type: r.headers()['content-type'] ?? '',
      body: await r.body(),
    }
  }

async function checkAll(
  db: DB,
  runId: number,
  watcher: number,
  accounts: StoryAccount[],
  meta: boolean,
  deps: Deps,
) {
  const stats = { accounts: 0, live: 0, read: 0, fresh: 0, files: 0, failed: 0, wall: false }
  const keep = async (a: { brand_id: number }, items: ReadStory[], fetcher: Fetcher) => {
    for (const s of items) {
      const { id, fresh } = saveStory(db, watcher, a.brand_id, s)
      stats.read++
      if (fresh) stats.fresh++
      stats.files += await saveOriginals(db, watcher, id, s, fetcher)
    }
    changed()
  }

  // Instagram and Facebook: the brand's own connected Page, through Meta's API.
  if (meta && hasMeta(db, watcher)) {
    const handle = (n: Network) => accounts.find((a) => a.own && a.network === n)?.handle
    try {
      const items = await readMetaStories(
        db,
        watcher,
        { instagram: handle('instagram'), facebook: handle('facebook') },
        deps.graph,
        (l) => log(db, runId, l),
      )
      await keep({ brand_id: watcher }, items, deps.fetcher ?? plainFetcher)
    } catch (e) {
      stats.failed++
      log(db, runId, `Meta: ${(e as Error).message}`)
    }
  }

  // TikTok: first whether each account has a story up, from Node; the story lists and the videos
  // through the logged-out browser, where TikTok wants its visitor cookies.
  const tiktok = accounts.filter((a) => a.network === 'tiktok')
  const get = deps.get ?? nodeGet
  const toRead: { a: StoryAccount; id: string | null }[] = []
  for (const a of tiktok) {
    stats.accounts++
    try {
      const status = storyStatusFrom(
        await get(`https://www.tiktok.com/@${encodeURIComponent(a.handle)}`),
      )
      if (!status) {
        log(db, runId, `@${a.handle}: the profile did not load from here; trying the browser.`)
        toRead.push({ a, id: null })
      } else if (status.live === false) log(db, runId, `@${a.handle}: no story up now.`)
      else toRead.push({ a, id: status.id })
    } catch (e) {
      log(
        db,
        runId,
        `@${a.handle}: ${e instanceof TikTokWall ? 'TikTok’s check stopped the plain request' : (e as Error).message}; trying the browser.`,
      )
      toRead.push({ a, id: null })
    }
  }
  if (toRead.length) {
    const browser = await (deps.open ?? openLoggedOut)()
    try {
      const fetcher = deps.fetcher ?? browserFetcher(browser.context)
      for (const [i, { a }] of toRead.entries()) {
        try {
          const opened = await openProfile(
            browser.context,
            { url: `https://www.tiktok.com/@${a.handle}`, handle: a.handle },
            { log: (l) => log(db, runId, l) },
          )
          const status = storyStatusOf(opened.data)
          if (!status) throw new Error('the profile did not load')
          if (status.live === false) {
            log(db, runId, `@${a.handle}: no story up now.`)
          } else {
            const items = await readStoryList(opened.get, status.id, a.handle)
            if (items.length) stats.live++
            log(db, runId, `@${a.handle}: ${items.length} stories up now.`)
            await keep(a, items, fetcher)
          }
          await opened.page.close().catch(() => {})
        } catch (e) {
          stats.failed++
          log(db, runId, `@${a.handle}: ${(e as Error).message}`)
          // A captcha or TikTok's check ends the check: asking again only makes it stricter.
          if (e instanceof Challenge || e instanceof TikTokWall) {
            stats.wall = true
            break
          }
        }
        if (i < toRead.length - 1) await pause(3000, 7000)
      }
    } finally {
      await browser.close()
    }
  }
  const status = stats.wall
    ? 'wall'
    : stats.failed
      ? stats.read || stats.accounts > stats.failed
        ? 'partial'
        : 'error'
      : 'ok'
  finish(db, runId, status, stats, `Done: ${stats.read} stories read, ${stats.fresh} new.`)
}

const plainFetcher: Fetcher = async (url) => {
  const r = await fetch(url, { credentials: 'omit', headers: { 'user-agent': 'Mozilla/5.0' } })
  return {
    ok: r.ok,
    status: r.status,
    type: r.headers.get('content-type') ?? '',
    body: Buffer.from(await r.arrayBuffer()),
  }
}

// The files: compact copies, posters and Claude's reading, one at a time

let working: Promise<void> | null = null

/** Starts the file work if it is not running; it ends when nothing is left to do. */
export function kickFiles(db: DB, ai = true) {
  if (working) return working
  working = workFiles(db, ai)
    .catch((e: Error) => console.error(`Stories: ${e.message}`))
    .finally(() => {
      working = null
    })
  return working
}

interface MediaRow {
  story_id: number
  position: number
  kind: 'video' | 'image'
  original_path: string
  watcher_id: number
}

async function workFiles(db: DB, ai: boolean) {
  const next = db.prepare(
    `SELECT m.story_id, m.position, m.kind, m.original_path, s.watcher_id FROM story_media m
     JOIN stories s ON s.id = m.story_id
     WHERE m.status = 'pending' AND m.original_path IS NOT NULL ORDER BY m.story_id, m.position LIMIT 1`,
  )
  for (;;) {
    const row = next.get() as MediaRow | undefined
    if (!row) break
    await compactOne(db, row)
    changed()
  }
  if (ai) await readStories(db)
}

/** One file's compact copy and poster, with its size and length measured from the file. */
export async function compactOne(db: DB, row: MediaRow) {
  const src = join(DATA_DIR, row.original_path)
  const name = `${row.story_id}-${row.position}`
  const dir = media.compactDir(row.watcher_id)
  const set = (fields: Record<string, string | number | null>) => {
    const keys = Object.keys(fields)
    db.prepare(
      `UPDATE story_media SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE story_id = ? AND position = ?`,
    ).run(...Object.values(fields), row.story_id, row.position)
  }
  try {
    if (!existsSync(src)) throw new Error('the original is not on disk')
    mkdirSync(dir, { recursive: true })
    const poster = join(dir, `${name}-poster.webp`)
    if (row.kind === 'video') {
      const p = await media.probe(src)
      const out = join(dir, `${name}.mp4`)
      let bytes = await media.encodeVideo(src, out, p.audio)
      // TikTok's own H.264 can already be smaller than a fresh encode at the same quality: then
      // the original itself, moved into a quick-start MP4, is the copy kept.
      const original = media.fileBytes(src)
      if (bytes >= original && p.codec === 'h264' && /\.mp4$/.test(src)) {
        bytes = await media.remuxVideo(src, out)
      }
      const frame = join(DATA_DIR, 'cache', `story-${name}.jpg`)
      await media.videoFrame(src, frame, Math.min(1, (p.duration ?? 2) / 3))
      const posterBytes = await media.posterOf(frame, poster)
      media.removeFile(frame)
      set({
        width: p.width,
        height: p.height,
        duration: p.duration,
        codec: p.codec,
        compact_path: media.mediaUrl(row.watcher_id, `${name}.mp4`),
        compact_bytes: bytes,
        poster_path: media.mediaUrl(row.watcher_id, `${name}-poster.webp`),
        poster_bytes: posterBytes,
        status: 'done',
        error: null,
      })
    } else {
      const out = join(dir, `${name}.webp`)
      const bytes = await media.compactImage(src, out)
      const posterBytes = await media.posterOf(src, poster)
      const p = await media.probe(out).catch(() => null)
      set({
        ...(p?.width ? { width: p.width, height: p.height } : {}),
        compact_path: media.mediaUrl(row.watcher_id, `${name}.webp`),
        compact_bytes: bytes,
        poster_path: media.mediaUrl(row.watcher_id, `${name}-poster.webp`),
        poster_bytes: posterBytes,
        status: 'done',
        error: null,
      })
    }
  } catch (e) {
    set({ status: 'failed', error: (e as Error).message.slice(0, 300) })
  }
}

/**
 * Claude reads each story whose files are ready and that it has not read: what it is about, its
 * kind, the words on it, who it names, its tone, and whose post it shares. Skipped while Claude is
 * paused at its limit, for brands with the AI off, and with no AI set up; tried again later.
 */
export async function readStories(db: DB, limit = 40, at = new Date()) {
  if (!process.env.ANTHROPIC_API_KEY && activePause(db)) return 0
  // A story whose reading failed is tried again six hours later.
  const retry = new Date(at.getTime() - 6 * HOUR).toISOString()
  const rows = db
    .prepare(
      `SELECT s.id, s.watcher_id, s.brand_id, s.network, s.handle, s.caption, s.stickers, s.mentions,
         s.music, b.name AS brand FROM stories s JOIN brands b ON b.id = s.watcher_id
       WHERE s.ai_at IS NULL AND b.ai_sort != 0 AND (s.ai_tried_at IS NULL OR s.ai_tried_at < ?)
         AND NOT EXISTS (SELECT 1 FROM story_media m WHERE m.story_id = s.id AND m.status = 'pending')
       ORDER BY s.id LIMIT ?`,
    )
    .all(retry, limit) as {
    id: number
    watcher_id: number
    brand_id: number
    network: Network
    handle: string
    caption: string
    stickers: string
    mentions: string
    music: string | null
    brand: string
  }[]
  if (!rows.length) return 0
  const engine = pickEngine(getSettings(db))
  if (!engine) return 0
  let done = 0
  for (const s of rows) {
    const first = db
      .prepare(
        `SELECT kind, original_path, compact_path, duration FROM story_media WHERE story_id = ?
         ORDER BY position LIMIT 1`,
      )
      .get(s.id) as
      | {
          kind: string
          original_path: string | null
          compact_path: string | null
          duration: number | null
        }
      | undefined
    let picture: string | null = null
    let temp: string | null = null
    try {
      if (first?.kind === 'video') {
        const src = first.original_path
          ? join(DATA_DIR, first.original_path)
          : first.compact_path
            ? join(DATA_DIR, first.compact_path)
            : null
        if (src && existsSync(src)) {
          temp = join(DATA_DIR, 'cache', `story-sheet-${s.id}.jpg`)
          picture = await media.videoSheet(src, temp, first.duration)
        }
      } else if (first?.compact_path) picture = join(DATA_DIR, first.compact_path)
      const music = s.music
        ? (JSON.parse(s.music) as { title: string; author: string | null })
        : null
      const r = await describeStory(
        engine,
        s.brand,
        s.handle,
        {
          caption: s.caption,
          stickers: JSON.parse(s.stickers) as string[],
          mentions: JSON.parse(s.mentions) as string[],
          music: music ? [music.title, music.author].filter(Boolean).join(' · ') : null,
        },
        picture,
        { db, task: 'describe-story', brandId: s.brand_id, network: s.network },
      )
      db.prepare(
        `UPDATE stories SET ai_about = ?, ai_kind = ?, ai_text = ?, ai_accounts = ?, ai_tone = ?,
           ai_repost_of = ?, ai_at = ?, ai_error = ? WHERE id = ?`,
      ).run(
        r?.about ?? null,
        r?.kind ?? null,
        r?.text ?? null,
        // The account itself is not one it names.
        JSON.stringify((r?.accounts ?? []).filter((h) => h !== s.handle.toLowerCase())),
        r?.tone ?? null,
        r?.repostOf ?? null,
        now(),
        r ? null : 'Claude’s answer could not be read.',
        s.id,
      )
      done++
      changed()
    } catch (e) {
      // A failure (Claude at its limit, signed out, not answering) ends this round: the stories
      // left wait for the next one, and this one is tried again in six hours. Kept to show why.
      if (!(e instanceof AiLimitError))
        db.prepare('UPDATE stories SET ai_tried_at = ?, ai_error = ? WHERE id = ?').run(
          now(),
          (e as Error).message.slice(0, 300),
          s.id,
        )
      break
    } finally {
      media.removeFile(temp)
    }
  }
  return done
}

// Cleanup and the schedule

/**
 * Removes the originals whose days are over, where the compact copy exists. A file whose compact
 * copy failed keeps its original: it is the only copy there is. Rows and compact files stay.
 */
export function cleanupOriginals(db: DB, at = new Date()) {
  const rows = db
    .prepare(
      `SELECT story_id, position, original_path FROM story_media
       WHERE original_path IS NOT NULL AND original_until <= ? AND status = 'done'`,
    )
    .all(at.toISOString()) as { story_id: number; position: number; original_path: string }[]
  const done = db.prepare(
    `UPDATE story_media SET original_path = NULL, original_removed_at = ?
     WHERE story_id = ? AND position = ?`,
  )
  let freed = 0
  for (const r of rows) {
    const file = join(DATA_DIR, r.original_path)
    freed += media.fileBytes(file)
    media.removeFile(file)
    done.run(at.toISOString(), r.story_id, r.position)
  }
  if (rows.length) changed()
  return { removed: rows.length, freed }
}

/** Whether the shared heavy-work lock is free now (always, where there is none). */
export const heavyLockFree = (
  lock = process.env.SOCIALMONITOR_HEAVY_LOCK ?? '/tmp/shades-heavy.lock',
) =>
  new Promise<boolean>((resolve) => {
    if (process.platform !== 'linux' || !lock || lock === 'off' || !existsSync('/usr/bin/flock'))
      return resolve(true)
    execFile('flock', ['-n', lock, 'true'], (e) => resolve(!e))
  })

/** A few minutes per brand, so brands checked every three hours never start together. */
const offset = (brandId: number) => ((brandId * 7) % 30) * 60_000

/**
 * Once a minute (the scheduler's tick): the day's cleanup of old originals once, any file work
 * left from before a restart, and the stories check of one brand that is due. Brands are due
 * three hours after their last check, each a few minutes apart; a check waits while an update, an
 * Ads read, a restore or other heavy work on this computer runs.
 */
export async function storiesTick(db: DB, at = new Date(), deps?: Deps) {
  const today = at.toISOString().slice(0, 10)
  const cleaned = db
    .prepare("SELECT value FROM settings WHERE key = 'stories_cleanup_on'")
    .get() as { value: string } | undefined
  if (cleaned?.value !== today) {
    cleanupOriginals(db, at)
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('stories_cleanup_on', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(today)
  }
  void kickFiles(db)
  if (checking) return null
  const brands = db
    .prepare(
      `SELECT p.brand_id AS id, (SELECT max(started_at) FROM story_runs r WHERE r.brand_id = p.brand_id) AS last
       FROM brand_plans p JOIN brands b ON b.id = p.brand_id
       WHERE b.competitor_of IS NULL AND (p.stories = 1 OR p.rival_stories = 1) ORDER BY last`,
    )
    .all() as { id: number; last: string | null }[]
  const due = brands.filter(
    (b) => !b.last || Date.parse(b.last) + CHECK_EVERY_MS + offset(b.id) <= at.getTime(),
  )
  if (!due.length || !(await heavyLockFree())) return null
  for (const b of due) {
    try {
      return startStoriesCheck(db, b.id, 'schedule', null, { deps })
    } catch {
      // An update or a restore is running, or this brand has no TikTok: the next one, or the
      // next tick.
    }
  }
  return null
}
