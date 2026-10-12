import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/**
 * SocialMonitor for Claude. Every tool calls the dashboard's local API, so updates run in
 * the app (one queue, one browser profile) and Claude sees exactly what the dashboard shows.
 * Answers are compact text lines, not raw JSON: fewer tokens for the same facts.
 */
const BASE = process.env.SOCIALMONITOR_URL ?? 'http://127.0.0.1:4400'

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error(
      `SocialMonitor is not running at ${BASE}. Start it with "yarn start" in the repository.`,
    )
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `SocialMonitor answered ${res.status}.`)
  return data
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const one = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const day = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : 'never')

interface Profile {
  network: string
  handle: string
  url: string
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
}
interface Brand {
  id: number
  name: string
  profiles: Profile[]
  counts: Record<string, number>
}

const network = z.enum(['instagram', 'facebook', 'tiktok'])
const label = z.enum(['praise', 'question', 'complaint', 'suggestion', 'neutral', 'spam'])

async function brandId(name?: string): Promise<number | undefined> {
  if (!name) return undefined
  const brands = await call<Brand[]>('GET', '/api/brands')
  const b = brands.find((x) => x.name.toLowerCase() === name.toLowerCase() || String(x.id) === name)
  if (!b)
    throw new Error(
      `No brand "${name}". Brands: ${brands.map((x) => x.name).join(', ') || 'none yet'}.`,
    )
  return b.id
}

const server = new McpServer({ name: 'socialmonitor', version: '0.1.0' })

server.registerTool(
  'overview',
  {
    description:
      'Brands with comment counts by label (complaint, question, praise…), how many need a reply, and when each network was last updated. Start here.',
    inputSchema: {
      brand: z.string().optional().describe('Brand name or id; all brands when empty'),
    },
  },
  async ({ brand }) => {
    const id = await brandId(brand)
    const brands = (await call<Brand[]>('GET', '/api/brands')).filter((b) => !id || b.id === id)
    if (!brands.length) return text('No brands yet. Add one with add_brand.')
    return text(
      brands
        .map((b) => {
          const c = b.counts
          const counts = Object.entries(c)
            .filter(([, n]) => n)
            .map(([k, n]) => `${k} ${n}`)
            .join(', ')
          const nets = b.profiles
            .map(
              (p) =>
                `  ${p.network} @${p.handle}: updated ${day(p.last_run_at)}${p.last_status === 'error' ? ` NEEDS YOU: ${p.last_error}` : ''}`,
            )
            .join('\n')
          return `${b.name} (id ${b.id}): ${counts || 'no comments yet'}\n${nets}`
        })
        .join('\n\n'),
    )
  },
)

server.registerTool(
  'comments',
  {
    description:
      'Comments as lines "id|network|label|reply|sentiment:kind|likes|author|text". The brand\'s own replies are left out. Filter by brand, label, network, needs_reply, sentiment (positive, negative, none) or a search word.',
    inputSchema: {
      brand: z.string().optional(),
      label: label.optional(),
      network: network.optional(),
      needs_reply: z.boolean().optional(),
      search: z.string().optional(),
      sentiment: z.enum(['positive', 'negative', 'neutral', 'none']).optional(),
      limit: z.number().int().min(1).max(200).default(30),
    },
  },
  async ({ brand, label, network, needs_reply, search, sentiment, limit }) => {
    const p = new URLSearchParams({ limit: String(limit) })
    const id = await brandId(brand)
    if (id) p.set('brand', String(id))
    if (label) p.set('label', label)
    if (network) p.set('network', network)
    if (needs_reply) p.set('reply', '1')
    if (search) p.set('q', search)
    if (sentiment) p.set('sentiment', sentiment)
    const rows = await call<
      {
        id: number
        network: string
        label: string | null
        needs_reply: number | null
        likes: number | null
        author: string
        text: string
        reason: string | null
        sentiment: string | null
        category: string | null
      }[]
    >('GET', `/api/comments?${p}&others=1`)
    if (!rows.length) return text('No comments match.')
    return text(
      rows
        .map(
          (c) =>
            `${c.id}|${c.network}|${c.label ?? 'unsorted'}|${c.needs_reply ? 1 : 0}|${c.sentiment ? `${c.sentiment}:${c.category ?? '-'}` : '-'}|${c.likes ?? 0}|${c.author}|${one(c.text, 240)}`,
        )
        .join('\n'),
    )
  },
)

