import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db.ts'
import { viaApi } from './analyze.ts'
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
