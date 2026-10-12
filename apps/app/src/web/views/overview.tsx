import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { CommentRow, Network, PostRow, Profile } from '../api.ts'
import { api } from '../api.ts'
import { Icon, NETWORK_NAME, NetworkMark, Scroller, ago, fmt, short, when } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import { brandCategories } from '../rate.tsx'
import { Heatmap, LineChart } from '../charts.tsx'
import type { PostPoint } from '../charts.tsx'
import { locale, t } from '../i18n.ts'
import { usePref } from '../prefs.ts'
import { MoodStrip, PostDrawer } from '../social.tsx'
import { CommentList } from './comments.tsx'
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
    avatar: string | null
    url: string | null
  }[]
  words: { word: string; n: number }[]
  watched: {
    term: string
    kind: 'product' | 'competitor' | 'topic'
    n: number
    before: number | null
    complaints: number
    praise: number
  }[]
}

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

interface DayRow {
  day: string
  comments: number
  complaints: number
  questions: number
  praise: number
  posts: number
  likes: number
  views: number
  interactions: number
}
type DayKey = Exclude<keyof DayRow, 'day'>

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
const WATCH_KIND = { product: 'Product', competitor: 'Other brand', topic: 'Topic' } as const
const WATCH_TONE = { product: 'question', competitor: 'suggestion', topic: 'neutral' } as const

