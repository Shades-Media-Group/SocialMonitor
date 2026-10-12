import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { BrandRow, CommentRow, PostRow } from '../api.ts'
import { api } from '../api.ts'
import { Icon, Empty, Menu, NetworkMark, Segmented, ago, count } from '../ui.tsx'
import { lang, t } from '../i18n.ts'
import { usePref } from '../prefs.ts'
import { JsonPanel } from '../json.tsx'
import { LABELS } from '../labels.tsx'
import type { IconName } from 'shades-gradient'
import { Rate, brandCategories } from '../rate.tsx'
import { FeedCard, PostDrawer } from '../social.tsx'

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

/** How a comment reads at a glance: trouble, good news, a question, or nothing in particular. */
const mood = (c: CommentRow, own: boolean) =>
  own
    ? 'own'
    : c.sentiment === 'negative' || c.label === 'complaint'
      ? 'bad'
      : c.sentiment === 'positive' || c.label === 'praise'
        ? 'good'
        : c.label === 'question'
          ? 'ask'
          : 'plain'

const LABEL_ICON: Record<string, IconName> = {
  complaint: 'warning',
  question: 'help',
  suggestion: 'sparkle',
  praise: 'favorite',
  neutral: 'remove',
  spam: 'error',
}

/** The small tags that sit on the bubble's lower edge: what kind, how it was rated, the answer. */
function Tags({ c, answered }: { c: CommentRow; answered: boolean }) {
  return (
    <span class="sm-b__tags">
      {c.label && LABELS[c.label] && (
        <span class={`sm-tag sm-tag--${c.label}`}>
          <Icon name={LABEL_ICON[c.label] ?? 'info'} size={11} /> {LABELS[c.label]!.name}
        </span>
      )}
      {c.sentiment === 'negative' && (
        <span class="sm-tag sm-tag--bad">
          <Icon name="arrowDown" size={11} /> {t('Negative')}
        </span>
      )}
      {c.sentiment === 'positive' && (
        <span class="sm-tag sm-tag--good">
          <Icon name="arrowUp" size={11} /> {t('Positive')}
        </span>
      )}
      {answered ? (
        <span class="sm-tag sm-tag--done">
          <Icon name="check" size={11} /> {t('Answered')}
        </span>
      ) : c.needs_reply === 1 && c.reply_status === 'open' ? (
        <span class="sm-tag sm-tag--wait">
          <Icon name="schedule" size={11} /> {t('To answer')}
        </span>
      ) : null}
    </span>
  )
}

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

  const answeredBy = (c: CommentRow) =>
    c.reply_status === 'done' ||
    comments.some(
      (r) =>
        r.parent_ext_id === c.ext_id && handles.get(r.brand_id)?.includes(r.author.toLowerCase()),
    )

  const one = (c: CommentRow, reply = false) => {
    const brand = brands.find((b) => b.id === c.brand_id)
    const own = handles.get(c.brand_id)?.includes(c.author.toLowerCase())
    const edit = brand?.my_role === 'admin'
    return (
      <article class={`sm-b sm-b--${mood(c, !!own)}${reply ? ' sm-b--reply' : ''}`}>
        <span class={`sm-b__avatar sm-face--${own ? 'own' : hue(c.author)}`} aria-hidden="true">
          {initials(c.author)}
          <span class="sm-b__net">
            <NetworkMark network={c.network} size={10} />
          </span>
        </span>
        <div class="sm-c__body sm-b__col">
          <div class="sm-b__bubble">
            <header class="sm-b__meta">
              <b>{own ? `${brand?.name ?? c.author}` : c.author}</b>
              {own && (
                <span class="sm-b__own">
                  <Icon name="success" size={12} /> {t('Brand reply')}
                </span>
              )}
              <span>{ago(c.posted_at)}</span>
              {c.likes ? (
                <span class="sm-b__likes g-num">
                  <Icon name="favorite" size={11} /> {c.likes}
                </span>
              ) : null}
            </header>
            <p class="sm-b__text">{c.text}</p>
          </div>
          {!own && <Tags c={c} answered={answeredBy(c)} />}
          {c.reason && !own && (
            <p class="sm-b__ai">
              <Icon name="sparkle" size={12} /> {c.reason}
            </p>
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
  const [filter, setFilter] = usePref<Filter>('comments.filter', 'all')
  const [sentiment, setSentiment] = usePref('comments.sentiment', '')
  const [category, setCategory] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CommentRow[] | null>(null)
  const [openPost, setOpenPost] = useState<PostRow | null>(null)
  const [look, setLook] = usePref<'list' | 'feed'>('comments.look', 'list')
  const [posts, setPosts] = useState<Map<number, PostRow>>(new Map())
  useEffect(() => {
    api
      .get<PostRow[]>(`/api/posts?brand=${brand.id}&limit=500`)
      .then((list) => setPosts(new Map(list.map((p) => [p.id, p]))))
      .catch(() => {})
  }, [brand.id, version])
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
        <Segmented<'list' | 'feed'>
          label={t('Layout')}
          value={look}
          onChange={setLook}
          options={[
            ['list', t('Comments')],
            ['feed', t('By post')],
          ]}
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
        look === 'feed' ? (
          <div class="sm-feed">
            {[...new Set(rows.map((c) => c.post_id))].map((pid) => {
              const post = posts.get(pid)
              return post ? (
                <FeedCard
                  post={post}
                  comments={rows.filter((c) => c.post_id === pid)}
                  brands={brands}
                  onOpen={setOpenPost}
                  onChange={() => setTick((x) => x + 1)}
                />
              ) : null
            })}
          </div>
        ) : (
          <section class="sm-box sm-box--list">
            <header class="sm-box__head">
              <h2>{count(rows.filter((c) => !c.parent_ext_id).length, 'comment')}</h2>
            </header>
            <CommentList comments={rows} brands={brands} onChange={() => setTick((x) => x + 1)} />
          </section>
        )
      ) : (
        <Empty title={t('No comments match.')}>
          {t('Change the filters, or press Update to read new ones.')}
        </Empty>
      )}
      <PostDrawer post={openPost} brands={brands} onClose={() => setOpenPost(null)} />
    </div>
  )
}
