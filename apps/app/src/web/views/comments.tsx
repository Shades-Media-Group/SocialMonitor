import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { BrandRow, CommentRow } from '../api.ts'
import { api } from '../api.ts'
import { Empty, NetworkMark, Segmented, ago } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import { LabelPill } from '../labels.tsx'
import { Rate, brandCategories } from '../rate.tsx'

// Initials sit on one of Gradient's ramps, chosen by the author's name: the same person keeps
// the same colour everywhere, and a thread reads at a glance.
const HUES = ['blue', 'violet', 'pink', 'orange', 'amber', 'green'] as const
const hue = (name: string) =>
  HUES[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % HUES.length]!
const initials = (name: string) =>
  name
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 2)
    .toUpperCase() || '?'

/**
 * Comments as threads: a comment, then the replies under it, with the brand's own answers
 * marked. Answered / Skip clear the reply queue; Positive / Negative and the kind are the
 * person's (or Claude's) own reading of the comment.
 */
export function CommentList({
  comments,
  brands,
  onChange,
}: {
  comments: CommentRow[]
  brands: BrandRow[]
  onChange?: () => void
}) {
  const handles = new Map<number, string[]>(
    brands.map((b) => [b.id, b.profiles.map((p) => p.handle.toLowerCase())]),
  )
  const ids = new Set(comments.map((c) => c.ext_id))
  const children = new Map<string, CommentRow[]>()
  for (const c of comments)
    if (c.parent_ext_id && ids.has(c.parent_ext_id))
      children.set(c.parent_ext_id, [...(children.get(c.parent_ext_id) ?? []), c])
  const roots = comments.filter((c) => !c.parent_ext_id || !ids.has(c.parent_ext_id))

  const mark = async (c: CommentRow, reply_status: 'done' | 'ignored' | 'open') => {
    await api.patch(`/api/comments/${c.id}`, { reply_status })
    onChange?.()
  }

  const one = (c: CommentRow, reply = false) => {
    const brand = brands.find((b) => b.id === c.brand_id)
    const own = handles.get(c.brand_id)?.includes(c.author.toLowerCase())
    return (
      <article class={`sm-c${reply ? ' sm-c--reply' : ''}${own ? ' sm-c--own' : ''}`}>
        <span class={`sm-c__face sm-face--${own ? 'own' : hue(c.author)}`} aria-hidden="true">
          {initials(c.author)}
        </span>
        <div class="sm-c__body">
          <header class="sm-c__meta">
            <span class="sm-c__author">{own ? `${brand?.name ?? c.author}` : c.author}</span>
            {own && <span class="sm-c__own">Brand reply</span>}
            <NetworkMark network={c.network} size={13} />
            <span>{ago(c.posted_at)}</span>
            {c.likes ? <span class="g-num">{c.likes} likes</span> : null}
            {c.label && !own && (
              <LabelPill label={c.label} reply={c.needs_reply === 1 && c.reply_status === 'open'} />
            )}
          </header>
          <p class="sm-c__text">{c.text}</p>
          {c.reason && !own && <p class="sm-c__reason">AI: {c.reason}</p>}
          {!own && (
            <footer class="sm-c__actions">
              <Rate
                key={`${c.id}-${c.sentiment}-${c.category}`}
                comment={c}
                brand={brand}
                onChange={onChange}
              />
              <span class="sm-c__links">
                {c.needs_reply === 1 &&
                  (c.reply_status === 'open' ? (
                    <>
                      <button class="sm-textbtn" type="button" onClick={() => mark(c, 'done')}>
                        Answered
                      </button>
                      <button class="sm-textbtn" type="button" onClick={() => mark(c, 'ignored')}>
                        Skip
                      </button>
                    </>
                  ) : (
                    <button class="sm-textbtn" type="button" onClick={() => mark(c, 'open')}>
                      {c.reply_status === 'done' ? 'Answered' : 'Skipped'} · undo
                    </button>
                  ))}
                <a class="sm-textbtn" href={c.post_url} target="_blank" rel="noreferrer">
                  Open the post
                </a>
              </span>
            </footer>
          )}
        </div>
      </article>
    )
  }

  return (
    <ul class="sm-thread">
      {roots.map((c) => (
        <li>
          {one(c)}
          {(children.get(c.ext_id) ?? []).map((r) => one(r, true))}
        </li>
      ))}
    </ul>
  )
}

type Filter = 'all' | 'reply' | 'complaint' | 'question' | 'praise'

