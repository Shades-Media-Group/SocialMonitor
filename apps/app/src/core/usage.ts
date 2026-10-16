import type { DB } from './db.ts'
import { now } from './db.ts'
import type { Network } from './types.ts'

/**
 * What each AI call used: tokens and the API-equivalent price, one row per call in ai_usage.
 * Claude Code reports its own price (total_cost_usd); the API path is priced from PRICES. On a
 * Claude subscription nothing is billed per call, so this is what the same work would cost on
 * the API, never money spent.
 */

/** Every kind of AI work the app does, named for the Admin tab. */
export const AI_TASKS = [
  'sort-comments',
  'describe-post',
  'campaign-tags',
  'summary',
  'ideas',
  'reply',
  'translate',
  'limit-check',
] as const
export type AiTask = (typeof AI_TASKS)[number]

/** Who the call was for: passed down by each caller, all optional but the task. */
export interface UsageContext {
  db: DB
  task: AiTask
  brandId?: number | null
  network?: Network | null
  /** How many comments or posts the call covered. */
  items?: number
}

export interface Usage {
  engine: 'claude' | 'api'
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  durationMs: number | null
}

/**
 * Anthropic's first-party API prices in USD per million tokens, from the Claude API model table
 * (platform.claude.com pricing, as cached on 2026-10-06). Cache writes are 1.25x input (5-minute
 * TTL) and cache reads 0.1x input. Claude Haiku 5.5 charges $0.50 / $2.50 for prompts over 100K
 * tokens. A model missing here is priced as Haiku 5.5, the app's default.
 */
const PRICES: Record<string, { input: number; output: number; long?: [number, number] }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, long: [0.5, 2.5] },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)

/** The API price of one call's tokens. */
export function apiCost(
  model: string,
  u: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
) {
  const p = PRICES[model.replace(/-\d{8}$/, '')] ?? PRICES['claude-haiku-5-5']!
  const prompt = u.input + u.cacheRead + u.cacheWrite
  const [input, output] = p.long && prompt > 100_000 ? p.long : [p.input, p.output]
  return (
    (u.input * input +
      u.cacheWrite * input * 1.25 +
      u.cacheRead * input * 0.1 +
      u.output * output) /
    1e6
  )
}

/** Usage from the Messages API's `usage` object. */
export function fromApi(model: string, usage: unknown): Usage {
  const u = (usage ?? {}) as Record<string, unknown>
  const t = {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
  }
  return { engine: 'api', model, ...t, costUsd: apiCost(model, t), durationMs: null }
}

/**
 * Usage from `claude -p --output-format json`: tokens summed over modelUsage (every model the
 * call used), else the top-level usage; the price is Claude Code's own total_cost_usd.
 */
export function fromClaudeCode(d: unknown): Usage | null {
  if (!d || typeof d !== 'object') return null
  const x = d as Record<string, unknown>
  const models = Object.entries((x.modelUsage ?? {}) as Record<string, Record<string, unknown>>)
  const u = (x.usage ?? {}) as Record<string, unknown>
  const t = models.length
    ? models.reduce(
        (s, [, m]) => ({
          input: s.input + n(m.inputTokens),
          output: s.output + n(m.outputTokens),
          cacheRead: s.cacheRead + n(m.cacheReadInputTokens),
          cacheWrite: s.cacheWrite + n(m.cacheCreationInputTokens),
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      )
    : {
        input: n(u.input_tokens),
        output: n(u.output_tokens),
        cacheRead: n(u.cache_read_input_tokens),
        cacheWrite: n(u.cache_creation_input_tokens),
      }
  if (!t.input && !t.output && !t.cacheRead && !t.cacheWrite) return null
  // The model that cost the most names the call.
  const model = models.sort((a, b) => n(b[1].costUSD) - n(a[1].costUSD))[0]?.[0] ?? 'claude-code'
  return {
    engine: 'claude',
    model,
    ...t,
    costUsd: n(x.total_cost_usd),
    durationMs: n(x.duration_ms) || null,
  }
}

/** Never throws: a usage row that cannot be written must not stop the sorting it describes. */
export function recordUsage(ctx: UsageContext | undefined, u: Usage | null) {
  if (!ctx || !u) return
  try {
    ctx.db
      .prepare(
        `INSERT INTO ai_usage (at, brand_id, task, network, engine, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, items, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        ctx.brandId ?? null,
        ctx.task,
        ctx.network ?? null,
        u.engine,
        u.model,
        u.input,
        u.output,
        u.cacheRead,
        u.cacheWrite,
        u.costUsd,
        ctx.items ?? 0,
        u.durationMs,
      )
  } catch (e) {
    console.error(`Could not record AI usage: ${(e as Error).message}`)
  }
}
