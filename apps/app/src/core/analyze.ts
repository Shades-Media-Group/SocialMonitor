import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db.ts'
import type { Label } from './types.ts'
import { LABELS } from './types.ts'
import { hasClaudeCode } from './settings.ts'
import type { Settings } from './settings.ts'
import type { UsageContext } from './usage.ts'
import { fromApi, fromClaudeCode, recordUsage } from './usage.ts'

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

async function viaClaudeCode(
  prompt: string,
  input: string,
  pics: Pic[] = [],
  use?: UsageContext,
): Promise<string> {
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
  try {
    return await claudeOnce(args, input, process.env, use)
  } catch (e) {
    // The setup token lasts a year. When it has run out, try the computer's own Claude Code sign-in
    // (`claude`, then /login, once), which renews itself, before giving up.
    if (!(e instanceof SignedOut) || !process.env.CLAUDE_CODE_OAUTH_TOKEN) throw e
    const { CLAUDE_CODE_OAUTH_TOKEN: _, ...rest } = process.env
    return claudeOnce(args, input, rest, use)
  }
}

class SignedOut extends Error {}

function claudeOnce(
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  use?: UsageContext,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      args,
      { cwd: join(DATA_DIR, 'cache'), timeout: 180000, maxBuffer: 8 << 20, env },
      (err, stdout) => {
        if (err && !stdout)
          return reject(new Error(`Claude Code failed: ${err.message.split('\n')[0]}`))
        try {
          const d = JSON.parse(stdout) as { result?: string; is_error?: boolean }
          // A failed call can still have used tokens, so it is counted before the error check.
          recordUsage(use, fromClaudeCode(d))
          if (d.is_error)
            return reject(
              /authenticat|oauth|log ?in|credential/i.test(d.result ?? '')
                ? new SignedOut(
                    'Claude Code is signed out. On this computer run  claude setup-token  and put CLAUDE_CODE_OAUTH_TOKEN=… in .env (it lasts a year), then restart SocialMonitor.',
                  )
                : new Error(`Claude Code: ${d.result}`),
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
export async function viaClaude(
  prompt: string,
  input: string,
  pics: Pic[] = [],
  use?: UsageContext,
): Promise<string> {
  try {
    return await viaClaudeCode(prompt, input, pics, use)
  } catch (e) {
    if (!process.env.ANTHROPIC_API_KEY) throw e
    return viaApi(prompt, input, pics, use)
  }
}

/** The engine's own path: Claude Code (with the API as fallback) or the API alone. */
const ask = (engine: Engine, prompt: string, input: string, pics: Pic[], use?: UsageContext) =>
  engine === 'claude' ? viaClaude(prompt, input, pics, use) : viaApi(prompt, input, pics, use)

const MEDIA_TYPE: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

export async function viaApi(
  prompt: string,
  input: string,
  pics: Pic[] = [],
  use?: UsageContext,
): Promise<string> {
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
  const started = Date.now()
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
  const d = (await r.json()) as {
    content?: { text?: string }[]
    error?: { message?: string }
    model?: string
    usage?: unknown
  }
  if (d.usage)
    recordUsage(use, {
      ...fromApi(d.model ?? API_MODEL, d.usage),
      durationMs: Date.now() - started,
    })
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
  use?: UsageContext,
) {
  const prompt = `You answer comments for ${brand}${about ? ` (${clip(about, 240)})` : ''}. Post: ${clip(post, 300) || '(no caption)'}
Write one reply to the comment below, in the comment's own language: warm, short (at most 3 sentences), specific, no hashtags, no promises the brand cannot keep. If it is a complaint, apologise once and say how to get help. Output only the reply.`
  const text = await ask(engine, prompt, clip(comment, 800), [], use)
  return text.trim().slice(0, 1200)
}

/**
 * Which saved reply the model chose ("n|reply", 1-based) or none ("0|reply", a fresh draft).
 * An answer without the "n|" lead counts as a fresh draft. A model that echoes the saved
 * reply's "title|kind|" before the text has them taken off.
 */
export function parsePick(text: string, count: number): { index: number | null; text: string } {
  const m = /^\s*(\d+)\s*\|([\s\S]*)$/.exec(text)
  const n = m ? Number(m[1]) : 0
  let reply = (m ? m[2]! : text).trim()
  const echo = /^[^|\n]{1,80}\|[^|\n]{1,40}\|([\s\S]+)$/.exec(reply)
  if (echo) reply = echo[1]!.trim()
  return { index: n >= 1 && n <= count ? n - 1 : null, text: reply }
}

/**
 * The best of the brand's saved replies for this comment, filled in for the person who wrote it;
 * a fresh draft when none fits. Saved replies go in clipped, the most fitting first.
 */
export async function draftFromSaved(
  engine: Engine,
  brand: string,
  about: string,
  post: string,
  comment: { text: string; author: string; kind?: string | null },
  saved: { title: string; text: string; category: string | null }[],
  use?: UsageContext,
) {
  const prompt = `You answer comments for ${brand}${about ? ` (${clip(about, 240)})` : ''}. Post: ${clip(post, 300) || '(no caption)'}
The team keeps these saved replies, each a number, its title, the kind of comment it is for, then its text:
${saved.map((s, i) => `[${i + 1}] ${clip(s.title, 80)} (for: ${s.category ?? 'any comment'})\n${clip(s.text, 600)}`).join('\n')}
The comment below is by @${comment.author}${comment.kind ? `, kind ${comment.kind}` : ''}.
If one saved reply answers it, output its number, "|", then the reply: keep its wording, fill each {placeholder} from the comment ({name} is the commenter's name; use a first name when the username shows one), leave a placeholder you cannot fill as it is, and translate the reply only if the comment is in another language.
If none fits, output "0|" then one new reply in the comment's own language: warm, short (at most 3 sentences), specific, no hashtags, no promises the brand cannot keep, and no facts (prices, times, rules) that the post or the saved replies do not give.
Output only that, for example "2|Hi Ana, …".`
  const text = await ask(engine, prompt, clip(comment.text, 800), [], use)
  const pick = parsePick(text, saved.length)
  return { index: pick.index, text: pick.text.slice(0, 1200) }
}

const LANGUAGE: Record<string, string> = {
  en: 'English',
  ro: 'Romanian',
  ru: 'Russian',
  fr: 'French',
  zh: 'Simplified Chinese',
}

/** The comment in the reader's language (English unless told otherwise). */
export async function translate(engine: Engine, text: string, lang = 'en', use?: UsageContext) {
  const prompt = `Translate this social media comment into natural ${LANGUAGE[lang] ?? 'English'}. Keep emoji. Output only the translation.`
  const out = await ask(engine, prompt, clip(text, 1500), [], use)
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
  use?: UsageContext,
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
    const text = await ask(engine, prompt, input, pics, use && { ...use, items: batch.length })
    for (const [j, v] of parseVerdicts(text)) {
      const c = batch[j - 1]
      if (c) out.set(c.id, v)
    }
  }
  return out
}

/**
 * Asks Claude which of the brand's campaigns each post belongs to, from its caption and what it
 * shows. Posts are numbered from 1; the answer is read with parsePicks in campaigns.ts.
 */
export async function pickCampaigns(
  engine: Engine,
  brand: string,
  campaigns: { id: number; name: string; hints: string }[],
  posts: { caption: string; about: string | null }[],
  use?: UsageContext,
): Promise<string> {
  const prompt = `Brand: ${brand}. Its campaigns, one per line as "id|name|hints":
${campaigns.map((c) => `${c.id}|${clip(c.name, 80)}|${clip(c.hints, 300) || '-'}`).join('\n')}
For each post below, pick the one campaign it clearly belongs to, or - when none fits. Reply with one line per post, "n|id" or "n|-". Output only these lines.`
  const input = posts
    .map(
      (p, i) =>
        `${i + 1}|${clip(p.caption, 600) || '(no caption)'}${p.about ? ` [What the post shows: ${clip(p.about, 300)}]` : ''}`,
    )
    .join('\n')
  return ask(engine, prompt, input, [], use && { ...use, items: posts.length })
}

/** One sentence about the post, from its caption, top comments and, when saved, its picture. */
export async function describePost(
  engine: Engine,
  brand: string,
  caption: string,
  topComments: string[],
  imagePath: string | null,
  use?: UsageContext,
): Promise<string> {
  const input = `Caption: ${clip(caption, 1200) || '(none)'}${topComments.length ? `\nTop comments: ${topComments.map((c) => clip(c, 140)).join(' / ')}` : ''}`
  const pics = imagePath ? [{ label: "The post's picture", path: imagePath }] : []
  const text = await ask(engine, DESCRIBE(brand), input, pics, use && { ...use, items: 1 })
  return clip(text, 300)
}

const SUMMARY = (brand: string, about: string) =>
  `Brand: ${brand}${about ? ` (${about})` : ''}. Below are the numbers and the top comments from its social media this week and the week before.
Write for the brand's social media manager, in English, in plain sentences: no headings, lists, markdown or emoji.
Three short paragraphs, at most 120 words in all: what people said this week; what changed against the week before, with the numbers given; what to answer first, and why. Use only the facts below and never invent a number. Output only the paragraphs.`

/** The summary's paragraphs, with any markdown, bullets or headings the model added taken out. */
export function parseSummary(text: string): string[] {
  return text
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(#+|[-*•]|\d+[.)])\s+/, '')
        .replace(/\*\*|__/g, '')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 4)
    .map((p) => clip(p, 600))
}

/** A few lines on the brand's week, from compact numbers and clipped comments: never raw rows. */
export async function writeSummary(
  engine: Engine,
  brand: string,
  about: string,
  input: string,
  use?: UsageContext,
) {
  const prompt = SUMMARY(brand, clip(about, 240))
  const text = await ask(engine, prompt, input, [], use)
  return parseSummary(text)
}
