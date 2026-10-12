import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { CommentRow, Network, PostRow, Profile } from '../api.ts'
import { api } from '../api.ts'
import { Icon, NETWORK_NAME, NetworkMark, count, fmt } from '../ui.tsx'
import type { IconName } from 'shades-gradient'
import { JsonPanel } from '../json.tsx'
import { brandCategories } from '../rate.tsx'
import { Donut, Heatmap, Sparkline, TimelineChart } from '../charts.tsx'
import type { PostPoint } from '../charts.tsx'
import { locale, t } from '../i18n.ts'
import { AccountCard, CommentDrawer, CommentTable, PostCard, PostDrawer } from '../social.tsx'
import type { ProfileStat } from '../social.tsx'

interface Insights {
  timeline: ({ day: string } & Record<
    'complaint' | 'question' | 'suggestion' | 'praise' | 'other',
    number
  >)[]
  posts: PostPoint[]
  responses: {
    comments: number
    answered: number
    rate: number | null
    median_minutes: number | null
  }
  labels: Record<string, number>
  reputation: number | null
  reach: number
  interactions: number
  previous: {
    labels: Record<string, number>
    responses: { rate: number | null; median_minutes: number | null }
    reputation: number | null
    reach: number
    posts: number
    interactions: number
  } | null
  networks: ({ network: Network } & Record<string, number>)[]
  heatmap: number[][]
  profiles: ProfileStat[]
  authors: {
    author: string
    network: Network
    n: number
    complaints: number
    praise: number
    last: string
  }[]
  words: { word: string; n: number }[]
}

const duration = (min: number | null) =>
  min == null
    ? '–'
    : min < 60
      ? t('{n} min', { n: min })
      : min < 1440
        ? t('{n} h', { n: Math.round(min / 60) })
        : count(Math.round(min / 1440), 'day')

type Tone = 'blue' | 'orange' | 'red' | 'green' | 'violet' | 'amber' | 'pink' | 'ink'

/** How a figure moved against the window before: an arrow, the change, green when it is good. */
function Delta({
  now,
  before,
  points,
  upIsGood = true,
}: {
  now: number | null
  before: number | null | undefined
  points?: boolean
  upIsGood?: boolean
}) {
  if (now == null || before == null) return null
  const diff = points
    ? Math.round(now - before)
    : before
      ? Math.round(((now - before) / before) * 100)
      : null
  if (diff == null) return null
  const good = diff === 0 ? null : diff > 0 === upIsGood
  return (
    <span
      class={`sm-delta${good === null ? '' : good ? ' is-good' : ' is-bad'}`}
      title={t('Against the period before')}
    >
      {diff !== 0 && <Icon name={diff > 0 ? 'arrowUp' : 'arrowDown'} size={12} />}
      {diff === 0 ? '±0' : `${Math.abs(diff)}${points ? ' pt' : '%'}`}
    </span>
  )
}

/** One figure: a tinted tile with its icon, the number, how it moved and its trend. */
const Kpi = ({
  label,
  value,
  sub,
  tone,
  icon,
  delta,
  spark,
}: {
  label: string
  value: string
  sub?: string
  tone: Tone
  icon: IconName
  delta?: preact.ComponentChildren
  spark?: number[]
}) => (
  <div class={`sm-kpi sm-tone--${tone}`}>
    <dt>
      <span class="sm-kpi__icon">
        <Icon name={icon} size={16} />
      </span>
      {label}
    </dt>
    <dd class="sm-kpi__value">
      <span class="g-num">{value}</span>
      {delta}
    </dd>
    <dd class="sm-kpi__foot">
      <span class="sm-kpi__sub">{sub}</span>
      {spark && <Sparkline values={spark} tone={tone} />}
    </dd>
  </div>
)

interface Summary {
  profiles: Profile[]
  counts: Record<string, number>
  week: Record<string, number>
  sentiment: {
    sentiment: 'positive' | 'negative' | 'neutral'
    category: string | null
    n: number
  }[]
  posts: number
  brand_replies: number
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0)

/**
 * The brand at a glance: a strip of measures for the period, then panels for the trend, what
 * people say, the comments to answer, the problems they name, engagement, posts and networks.
 */
