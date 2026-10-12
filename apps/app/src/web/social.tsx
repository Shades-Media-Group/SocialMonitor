import type { IconName } from 'shades-gradient'
import { useEffect, useState } from 'preact/hooks'
import type { BrandRow, CommentRow, Network, PostRow } from './api.ts'
import { api } from './api.ts'
import { Sparkline } from './charts.tsx'
import { t } from './i18n.ts'
import { LabelPill } from './labels.tsx'
import {
  Icon,
  Modal,
  NETWORK_NAME,
  NetworkMark,
  Sheet,
  ago,
  count,
  fmt,
  short,
  when,
} from './ui.tsx'
import { CommentList } from './views/comments.tsx'

/**
 * The social pieces every screen shares: an account card per network profile, a post card with
 * how its comments split, a comments table that opens one comment in a drawer, and the drawers.
 */

export interface ProfileStat {
  id: number
  network: Network
  handle: string
  url: string
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  posts: number
  comments: number
  complaints: number
  praise: number
  likes: number
  likes_avg: number | null
  views: number
  interactions: number
  last_post: string | null
  series: number[]
}

const TONE: Record<Network, string> = { instagram: 'pink', facebook: 'blue', tiktok: 'ink' }

/** One social account: who it is, what its posts drew in the period, and whether it is read. */
export function AccountCard({ p }: { p: ProfileStat }) {
  return (
    <article class={`sm-acct sm-tone--${TONE[p.network]}`}>
      <header class="sm-acct__head">
        <span class="sm-acct__mark">
          <NetworkMark network={p.network} size={18} />
        </span>
        <span class="sm-acct__who">
          <b>{NETWORK_NAME[p.network]}</b>
          <a href={p.url} target="_blank" rel="noreferrer">
            @{p.handle}
          </a>
        </span>
        {p.last_status === 'error' ? (
          <span class="sm-badge sm-badge--red" title={p.last_error ?? undefined}>
            {t('Needs you')}
          </span>
        ) : p.last_status === 'ok' ? (
          <span class="sm-badge sm-badge--green">{t('Up to date')}</span>
        ) : (
          <span class="sm-badge">{t('Not read yet')}</span>
        )}
      </header>
      <dl class="sm-acct__stats">
        <div>
          <dt>{t('Posts')}</dt>
          <dd class="g-num">{fmt(p.posts)}</dd>
        </div>
        <div>
          <dt>{t('Comments')}</dt>
          <dd class="g-num">{fmt(p.comments)}</dd>
        </div>
        <div>
          <dt>{t('Likes per post')}</dt>
          <dd class="g-num">{p.likes_avg == null ? '–' : fmt(p.likes_avg)}</dd>
        </div>
        <div>
          <dt>{t('Views')}</dt>
          <dd class="g-num">{short(p.views)}</dd>
        </div>
        <div>
          <dt>{t('Complaints')}</dt>
          <dd class={`g-num${p.complaints ? ' sm-hot' : ''}`}>{fmt(p.complaints)}</dd>
        </div>
        <div>
          <dt>{t('Praise')}</dt>
          <dd class="g-num">{fmt(p.praise)}</dd>
        </div>
      </dl>
      <footer class="sm-acct__foot">
        <span>
          {p.last_post
            ? t('Last post {when}', { when: when(p.last_post) })
            : t('No posts in this period.')}
        </span>
        <Sparkline values={p.series} tone={TONE[p.network]!} />
      </footer>
    </article>
  )
}

/** A post's comments split by type, as one thin bar with the counts on hover. */
export function MoodStrip({ p }: { p: PostRow }) {
  const parts = [
    ['complaint', p.n_complaint, t('Complaints')],
    ['question', p.n_question, t('Questions')],
    ['suggestion', p.n_suggestion, t('Suggestions')],
    ['praise', p.n_praise, t('Praise')],
    ['other', p.n_other, t('Other')],
  ] as const
  const total = parts.reduce((n, x) => n + x[1], 0)
  if (!total) return <span class="sm-mood-strip sm-mood-strip--empty" />
  return (
    <span
      class="sm-mood-strip"
      title={parts
        .filter((x) => x[1])
        .map((x) => `${x[2]}: ${x[1]}`)
        .join(' · ')}
    >
      {parts.map(([k, n]) => (n ? <i class={`sm-c-${k}`} style={{ flex: n }} /> : null))}
    </span>
  )
}