export function Comments({ brand, network, version, mode, notify, brands }: BrandView) {
  const [filter, setFilter] = useState<Filter>('all')
  const [sentiment, setSentiment] = useState('')
  const [category, setCategory] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CommentRow[] | null>(null)
  const [postId, setPostId] = useState(() => sessionStorage.getItem('sm-post'))
  const [tick, setTick] = useState(0)

  const query = new URLSearchParams({ brand: String(brand.id) })
  if (network) query.set('network', network)
  if (filter === 'reply') query.set('reply', '1')
  else if (filter !== 'all') query.set('label', filter)
  if (q.trim()) query.set('q', q.trim())
  if (sentiment) query.set('sentiment', sentiment)
  if (category) query.set('category', category)
  const qs = query.toString()

  useEffect(() => {
    const p = new URLSearchParams(qs)
    p.set('limit', '300')
    if (postId) p.set('post', postId)
    const t = setTimeout(() => {
      api
        .get<CommentRow[]>(`/api/comments?${p}`)
        .then(setRows)
        .catch(() => setRows([]))
    }, 150)
    return () => clearTimeout(t)
  }, [qs, postId, version, tick])

  const cats = brandCategories(brand).filter((c) => !sentiment || c.sentiment === sentiment)
  const compact = (rows ?? []).map((c) => ({
    id: c.id,
    network: c.network,
    author: c.author,
    text: c.text,
    likes: c.likes,
    posted_at: c.posted_at,
    reply_to: c.parent_ext_id,
    label: c.label,
    needs_reply: c.needs_reply === 1,
    reply_status: c.reply_status,
    reason: c.reason,
    sentiment: c.sentiment,
    category: c.category,
    post_url: c.post_url,
  }))

  const saveJson = async (next: unknown) => {
    if (!Array.isArray(next)) throw new Error('Expected a list of comments.')
    const before = new Map(compact.map((c) => [c.id, c]))
    let changed = 0
    for (const n of next as typeof compact) {
      const o = before.get(n.id)
      if (!o) continue
      let touched = false
      if (n.label !== o.label || n.needs_reply !== o.needs_reply || n.reason !== o.reason) {
        await api.patch(`/api/comments/${n.id}`, {
          label: n.label,
          needs_reply: n.needs_reply,
          reason: n.reason ?? undefined,
        })
        touched = true
      }
      if (n.reply_status !== o.reply_status) {
        await api.patch(`/api/comments/${n.id}`, { reply_status: n.reply_status })
        touched = true
      }
      if (n.sentiment !== o.sentiment || n.category !== o.category) {
        await api.post('/api/comments/sentiment', {
          ids: [n.id],
          sentiment: n.sentiment,
          category: n.category,
          by: 'you',
        })
        touched = true
      }
      if (touched) changed++
    }
    setTick((t) => t + 1)
    notify(`${changed} ${changed === 1 ? 'comment' : 'comments'} updated.`)
    return `Saved ${changed}. Editable: label, needs_reply, reply_status, reason, sentiment, category.`
  }

  return (
    <div class="sm-stack">
      <div class="sm-toolbar">
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            ['all', 'All'],
            ['reply', 'To answer'],
            ['complaint', 'Complaints'],
            ['question', 'Questions'],
            ['praise', 'Praise'],
          ]}
        />
        <select
          class="g-select sm-select-sm"
          value={sentiment}
          aria-label="Positive or negative"
          onChange={(e) => {
            setSentiment((e.target as HTMLSelectElement).value)
            setCategory('')
          }}
        >
          <option value="">Rated or not</option>
          <option value="positive">Positive</option>
          <option value="negative">Negative</option>
          <option value="none">Not rated yet</option>
        </select>
        {(sentiment === 'positive' || sentiment === 'negative') && cats.length > 0 && (
          <select
            class="g-select sm-select-sm"
            value={category}
            aria-label="Kind"
            onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}
          >
            <option value="">Every kind</option>
            {cats.map((c) => (
              <option value={c.key}>{c.name}</option>
            ))}
          </select>
        )}
        <input
          class="g-input sm-search"
          type="search"
          placeholder="Search the comments"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <a class="sm-textbtn sm-toolbar__end" href={`/api/comments.csv?${qs}`} download>
          Download CSV
        </a>
      </div>

      {postId && (
        <p class="sm-quiet">
          Comments under one post.{' '}
          <button
            class="sm-textbtn"
            type="button"
            onClick={() => {
              sessionStorage.removeItem('sm-post')
              setPostId(null)
            }}
          >
            Show every post
          </button>
        </p>
      )}

      {mode === 'json' && rows ? (
        <JsonPanel
          value={compact}
          onSave={saveJson}
          note="Edit label, reply_status, sentiment or category, then save."
        />
      ) : rows === null ? null : rows.length ? (
        <CommentList comments={rows} brands={brands} onChange={() => setTick((t) => t + 1)} />
      ) : (
        <Empty title="No comments match.">
          Change the filters, or press Update to read new ones.
        </Empty>
      )}
    </div>
  )
}
