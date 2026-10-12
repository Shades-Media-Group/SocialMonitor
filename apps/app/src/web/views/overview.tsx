import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { CommentRow, PostRow, Profile } from '../api.ts'
import { api } from '../api.ts'
import { NETWORK_NAME, NetworkMark, ago, count, fmt, pctf, short, when } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import { MoodBar } from '../labels.tsx'
import { brandCategories } from '../rate.tsx'
import { CommentList } from './comments.tsx'
import { EngagementChart, TimelineChart } from '../charts.tsx'
import type { PostPoint } from '../charts.tsx'
import { t } from '../i18n.ts'

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
}

const duration = (min: number | null) =>
  min == null
    ? '–'
    : min < 60
      ? t('{n} min', { n: min })
      : min < 1440
        ? t('{n} h', { n: Math.round(min / 60) })
        : count(Math.round(min / 1440), 'day')

/** One measure in the strip: what it is, the number, and one line of context. */
const Kpi = ({
  label,
  value,
  sub,
  hot,
}: {
  label: string
  value: string
  sub?: string
  hot?: boolean
}) => (
  <div class="sm-kpi">
    <dt>{label}</dt>
    <dd class={`g-num${hot ? ' sm-hot' : ''}`}>{value}</dd>
    {sub && <dd class="sm-kpi__sub">{sub}</dd>}
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
      .get<PostRow[]>(`/api/posts?brand=${brand.id}&limit=8${n}`)
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
  const sorted = total - (c.unsorted ?? 0)
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
    <ul class={`sm-tally${good ? ' sm-tally--good' : ''}`}>
      {list.map((x) => (
        <li>
          <span>{name(x.category)}</span>
          <span class="sm-tally__track">
            <span
              class="sm-tally__bar"
              style={{ width: `${Math.max(4, pct(x.n, list[0]!.n))}%` }}
            />
          </span>
          <b class="g-num">{x.n}</b>
        </li>
      ))}
    </ul>
  )

  const L = ins?.labels ?? c
  const lTotal = L.total ?? 0
  const lSorted = lTotal - (L.unsorted ?? 0)
  const r = ins?.responses
  const period = days ? t('Last {days}', { days: count(days, 'day') }) : t('All time')
  const hasTrend = !!ins?.timeline.some(
    (d) => d.complaint + d.question + d.suggestion + d.praise + d.other,
  )

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

  return (
    <div class="sm-overview">
      <dl class="sm-kpis" aria-label={period}>
        <Kpi
          label={t('Comments')}
          value={fmt(lTotal)}
          sub={s.week.total ? t('{n} in the last 7 days', { n: fmt(s.week.total) }) : period}
        />
        <Kpi
          label={t('Waiting for an answer')}
          value={fmt(waiting)}
          hot={waiting > 0}
          sub={waiting ? t('Oldest first in Comments') : t('All answered')}
        />
        <Kpi
          label={t('Complaints')}
          value={lSorted ? pctf(L.complaint ?? 0, lSorted) : '–'}
          sub={t('{n} comments', { n: fmt(L.complaint ?? 0) })}
        />
        <Kpi
          label={t('Praise')}
          value={lSorted ? pctf(L.praise ?? 0, lSorted) : '–'}
          sub={t('{n} comments', { n: fmt(L.praise ?? 0) })}
        />
        <Kpi
          label={t('Reputation')}
          value={ins?.reputation == null ? '–' : `${ins.reputation}`}
          sub={t('out of 100; 50 is even')}
        />
        <Kpi
          label={t('Answered by the brand')}
          value={r?.rate == null ? '–' : `${Math.round(r.rate * 100)}%`}
          sub={
            r?.median_minutes == null
              ? undefined
              : t('usually within {time}', { time: duration(r.median_minutes) })
          }
        />
        <Kpi label={t('Reach')} value={short(ins?.reach ?? 0)} sub={t('video views')} />
      </dl>

      <div class="sm-grid2">
        <section class="sm-box">
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

        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{t('What people say')}</h2>
            <span class="sm-box__meta">{t('{n} sorted', { n: fmt(sorted) })}</span>
          </header>
          {sorted ? (
            <MoodBar counts={c} />
          ) : (
            <p class="sm-quiet">{t('The split shows once comments are sorted.')}</p>
          )}
          <h3 class="sm-box__sub">{t('Problems people name')}</h3>
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
          {rated > 0 && (
            <p class="sm-box__note">
              {t('{rated} of {total} rated, {neutral} neutral.', {
                rated,
                total: fmt(total),
                neutral,
              })}
            </p>
          )}
        </section>
      </div>

      <div class="sm-grid2">
        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{reply.length ? t('Answer first') : t('Newest comments')}</h2>
            <a class="sm-box__link" href={`#/b/${brand.id}/comments`}>
              {t('All comments')}
            </a>
          </header>
          {reply.length || latest.length ? (
            <CommentList
              comments={reply.length ? reply : latest}
              brands={brands}
              onChange={() => setTick((x) => x + 1)}
            />
          ) : (
            <p class="sm-quiet">{t('Comments appear here after the first update.')}</p>
          )}
        </section>

        <div class="sm-stack">
          <section class="sm-box">
            <header class="sm-box__head">
              <h2>{t('Networks')}</h2>
              <a class="sm-box__link" href={`#/b/${brand.id}/about`}>
                {t('Edit links')}
              </a>
            </header>
            <table class="sm-dtable">
              <tbody>
                {s.profiles.map((p) => (
                  <tr>
                    <td>
                      <span class="sm-net-name">
                        <NetworkMark network={p.network} size={14} />
                        <a href={p.url} target="_blank" rel="noreferrer">
                          @{p.handle}
                        </a>
                      </span>
                    </td>
                    <td class="sm-num" title={p.last_run_at ?? undefined}>
                      {ago(p.last_run_at)}
                    </td>
                    <td class="sm-num">
                      {p.last_status === 'error' ? (
                        <span class="sm-status sm-status--error" title={p.last_error ?? undefined}>
                          {t('Needs you')}
                        </span>
                      ) : p.last_status === 'ok' ? (
                        <span class="sm-status sm-status--ok">{t('Up to date')}</span>
                      ) : (
                        <span class="sm-status">{t('Not read yet')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.profiles
              .filter((p) => p.last_status === 'error')
              .map((p) => (
                <p class="sm-note">
                  {NETWORK_NAME[p.network]}: {p.last_error}
                </p>
              ))}
          </section>

          {ins && ins.posts.length > 0 && (
            <section class="sm-box">
              <header class="sm-box__head">
                <h2>{t('Likes per post')}</h2>
                <span class="sm-box__meta">{t('Click a bar to open the post')}</span>
              </header>
              <EngagementChart posts={ins.posts} />
            </section>
          )}
        </div>
      </div>

      {posts.length > 0 && (
        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{t('Latest posts')}</h2>
            <a class="sm-box__link" href={`#/b/${brand.id}/posts`}>
              {t('All {n} posts', { n: fmt(s.posts) })}
            </a>
          </header>
          <div class="sm-scroll">
            <table class="sm-dtable sm-dtable--rows">
              <thead>
                <tr>
                  <th>{t('Post')}</th>
                  <th>{t('Published')}</th>
                  <th class="sm-num">{t('Likes')}</th>
                  <th class="sm-num">{t('Comments')}</th>
                  <th class="sm-num">{t('Views')}</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr>
                    <td>
                      <a class="sm-postcell" href={p.url} target="_blank" rel="noreferrer">
                        {p.thumb_url ? (
                          <img src={p.thumb_url} alt="" loading="lazy" />
                        ) : (
                          <span class="sm-postcell__blank" />
                        )}
                        <NetworkMark network={p.network} size={14} />
                        <span class="sm-postcell__text">{p.description ?? p.caption}</span>
                      </a>
                    </td>
                    <td class="sm-nowrap">{when(p.posted_at)}</td>
                    <td class="sm-num g-num">{fmt(p.likes)}</td>
                    <td class="sm-num g-num">{fmt(p.comments_count)}</td>
                    <td class="sm-num g-num">{fmt(p.views)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
