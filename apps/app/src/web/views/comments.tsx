import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { BrandRow, CommentRow, PostRow } from '../api.ts'
import { api } from '../api.ts'
import {
  Empty,
  Icon,
  Menu,
  NETWORK_NAME,
  NetworkMark,
  Segmented,
  ago,
  count,
  when,
} from '../ui.tsx'
import { lang, t } from '../i18n.ts'
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
  wide = false,
}: {
  comments: CommentRow[]
  brands: BrandRow[]
  onChange?: () => void
  /** Room to spare: actions show as buttons instead of a menu. */
  wide?: boolean
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

  // Translations and drafted replies, shown under the comment they belong to.
  const [extra, setExtra] = useState<
    Record<number, { kind: 'translation' | 'draft'; text: string }>
  >({})
  const [busy, setBusy] = useState<number | null>(null)
  const ask = async (c: CommentRow, kind: 'translation' | 'draft') => {
    setBusy(c.id)
    try {
      const r = await api.post<{ translation?: string; draft?: string }>(
        `/api/comments/${c.id}/${kind === 'translation' ? 'translate' : 'draft'}`,
        { lang },
      )
      setExtra((x) => ({ ...x, [c.id]: { kind, text: (r.translation ?? r.draft)! } }))
    } catch (e) {
      setExtra((x) => ({ ...x, [c.id]: { kind, text: (e as Error).message } }))
    } finally {
      setBusy(null)
    }
  }

  const mark = async (c: CommentRow, reply_status: 'done' | 'ignored' | 'open') => {
    await api.patch(`/api/comments/${c.id}`, { reply_status })
    onChange?.()
  }

  const one = (c: CommentRow, reply = false) => {
    const brand = brands.find((b) => b.id === c.brand_id)
    const own = handles.get(c.brand_id)?.includes(c.author.toLowerCase())
    const edit = brand?.my_role === 'admin'
    return (
      <article class={`sm-c${reply ? ' sm-c--reply' : ''}${own ? ' sm-c--own' : ''}`}>
        <span class={`sm-c__face sm-face--${own ? 'own' : hue(c.author)}`} aria-hidden="true">
          {initials(c.author)}
        </span>
        <div class="sm-c__body">
          <header class="sm-c__meta">
            <span class="sm-c__author">{own ? `${brand?.name ?? c.author}` : c.author}</span>
            {own && <span class="sm-c__own">{t('Brand reply')}</span>}
            <NetworkMark network={c.network} size={13} />
            <span>{ago(c.posted_at)}</span>
            {c.likes ? <span class="g-num">{count(c.likes, 'like')}</span> : null}
            {c.label && !own && (
              <LabelPill label={c.label} reply={c.needs_reply === 1 && c.reply_status === 'open'} />
            )}
          </header>
          <p class="sm-c__text">{c.text}</p>
          {c.reason && !own && (
            <p class="sm-c__reason">{t('AI: {reason}', { reason: c.reason })}</p>
          )}
          {(extra[c.id] || (lang === 'en' && c.translation)) && (
            <p class={`sm-c__extra${extra[c.id]?.kind === 'draft' ? ' sm-c__extra--draft' : ''}`}>
              <b>{extra[c.id]?.kind === 'draft' ? t('Draft reply') : t('Translation')}</b>{' '}
              {extra[c.id]?.text ?? c.translation}
              {extra[c.id]?.kind === 'draft' && (
                <button
                  class="sm-textbtn"
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(extra[c.id]!.text)}
                >
                  {t('Copy')}
                </button>
              )}
            </p>
          )}
          {!own && (
            <footer class="sm-c__actions">
              {edit && (
                <Rate
                  key={`${c.id}-${c.sentiment}-${c.category}`}
                  comment={c}
                  brand={brand}
                  onChange={onChange}
                />
              )}
              <span class="sm-c__links">
                {edit && c.needs_reply === 1 && c.reply_status === 'open' && (
                  <button
                    class="g-btn g-btn--sm sm-btn-answered"
                    type="button"
                    onClick={() => mark(c, 'done')}
                  >
                    {t('Answered')}
                  </button>
                )}
                {c.reply_status !== 'open' && c.needs_reply === 1 && (
                  <span class={`sm-badge ${c.reply_status === 'done' ? 'sm-badge--green' : ''}`}>
                    {c.reply_status === 'done' ? t('Answered') : t('Skipped')}
                  </span>
                )}
                {wide ? (
                  [
                    ...(!(lang === 'en' && c.translation) && !extra[c.id]
                      ? [
                          {
                            label: t('Translate'),
                            onSelect: () => ask(c, 'translation'),
                            disabled: busy === c.id,
                          },
                        ]
                      : []),
                    ...(edit
                      ? [
                          {
                            label: t('Draft a reply'),
                            onSelect: () => ask(c, 'draft'),
                            disabled: busy === c.id,
                          },
                        ]
                      : []),
                    ...(edit && c.needs_reply === 1 && c.reply_status === 'open'
                      ? [{ label: t('Skip'), onSelect: () => mark(c, 'ignored') }]
                      : []),
                    ...(edit && c.needs_reply === 1 && c.reply_status !== 'open'
                      ? [{ label: t('undo'), onSelect: () => mark(c, 'open') }]
                      : []),
                    {
                      label: t('Open the post'),
                      onSelect: () => open(c.post_url, '_blank', 'noreferrer'),
                    },
                    {
                      label: t('Copy the text'),
                      onSelect: () => navigator.clipboard?.writeText(c.text),
                    },
                  ].map((it) => (
                    <button
                      class="g-btn g-btn--ghost g-btn--sm"
                      type="button"
                      disabled={it.disabled}
                      onClick={it.onSelect}
                    >
                      {it.label}
                    </button>
                  ))
                ) : (
                  <Menu
                    label={t('More actions')}
                    items={[
                      ...(!(lang === 'en' && c.translation) && !extra[c.id]
                        ? [
                            {
                              label: t('Translate'),
                              onSelect: () => ask(c, 'translation'),
                              disabled: busy === c.id,
                            },
                          ]
                        : []),
                      ...(edit
                        ? [
                            {
                              label: t('Draft a reply'),
                              onSelect: () => ask(c, 'draft'),
                              disabled: busy === c.id,
                            },
                          ]
                        : []),
                      ...(edit && c.needs_reply === 1 && c.reply_status === 'open'
                        ? [{ label: t('Skip'), onSelect: () => mark(c, 'ignored') }]
                        : []),
                      ...(edit && c.needs_reply === 1 && c.reply_status !== 'open'
                        ? [{ label: t('undo'), onSelect: () => mark(c, 'open') }]
                        : []),
                      {
                        label: t('Open the post'),
                        onSelect: () => open(c.post_url, '_blank', 'noreferrer'),
                      },
                      {
                        label: t('Copy the text'),
                        onSelect: () => navigator.clipboard?.writeText(c.text),
                      },
                    ]}
                  />
                )}
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
    const timer = setTimeout(() => {
      api
        .get<CommentRow[]>(`/api/comments?${p}`)
        .then(setRows)
        .catch(() => setRows([]))
    }, 150)
    return () => clearTimeout(timer)
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
    setTick((x) => x + 1)
    notify(t('{n} updated.', { n: count(changed, 'comment') }))
    return t(
      'Saved {n}. Editable: label, needs_reply, reply_status, reason, sentiment, category.',
      { n: changed },
    )
  }

  return (
    <div class="sm-stack">
      <div class="sm-toolbar">
        <Segmented<Filter>
          label={t('Show')}
          value={filter}
          onChange={setFilter}
          options={[
            ['all', t('All')],
            ['reply', t('To answer')],
            ['complaint', t('Complaints')],
            ['question', t('Questions')],
            ['praise', t('Praise')],
          ]}
        />
        <select
          class="g-select sm-select-sm"
          value={sentiment}
          aria-label={t('Positive or negative')}
          onChange={(e) => {
            setSentiment((e.target as HTMLSelectElement).value)
            setCategory('')
          }}
        >
          <option value="">{t('Rated or not')}</option>
          <option value="positive">{t('Positive')}</option>
          <option value="negative">{t('Negative')}</option>
          <option value="neutral">{t('Neutral')}</option>
          <option value="none">{t('Not rated yet')}</option>
        </select>
        {(sentiment === 'positive' || sentiment === 'negative') && cats.length > 0 && (
          <select
            class="g-select sm-select-sm"
            value={category}
            aria-label={t('Kind')}
            onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}
          >
            <option value="">{t('Every kind')}</option>
            {cats.map((c) => (
              <option value={c.key}>{c.name}</option>
            ))}
          </select>
        )}
        <input
          class="g-input sm-search"
          type="search"
          placeholder={t('Search the comments')}
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <a class="sm-textbtn sm-toolbar__end" href={`/api/comments.csv?${qs}`} download>
          {t('Download CSV')}
        </a>
      </div>

      {postId && (
        <p class="sm-quiet">
          {t('Comments under one post.')}{' '}
          <button
            class="sm-textbtn"
            type="button"
            onClick={() => {
              sessionStorage.removeItem('sm-post')
              setPostId(null)
            }}
          >
            {t('Show every post')}
          </button>
        </p>
      )}

      {mode === 'json' && rows ? (
        <JsonPanel
          value={compact}
          onSave={saveJson}
          note={t('Edit label, reply_status, sentiment or category, then save.')}
        />
      ) : rows === null ? null : rows.length ? (
        <Inbox rows={rows} brands={brands} onChange={() => setTick((x) => x + 1)} />
      ) : (
        <Empty title={t('No comments match.')}>
          {t('Change the filters, or press Update to read new ones.')}
        </Empty>
      )}
    </div>
  )
}

/**
 * The comments as an inbox: a list on the left, the chosen comment on the right with its post,
 * its replies and everything you can do with it. Up and down arrows move through the list.
 */
function Inbox({
  rows,
  brands,
  onChange,
}: {
  rows: CommentRow[]
  brands: BrandRow[]
  onChange: () => void
}) {
  const roots = rows.filter(
    (c) => !c.parent_ext_id || !rows.some((r) => r.ext_id === c.parent_ext_id),
  )
  const [sel, setSel] = useState<number | null>(roots[0]?.id ?? null)
  const [posts, setPosts] = useState<Map<number, PostRow>>(new Map())
  const current = roots.find((c) => c.id === sel) ?? roots[0]
  const brand = brands.find((b) => b.id === current?.brand_id)
  const handles = brand?.profiles.map((p) => p.handle.toLowerCase()) ?? []
  const own = (c: CommentRow) => handles.includes(c.author.toLowerCase())

  useEffect(() => {
    if (!brand) return
    api
      .get<PostRow[]>(`/api/posts?brand=${brand.id}&limit=500`)
      .then((list) => setPosts(new Map(list.map((p) => [p.id, p]))))
      .catch(() => {})
  }, [brand?.id])

  const step = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = roots.findIndex((c) => c.id === current?.id)
    const next =
      roots[Math.min(roots.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      setSel(next.id)
      document.getElementById(`sm-row-${next.id}`)?.scrollIntoView({ block: 'nearest' })
    }
  }

  const post = current ? posts.get(current.post_id) : undefined
  return (
    <div class="sm-inbox">
      <section class="sm-box sm-inbox__list">
        <header class="sm-box__head">
          <h2>{count(roots.length, 'comment')}</h2>
          <span class="sm-box__meta">{t('↑ ↓ to move')}</span>
        </header>
        <ul role="listbox" tabIndex={0} aria-label={t('Comments')} onKeyDown={step}>
          {roots.map((c) => {
            const replies = rows.filter((r) => r.parent_ext_id === c.ext_id)
            const answered = replies.some(own)
            return (
              <li
                id={`sm-row-${c.id}`}
                role="option"
                aria-selected={c.id === current?.id}
                class="sm-inbox__row"
                onClick={() => setSel(c.id)}
              >
                <span class={`sm-c__face sm-face--${hue(c.author)}`} aria-hidden="true">
                  {initials(c.author)}
                </span>
                <span class="sm-inbox__main">
                  <span class="sm-inbox__top">
                    <b>{c.author}</b>
                    <NetworkMark network={c.network} size={12} />
                    <span class="sm-inbox__when">{ago(c.posted_at)}</span>
                  </span>
                  <span class="sm-inbox__text">{c.text}</span>
                  <span class="sm-inbox__tags">
                    {c.label && <LabelPill label={c.label} />}
                    {c.sentiment === 'negative' && (
                      <span class="sm-badge sm-badge--red">{t('Negative')}</span>
                    )}
                    {c.sentiment === 'positive' && (
                      <span class="sm-badge sm-badge--green">{t('Positive')}</span>
                    )}
                    {c.needs_reply === 1 && c.reply_status === 'open' && !answered && (
                      <span class="sm-badge sm-badge--amber">{t('To answer')}</span>
                    )}
                    {(answered || c.reply_status === 'done') && (
                      <span class="sm-badge sm-badge--blue">{t('Answered')}</span>
                    )}
                    {replies.length > 0 && (
                      <span class="sm-inbox__n">{count(replies.length, 'comment')}</span>
                    )}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      {current && (
        <section class="sm-box sm-inbox__detail">
          <header class="sm-box__head">
            <h2>{current.author}</h2>
            <a
              class="g-btn g-btn--ghost g-btn--sm"
              href={current.post_url}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="external" size={14} /> {t('Open the post')}
            </a>
          </header>
          {post && (
            <a class="sm-inbox__post" href={post.url} target="_blank" rel="noreferrer">
              {post.thumb_url ? (
                <img src={post.thumb_url} alt="" />
              ) : (
                <span class="sm-postcell__blank" />
              )}
              <span>
                <span class="sm-inbox__postmeta">
                  <NetworkMark network={post.network} size={12} /> {when(post.posted_at)} ·{' '}
                  {count(post.likes, 'like')} · {count(post.comments_count, 'comment')}
                </span>
                <span class="sm-inbox__caption">{post.description ?? post.caption}</span>
              </span>
            </a>
          )}
          <CommentList
            wide
            comments={rows.filter((r) => r.id === current.id || r.parent_ext_id === current.ext_id)}
            brands={brands}
            onChange={onChange}
          />
          {(() => {
            const more = rows.filter(
              (r) => r.author.toLowerCase() === current.author.toLowerCase() && r.id !== current.id,
            )
            return more.length ? (
              <div class="sm-inbox__more">
                <h3 class="sm-box__sub">{t('More from {name}', { name: current.author })}</h3>
                <ul>
                  {more.map((m) => (
                    <li>
                      <button type="button" class="sm-inbox__morebtn" onClick={() => setSel(m.id)}>
                        <span class="sm-inbox__when">{ago(m.posted_at)}</span>
                        <span>{m.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          })()}
        </section>
      )}

      {current && (
        <aside class="sm-inbox__details" aria-label={t('Details')}>
          <h3 class="sm-attr__title">{t('Person')}</h3>
          <dl class="sm-attr">
            <dt>{t('Name')}</dt>
            <dd>{current.author}</dd>
            <dt>{t('Network')}</dt>
            <dd>
              <span class="sm-net-name">
                <NetworkMark network={current.network} size={12} /> {NETWORK_NAME[current.network]}
              </span>
            </dd>
            <dt>{t('Comments')}</dt>
            <dd class="g-num">
              {rows.filter((r) => r.author.toLowerCase() === current.author.toLowerCase()).length}
            </dd>
          </dl>
          <h3 class="sm-attr__title">{t('This comment')}</h3>
          <dl class="sm-attr">
            <dt>{t('Written')}</dt>
            <dd>{when(current.posted_at)}</dd>
            <dt>{t('Likes')}</dt>
            <dd class="g-num">{current.likes ?? 0}</dd>
            <dt>{t('Type')}</dt>
            <dd>{current.label ? <LabelPill label={current.label} /> : '–'}</dd>
            <dt>{t('Rating')}</dt>
            <dd>
              {current.sentiment === 'negative' ? (
                <span class="sm-badge sm-badge--red">{t('Negative')}</span>
              ) : current.sentiment === 'positive' ? (
                <span class="sm-badge sm-badge--green">{t('Positive')}</span>
              ) : current.sentiment === 'neutral' ? (
                <span class="sm-badge">{t('Neutral')}</span>
              ) : (
                t('Not rated yet')
              )}
            </dd>
            <dt>{t('Kind')}</dt>
            <dd>{brandCategories(brand).find((k) => k.key === current.category)?.name ?? '–'}</dd>
            <dt>{t('Answer')}</dt>
            <dd>
              {current.reply_status === 'done' ||
              rows.some((r) => r.parent_ext_id === current.ext_id && own(r)) ? (
                <span class="sm-badge sm-badge--blue">{t('Answered')}</span>
              ) : current.needs_reply === 1 && current.reply_status === 'open' ? (
                <span class="sm-badge sm-badge--amber">{t('To answer')}</span>
              ) : current.reply_status === 'ignored' ? (
                t('Skipped')
              ) : (
                t('Not needed')
              )}
            </dd>
          </dl>
          {post && (
            <>
              <h3 class="sm-attr__title">{t('Post')}</h3>
              <dl class="sm-attr">
                <dt>{t('Published')}</dt>
                <dd>{when(post.posted_at)}</dd>
                <dt>{t('Likes')}</dt>
                <dd class="g-num">{post.likes ?? '–'}</dd>
                <dt>{t('Comments')}</dt>
                <dd class="g-num">{post.comments_count ?? '–'}</dd>
                <dt>{t('Views')}</dt>
                <dd class="g-num">{post.views ?? '–'}</dd>
              </dl>
            </>
          )}
        </aside>
      )}
    </div>
  )
}
