import { useEffect, useState } from 'preact/hooks'
import type { AppState } from '../app.tsx'
import type { BrandRow, CommentRow, Network } from '../api.ts'
import { api } from '../api.ts'
import { Empty, NetworkMark, Segmented, ago } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import { LabelPill } from '../labels.tsx'
import { Rate, brandCategories } from '../rate.tsx'

export function CommentList({
  comments,
  brands,
  onChange,
}: {
  comments: CommentRow[]
  brands: BrandRow[]
  onChange?: () => void
}) {
  const many = brands.length > 1
  const mark = async (c: CommentRow, reply_status: 'done' | 'ignored' | 'open') => {
    await api.patch(`/api/comments/${c.id}`, { reply_status })
    onChange?.()
  }
  return (
    <ul class="sm-list">
      {comments.map((c) => (
        <li class="sm-comment">
          <div class="sm-comment__meta">
            <NetworkMark network={c.network} />
            <span class="sm-comment__author">{c.author}</span>
            <span>
              {many && `${brands.find((b) => b.id === c.brand_id)?.name ?? ''} · `}
              {ago(c.posted_at)}
              {c.likes ? ` · ${c.likes} likes` : ''}
            </span>
            {c.label && <LabelPill label={c.label} reply={c.needs_reply === 1} />}
          </div>
          <p class="sm-comment__text">{c.text}</p>
          {c.reason && <p class="sm-comment__reason">{c.reason}</p>}
          <div class="sm-comment__actions">
            <Rate comment={c} brand={brands.find((b) => b.id === c.brand_id)} onChange={onChange} />
            <a class="g-link" href={c.post_url} target="_blank" rel="noreferrer">
              Open the post
            </a>
            {c.needs_reply === 1 &&
              (c.reply_status === 'open' ? (
                <>
                  <button class="g-link sm-linkbtn" type="button" onClick={() => mark(c, 'done')}>
                    Answered
                  </button>
                  <button
                    class="g-link sm-linkbtn"
                    type="button"
                    onClick={() => mark(c, 'ignored')}
                  >
                    Skip
                  </button>
                </>
              ) : (
                <button class="g-link sm-linkbtn" type="button" onClick={() => mark(c, 'open')}>
                  {c.reply_status === 'done' ? 'Answered' : 'Skipped'} · undo
                </button>
              ))}
          </div>
        </li>
      ))}
    </ul>
  )
}

type Filter = 'reply' | 'complaint' | 'question' | 'praise' | 'all'

