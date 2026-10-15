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
  /** 0 can wait, 1 answer soon, 2 urgent (outage, money lost, safety, a threat to leave or go public). */
  urgency?: 0 | 1 | 2
  emotion?: Emotion
  /** One of the brand's own kinds (its key), when the comment is clearly positive or negative. */
  category?: string
}

/** How the person feels, from most to least upset. */
export const EMOTIONS = [
  'angry',
  'frustrated',
  'disappointed',
  'worried',
  'confused',
  'neutral',
  'curious',
  'happy',
  'grateful',
  'excited',
] as const
export type Emotion = (typeof EMOTIONS)[number]

export interface Kind {
  key: string
  name: string
  sentiment: 'positive' | 'negative'
}

const SORT = (brand: string, post: string, about = '', kinds: Kind[] = []) =>
  `Brand: ${brand}${about ? ` (${about})` : ''}. Post: ${post || '(no caption)'}
Sort each comment line "n|text". A line may carry its context after the text: the comment it
answers, the answers under it (the brand's own included) and a picture the person attached.
Judge what the person means in that whole context, as a person would: sarcasm and irony, jokes,
quoting what others say ("many say it's bad") to then show the opposite, rival names, and
screenshots that carry the real point (a fast speed test is praise, an error screen a complaint).
Emoji are part of the meaning; read them with the words. 😂 or 🤣 after a claim often mean
mockery or sarcasm, 😏 doubt, 🙏 pleading, 😭 or 💔 sadness, ❤️ 🥰 👍 approval, ❌ and ✅ a verdict.
A comment of only emoji has their feeling. TikTok writes some emoji as names in brackets, like
[LOL mare] or [Слезы радости]: read those as the emoji they name.
Reply with one line per comment, "n|label|r|u|e|k|why":
label is one of ${LABELS.join(', ')}; complaint = unhappy with the product, service, price or support.
r is 1 if the brand should answer (complaints, questions, unhappy or confused customers), else 0.
u is urgency: 2 = outage, money lost, safety, or a threat to leave or go public; 1 = should be answered today; 0 = can wait.
e is the feeling, one of ${EMOTIONS.join(', ')}.
k is the brand's kind of comment when it is clearly negative or positive, one of: ${kinds.map((k) => `${k.key} (${k.sentiment}: ${k.name})`).join(', ') || 'none'}; else -.
why: at most 8 words, in English. Output only these lines.`

const DESCRIBE = (brand: string) =>
  `Brand: ${brand}. In one sentence of at most 25 words, in English, say what this social media post is about and what it promotes. Read emoji in the caption and comments as part of the tone. Output only the sentence.`

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

/** A picture the AI should look at, with what it is ("Comment 3's picture"). */
export interface Pic {
  label: string
  path: string
}

function viaClaudeCode(prompt: string, input: string, pics: Pic[] = []): Promise<string> {
  mkdirSync(join(DATA_DIR, 'cache'), { recursive: true })
  writeFileSync(EMPTY_MCP, '{"mcpServers":{}}')
  const image = pics.length > 0
  const args = [
    '-p',
    image
      ? `${prompt}\n${pics.map((p) => `${p.label} is at ${p.path}; look at it with the Read tool.`).join('\n')}`
      : prompt,
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
          if (d.is_error)
            return reject(
              new Error(
                /authenticat|oauth|log ?in|credential/i.test(d.result ?? '')
                  ? 'Claude Code is signed out. On this computer run  claude setup-token  and put CLAUDE_CODE_OAUTH_TOKEN=… in .env (it lasts a year), then restart SocialMonitor.'
                  : `Claude Code: ${d.result}`,
              ),
            )
          resolve(d.result ?? '')
        } catch {
          reject(new Error('Claude Code answered something that is not JSON.'))
        }
      },
    )
    child.stdin?.end(input)
  })
}

/** Claude Code first; when it fails and an Anthropic API key is set, the API instead. */
export async function viaClaude(prompt: string, input: string, pics: Pic[] = []): Promise<string> {
  try {
    return await viaClaudeCode(prompt, input, pics)
  } catch (e) {
    if (!process.env.ANTHROPIC_API_KEY) throw e
    return viaApi(prompt, input, pics)
  }
}

const MEDIA_TYPE: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

export async function viaApi(prompt: string, input: string, pics: Pic[] = []): Promise<string> {
  const content: unknown[] = []
  const { readFileSync } = await import('node:fs')
  for (const p of pics) {
    content.push({ type: 'text', text: `${p.label}:` })
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: MEDIA_TYPE[p.path.split('.').pop()!] ?? 'image/jpeg',
        data: readFileSync(p.path).toString('base64'),
      },
    })
  }
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