export function Overview(v: BrandView) {
  const { brand, network, version, mode, openUpdate, brands, days } = v
  const [s, setS] = useState<Summary | null>(null)
  const [ins, setIns] = useState<Insights | null>(null)
  const [reply, setReply] = useState<CommentRow[]>([])
  const [posts, setPosts] = useState<PostRow[]>([])
  const [latest, setLatest] = useState<CommentRow[]>([])
  const [tick, setTick] = useState(0)
  const [openPost, setOpenPost] = useState<PostRow | null>(null)
  const [metric, setMetric] = usePref<DayKey>('overview.metric', 'comments')
  const [series, setSeries] = useState<{ now: DayRow[]; before: DayRow[] } | null>(null)

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

  // The chart's two windows: this period and the same length just before.
  useEffect(() => {
    const span = days || 365
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const to = iso(new Date())
    const from = iso(new Date(Date.now() - (span - 1) * 86400_000))
    const pFrom = iso(new Date(Date.now() - (2 * span - 1) * 86400_000))
    const pTo = iso(new Date(Date.now() - span * 86400_000))
    const q = (a: string, b: string) =>
      `/api/brands/${brand.id}/daily?from=${a}&to=${b}${network ? `&network=${network}` : ''}`
    Promise.all([api.get<DayRow[]>(q(from, to)), api.get<DayRow[]>(q(pFrom, pTo))])
      .then(([now, before]) => setSeries({ now, before }))
      .catch(() => setSeries(null))
  }, [brand.id, network, version, days, tick])

  if (!s) return null
  const c = s.counts
  const total = c.total ?? 0
  const waiting = c.needs_reply ?? 0
  const cats = brandCategories(brand)
  const negatives = s.sentiment.filter((x) => x.sentiment === 'negative')
  const positives = s.sentiment.filter((x) => x.sentiment === 'positive')
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
  const r = ins?.responses
  const weekdays = Array.from({ length: 7 }, (_, d) =>
    new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(locale, {
      weekday: 'short',
      timeZone: 'UTC',
    }),
  )
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

  const sum = (rows: DayRow[] | undefined, k: DayKey) => (rows ?? []).reduce((n, r) => n + r[k], 0)
  const CARDS: [DayKey, string][] = [
    ['comments', t('Comments')],
    ['complaints', t('Complaints')],
    ['praise', t('Praise')],
    ['questions', t('Questions')],
    ['posts', t('Posts')],
    ['likes', t('Likes')],
    ['views', t('Views')],
  ]
  const active = CARDS.find(([k]) => k === metric) ?? CARDS[0]!
  const stream = reply.length ? reply : latest
  const live = (ins?.profiles ?? []).filter((p) => p.posts || p.comments || p.last_status)
  const maxWord = Math.max(1, ...(ins?.words ?? []).map((w) => w.n))
  const split = byLabel.filter((x) => x.n)
  const splitTotal = split.reduce((n, x) => n + x.n, 0)

  return (
    <div class="sm-overview sm-ga">
      <section class="sm-box sm-ga__report">
        <div class="sm-ga__cards" role="tablist" aria-label={t('What to chart')}>
          {CARDS.map(([k, label]) => {
            const now = sum(series?.now, k)
            const before = sum(series?.before, k)
            return (
              <button
                type="button"
                role="tab"
                aria-selected={metric === k}
                class="sm-ga__card"
                onClick={() => setMetric(k)}
              >
                <span class="sm-ga__label">{label}</span>
                <span class="sm-ga__value g-num">{short(now)}</span>
                <Delta now={now} before={series ? before : null} upIsGood={k !== 'complaints'} />
              </button>
            )
          })}
          <div class="sm-ga__card sm-ga__card--static">
            <span class="sm-ga__label" title={t('Waiting for an answer')}>
              {t('To answer')}
            </span>
            <span class={`sm-ga__value g-num${waiting ? ' sm-hot' : ''}`}>{fmt(waiting)}</span>
            <span class="sm-ga__sub">
              {r?.rate == null ? '' : t('{n}% answered', { n: Math.round(r.rate * 100) })}
            </span>
          </div>
          <div class="sm-ga__card sm-ga__card--static">
            <span class="sm-ga__label">{t('Reputation')}</span>
            <span class="sm-ga__value g-num">{ins?.reputation ?? '–'}</span>
            <Delta now={ins?.reputation ?? null} before={P?.reputation} points />
          </div>
        </div>
        {series && (
          <LineChart
            days={series.now.map((d) => d.day)}
            values={series.now.map((d) => d[active[0]])}
            previous={series.before.map((d) => d[active[0]])}
            label={active[1]}
          />
        )}
      </section>

      <div class="sm-layout sm-layout--top">
        <div class="sm-stack sm-span-6">
          <section class="sm-box sm-box--table">
            <header class="sm-box__head">
              <h2>{t('Accounts')}</h2>
              <a class="sm-box__link" href={`#/b/${brand.id}/about`}>
                {t('Edit links')}
              </a>
            </header>
            <div class="sm-scroll">
              <table class="sm-dtable">
                <thead>
                  <tr>
                    <th>{t('Account')}</th>
                    <th class="sm-num">{t('Posts')}</th>
                    <th class="sm-num">{t('Comments')}</th>
                    <th class="sm-num">{t('Views')}</th>
                    <th class="sm-num">{t('Complaints')}</th>
                    <th>{t('Updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(ins?.profiles ?? []).map((p) => (
                    <tr>
                      <td>
                        <span class="sm-net-name">
                          <NetworkMark network={p.network} size={14} />
                          <a href={p.url} target="_blank" rel="noreferrer">
                            @{p.handle}
                          </a>
                        </span>
                      </td>
                      <td class="sm-num g-num">{fmt(p.posts)}</td>
                      <td class="sm-num g-num">{fmt(p.comments)}</td>
                      <td class="sm-num g-num">{short(p.views)}</td>
                      <td class={`sm-num g-num${p.complaints ? ' sm-hot' : ''}`}>
                        {fmt(p.complaints)}
                      </td>
                      <td class="sm-nowrap">
                        {p.last_status === 'error' ? (
                          <span
                            class="sm-status sm-status--error"
                            title={p.last_error ?? undefined}
                          >
                            {t('Needs you')}
                          </span>
                        ) : p.last_status === 'ok' ? (
                          <span class="sm-status sm-status--ok" title={when(p.last_run_at)}>
                            {ago(p.last_run_at)}
                          </span>
                        ) : (
                          <span class="sm-status">{t('Not read yet')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {live.length === 0 && <p class="sm-quiet">{t('No posts in this period.')}</p>}
          </section>
          <div class="sm-pair">
            <section class="sm-box">
              <header class="sm-box__head">
                <h2>{t('What people say')}</h2>
                <span class="sm-box__meta">{t('{n} sorted', { n: fmt(lSorted) })}</span>
              </header>
              <ul class="sm-bars sm-bars--split">
                {split.map((x) => (
                  <li>
                    <span class="sm-bars__name">
                      <i class={`sm-swatch sm-c-${x.key}`} aria-hidden="true" /> {x.name}
                    </span>
                    <span class="sm-bars__track">
                      <span
                        class={`sm-bars__fill sm-c-${x.key}`}
                        style={{ width: `${Math.max(2, (x.n / Math.max(1, splitTotal)) * 100)}%` }}
                      />
                    </span>
                    <b class="g-num">{x.n}</b>
                  </li>
                ))}
              </ul>
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
          {(ins?.watched.length ?? 0) > 0 && (
            <section class="sm-box sm-box--table">
              <header class="sm-box__head">
                <h2>{t('Words you watch')}</h2>
                <a class="sm-box__link" href={`#/b/${brand.id}/about`}>
                  {t('Edit')}
                </a>
              </header>
              <table class="sm-dtable">
                <thead>
                  <tr>
                    <th>{t('Word')}</th>
                    <th class="sm-num">{t('Mentions')}</th>
                    <th class="sm-num">{t('Change')}</th>
                    <th class="sm-num">{t('Complaints')}</th>
                    <th class="sm-num">{t('Praise')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...ins!.watched]
                    .sort((a, b) => b.n - a.n)
                    .map((w) => (
                      <tr
                        class="sm-ctable__row"
                        onClick={() => {
                          sessionStorage.setItem('sm-q', w.term)
                          location.hash = `#/b/${brand.id}/comments`
                        }}
                      >
                        <td>
                          <span class="sm-net-name">
                            <span class={`sm-word sm-word--${WATCH_TONE[w.kind]}`}>
                              {t(WATCH_KIND[w.kind])}
                            </span>
                            <b>{w.term}</b>
                          </span>
                        </td>
                        <td class="sm-num g-num">{fmt(w.n)}</td>
                        <td class="sm-num">
                          <Delta now={w.n} before={w.before} />
                        </td>
                        <td class={`sm-num g-num${w.complaints ? ' sm-hot' : ''}`}>
                          {fmt(w.complaints)}
                        </td>
                        <td class="sm-num g-num">{fmt(w.praise)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          )}
        </div>

        <Scroller
          fit="column"
          class="sm-span-6"
          head={
            <header class="sm-box__head">
              <h2>{reply.length ? t('Answer first') : t('Newest comments')}</h2>
              <a class="sm-box__link" href={`#/b/${brand.id}/comments`}>
                {t('All comments')}
              </a>
            </header>
          }
        >
          {stream.length ? (
            <CommentList
              comments={stream}
              brands={brands}
              showPost
              onChange={() => setTick((x) => x + 1)}
            />
          ) : (
            <p class="sm-quiet">{t('Comments appear here after the first update.')}</p>
          )}
        </Scroller>

        <section class="sm-box sm-box--table sm-span-12">
          <header class="sm-box__head">
            <h2>{t('Posts')}</h2>
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
                  <th class="sm-num">{t('Shares')}</th>
                  <th class="sm-num">{t('Views')}</th>
                  <th>{t('What people say')}</th>
                  <th class="sm-num">{t('To answer')}</th>
                </tr>
              </thead>
              <tbody>
                {posts.slice(0, 8).map((p) => (
                  <tr class="sm-ctable__row" onClick={() => setOpenPost(p)}>
                    <td>
                      <span class="sm-postcell">
                        {p.thumb_url ? (
                          <img src={p.thumb_url} alt="" loading="lazy" />
                        ) : (
                          <span class="sm-postcell__blank" />
                        )}
                        <NetworkMark network={p.network} size={13} />
                        <span class="sm-postcell__text">{p.description ?? p.caption}</span>
                      </span>
                    </td>
                    <td class="sm-nowrap">{when(p.posted_at)}</td>
                    <td class="sm-num g-num">{fmt(p.likes)}</td>
                    <td class="sm-num g-num">{fmt(p.comments_count)}</td>
                    <td class="sm-num g-num">{fmt(p.shares)}</td>
                    <td class="sm-num g-num">{fmt(p.views)}</td>
                    <td class="sm-ga__mood">
                      <MoodStrip p={p} />
                    </td>
                    <td class={`sm-num g-num${p.waiting ? ' sm-hot' : ''}`}>{p.waiting || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="sm-layout sm-layout--top">
        <div class="sm-stack sm-span-8">
          <section class="sm-box">
            <header class="sm-box__head">
              <h2>{t('When people comment')}</h2>
              <span class="sm-box__meta">{t('By weekday and hour (UTC)')}</span>
            </header>
            {ins && (
              <Heatmap grid={ins.heatmap} days={weekdays} caption={t('When people comment')} />
            )}
          </section>
          <section class="sm-box">
            <header class="sm-box__head">
              <h2>{t('Words people use')}</h2>
            </header>
            {ins?.words.length ? (
              <ul class="sm-bars">
                {ins.words.slice(0, 8).map((w) => (
                  <li>
                    <span class="sm-bars__name">{w.word}</span>
                    <span class="sm-bars__track">
                      <span
                        class="sm-bars__fill sm-bars__fill--ink"
                        style={{ width: `${(w.n / maxWord) * 100}%` }}
                      />
                    </span>
                    <b class="g-num">{w.n}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="sm-quiet">{t('Words show once a few comments repeat them.')}</p>
            )}
          </section>
        </div>

        <Scroller
          fit="column"
          class="sm-span-4"
          head={
            <header class="sm-box__head">
              <h2>{t('Most active people')}</h2>
            </header>
          }
        >
          <table class="sm-dtable">
            <tbody>
              {(ins?.authors ?? []).map((a) => (
                <tr>
                  <td>
                    <a class="sm-person" href={a.url ?? undefined} target="_blank" rel="noreferrer">
                      {a.avatar ? (
                        <img class="sm-person__face" src={a.avatar} alt="" loading="lazy" />
                      ) : (
                        <NetworkMark network={a.network} size={13} />
                      )}
                      <span class="sm-person__name">{a.author}</span>
                    </a>
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
        </Scroller>
      </div>

      <PostDrawer post={openPost} brands={brands} onClose={() => setOpenPost(null)} />
    </div>
  )
}
