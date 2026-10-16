import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import type { CollectedPost } from './types.ts'

// Claude Code is never run: each `claude` call is answered by `answer` below.
vi.hoisted(() => {
  process.env.SOCIALMONITOR_DATA = `${process.env.TMPDIR ?? '/tmp'}/sm-ai-limits-test`
})
const claude = vi.hoisted(() => ({
  calls: [] as { prompt: string; args: string[]; input: string }[],
  answer: (_prompt: string, _input: string): Record<string, unknown> => ({ result: '' }),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>()
  return {
    ...real,
    // `claude --version`: Claude Code is installed.
    execFileSync: vi.fn(() => '2.1.301'),
    execFile: vi.fn(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        let input = ''
        setTimeout(() => {
          const prompt = args[args.indexOf('-p') + 1]!
          claude.calls.push({ prompt, args, input })
          const d = { type: 'result', is_error: false, ...claude.answer(prompt, input) }
          cb(d.is_error ? new Error('exit 1') : null, JSON.stringify(d))
        }, 0)
        return { stdin: { end: (s: string) => (input = s) } }
      },
    ),
  }
})

// No browser, no network: the collector hands back the posts below.
const feed = vi.hoisted(() => ({ posts: [] as CollectedPost[], reads: 0 }))
vi.mock('./collect/index.ts', () => {
  const collect = async () => {
    feed.reads++
    return structuredClone(feed.posts)
  }
  return {
    collectors: {
      instagram: { network: 'instagram', collect },
      facebook: { network: 'facebook', collect },
      tiktok: { network: 'tiktok', collect },
    },
  }
})
vi.mock('./collect/browser.ts', () => ({
  openBrowser: async () => ({ pages: () => [{}], newPage: async () => ({}) }),
  closeBrowser: async () => {},
  pause: async () => {},
  Challenge: class extends Error {},
}))
vi.mock('./media.ts', () => ({ saveImage: async (...a: unknown[]) => a[3] ?? null }))
vi.mock('./fill.ts', () => ({ fillTikTok: async () => {} }))
vi.mock('./alerts.ts', () => ({
  autoSendBad: async () => {},
  instantAlerts: async () => {},
  sendDigests: async () => {},
}))

const { openDb } = await import('./db.ts')
const store = await import('./store.ts')
const { catchUp, idle, queueRun } = await import('./run.ts')
const { startScheduler } = await import('./schedule.ts')
const { activePause, catchUpState, lastPause } = await import('./ai-limit.ts')

// 13:00 in Chisinau on Friday 16 October 2026.
const NOW = new Date('2026-10-16T10:00:00Z')
const LIMIT = { is_error: true, api_error_status: null, usage: { input_tokens: 0 } }
const OK = (result: string) => ({
  result,
  total_cost_usd: 0.00002,
  usage: { input_tokens: 9, output_tokens: 2 },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 9, outputTokens: 2, costUSD: 0.00002 } },
})
/** A working Claude: says ok, describes posts and sorts every comment line as praise. */
const working = (prompt: string, input: string) =>
  prompt.startsWith('Reply with exactly')
    ? OK('ok')
    : prompt.includes('In one sentence')
      ? OK('A summer bag on a beach.')
      : OK(
          input
            .split('\n')
            .map((l) => `${l.split('|')[0]}|praise|0|0|happy|-|likes the bag`)
            .join('\n'),
        )
const post = (id: string, comments: number): CollectedPost => ({
  ext_id: id,
  url: `https://www.instagram.com/p/${id}/`,
  posted_at: '2026-10-15T09:00:00Z',
  kind: 'post',
  caption: 'Tavelo summer bag',
  thumb_url: null,
  likes: 10,
  comments_count: comments,
  shares: null,
  views: null,
  comments: Array.from({ length: comments }, (_, i) => ({
    ext_id: `${id}-c${i}`,
    parent_ext_id: null,
    author: `fan${i}`,
    text: `Lovely bag ${i}`,
    likes: 0,
    posted_at: '2026-10-15T10:00:00Z',
  })),
})
const unsorted = (db: ReturnType<typeof openDb>) =>
  (db.prepare('SELECT count(*) AS n FROM comments WHERE label IS NULL').get() as { n: number }).n