/** A reply the brand could post, in the comment's own language. Never posted by the app. */
export async function draftReply(
  engine: Engine,
  brand: string,
  about: string,
  post: string,
  comment: string,
) {
  const prompt = `You answer comments for ${brand}${about ? ` (${clip(about, 240)})` : ''}. Post: ${clip(post, 300) || '(no caption)'}
Write one reply to the comment below, in the comment's own language: warm, short (at most 3 sentences), specific, no hashtags, no promises the brand cannot keep. If it is a complaint, apologise once and say how to get help. Output only the reply.`
  const text =
    engine === 'claude'
      ? await viaClaude(prompt, clip(comment, 800))
      : await viaApi(prompt, clip(comment, 800))
  return text.trim().slice(0, 1200)
}

const LANGUAGE: Record<string, string> = {
  en: 'English',
  ro: 'Romanian',
  ru: 'Russian',
  fr: 'French',
  zh: 'Simplified Chinese',
}

/** The comment in the reader's language (English unless told otherwise). */
export async function translate(engine: Engine, text: string, lang = 'en') {
  const prompt = `Translate this social media comment into natural ${LANGUAGE[lang] ?? 'English'}. Keep emoji. Output only the translation.`
  const out =
    engine === 'claude'
      ? await viaClaude(prompt, clip(text, 1500))
      : await viaApi(prompt, clip(text, 1500))
  return out.trim().slice(0, 2000)
}

/** Parses "n|label|r|u|e|why" lines (and the older "n|label|r|why"); anything else is ignored. */
export function parseVerdicts(text: string): Map<number, Verdict> {
  const out = new Map<number, Verdict>()
  for (const line of text.split('\n')) {
    const [n, label, r, ...rest] = line.trim().split('|')
    const i = Number(n)
    const l = label?.trim().toLowerCase() as Label
    if (!Number.isInteger(i) || !(LABELS as readonly string[]).includes(l)) continue
    const u = rest[0]?.trim()
    const e = rest[1]?.trim().toLowerCase() as Emotion
    const full = rest.length >= 3 && /^[012]$/.test(u ?? '') && EMOTIONS.includes(e)
    // The brand's kind comes next when given: a key such as "slow-internet", or "-".
    const k = rest[2]?.trim()
    const withKind = full && rest.length >= 4 && /^(-|[a-z0-9][a-z0-9-]{0,40})$/.test(k ?? '')
    out.set(i, {
      label: l,
      needsReply: r?.trim() === '1',
      reason: (full ? rest.slice(withKind ? 3 : 2) : rest).join('|').trim().slice(0, 120),
      ...(full ? { urgency: Number(u) as 0 | 1 | 2, emotion: e } : {}),
      ...(withKind && k !== '-' ? { category: k } : {}),
    })
  }
  return out
}

/** Sorts comments in batches of 60. Returns verdicts by the caller's comment id. */
export async function sortComments(
  engine: Engine,
  brand: string,
  caption: string,
  comments: { id: number; text: string; context?: string; image?: string }[],
  about = '',
  kinds: Kind[] = [],
): Promise<Map<number, Verdict>> {
  const out = new Map<number, Verdict>()
  const prompt = SORT(brand, clip(caption, 300), clip(about, 240), kinds)
  // Batches stay small when pictures come along, so each answer stays quick and cheap.
  for (let i = 0; i < comments.length;) {
    const batch: typeof comments = []
    while (i < comments.length && batch.length < 60 && batch.filter((c) => c.image).length < 6)
      batch.push(comments[i++]!)
    const input = batch
      .map(
        (c, j) =>
          `${j + 1}|${clip(c.text, 500) || '(no words)'}${c.context ? ` [${clip(c.context, 600)}]` : ''}${c.image ? ` [has picture ${j + 1}]` : ''}`,
      )
      .join('\n')
    const pics = batch.flatMap((c, j) =>
      c.image ? [{ label: `Comment ${j + 1}'s picture`, path: c.image }] : [],
    )
    const text =
      engine === 'claude' ? await viaClaude(prompt, input, pics) : await viaApi(prompt, input, pics)
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
  const pics = imagePath ? [{ label: "The post's picture", path: imagePath }] : []
  const text =
    engine === 'claude'
      ? await viaClaude(DESCRIBE(brand), input, pics)
      : await viaApi(DESCRIBE(brand), input, pics)
  return clip(text, 300)
}