server.registerTool(
  'posts',
  {
    description:
      'Recent posts as lines "id|network|date|likes|comments|views|what it is about|url".',
    inputSchema: {
      brand: z.string().optional(),
      network: network.optional(),
      limit: z.number().int().min(1).max(100).default(10),
    },
  },
  async ({ brand, network, limit }) => {
    const p = new URLSearchParams({ limit: String(limit) })
    const id = await brandId(brand)
    if (id) p.set('brand', String(id))
    if (network) p.set('network', network)
    const rows = await call<
      {
        id: number
        network: string
        posted_at: string | null
        likes: number | null
        comments_count: number | null
        views: number | null
        description: string | null
        caption: string
        url: string
      }[]
    >('GET', `/api/posts?${p}`)
    if (!rows.length) return text('No posts yet. Run update first.')
    return text(
      rows
        .map(
          (r) =>
            `${r.id}|${r.network}|${day(r.posted_at)}|${r.likes ?? '-'}|${r.comments_count ?? '-'}|${r.views ?? '-'}|${one(r.description ?? r.caption, 160)}|${r.url}`,
        )
        .join('\n'),
    )
  },
)

server.registerTool(
  'update',
  {
    description:
      'Starts an update: reads posts and comments, sorts the comments, writes a report. Read-only and slow on purpose; networks you are signed in to keep the gap set in Settings. Returns the run id for run_status.',
    inputSchema: {
      brand: z.string().optional().describe('All brands when empty'),
      networks: z.array(network).default(['instagram', 'facebook', 'tiktok']),
      range: z
        .enum(['new', 'all'])
        .default('new')
        .describe('new: posts since the last update; all: the latest posts again'),
      limit: z.number().int().min(1).max(50).default(5),
    },
  },
  async ({ brand, networks, range, limit }) => {
    const id = await brandId(brand)
    const brandIds = id ? [id] : (await call<Brand[]>('GET', '/api/brands')).map((b) => b.id)
    const r = await call<{ id: number }>('POST', '/api/runs', { brandIds, networks, range, limit })
    return text(
      `Update ${r.id} started. Check it with run_status; it takes a few minutes per network.`,
    )
  },
)

server.registerTool(
  'run_status',
  {
    description: 'Status and the last log lines of an update (the latest when no id).',
    inputSchema: { id: z.number().int().optional() },
  },
  async ({ id }) => {
    const runId = id ?? (await call<{ id: number }[]>('GET', '/api/runs'))[0]?.id
    if (!runId) return text('No updates yet.')
    const r = await call<{ id: number; status: string; log: string }>('GET', `/api/runs/${runId}`)
    return text(`Update ${r.id}: ${r.status}\n${r.log.trim().split('\n').slice(-12).join('\n')}`)
  },
)

server.registerTool(
  'report',
  {
    description:
      'The Markdown report of an update (the latest finished one when no id): what was read, what needs an answer, the mood.',
    inputSchema: { id: z.number().int().optional() },
  },
  async ({ id }) => {
    let runId = id
    if (!runId)
      runId = (await call<{ id: number; status: string }[]>('GET', '/api/runs')).find(
        (r) => r.status !== 'running',
      )?.id
    if (!runId) return text('No finished updates yet.')
    const r = await call<{ report: string | null; status: string }>('GET', `/api/runs/${runId}`)
    return text(r.report ?? `Update ${runId} is ${r.status}; no report yet.`)
  },
)

server.registerTool(
  'relabel',
  {
    description: "Corrects the AI: sets a comment's label and whether it needs a reply.",
    inputSchema: {
      id: z.number().int(),
      label,
      needs_reply: z.boolean(),
      reason: z.string().max(120).optional(),
    },
  },
  async ({ id, label, needs_reply, reason }) => {
    await call('PATCH', `/api/comments/${id}`, {
      label,
      needs_reply,
      reason: reason ?? 'Set by hand.',
    })
    return text(`Comment ${id}: ${label}${needs_reply ? ', needs a reply' : ''}.`)
  },
)