export function Comments({ brands, brandId, running, mode, notify }: AppState) {
  const [filter, setFilter] = useState<Filter>('all')
  const [sentiment, setSentiment] = useState('')
  const [category, setCategory] = useState('')
  const [network, setNetwork] = useState<Network | ''>('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CommentRow[] | null>(null)
  const [postId, setPostId] = useState(() => sessionStorage.getItem('sm-post'))
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const p = new URLSearchParams({ limit: '200' })
    if (postId) p.set('post', postId)
    if (brandId) p.set('brand', String(brandId))
    if (network) p.set('network', network)
    if (filter === 'reply') p.set('reply', '1')
    else if (filter !== 'all') p.set('label', filter)
    if (q.trim()) p.set('q', q.trim())
    if (sentiment) p.set('sentiment', sentiment)
    if (category) p.set('category', category)
    const t = setTimeout(() => {
      api
        .get<CommentRow[]>(`/api/comments?${p}`)
        .then(setRows)
        .catch(() => setRows([]))
    }, 200)
    return () => clearTimeout(t)
  }, [brandId, filter, network, q, running, postId, tick, sentiment, category])

  const query = new URLSearchParams()
  if (brandId) query.set('brand', String(brandId))
  if (network) query.set('network', network)
  if (filter === 'reply') query.set('reply', '1')
  else if (filter !== 'all') query.set('label', filter)
  if (q.trim()) query.set('q', q.trim())
  if (sentiment) query.set('sentiment', sentiment)
  if (category) query.set('category', category)

  const compact = (rows ?? []).map((c) => ({
    id: c.id,
    network: c.network,
    author: c.author,
    text: c.text,
    likes: c.likes,
    posted_at: c.posted_at,
    label: c.label,
    needs_reply: c.needs_reply === 1,
    reply_status: c.reply_status,
    reason: c.reason,
    sentiment: c.sentiment,
    category: c.category,
    sentiment_by: c.sentiment_by,
    post_url: c.post_url,
  }))
  const saveJson = async (next: unknown) => {
    if (!Array.isArray(next)) throw new Error('Expected a list of comments.')
    const before = new Map(compact.map((c) => [c.id, c]))
    let changed = 0
    for (const n of next as typeof compact) {
      const o = before.get(n.id)
      if (!o) continue
      if (n.label !== o.label || n.needs_reply !== o.needs_reply || n.reason !== o.reason)
        await api.patch(`/api/comments/${n.id}`, {
          label: n.label,
          needs_reply: n.needs_reply,
          reason: n.reason ?? undefined,
        })
      if (n.reply_status !== o.reply_status)
        await api.patch(`/api/comments/${n.id}`, { reply_status: n.reply_status })
      if (
        n.label !== o.label ||
        n.needs_reply !== o.needs_reply ||
        n.reason !== o.reason ||
        n.reply_status !== o.reply_status
      )
        changed++
    }
    setTick((t) => t + 1)
    notify(`${changed} ${changed === 1 ? 'comment' : 'comments'} updated.`)
    return `Saved ${changed} changes. Only label, needs_reply, reply_status and reason are saved.`
  }

  return (
    <div class="sm-stack">
      <div class="sm-toolbar">
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            ['reply', 'Need a reply'],
            ['complaint', 'Complaints'],
            ['question', 'Questions'],
            ['praise', 'Praise'],
            ['all', 'All'],
          ]}
        />
        <select
          class="g-select sm-select-sm"
          value={network}
          aria-label="Network"
          onChange={(e) => setNetwork((e.target as HTMLSelectElement).value as Network | '')}
        >
          <option value="">Every network</option>
          <option value="instagram">Instagram</option>
          <option value="facebook">Facebook</option>
          <option value="tiktok">TikTok</option>
        </select>
        <select
          class="g-select sm-select-sm"
          value={sentiment}
          aria-label="Positive or negative"
          onChange={(e) => {
            setSentiment((e.target as HTMLSelectElement).value)
            setCategory('')
          }}
        >
          <option value="">Positive and negative</option>
          <option value="positive">Positive</option>
          <option value="negative">Negative</option>
          <option value="none">Not rated yet</option>
        </select>
        {(sentiment === 'positive' || sentiment === 'negative') && (
          <select
            class="g-select sm-select-sm"
            value={category}
            aria-label="Kind"
            onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}
          >
            <option value="">Every kind</option>
            {(brandId
              ? brandCategories(brands.find((b) => b.id === brandId))
              : brands.flatMap(brandCategories)
            )
              .filter(
                (c, i, a) =>
                  a.findIndex((x) => x.key === c.key) === i &&
                  (!sentiment || c.sentiment === sentiment),
              )
              .map((c) => (
                <option value={c.key}>{c.name}</option>
              ))}
          </select>
        )}
        <input
          class="g-input sm-search"
          type="search"
          placeholder="Search comments"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <a class="g-link sm-toolbar__end" href={`/api/comments.csv?${query}`} download>
          Download as CSV
        </a>
      </div>
      {postId && (
        <p class="sm-quiet">
          Comments on one post.{' '}
          <button
            class="g-link sm-linkbtn"
            type="button"
            onClick={() => {
              sessionStorage.removeItem('sm-post')
              setPostId(null)
            }}
          >
            Show all posts
          </button>
        </p>
      )}
      {mode === 'json' && rows ? (
        <JsonPanel
          value={compact}
          onSave={saveJson}
          note="Edit label, needs_reply, reply_status or reason, then save. Other fields are read-only."
        />
      ) : rows === null ? null : rows.length ? (
        <CommentList comments={rows} brands={brands} onChange={() => setTick((t) => t + 1)} />
      ) : (
        <Empty title="No comments match.">
          Change the filter, or press Update to read new ones.
        </Empty>
      )}
    </div>
  )
}
