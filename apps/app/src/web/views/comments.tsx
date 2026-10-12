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
            {c.label && (
              <span class={`sm-label sm-label--${c.label}`}>
                {LABEL_NAME[c.label]}
                {c.needs_reply ? ' · reply' : ''}
              </span>
            )}
          </div>
          <p class="sm-comment__text">{c.text}</p>
          {c.reason && <p class="sm-comment__reason">{c.reason}</p>}
          <div class="sm-comment__actions">
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

export function Comments({ brands, brandId, running }: AppState) {
  const [filter, setFilter] = useState<Filter>(() =>
    sessionStorage.getItem('sm-post') ? 'all' : 'reply',
  )
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
    const t = setTimeout(() => {
      api
        .get<CommentRow[]>(`/api/comments?${p}`)
        .then(setRows)
        .catch(() => setRows([]))
    }, 200)
    return () => clearTimeout(t)
  }, [brandId, filter, network, q, running, postId, tick])

  const query = new URLSearchParams()
  if (brandId) query.set('brand', String(brandId))
  if (network) query.set('network', network)
  if (filter === 'reply') query.set('reply', '1')
  else if (filter !== 'all') query.set('label', filter)
  if (q.trim()) query.set('q', q.trim())

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
      {rows === null ? null : rows.length ? (
        <CommentList comments={rows} brands={brands} onChange={() => setTick((t) => t + 1)} />
      ) : (
        <Empty title="No comments match.">
          Change the filter, or press Update to read new ones.
        </Empty>
      )}
    </div>
  )
}
