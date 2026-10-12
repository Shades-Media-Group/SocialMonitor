import { useEffect, useState } from 'preact/hooks'
import type { AppState } from '../app.tsx'
import type { BrandRow, CommentRow, Network } from '../api.ts'
import { api } from '../api.ts'
import { Empty, NetworkMark, Segmented, ago } from '../ui.tsx'

const LABEL_NAME: Record<string, string> = {
  complaint: 'Complaint',
  question: 'Question',
  praise: 'Praise',
  suggestion: 'Suggestion',
  neutral: 'Neutral',
  spam: 'Spam',
}

export function CommentList({ comments, brands }: { comments: CommentRow[]; brands: BrandRow[] }) {
  const many = brands.length > 1
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
            {c.label && (
              <span class={`sm-label sm-label--${c.label}`}>
                {LABEL_NAME[c.label]}
                {c.needs_reply ? ' · reply' : ''}
              </span>
            )}
          </div>
          <p class="sm-comment__text">{c.text}</p>
          {c.reason && <p class="sm-comment__reason">{c.reason}</p>}
          <a class="g-link sm-comment__post" href={c.post_url} target="_blank" rel="noreferrer">
            Open the post
          </a>
        </li>
      ))}
    </ul>
  )
}

type Filter = 'reply' | 'complaint' | 'question' | 'praise' | 'all'

export function Comments({ brands, brandId, running }: AppState) {
  const [filter, setFilter] = useState<Filter>('reply')
  const [network, setNetwork] = useState<Network | ''>('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CommentRow[] | null>(null)

  useEffect(() => {
    const p = new URLSearchParams({ limit: '200' })
    if (brandId) p.set('brand', String(brandId))
    if (network) p.set('network', network)
    if (filter === 'reply') p.set('reply', '1')
    else if (filter !== 'all') p.set('label', filter)
    if (q.trim()) p.set('q', q.trim())
    const t = setTimeout(() => {
      api
        .get<CommentRow[]>(`/api/comments?${p}`)
        .then(setRows)
        .catch(() => setRows([]))
    }, 200)
    return () => clearTimeout(t)
  }, [brandId, filter, network, q, running])

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
        <input
          class="g-input sm-search"
          type="search"
          placeholder="Search comments"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
      </div>
      {rows === null ? null : rows.length ? (
        <CommentList comments={rows} brands={brands} />
      ) : (
        <Empty title="No comments match.">
          Change the filter, or press Update to read new ones.
        </Empty>
      )}
    </div>
  )
}