server.registerTool(
  'kinds',
  {
    description:
      'A brand\'s positive and negative kinds of comment, as lines "key|sentiment|name". Use the keys with rate.',
    inputSchema: { brand: z.string() },
  },
  async ({ brand }) => {
    const id = await brandId(brand)
    const b = (await call<(Brand & { categories: string })[]>('GET', '/api/brands')).find(
      (x) => x.id === id,
    )!
    const cats = JSON.parse(b.categories || '[]') as {
      key: string
      name: string
      sentiment: string
    }[]
    return text(
      cats.length
        ? cats.map((c) => `${c.key}|${c.sentiment}|${c.name}`).join('\n')
        : 'No kinds set for this brand.',
    )
  },
)

server.registerTool(
  'rate',
  {
    description:
      'Rates comments as Claude: positive or negative with a kind (a key from kinds), or neutral for an ordinary comment that counts neither way. sentiment null clears it. Rate only what the text supports.',
    inputSchema: {
      ids: z.array(z.number().int()).min(1).max(200),
      sentiment: z.enum(['positive', 'negative', 'neutral']).nullable(),
      kind: z.string().optional().describe('A key from the kinds tool'),
    },
  },
  async ({ ids, sentiment, kind }) => {
    const r = await call<{ updated: number }>('POST', '/api/comments/sentiment', {
      ids,
      sentiment,
      category: kind ?? null,
      by: 'ai',
    })
    return text(
      `${r.updated} comments ${sentiment ? `rated ${sentiment}${kind ? ` (${kind})` : ''}` : 'cleared'}.`,
    )
  },
)

server.registerTool(
  'add_brand',
  {
    description: 'Adds a brand to watch, with its Instagram, Facebook and TikTok profile links.',
    inputSchema: { name: z.string().min(1), links: z.array(z.string().url()).min(1) },
  },
  async ({ name, links }) => {
    const b = await call<{ id: number }>('POST', '/api/brands', { name, links })
    return text(`${name} added (id ${b.id}). Run update to read it.`)
  },
)

server.registerTool(
  'schedules',
  {
    description:
      'Lists schedules, or sets one: every N hours, or at times of day ("09:00"). Updates are manual unless a schedule exists.',
    inputSchema: {
      action: z.enum(['list', 'set', 'delete']).default('list'),
      id: z.number().int().optional().describe('For set (to edit) and delete'),
      brand: z.string().optional(),
      every_hours: z.number().min(1).max(168).optional(),
      times: z.array(z.string().regex(/^\d\d:\d\d$/)).optional(),
      networks: z.array(network).default(['instagram', 'facebook', 'tiktok']),
      enabled: z.boolean().default(true),
    },
  },
  async ({ action, id, brand, every_hours, times, networks, enabled }) => {
    if (action === 'delete') {
      if (!id) throw new Error('Give the schedule id.')
      await call('DELETE', `/api/schedules/${id}`)
      return text(`Schedule ${id} deleted.`)
    }
    if (action === 'set') {
      const b = await brandId(brand)
      if (!b) throw new Error('Name the brand.')
      const body = {
        brand_id: b,
        kind: times?.length ? 'times' : 'interval',
        every_hours: every_hours ?? 24,
        times,
        networks,
        range: 'new',
        enabled,
      }
      const s = await call<{ id: number }>(
        id ? 'PUT' : 'POST',
        id ? `/api/schedules/${id}` : '/api/schedules',
        body,
      )
      return text(`Schedule ${s.id} saved.`)
    }
    const rows = await call<
      {
        id: number
        brand_id: number
        kind: string
        every_hours: number | null
        times: string[]
        networks: string[]
        enabled: number
        next_run_at: string | null
      }[]
    >('GET', '/api/schedules')
    if (!rows.length) return text('No schedules: updates are manual.')
    return text(
      rows
        .map(
          (s) =>
            `${s.id}|brand ${s.brand_id}|${s.kind === 'interval' ? `every ${s.every_hours}h` : `at ${s.times.join(', ')}`}|${s.networks.join(',')}|${s.enabled ? `next ${day(s.next_run_at)}` : 'paused'}`,
        )
        .join('\n'),
    )
  },
)

await server.connect(new StdioServerTransport())