export function Overview(v: BrandView) {
  const { brand, network, version, mode, openUpdate, brands, days } = v
  const [s, setS] = useState<Summary | null>(null)
  const [ins, setIns] = useState<Insights | null>(null)
  const [reply, setReply] = useState<CommentRow[]>([])
  const [posts, setPosts] = useState<PostRow[]>([])
  const [latest, setLatest] = useState<CommentRow[]>([])
  const [tick, setTick] = useState(0)
  const [openPost, setOpenPost] = useState<PostRow | null>(null)
  const [openComment, setOpenComment] = useState<CommentRow | null>(null)

  useEffect(() => {
    const n = network ? `&network=${network}` : ''
    api
      .get<Summary>(`/api/brands/${brand.id}/summary${network ? `?network=${network}` : ''}`)
      .then(setS)
      .catch(() => setS(null))
    // Threads keep their replies: the chosen comments, plus every reply under them.
    const withReplies = (roots: CommentRow[], all: CommentRow[]) => {
      const ids = new Set(roots.map((r) => r.ext_id))
      return [...roots, ...all.filter((c) => c.parent_ext_id && ids.has(c.parent_ext_id))]
    }
    api
      .get<CommentRow[]>(`/api/comments?brand=${brand.id}&limit=500${n}`)
      .then((all) => {
        const roots = all.filter((c) => !c.parent_ext_id)
        const waiting = roots
          .filter((c) => c.needs_reply === 1 && c.reply_status === 'open')
          .slice(0, 5)
        setReply(withReplies(waiting, all))
        // When nothing waits for an answer, the newest threads take the place, ready to rate.
        const newest = roots
          .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''))
          .slice(0, 5)
        setLatest(withReplies(newest, all))
      })
      .catch(() => {
        setReply([])
        setLatest([])
      })
    api
      .get<PostRow[]>(`/api/posts?brand=${brand.id}&limit=200${n}`)
      .then(setPosts)
      .catch(() => setPosts([]))
  }, [brand.id, network, version, tick])

  useEffect(() => {
    api
      .get<Insights>(
        `/api/brands/${brand.id}/insights?days=${days}${network ? `&network=${network}` : ''}`,
      )
      .then(setIns)
      .catch(() => setIns(null))
  }, [brand.id, network, version, days, tick])

  if (!s) return null
  const c = s.counts
  const total = c.total ?? 0
  const waiting = c.needs_reply ?? 0
  const cats = brandCategories(brand)
  const negatives = s.sentiment.filter((x) => x.sentiment === 'negative')
  const positives = s.sentiment.filter((x) => x.sentiment === 'positive')
  const rated = s.sentiment.reduce((n, x) => n + x.n, 0)
  const neutral = s.sentiment.filter((x) => x.sentiment === 'neutral').reduce((n, x) => n + x.n, 0)
  const name = (key: string | null) => cats.find((k) => k.key === key)?.name ?? t('No kind given')

  if (mode === 'json')
    return (
      <JsonPanel
        value={{
          brand: brand.name,
          network: network || 'all',
          comments: c,
          last_7_days: s.week,
          rated: Object.fromEntries(
            s.sentiment.map((x) => [`${x.sentiment}:${x.category ?? 'none'}`, x.n]),
          ),
          brand_replies: s.brand_replies,
          posts: s.posts,
          answer_first: reply.map((r) => ({
            id: r.id,
            author: r.author,
            text: r.text,
            label: r.label,
            reason: r.reason,
          })),
          networks: s.profiles.map((p) => ({
            network: p.network,
            handle: p.handle,
            last_update: p.last_run_at,
            status: p.last_status,
            error: p.last_error,
          })),
        }}
      />
    )

  const tally = (list: typeof negatives, good = false) => (
    <ul class={`sm-bars${good ? ' sm-bars--good' : ''}`}>
      {list.map((x) => (
        <li>
          <span class="sm-bars__name">{name(x.category)}</span>
          <span class="sm-bars__track">
            <span
              class="sm-bars__fill"
              style={{ width: `${Math.max(3, pct(x.n, list[0]!.n))}%` }}
            />
          </span>
          <b class="g-num">{x.n}</b>
        </li>
      ))}
    </ul>
  )

  const L = ins?.labels ?? c
  const P = ins?.previous
  const lTotal = L.total ?? 0
  const lSorted = lTotal - (L.unsorted ?? 0)
  const share = (k: string, labels = L) => {
    const sortedN = (labels.total ?? 0) - (labels.unsorted ?? 0)
    return sortedN ? ((labels[k] ?? 0) / sortedN) * 100 : null
  }
  const r = ins?.responses
  const period = days ? t('Last {days}', { days: count(days, 'day') }) : t('All time')
  const series = (k: 'complaint' | 'praise' | 'all') =>
    (ins?.timeline ?? []).map((d) =>
      k === 'all' ? d.complaint + d.question + d.suggestion + d.praise + d.other : d[k],
    )
  const hasTrend = series('all').some(Boolean)
  const weekdays = Array.from({ length: 7 }, (_, d) =>
    new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(locale, {
      weekday: 'short',
      timeZone: 'UTC',
    }),
  )
  const maxWord = Math.max(1, ...(ins?.words ?? []).map((w) => w.n))
  const posNeg = [
    {
      key: 'praise',
      name: t('Positive'),
      n: s.sentiment.filter((x) => x.sentiment === 'positive').reduce((n, x) => n + x.n, 0),
    },
    {
      key: 'complaint',
      name: t('Negative'),
      n: s.sentiment.filter((x) => x.sentiment === 'negative').reduce((n, x) => n + x.n, 0),
    },
    { key: 'other', name: t('Neutral'), n: neutral },
  ]
  const byLabel = [
    { key: 'complaint', name: t('Complaints'), n: L.complaint ?? 0 },
    { key: 'question', name: t('Questions'), n: L.question ?? 0 },
    { key: 'suggestion', name: t('Suggestions'), n: L.suggestion ?? 0 },
    { key: 'praise', name: t('Praise'), n: L.praise ?? 0 },
    {
      key: 'other',
      name: t('Other'),
      n: Math.max(
        0,
        lSorted - (L.complaint ?? 0) - (L.question ?? 0) - (L.suggestion ?? 0) - (L.praise ?? 0),
      ),
    },
  ]

  if (total === 0)
    return (
      <div class="sm-empty sm-empty--page">
        <p class="sm-empty__title">
          {network
            ? t('Nothing read on {network} yet.', { network: NETWORK_NAME[network] })
            : t('Nothing read yet.')}
        </p>
        <p class="sm-empty__body">
          {t('An update reads the latest posts and every comment under them.')}{' '}
          <button class="sm-textbtn" type="button" onClick={() => openUpdate(brand.id)}>
            {t('Run the first update')}
          </button>
        </p>
      </div>
    )

  const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : ''
  const wall = posts.filter((p) => !since || (p.posted_at ?? '') >= since).slice(0, 10)
  const postMap = new Map(posts.map((p) => [p.id, p]))
  const stream = reply.length ? reply : latest

  return (
    <div class="sm-overview">
      <section class="sm-sec">
        <header class="sm-sec__head">
          <h2>{t('Accounts')}</h2>
          <span class="sm-sec__meta">{period}</span>
          <a class="sm-box__link" href={`#/b/${brand.id}/about`}>
            {t('Edit links')}
          </a>
        </header>
        <div class="sm-accounts">
          {(ins?.profiles ?? []).map((p) => (
            <AccountCard p={p} />
          ))}
        </div>
      </section>

      <dl class="sm-kpis sm-kpis--six">
        <Kpi
          tone="blue"
          icon="chat"
          label={t('Comments')}
          value={fmt(lTotal)}
          delta={<Delta now={lTotal} before={P?.labels.total} />}
          sub={s.week.total ? t('{n} in the last 7 days', { n: fmt(s.week.total) }) : undefined}
          spark={series('all')}
        />
        <Kpi
          tone="orange"
          icon="schedule"
          label={t('Waiting for an answer')}
          value={fmt(waiting)}
          sub={waiting ? t('Oldest first in Comments') : t('All answered')}
        />
        <Kpi
          tone="red"
          icon="warning"
          label={t('Complaints')}
          value={share('complaint') == null ? '–' : `${Math.round(share('complaint')!)}%`}
          delta={
            <Delta
              now={share('complaint')}
              before={P ? share('complaint', P.labels) : null}
              points
              upIsGood={false}
            />
          }
          sub={t('{n} comments', { n: fmt(L.complaint ?? 0) })}
          spark={series('complaint')}
        />
        <Kpi
          tone="green"
          icon="favorite"
          label={t('Praise')}
          value={share('praise') == null ? '–' : `${Math.round(share('praise')!)}%`}
          delta={
            <Delta now={share('praise')} before={P ? share('praise', P.labels) : null} points />
          }
          sub={t('{n} comments', { n: fmt(L.praise ?? 0) })}
          spark={series('praise')}
        />
        <Kpi
          tone="violet"
          icon="star"
          label={t('Reputation')}
          value={ins?.reputation == null ? '–' : `${ins.reputation}`}
          delta={<Delta now={ins?.reputation ?? null} before={P?.reputation} points />}
          sub={t('out of 100; 50 is even')}
        />
        <Kpi
          tone="amber"
          icon="check"
          label={t('Answered by the brand')}
          value={r?.rate == null ? '–' : `${Math.round(r.rate * 100)}%`}
          delta={
            <Delta
              now={r?.rate == null ? null : r.rate * 100}
              before={P?.responses.rate == null ? null : P.responses.rate * 100}
              points
            />
          }
          sub={
            r?.median_minutes == null
              ? undefined
              : t('usually within {time}', { time: duration(r.median_minutes) })
          }
        />
      </dl>

      <section class="sm-sec">
        <header class="sm-sec__head">
          <h2>{t('Posts')}</h2>
          <span class="sm-sec__meta">{t('Click a post to read its comments')}</span>
          <a class="sm-box__link" href={`#/b/${brand.id}/posts`}>
            {t('All {n} posts', { n: fmt(s.posts) })}
          </a>
        </header>
        {wall.length ? (
          <div class="sm-wall">
            {wall.map((p) => (
              <PostCard p={p} onOpen={setOpenPost} />
            ))}
          </div>
        ) : (
          <p class="sm-quiet">{t('No posts in this period.')}</p>
        )}
      </section>

      <div class="sm-layout">
        <section class="sm-box sm-span-8">
          <header class="sm-box__head">
            <h2>{t('Comments over time')}</h2>
            <span class="sm-box__meta">{period}</span>
          </header>
          {hasTrend ? (
            <TimelineChart days={ins!.timeline} />
          ) : (
            <p class="sm-quiet">{t('No comments in this period.')}</p>
          )}
        </section>

        <section class="sm-box sm-span-4">
          <header class="sm-box__head">
            <h2>{t('What people say')}</h2>
            <span class="sm-box__meta">{t('{n} sorted', { n: fmt(lSorted) })}</span>
          </header>
          <Donut parts={byLabel} total={fmt(lSorted)} caption={t('sorted')} />
        </section>

        <section class="sm-box sm-span-8 sm-box--table">
          <header class="sm-box__head">
            <h2>{reply.length ? t('Answer first') : t('Newest comments')}</h2>
            <a class="sm-box__link" href={`#/b/${brand.id}/comments`}>
              {t('All comments')}
            </a>
          </header>
          {stream.length ? (
            <CommentTable rows={stream} brands={brands} posts={postMap} onOpen={setOpenComment} />
          ) : (
            <p class="sm-quiet">{t('Comments appear here after the first update.')}</p>
          )}
        </section>

        <div class="sm-span-4 sm-stack">
          <section class="sm-box">
            <header class="sm-box__head">
              <h2>{t('Positive or negative')}</h2>
              <span class="sm-box__meta">
                {t('{rated} of {total} rated', { rated, total: fmt(total) })}
              </span>
            </header>
            <Donut parts={posNeg} total={fmt(rated)} caption={t('rated')} />
          </section>
          <section class="sm-box">
            <header class="sm-box__head">
              <h2>{t('Problems people name')}</h2>
            </header>
            {negatives.length ? (
              tally(negatives)
            ) : (
              <p class="sm-quiet">
                {t('Rate comments negative, or ask Claude to, and their kinds add up here.')}
              </p>
            )}
            {positives.length > 0 && (
              <>
                <h3 class="sm-box__sub">{t('What people like')}</h3>
                {tally(positives, true)}
              </>
            )}
          </section>
        </div>

        <section class="sm-box sm-span-8">
          <header class="sm-box__head">
            <h2>{t('When people comment')}</h2>
            <span class="sm-box__meta">{t('By weekday and hour (UTC)')}</span>
          </header>
          {ins && <Heatmap grid={ins.heatmap} days={weekdays} caption={t('When people comment')} />}
        </section>

        <div class="sm-span-4 sm-stack">
          <section class="sm-box">
            <header class="sm-box__head">
              <h2>{t('Words people use')}</h2>
            </header>
            {ins?.words.length ? (
              <ul class="sm-words">
                {ins.words.map((w) => (
                  <li
                    style={{ '--w': 0.25 + (w.n / maxWord) * 0.75 }}
                    title={count(w.n, 'comment')}
                  >
                    {w.word}
                    <b class="g-num">{w.n}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="sm-quiet">{t('Words show once a few comments repeat them.')}</p>
            )}
          </section>
          <section class="sm-box sm-box--table">
            <header class="sm-box__head">
              <h2>{t('Most active people')}</h2>
            </header>
            <table class="sm-dtable">
              <tbody>
                {(ins?.authors ?? []).map((a) => (
                  <tr>
                    <td>
                      <span class="sm-person">
                        <NetworkMark network={a.network} size={13} />
                        <span class="sm-person__name">{a.author}</span>
                      </span>
                    </td>
                    <td class="sm-num">
                      {a.complaints > 0 && (
                        <span class="sm-dot sm-c-complaint" title={t('Complaints')} />
                      )}
                      {a.praise > 0 && <span class="sm-dot sm-c-praise" title={t('Praise')} />}
                    </td>
                    <td class="sm-num g-num">{a.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>

      <PostDrawer post={openPost} brands={brands} onClose={() => setOpenPost(null)} />
      <CommentDrawer
        comment={openComment}
        rows={stream}
        brands={brands}
        posts={postMap}
        onClose={() => setOpenComment(null)}
        onChange={() => setTick((x) => x + 1)}
      />
    </div>
  )
}
