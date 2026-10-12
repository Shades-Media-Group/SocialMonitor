import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db.ts'
import type { Label } from './types.ts'
import { LABELS } from './types.ts'
import { hasClaudeCode } from './settings.ts'
import type { Settings } from './settings.ts'

/**
 * The AI step, kept small on purpose. Comments go in as `n|text` lines and come back as
 * `n|label|reply|why` lines: no JSON wrapper, no ids longer than they need to be, no
 * repeated instructions. Claude Code runs with a one-line system prompt and no tools,
 * skills, plugins, MCP servers or settings, so each call carries only this text.
 */

export interface Verdict {
  label: Label
  needsReply: boolean
  reason: string
}

const SORT = (brand: string, post: string, about = '') =>
  `Brand: ${brand}${about ? ` (${about})` : ''}. Post: ${post || '(no caption)'}
Sort each comment line "n|text". Reply with one line per comment, "n|label|r|why":
label is one of ${LABELS.join(', ')}; complaint = unhappy with the product, service, price or support.
r is 1 if the brand should answer (complaints, questions, unhappy or confused customers), else 0.
why: at most 8 words, in English. Output only these lines.`

const DESCRIBE = (brand: string) =>
  `Brand: ${brand}. In one sentence of at most 25 words, in English, say what this social media post is about and what it promotes. Output only the sentence.`

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

type Engine = 'claude' | 'api'

export function pickEngine(s: Settings): Engine | null {
  const key = !!process.env.ANTHROPIC_API_KEY
  if (s.analyzer === 'api') return key ? 'api' : null
  if (s.analyzer === 'claude') return hasClaudeCode() ? 'claude' : null
  return hasClaudeCode() ? 'claude' : key ? 'api' : null
}

const MODEL_ALIAS = 'haiku'
const API_MODEL = process.env.SOCIALMONITOR_MODEL ?? 'claude-haiku-5-5'
const EMPTY_MCP = join(DATA_DIR, 'cache', 'no-mcp.json')

function viaClaudeCode(prompt: string, input: string, image?: string): Promise<string> {
  mkdirSync(join(DATA_DIR, 'cache'), { recursive: true })
  writeFileSync(EMPTY_MCP, '{"mcpServers":{}}')
  const args = [
    '-p',
    image ? `${prompt}\nThe post's picture is at ${image}; look at it with the Read tool.` : prompt,
    '--system-prompt',
    'You label and describe social media content for a brand. Answer only in the requested format.',
    '--model',
    MODEL_ALIAS,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP,
    '--disable-slash-commands',
    '--tools',
    image ? 'Read' : '',
    ...(image ? ['--allowedTools', 'Read'] : []),
  ]
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      args,
      { cwd: join(DATA_DIR, 'cache'), timeout: 180000, maxBuffer: 8 << 20 },
      (err, stdout) => {
        if (err && !stdout)
          return reject(new Error(`Claude Code failed: ${err.message.split('\n')[0]}`))
        try {
          const d = JSON.parse(stdout) as { result?: string; is_error?: boolean }
          if (d.is_error) return reject(new Error(`Claude Code: ${d.result}`))
          resolve(d.result ?? '')
        } catch {
          reject(new Error('Claude Code answered something that is not JSON.'))
        }
      },
    )
    child.stdin?.end(input)
  })
}

async function viaApi(
  prompt: string,
  input: string,
  image?: { data: string; type: string },
): Promise<string> {
  const content: unknown[] = []
  if (image)
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.type, data: image.data },
    })
  content.push({ type: 'text', text: input ? `${prompt}\n\n${input}` : prompt })
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: API_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content }],
    }),
  })
  const d = (await r.json()) as { content?: { text?: string }[]; error?: { message?: string } }
  if (!r.ok) throw new Error(`Anthropic API: ${d.error?.message ?? r.status}`)
  return d.content?.map((c) => c.text ?? '').join('') ?? ''
}

/** Parses "n|label|r|why" lines; anything else is ignored. */
export function parseVerdicts(text: string): Map<number, Verdict> {
  const out = new Map<number, Verdict>()
  for (const line of text.split('\n')) {
    const [n, label, r, ...why] = line.trim().split('|')
    const i = Number(n)
    const l = label?.trim().toLowerCase() as Label
    if (!Number.isInteger(i) || !(LABELS as readonly string[]).includes(l)) continue
    out.set(i, {
      label: l,
      needsReply: r?.trim() === '1',
      reason: why.join('|').trim().slice(0, 120),
    })
  }
  return out
}

/** Sorts comments in batches of 60. Returns verdicts by the caller's comment id. */
export async function sortComments(
  engine: Engine,
  brand: string,
  caption: string,
  comments: { id: number; text: string }[],
  about = '',
): Promise<Map<number, Verdict>> {
  const out = new Map<number, Verdict>()
  const prompt = SORT(brand, clip(caption, 300), clip(about, 240))
  for (let i = 0; i < comments.length; i += 60) {
    const batch = comments.slice(i, i + 60)
    const input = batch.map((c, j) => `${j + 1}|${clip(c.text, 500)}`).join('\n')
    const text =
      engine === 'claude' ? await viaClaudeCode(prompt, input) : await viaApi(prompt, input)
    for (const [j, v] of parseVerdicts(text)) {
      const c = batch[j - 1]
      if (c) out.set(c.id, v)
    }
  }
  return out
}

/** One sentence about the post, from its caption, top comments and, when saved, its picture. */
export async function describePost(
  engine: Engine,
  brand: string,
  caption: string,
  topComments: string[],
  imagePath: string | null,
): Promise<string> {
  const input = `Caption: ${clip(caption, 1200) || '(none)'}${topComments.length ? `\nTop comments: ${topComments.map((c) => clip(c, 140)).join(' / ')}` : ''}`
  let text: string
  if (engine === 'claude')
    text = await viaClaudeCode(DESCRIBE(brand), input, imagePath ?? undefined)
  else {
    let image: { data: string; type: string } | undefined
    if (imagePath) {
      const { readFileSync } = await import('node:fs')
      image = {
        data: readFileSync(imagePath).toString('base64'),
        type: imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg',
      }
    }
    text = await viaApi(DESCRIBE(brand), input, image)
  }
  return clip(text, 300)
}
