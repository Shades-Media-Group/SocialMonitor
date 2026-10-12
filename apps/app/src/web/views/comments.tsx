import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { IconName } from 'shades-gradient'
import type { BrandView } from '../app.tsx'
import type { BrandRow, CommentRow, PostRow } from '../api.ts'
import { api } from '../api.ts'
import {
  Icon,
  Empty,
  Menu,
  NETWORK_NAME,
  NetworkMark,
  Scroller,
  Segmented,
  ago,
  count,
  fmt,
  span,
  when,
} from '../ui.tsx'
import { lang, t } from '../i18n.ts'
import { usePref } from '../prefs.ts'
import { JsonPanel } from '../json.tsx'
import { LABELS } from '../labels.tsx'
import { Rate, brandCategories } from '../rate.tsx'
import { CommentDrawer, CommentTable, FeedCard, PostDrawer } from '../social.tsx'

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

/** Each kind of comment has its own icon, so it reads before the word does. */
const KIND_ICON: Record<string, IconName> = {
  complaint: 'warning',
  question: 'help',
  suggestion: 'bolt',
  praise: 'favorite',
  neutral: 'chat',
  spam: 'visibilityOff',
}

function Chip({
  kind,
  icon,
  title,
  children,
}: {
  kind: string
  icon: IconName
  title?: string
  children: ComponentChildren
}) {
  return (
    <span class={`sm-word sm-word--${kind}`} title={title}>
      <Icon name={icon} size={12} />
      {children}
    </span>
  )
}

/**
 * Under the bubble, three questions answered in order: what kind of comment it is, how it
 * feels, and whether it still needs an answer. The AI's one-line reading sits on its own line.
 */
