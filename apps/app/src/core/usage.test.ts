import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db.ts'
import { viaApi } from './analyze.ts'
import { aiStep, sortPending } from './run.ts'
import { addBrand, listProfiles, savePost, setSetting, startRun } from './store.ts'
import { apiCost, fromApi, fromClaudeCode, recordUsage } from './usage.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The shape `claude -p --output-format json` prints. */
const claudeJson = {
  type: 'result',
  is_error: false,
  duration_ms: 2140,
  result: '1|praise|0|0|happy|-|likes the offer',
  total_cost_usd: 0.00231,
  usage: {
    input_tokens: 12,
    output_tokens: 40,
    cache_creation_input_tokens: 900,
    cache_read_input_tokens: 3000,
  },
  modelUsage: {
    'claude-haiku-5-5': {
      inputTokens: 12,
      outputTokens: 40,
      cacheReadInputTokens: 3000,
      cacheCreationInputTokens: 900,
      costUSD: 0.00231,
    },
  },
}

describe('AI usage', () => {
  it("reads Claude Code's tokens, model, price and time", () => {
    expect(fromClaudeCode(claudeJson)).toEqual({
      engine: 'claude',
      model: 'claude-haiku-5-5',
      input: 12,
      output: 40,
      cacheRead: 3000,
      cacheWrite: 900,
      costUsd: 0.00231,
      durationMs: 2140,
    })
    // Without modelUsage the top-level usage counts; a call that used nothing is not a row.
    const { modelUsage: _, ...bare } = claudeJson
    expect(fromClaudeCode(bare)).toMatchObject({ model: 'claude-code', input: 12, cacheRead: 3000 })
    expect(
      fromClaudeCode({ is_error: true, usage: { input_tokens: 0 }, modelUsage: {} }),
    ).toBeNull()
    expect(fromClaudeCode('not json')).toBeNull()
  })

  it("prices the API's tokens at Haiku's published rates", () => {
    // $0.10 in, $0.50 out per million; cache writes 1.25x and reads 0.1x the input price.
    const u = fromApi('claude-haiku-5-5', {
      input_tokens: 50_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(u.costUsd).toBeCloseTo(0.005 + 0.5, 10)
    expect(
      apiCost('claude-haiku-5-5', { input: 0, output: 0, cacheRead: 50_000, cacheWrite: 50_000 }),
    ).toBeCloseTo((50_000 * 0.01 + 50_000 * 0.125) / 1e6, 10)
    expect(
      apiCost('claude-haiku-4-5', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBe(1)
    // Over 100K tokens of prompt, Haiku 5.5 charges its long-prompt rate.
    expect(
      apiCost('claude-haiku-5-5', { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBeCloseTo(0.1, 10)
  })

  it('keeps a row for each API call, with its brand, task and items', async () => {
    const db = openDb(':memory:')
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          model: 'claude-haiku-5-5',
          content: [{ text: 'A bag for the beach.' }],
          usage: { input_tokens: 2000, output_tokens: 30 },
        }),
      ),
    )
    const text = await viaApi('Describe', 'Caption: Tavelo summer bag', [], {
      db,
      task: 'describe-post',
      brandId: 7,
      network: 'instagram',
      items: 1,
    })
    expect(text).toBe('A bag for the beach.')
    const row = db.prepare('SELECT * FROM ai_usage').get() as Record<string, unknown>
    expect(row).toMatchObject({
      brand_id: 7,
      task: 'describe-post',
      network: 'instagram',
      engine: 'api',
      model: 'claude-haiku-5-5',
      input_tokens: 2000,
      output_tokens: 30,
      items: 1,
    })
    expect(row.cost_usd).toBeCloseTo((2000 * 0.1 + 30 * 0.5) / 1e6, 12)
    // Append-only.
    expect(() => db.exec('UPDATE ai_usage SET cost_usd = 0')).toThrow(/append-only/)
    vi.unstubAllEnvs()
  })

  it('adds run_id to an older database, keeping its rows and the append-only rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sm-usage-'))
    const file = join(dir, 'old.db')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE ai_usage (id INTEGER PRIMARY KEY, at TEXT NOT NULL, brand_id INTEGER,
      task TEXT NOT NULL, network TEXT, engine TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, items INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER);
    CREATE TRIGGER ai_usage_no_update BEFORE UPDATE ON ai_usage
    BEGIN SELECT RAISE(ABORT, 'AI usage is append-only.'); END;
    INSERT INTO ai_usage (at, task, engine, model) VALUES ('2026-10-01T00:00:00.000Z', 'summary', 'api', 'm');
    CREATE TABLE runs (id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, scope TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'running',
      log TEXT NOT NULL DEFAULT '', stats TEXT, report TEXT);
    INSERT INTO runs (trigger, scope, started_at) VALUES ('manual', '{}', '2026-10-01T00:00:00.000Z');`)
    old.close()
    const db = openDb(file)
    try {
      expect(db.prepare('SELECT task, run_id FROM ai_usage').all()).toEqual([
        { task: 'summary', run_id: null },
      ])
      // The update from before: no tally, so the Admin tab says it was not recorded.
      expect(db.prepare('SELECT tally FROM runs').get()).toEqual({ tally: null })
      expect(() => db.exec('UPDATE ai_usage SET run_id = 1')).toThrow(/append-only/)
      recordUsage({ db, task: 'reply', runId: 7 }, fromClaudeCode(claudeJson))
      expect(db.prepare('SELECT run_id FROM ai_usage WHERE task = ?').get('reply')).toEqual({
        run_id: 7,
      })
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ties every AI call an update makes to it, and leaves calls outside updates untied', async () => {
    const db = openDb(':memory:')
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    setSetting(db, 'settings', JSON.stringify({ analyzer: 'api' }))
    const brand = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
    const [profile] = listProfiles(db, brand.id)
    const post = (ext: string, comments: string[]) =>
      savePost(db, profile!, {
        ext_id: ext,
        url: `https://www.instagram.com/p/${ext}`,
        posted_at: null,
        kind: 'post',
        caption: 'Summer bags',
        thumb_url: null,
        likes: 1,
        comments_count: comments.length,
        shares: 0,
        views: 0,
        comments: comments.map((text, i) => ({
          ext_id: `${ext}-${i}`,
          parent_ext_id: null,
          author: `fan${i}`,
          text,
          likes: 0,
          posted_at: null,
        })),
      }).post
    const first = post('1', ['love it', 'too pricey'])
    // A campaign with no hints, so Claude is asked where the post belongs.
    db.prepare(
      `INSERT INTO campaigns (brand_id, name, created_at, updated_at) VALUES (?, 'Autumn', ?, ?)`,
    ).run(brand.id, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = String(init.body)
        const text = body.includes('Its campaigns')
          ? '1|-'
          : body.includes('Sort each comment')
            ? '1|praise|0|0|happy|-|likes it\n2|complaint|1|1|frustrated|-|price'
            : 'A summer bag on a beach.'
        return Response.json({
          model: 'claude-haiku-5-5',
          content: [{ text }],
          usage: { input_tokens: 100, output_tokens: 10 },
        })
      }),
    )
    const runId = startRun(db, 'manual', {
      brandIds: [brand.id],
      networks: ['instagram'],
      range: 'new',
      limit: 10,
    })
    await aiStep(db, [{ postId: first.id, brand: 'Tavelo' }], () => {}, undefined, runId)
    // Sort now, outside any update.
    post('2', ['when is the sale?'])
    await sortPending(db)
    const rows = db.prepare('SELECT task, brand_id, run_id FROM ai_usage ORDER BY id').all() as {
      task: string
      brand_id: number
      run_id: number | null
    }[]
    expect(rows.map((r) => [r.task, r.run_id])).toEqual([
      ['describe-post', runId],
      ['sort-comments', runId],
      ['campaign-tags', runId],
      ['describe-post', null],
      ['sort-comments', null],
      ['campaign-tags', null],
    ])
    expect(rows.every((r) => r.brand_id === brand.id)).toBe(true)
    vi.unstubAllEnvs()
  })

  it('never throws, even when the row cannot be written', () => {
    const db = openDb(':memory:')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.close()
    expect(() =>
      recordUsage({ db, task: 'sort-comments' }, fromClaudeCode(claudeJson)),
    ).not.toThrow()
    expect(err).toHaveBeenCalled()
    // No context (a caller that does not track usage) writes nothing and does not fail.
    expect(() => recordUsage(undefined, fromClaudeCode(claudeJson))).not.toThrow()
  })
})