/** A post as the network shows it: the picture, when, what it says, and what it drew. */
export function PostCard({ p, onOpen }: { p: PostRow; onOpen: (p: PostRow) => void }) {
  const stats: [string, IconName, number | null][] = [
    ['Likes', 'favorite', p.likes],
    ['Comments', 'chat', p.comments_count],
    ['Shares', 'share', p.shares],
    ['Views', 'visibility', p.views],
  ]
  return (
    <article class="sm-postcard2">
      <button
        type="button"
        class="sm-postcard2__img"
        onClick={() => onOpen(p)}
        aria-label={t('Open the post')}
      >
        {p.thumb_url ? <img src={p.thumb_url} alt="" loading="lazy" /> : <span />}
      </button>
      <div class="sm-postcard2__body">
        <span class="sm-postcard2__when">
          <NetworkMark network={p.network} size={12} />
          {when(p.posted_at)}
          {p.waiting > 0 && (
            <span class="sm-word sm-word--late">{t('{n} to answer', { n: p.waiting })}</span>
          )}
        </span>
        <p class="sm-postcard2__text" title={p.description ?? p.caption ?? undefined}>
          {p.description ?? p.caption ?? t('No caption.')}
        </p>
        <dl class="sm-postcard2__stats">
          {stats.map(([label, icon, v]) => (
            <div title={t(label)}>
              <dt>
                <Icon name={icon} size={12} />
                <span>{t(label)}</span>
              </dt>
              <dd class="g-num">{short(v)}</dd>
            </div>
          ))}
        </dl>
        <MoodStrip p={p} />
      </div>
    </article>
  )
}

/** One post the way the network shows it: the picture on the left, the caption and comments on the right. */
export function PostDrawer({
  post,
  brands,
  onClose,
}: {
  post: PostRow | null
  brands: BrandRow[]
  onClose: () => void
}) {
  const [rows, setRows] = useState<CommentRow[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!post) return
    setRows(null)
    api
      .get<CommentRow[]>(`/api/comments?post=${post.id}&limit=500`)
      .then(setRows)
      .catch(() => setRows([]))
  }, [post?.id, tick])
  if (!post) return null
  return (
    <Modal wide title={`${NETWORK_NAME[post.network]} · ${when(post.posted_at)}`} onClose={onClose}>
      <div class="sm-viewer">
        <a
          class="sm-viewer__media"
          href={post.url}
          target="_blank"
          rel="noreferrer"
          aria-label={t('Open the post')}
        >
          {post.thumb_url ? <img src={post.thumb_url} alt="" /> : <span />}
        </a>
        <div class="sm-viewer__side">
          <header class="sm-viewer__head">
            <span class="sm-viewer__avatar">
              <NetworkMark network={post.network} size={16} />
            </span>
            <span class="sm-viewer__who">
              <b>@{post.handle}</b>
              <small>
                {NETWORK_NAME[post.network]} · {when(post.posted_at)}
              </small>
            </span>
            <a
              class="g-btn g-btn--ghost g-btn--sm"
              href={post.url}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="external" size={14} /> {t('Open')}
            </a>
          </header>
          <div class="sm-viewer__scroll">
            <p class="sm-viewer__caption">
              <b>@{post.handle}</b> {post.caption ?? post.description}
            </p>
            {rows === null ? null : rows.length ? (
              <div class="sm-ig">
                <CommentList
                  comments={rows}
                  brands={brands}
                  onChange={() => setTick((x) => x + 1)}
                />
              </div>
            ) : (
              <p class="sm-quiet">{t('No comments saved for this post.')}</p>
            )}
          </div>
          <footer class="sm-viewer__foot">
            <span class="sm-postcard2__metrics g-num">
              <span>
                <Icon name="favorite" size={15} /> {fmt(post.likes)}
              </span>
              <span>
                <Icon name="chat" size={15} /> {fmt(post.comments_count)}
              </span>
              <span>
                <Icon name="share" size={15} /> {fmt(post.shares)}
              </span>
              {post.views != null && (
                <span>
                  <Icon name="visibility" size={15} /> {fmt(post.views)}
                </span>
              )}
            </span>
            <MoodStrip p={post} />
            <small class="sm-quiet">{t('{n} saved', { n: fmt(post.stored_comments) })}</small>
          </footer>
        </div>
      </div>
    </Modal>
  )
}

/** A post with its first comments under it, as in a feed; the rest open in the viewer. */
export function FeedCard({
  post,
  comments,
  brands,
  onOpen,
  onChange,
}: {
  post: PostRow
  comments: CommentRow[]
  brands: BrandRow[]
  onOpen: (p: PostRow) => void
  onChange: () => void
}) {
  const roots = comments.filter((c) => !c.parent_ext_id)
  const shown = roots.slice(0, 3)
  const ids = new Set(shown.map((c) => c.ext_id))
  return (
    <article class="sm-feedcard">
      <header class="sm-viewer__head">
        <span class="sm-viewer__avatar">
          <NetworkMark network={post.network} size={15} />
        </span>
        <span class="sm-viewer__who">
          <b>@{post.handle}</b>
          <small>{when(post.posted_at)}</small>
        </span>
        <MoodStrip p={post} />
      </header>
      <button
        type="button"
        class="sm-feedcard__media"
        onClick={() => onOpen(post)}
        aria-label={t('Open the post')}
      >
        {post.thumb_url ? <img src={post.thumb_url} alt="" loading="lazy" /> : <span />}
      </button>
      <div class="sm-feedcard__body">
        <span class="sm-postcard2__metrics g-num">
          <span>
            <Icon name="favorite" size={15} /> {fmt(post.likes)}
          </span>
          <span>
            <Icon name="chat" size={15} /> {fmt(post.comments_count)}
          </span>
          <span>
            <Icon name="share" size={15} /> {fmt(post.shares)}
          </span>
        </span>
        <p class="sm-viewer__caption sm-feedcard__caption">
          <b>@{post.handle}</b> {post.description ?? post.caption}
        </p>
        <div class="sm-ig sm-ig--feed">
          <CommentList
            comments={comments.filter(
              (c) => ids.has(c.ext_id) || (c.parent_ext_id && ids.has(c.parent_ext_id)),
            )}
            brands={brands}
            onChange={onChange}
          />
        </div>
        {roots.length > shown.length && (
          <button type="button" class="sm-feedcard__more" onClick={() => onOpen(post)}>
            {t('View all {n}', { n: count(roots.length, 'comment') })}
          </button>
        )}
      </div>
    </article>
  )
}