function Tags({
  c,
  answered,
  children,
}: {
  c: CommentRow
  answered: boolean
  children?: ComponentChildren
}) {
  // The mood only adds something when the kind doesn't already say it.
  const mood =
    c.sentiment === 'negative' && c.label !== 'complaint'
      ? 'negative'
      : c.sentiment === 'positive' && c.label !== 'praise'
        ? 'positive'
        : null
  return (
    <div class="sm-b__foot">
      <span class="sm-b__tags">
        {c.label && LABELS[c.label] && (
          <Chip kind={c.label} icon={KIND_ICON[c.label] ?? 'chat'}>
            {LABELS[c.label]!.name}
          </Chip>
        )}
        {mood === 'negative' && (
          <Chip kind="complaint" icon="arrowDown">
            {t('Negative')}
          </Chip>
        )}
        {mood === 'positive' && (
          <Chip kind="praise" icon="arrowUp">
            {t('Positive')}
          </Chip>
        )}
        {c.answered_by === 'brand' ? (
          <Chip kind="done" icon="check" title={when(c.answered_at)}>
            {t('Answered on the network')}
            {c.answered_at &&
              c.posted_at &&
              ` · ${t('{time} later', { time: span(c.posted_at, c.answered_at) })}`}
          </Chip>
        ) : answered ? (
          <Chip kind="done" icon="check">
            {t('Answered')}
          </Chip>
        ) : c.overdue ? (
          <Chip kind="late" icon="schedule">
            {t('Overdue')}
          </Chip>
        ) : c.needs_reply === 1 && c.reply_status === 'open' ? (
          <Chip kind="wait" icon="schedule">
            {t('To answer')}
          </Chip>
        ) : null}
        {c.reason && (
          <span class="sm-b__note" title={t('What the AI understood')}>
            <b>{t('AI')}</b> {c.reason}
          </span>
        )}
        {children}
      </span>
    </div>
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
  const [editing, setEditing] = useState<number | null>(null)
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
    // The avatar and name open the person's profile on the network, in a new tab.
    const Face = c.author_url ? 'a' : 'span'
    const profile = c.author_url ? { href: c.author_url, target: '_blank', rel: 'noreferrer' } : {}
    const profileName = t('Open {name} on {network}', {
      name: c.author,
      network: NETWORK_NAME[c.network],
    })
    // Older updates stored a placeholder where a sticker or picture had no words.
    const text = c.text.trim() === '[sticker or picture]' ? '' : c.text.trim()
    const items = [
      ...(edit && c.needs_reply === 1 && c.reply_status === 'open' && !answeredBy(c)
        ? [{ label: t('Answered'), onSelect: () => mark(c, 'done') }]
        : []),
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
        ? [{ label: t('Draft a reply'), onSelect: () => ask(c, 'draft'), disabled: busy === c.id }]
        : []),
      ...(edit && c.needs_reply === 1 && c.reply_status === 'open'
        ? [{ label: t('Skip'), onSelect: () => mark(c, 'ignored') }]
        : []),
      ...(edit && c.needs_reply === 1 && c.reply_status !== 'open'
        ? [{ label: t('undo'), onSelect: () => mark(c, 'open') }]
        : []),
      { label: t('Open the post'), onSelect: () => open(c.post_url, '_blank', 'noreferrer') },
      { label: t('Copy the text'), onSelect: () => navigator.clipboard?.writeText(c.text) },
    ]
    return (
      <article class={`sm-b sm-b--${mood(c, !!own)}${reply ? ' sm-b--reply' : ''}`}>
        <Face
          class={`sm-b__avatar sm-face--${own ? 'own' : hue(c.author)}`}
          {...profile}
          aria-label={profile.href ? profileName : undefined}
        >
          {c.author_avatar ? (
            <img src={c.author_avatar} alt="" loading="lazy" />
          ) : (
            initials(c.author)
          )}
          <span class="sm-b__net">
            <NetworkMark network={c.network} size={10} />
          </span>
        </Face>
        <div class="sm-c__body sm-b__col">
          <div class="sm-b__bubble">
            <header class="sm-b__who">
              <Face class="sm-b__name" {...profile}>
                {own ? (brand?.name ?? c.author) : c.author}
              </Face>
              {own && <span class="sm-b__brand">{t('Brand')}</span>}
              <span class="sm-b__when" title={when(c.posted_at)}>
                {ago(c.posted_at)}
              </span>
              {c.likes ? (
                <span class="sm-b__likes g-num">
                  <Icon name="favorite" size={11} /> {fmt(c.likes)}
                </span>
              ) : null}
            </header>
            {text ? (
              <p class="sm-b__text">{text}</p>
            ) : (
              !c.media_url && (
                <p class="sm-b__text sm-b__text--none">{t('Sent a sticker or a picture')}</p>
              )
            )}
            {c.media_url && (
              <a class="sm-b__media" href={c.media_url} target="_blank" rel="noreferrer">
                <img src={c.media_url} alt={t('Picture in the comment')} loading="lazy" />
              </a>
            )}
          </div>

          {!own && (
            <Tags c={c} answered={answeredBy(c)}>
              {!wide && edit && (
                <button
                  type="button"
                  class={`sm-tag sm-tag--edit${editing === c.id ? ' is-on' : ''}`}
                  aria-expanded={editing === c.id}
                  aria-label={t('Change the rating')}
                  title={t('Change the rating')}
                  onClick={() => setEditing(editing === c.id ? null : c.id)}
                >
                  <Icon name="edit" size={12} />
                </button>
              )}
              {!wide && <Menu label={t('More actions')} items={items} />}
            </Tags>
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
          {!own && (wide || editing === c.id) && (
            <footer class="sm-c__actions">
              {edit && (
                <Rate
                  key={`${c.id}-${c.sentiment}-${c.category}`}
                  comment={c}
                  brand={brand}
                  onChange={onChange}
                />
              )}
              {wide && (
                <span class="sm-c__links">
                  {items.map((it) => (
                    <button
                      class="g-btn g-btn--ghost g-btn--sm"
                      type="button"
                      disabled={it.disabled}
                      onClick={it.onSelect}
                    >
                      {it.label}
                    </button>
                  ))}
                </span>
              )}
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
          {children.has(c.ext_id) && (
            <div class="sm-replies">{children.get(c.ext_id)!.map((r) => one(r, true))}</div>
          )}
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
  const [look, setLook] = usePref<'list' | 'feed' | 'table'>('comments.look', 'list')
  const [openComment, setOpenComment] = useState<CommentRow | null>(null)
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
        <Segmented<'list' | 'feed' | 'table'>
          label={t('Layout')}
          value={look}
          onChange={setLook}
          options={[
            ['list', t('Bubbles')],
            ['feed', t('By post')],
            ['table', t('Table')],
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
        look === 'table' ? (
          <section class="sm-box sm-box--table">
            <header class="sm-box__head">
              <h2>{count(rows.filter((c) => !c.parent_ext_id).length, 'comment')}</h2>
              <span class="sm-box__meta">{t('Click a row to read and answer it')}</span>
            </header>
            <CommentTable rows={rows} brands={brands} posts={posts} onOpen={setOpenComment} />
          </section>
        ) : look === 'feed' ? (
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
          <Scroller
            head={
              <header class="sm-box__head">
                <h2>{count(rows.filter((c) => !c.parent_ext_id).length, 'comment')}</h2>
              </header>
            }
          >
            <CommentList comments={rows} brands={brands} onChange={() => setTick((x) => x + 1)} />
          </Scroller>
        )
      ) : (
        <Empty title={t('No comments match.')}>
          {t('Change the filters, or press Update to read new ones.')}
        </Empty>
      )}
      <PostDrawer post={openPost} brands={brands} onClose={() => setOpenPost(null)} />
      <CommentDrawer
        comment={openComment}
        rows={rows ?? []}
        brands={brands}
        posts={posts}
        onClose={() => setOpenComment(null)}
        onChange={() => setTick((x) => x + 1)}
      />
    </div>
  )
}