let db: ReturnType<typeof openDb>
let brandId: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('TZ', 'Europe/Chisinau')
  claude.calls = []
  claude.answer = working
  feed.posts = [post('A1', 3)]
  feed.reads = 0
  db = openDb(':memory:')
  brandId = store.addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo/'], null).id
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('an update when Claude is at its usage limit', () => {
  it('a scheduled update moves to the reset, and the history says so', async () => {
    claude.answer = () => ({
      ...LIMIT,
      result: "You've hit your limit · resets 6pm (Europe/Chisinau)",
    })
    const s = store.saveSchedule(db, {
      brand_id: brandId,
      kind: 'interval',
      every_hours: 6,
      networks: ['instagram'],
    })
    store.setNextRun(db, s.id, '2026-10-16T09:59:00Z')
    clearInterval(startScheduler(db))
    await idle()

    // One tiny call on the cheapest model with no tools, counted as a limit check.
    expect(claude.calls).toHaveLength(1)
    const probe = claude.calls[0]!
    expect(probe.prompt).toBe('Reply with exactly: ok')
    expect(probe.args).toEqual(
      expect.arrayContaining([
        '--model',
        'haiku',
        '--output-format',
        'json',
        '--no-session-persistence',
      ]),
    )
    expect(probe.args[probe.args.indexOf('--tools') + 1]).toBe('')
    // Nothing was read: the update waits for Claude.
    expect(feed.reads).toBe(0)
    expect(activePause(db)?.until).toBe('2026-10-16T15:00:00.000Z')
    expect(store.listSchedules(db)[0]!.next_run_at).toBe('2026-10-16T15:02:00.000Z')
    const run = store.getRun(db, store.listRuns(db)[0]!.id)!
    expect(run.status).toBe('postponed')
    expect(run.report).toContain(
      'Claude is at its usage limit until 18:00. This update moves to 18:02.',
    )

    // Still paused at the next start: no call at all, postponed again.
    store.setNextRun(db, s.id, '2026-10-16T10:30:00Z')
    vi.setSystemTime(new Date('2026-10-16T10:31:00Z'))
    clearInterval(startScheduler(db))
    await idle()
    expect(claude.calls).toHaveLength(1)
    expect(store.listRuns(db).map((r) => r.status)).toEqual(['postponed', 'postponed'])
    expect(store.listSchedules(db)[0]!.next_run_at).toBe('2026-10-16T15:02:00.000Z')
  })

  it('a manual update reads now, leaves the sorting for later, and catches up after', async () => {
    claude.answer = () => ({ ...LIMIT, result: 'Claude AI usage limit reached' })
    const runId = queueRun(
      db,
      { brandIds: [brandId], networks: ['instagram'], range: 'new', limit: 5 },
      'manual',
    )
    await idle()
    const run = store.getRun(db, runId)!
    expect(feed.reads).toBe(1)
    expect(claude.calls).toHaveLength(1) // the check only: no AI call was tried after it
    expect(run.status).toBe('partial')
    expect(run.log).toContain('Posts and comments are read now; Claude sorts them after 14:02.')
    expect(run.report).toContain('### Waiting for Claude')
    expect(unsorted(db)).toBe(3)
    // No reset time given: an hour.
    expect(lastPause(db)).toMatchObject({ until: '2026-10-16T11:00:00.000Z', strikes: 1 })
    expect(catchUpState(db)).toEqual({ after: '2026-10-16T11:02:00.000Z', brands: [brandId] })

    // Before the pause ends nothing happens; after it, the leftovers are sorted once.
    expect(await catchUp(db)).toBeNull()
    claude.answer = working
    vi.setSystemTime(new Date('2026-10-16T11:03:00Z'))
    expect(await catchUp(db)).toBe(1)
    expect(unsorted(db)).toBe(0)
    expect(store.getPost(db, 1)!.description).toBe('A summer bag on a beach.')
    expect(lastPause(db)).toBeNull()
    expect(await catchUp(db)).toBeNull()
  })

  it('an update that will not use Claude does not check it', async () => {
    db.exec('UPDATE brands SET ai_sort = 0')
    const runId = queueRun(
      db,
      { brandIds: [brandId], networks: ['instagram'], range: 'new', limit: 5 },
      'manual',
    )
    await idle()
    expect(claude.calls).toHaveLength(0)
    expect(store.getRun(db, runId)!.status).toBe('ok')
  })

  it('a schedule due soon after the pause takes the leftovers itself', async () => {
    claude.answer = () => ({ ...LIMIT, result: 'Claude AI usage limit reached' })
    queueRun(db, { brandIds: [brandId], networks: ['instagram'], range: 'new', limit: 5 }, 'manual')
    await idle()
    const s = store.saveSchedule(db, {
      brand_id: brandId,
      kind: 'interval',
      every_hours: 6,
      networks: ['instagram'],
    })
    store.setNextRun(db, s.id, '2026-10-16T11:30:00Z')
    claude.answer = working
    vi.setSystemTime(new Date('2026-10-16T11:03:00Z'))
    const before = claude.calls.length
    expect(await catchUp(db)).toBe(0)
    expect(claude.calls).toHaveLength(before)
    expect(unsorted(db)).toBe(3)
  })

  it('a limit mid-run stops the AI at once and keeps what was sorted', async () => {
    // 70 comments: a batch of 60, then one of 10 that hits the limit. A second post never starts.
    feed.posts = [post('A1', 70), post('B2', 4)]
    const reset = Math.floor(NOW.getTime() / 1000) + 2 * 3600
    let sorts = 0
    claude.answer = (prompt, input) =>
      prompt.startsWith('Sort') || prompt.includes('Sort each comment')
        ? ++sorts === 2
          ? { ...LIMIT, result: `Claude AI usage limit reached|${reset}` }
          : working(prompt, input)
        : working(prompt, input)
    const runId = queueRun(
      db,
      { brandIds: [brandId], networks: ['instagram'], range: 'new', limit: 5 },
      'manual',
    )
    await idle()
    const run = store.getRun(db, runId)!
    // The check, one description, two sort batches; nothing after the limit.
    expect(claude.calls).toHaveLength(4)
    expect(run.status).toBe('partial')
    expect(run.report).toContain('Sorting stopped there; what was read is kept')
    expect(run.log).toContain('Stopped sorting: Claude is at its usage limit until 15:00.')
    expect(unsorted(db)).toBe(10 + 4)
    expect(store.getPost(db, 2)!.description).toBeNull()
    expect(activePause(db)?.until).toBe('2026-10-16T12:00:00.000Z')
    expect(catchUpState(db)).toEqual({ after: '2026-10-16T12:02:00.000Z', brands: [brandId] })
    // The check and the calls are counted, the check as its own task.
    const tasks = db.prepare('SELECT task FROM ai_usage ORDER BY id').all() as { task: string }[]
    expect(tasks.map((t) => t.task)).toEqual(['limit-check', 'describe-post', 'sort-comments'])

    claude.answer = working
    vi.setSystemTime(new Date('2026-10-16T12:03:00Z'))
    expect(await catchUp(db)).toBe(2)
    expect(unsorted(db)).toBe(0)
  })
})