/** Comments as a monitoring table: which post, who, what, how it was read, and when. */
export function CommentTable({
  rows,
  brands,
  posts,
  onOpen,
}: {
  rows: CommentRow[]
  brands: BrandRow[]
  posts: Map<number, PostRow>
  onOpen: (c: CommentRow) => void
}) {
  const own = (c: CommentRow) =>
    brands
      .find((b) => b.id === c.brand_id)
      ?.profiles.some((p) => p.handle.toLowerCase() === c.author.toLowerCase())
  return (
    <div class="sm-scroll">
      <table class="sm-dtable sm-dtable--rows sm-ctable">
        <thead>
          <tr>
            <th>{t('Post')}</th>
            <th>{t('Person')}</th>
            <th>{t('Comment')}</th>
            <th>{t('Type')}</th>
            <th>{t('Rating')}</th>
            <th class="sm-num">{t('Likes')}</th>
            <th class="sm-num">{t('Written')}</th>
            <th>{t('Answer')}</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((c) => !own(c))
            .map((c) => {
              const post = posts.get(c.post_id)
              const answered =
                c.reply_status === 'done' ||
                rows.some((r) => r.parent_ext_id === c.ext_id && own(r))
              return (
                <tr onClick={() => onOpen(c)} class="sm-ctable__row">
                  <td>
                    <span class="sm-ctable__post">
                      {post?.thumb_url ? (
                        <img src={post.thumb_url} alt="" />
                      ) : (
                        <span class="sm-postcell__blank" />
                      )}
                      <NetworkMark network={c.network} size={12} />
                    </span>
                  </td>
                  <td class="sm-ctable__who">{c.author}</td>
                  <td class="sm-ctable__text">
                    {c.text}
                    {c.reason && <small>{t('AI: {reason}', { reason: c.reason })}</small>}
                  </td>
                  <td>{c.label ? <LabelPill label={c.label} /> : '–'}</td>
                  <td>
                    {c.sentiment === 'negative' ? (
                      <span class="sm-badge sm-badge--red">{t('Negative')}</span>
                    ) : c.sentiment === 'positive' ? (
                      <span class="sm-badge sm-badge--green">{t('Positive')}</span>
                    ) : c.sentiment === 'neutral' ? (
                      <span class="sm-badge">{t('Neutral')}</span>
                    ) : (
                      <span class="sm-quiet">–</span>
                    )}
                  </td>
                  <td class="sm-num g-num">{fmt(c.likes ?? 0)}</td>
                  <td class="sm-num sm-nowrap">{ago(c.posted_at)}</td>
                  <td>
                    {answered ? (
                      <span class="sm-badge sm-badge--blue">{t('Answered')}</span>
                    ) : c.needs_reply === 1 && c.reply_status === 'open' ? (
                      <span class="sm-badge sm-badge--amber">{t('To answer')}</span>
                    ) : c.reply_status === 'ignored' ? (
                      <span class="sm-quiet">{t('Skipped')}</span>
                    ) : (
                      <span class="sm-quiet">–</span>
                    )}
                  </td>
                </tr>
              )
            })}
        </tbody>
      </table>
    </div>
  )
}

/** One comment, its replies and the post it is under, in a drawer, with everything you can do. */
export function CommentDrawer({
  comment,
  rows,
  brands,
  posts,
  onClose,
  onChange,
}: {
  comment: CommentRow | null
  rows: CommentRow[]
  brands: BrandRow[]
  posts: Map<number, PostRow>
  onClose: () => void
  onChange: () => void
}) {
  if (!comment) return null
  const post = posts.get(comment.post_id)
  return (
    <Sheet open title={comment.author} onClose={onClose}>
      <div class="sm-drawer">
        {post && (
          <a class="sm-drawer__post" href={post.url} target="_blank" rel="noreferrer">
            {post.thumb_url && <img src={post.thumb_url} alt="" />}
            <span>{post.description ?? post.caption}</span>
          </a>
        )}
        <CommentList
          wide
          comments={rows.filter((r) => r.id === comment.id || r.parent_ext_id === comment.ext_id)}
          brands={brands}
          onChange={onChange}
        />
      </div>
    </Sheet>
  )
}
