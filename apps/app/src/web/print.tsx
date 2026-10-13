import { useEffect, useState } from 'preact/hooks'
import type { BrandRow, CommentRow, Network, PostRow } from './api.ts'
import { api } from './api.ts'
import { Logo, NETWORK_NAME, NetworkMark, fmt, short, when } from './ui.tsx'
import { Heatmap, LineChart } from './charts.tsx'
import { brandCategories } from './rate.tsx'
import { locale, t } from './i18n.ts'
import { MoodStrip } from './social.tsx'
import type { ProfileStat } from './social.tsx'
import { CommentList } from './views/comments.tsx'

interface Insights {
  responses: {
    comments: number
    answered: number
    rate: number | null
    median_minutes: number | null
  }
  labels: Record<string, number>
  reputation: number | null
  reach: number
  previous: { labels: Record<string, number>; reputation: number | null; reach: number } | null
  profiles: ProfileStat[]
  heatmap: number[][]
  words: { word: string; n: number }[]
}
interface Summary {
  sentiment: { sentiment: string; category: string | null; n: number }[]
}
interface DayRow {
  day: string
  comments: number
  complaints: number
  praise: number
  likes: number
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The letterhead: the mark and what kind of report this is on one line, the brand large, then
 * the facts that frame it, labelled, between hairlines. Ink on paper, like a statement.
 */
function PrHead({
  title,
  kind,
  facts,
}: {
  title: string
  kind: string
  facts: [string, string][]
}) {
  return (
    <header class="sm-pr__head">
      <div class="sm-pr__top">
        <Logo />
        <span>{kind}</span>
      </div>
      <h1>{title}</h1>
      <dl class="sm-pr__meta">
        {facts.map(([k, v]) => (
          <div>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </header>
  )
}

/** The change against the period before, as a small coloured tag. */
function Change({
  now,
  before,
  upIsGood = true,
}: {
  now: number
  before?: number | null
  upIsGood?: boolean
}) {
  if (before == null || before === 0) return null
  const d = Math.round(((now - before) / before) * 100)
  const good = d === 0 ? null : d > 0 === upIsGood
  return (
    <span class={`sm-pr__chg${good === null ? '' : good ? ' is-good' : ' is-bad'}`}>
      {d > 0 ? '▲' : d < 0 ? '▼' : '±'} {Math.abs(d)}%
    </span>
  )
}

/**
 * The brand's report on paper: what the server turns into a PDF. The dashboard's own pieces —
 * figures with their change, the trend against the period before, coloured bars, the accounts,
 * the posts with their comment mood, and the comments to answer as bubbles with their tags.
 * Sets data-ready on <body> once everything has loaded, so the PDF never catches a half page.
 */
export function PrintReport({ brand }: { brand: BrandRow }) {
  const q = new URLSearchParams(location.search)
  const days = Number(q.get('days') ?? 30)
  const network = (q.get('network') ?? '') as Network | ''
  const n = network ? `&network=${network}` : ''
  const [ins, setIns] = useState<Insights | null>(null)
  const [sum, setSum] = useState<Summary | null>(null)
  const [reply, setReply] = useState<CommentRow[]>([])
  const [posts, setPosts] = useState<PostRow[]>([])
  const [series, setSeries] = useState<{ now: DayRow[]; before: DayRow[] } | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = 'light'
    const span = days || 365
    const d = (back: number) => iso(new Date(Date.now() - back * 86400_000))
    const daily = (a: string, b: string) =>
      api.get<DayRow[]>(`/api/brands/${brand.id}/daily?from=${a}&to=${b}${n}`)
    Promise.all([
      api.get<Insights>(`/api/brands/${brand.id}/insights?days=${days}${n}`).then(setIns),
      api
        .get<Summary>(`/api/brands/${brand.id}/summary${network ? `?network=${network}` : ''}`)
        .then(setSum),
      api
        .get<CommentRow[]>(
          `/api/comments?brand=${brand.id}&threads=1&reply=1&others=1&limit=12${n}`,
        )
        .then(async (r) =>
          // Nothing waiting: the latest comments stand in, so the report still shows what people said.
          setReply(
            r.length
              ? r
              : await api.get<CommentRow[]>(
                  `/api/comments?brand=${brand.id}&threads=1&others=1&limit=8${n}`,
                ),
          ),
        ),
      api.get<PostRow[]>(`/api/posts?brand=${brand.id}&limit=10${n}`).then(setPosts),
      Promise.all([daily(d(span - 1), d(0)), daily(d(2 * span - 1), d(span))]).then(
        ([now, before]) => setSeries({ now, before }),
      ),
    ])
      // Two frames: charts measure their width, then draw at it.
      .finally(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => (document.body.dataset.ready = '1')),
        ),
      )
  }, [])

  if (!ins || !sum) return null
  const L = ins.labels
  const P = ins.previous?.labels
  const total = L.total ?? 0
  const sorted = total - (L.unsorted ?? 0)
  const share = (k: string) => (sorted ? Math.round(((L[k] ?? 0) / sorted) * 100) : null)
  const cats = brandCategories(brand)
  const negatives = sum.sentiment
    .filter((x) => x.sentiment === 'negative')
    .sort((a, b) => b.n - a.n)
  const maxNeg = Math.max(1, ...negatives.map((x) => x.n))
  const split = (
    [
      ['complaint', t('Complaints')],
      ['question', t('Questions')],
      ['suggestion', t('Suggestions')],
      ['praise', t('Praise')],
    ] as const
  ).map(([k, name]) => ({ k: k as string, name, n: L[k] ?? 0 }))
  split.push({
    k: 'other',
    name: t('Other'),
    n: Math.max(0, sorted - split.reduce((s, x) => s + x.n, 0)),
  })
  const maxWord = Math.max(1, ...ins.words.map((w) => w.n))
  const period = days ? t('Last {n} days', { n: days }) : t('All time')
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 7 + i)).toLocaleDateString(locale, {
      weekday: 'short',
      timeZone: 'UTC',
    }),
  )
  const figures = [
    { label: t('Comments'), value: fmt(total), chg: <Change now={total} before={P?.total} /> },
    {
      label: t('Complaints'),
      value: share('complaint') == null ? '–' : `${share('complaint')}%`,
      chg: <Change now={L.complaint ?? 0} before={P?.complaint} upIsGood={false} />,
    },
    {
      label: t('Praise'),
      value: share('praise') == null ? '–' : `${share('praise')}%`,
      chg: <Change now={L.praise ?? 0} before={P?.praise} />,
    },
    {
      label: t('Reputation'),
      value: ins.reputation == null ? '–' : `${ins.reputation}`,
      chg: null,
    },
    {
      label: t('Answered by the brand'),
      value: ins.responses.rate == null ? '–' : `${Math.round(ins.responses.rate * 100)}%`,
      chg: null,
    },
    {
      label: t('Reach'),
      value: short(ins.reach),
      chg: <Change now={ins.reach} before={ins.previous?.reach} />,
    },
  ]

  return (
    <div class="sm-shell sm-shell--print">
      <article class="sm-pr sm-body">
        <PrHead
          title={brand.name}
          kind={t('Brand report')}
          facts={[
            [t('Period'), period],
            [t('Networks'), network ? NETWORK_NAME[network] : t('All networks')],
            ...(brand.industry ? [[t('Field of work'), brand.industry] as [string, string]] : []),
            [t('Prepared'), new Date().toLocaleDateString(locale, { dateStyle: 'long' })],
          ]}
        />

        <section class="sm-pr__figs">
          {figures.map((f) => (
            <div class="sm-pr__fig">
              <span class="sm-pr__label">{f.label}</span>
              <b class="g-num">{f.value}</b>
              {f.chg}
            </div>
          ))}
        </section>

        {series && (
          <section class="sm-pr__block">
            <h2>{t('Comments over time')}</h2>
            <LineChart
              days={series.now.map((d) => d.day)}
              values={series.now.map((d) => d.comments)}
              previous={series.before.map((d) => d.comments)}
              label={t('Comments')}
            />
            <p class="sm-pr__legend">
              <i class="sm-swatch sm-line__key" /> {period}
              <i class="sm-swatch sm-line__key sm-line__key--prev" /> {t('Period before')}
            </p>
          </section>
        )}

        <div class="sm-pr__two">
          <section class="sm-pr__block">
            <h2>{t('What people say')}</h2>
            <div class="sm-pr__stack">
              {split
                .filter((x) => x.n)
                .map((x) => (
                  <i class={`sm-c-${x.k}`} style={{ flex: x.n }} />
                ))}
            </div>
            <ul class="sm-pr__keys">
              {split.map((x) => (
                <li>
                  <i class={`sm-swatch sm-c-${x.k}`} />
                  <span>{x.name}</span>
                  <b class="g-num">{x.n}</b>
                  <span class="g-num">{sorted ? `${Math.round((x.n / sorted) * 100)}%` : '–'}</span>
                </li>
              ))}
            </ul>
          </section>

          <section class="sm-pr__block">
            <h2>{t('Problems people name')}</h2>
            {negatives.length ? (
              <ul class="sm-bars">
                {negatives.map((x) => (
                  <li>
                    <span class="sm-bars__name">
                      {cats.find((k) => k.key === x.category)?.name ?? t('No kind given')}
                    </span>
                    <span class="sm-bars__track">
                      <span
                        class="sm-bars__fill sm-c-complaint"
                        style={{ width: `${(x.n / maxNeg) * 100}%` }}
                      />
                    </span>
                    <b class="g-num">{x.n}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="sm-quiet">{t('No problems named in this period.')}</p>
            )}
          </section>
        </div>

        <section class="sm-pr__block">
          <h2>{t('Accounts')}</h2>
          <table class="sm-dtable">
            <thead>
              <tr>
                <th>{t('Account')}</th>
                <th class="sm-num">{t('Posts')}</th>
                <th class="sm-num">{t('Comments')}</th>
                <th class="sm-num">{t('Likes per post')}</th>
                <th class="sm-num">{t('Views')}</th>
                <th class="sm-num">{t('Complaints')}</th>
                <th class="sm-num">{t('Praise')}</th>
              </tr>
            </thead>
            <tbody>
              {ins.profiles.map((p) => (
                <tr>
                  <td>
                    <span class="sm-net-name">
                      <NetworkMark network={p.network} size={13} /> @{p.handle}
                    </span>
                  </td>
                  <td class="sm-num g-num">{fmt(p.posts)}</td>
                  <td class="sm-num g-num">{fmt(p.comments)}</td>
                  <td class="sm-num g-num">{p.likes_avg == null ? '–' : fmt(p.likes_avg)}</td>
                  <td class="sm-num g-num">{short(p.views)}</td>
                  <td class="sm-num g-num">
                    {p.complaints ? (
                      <span class="sm-pill-c sm-pill-c--bad">{p.complaints}</span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td class="sm-num g-num">
                    {p.praise ? <span class="sm-pill-c sm-pill-c--good">{p.praise}</span> : '0'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {posts.length > 0 && (
          <section class="sm-pr__block">
            <h2>{t('Posts')}</h2>
            <table class="sm-dtable">
              <thead>
                <tr>
                  <th>{t('Post')}</th>
                  <th>{t('Published')}</th>
                  <th class="sm-num">{t('Likes')}</th>
                  <th class="sm-num">{t('Comments')}</th>
                  <th class="sm-num">{t('Views')}</th>
                  <th>{t('What people say')}</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr>
                    <td>
                      <span class="sm-postcell">
                        {p.thumb_url ? (
                          <img src={p.thumb_url} alt="" />
                        ) : (
                          <span class="sm-postcell__blank" />
                        )}
                        <NetworkMark network={p.network} size={12} />
                        <span class="sm-postcell__text">{p.description ?? p.caption}</span>
                      </span>
                    </td>
                    <td class="sm-nowrap">{when(p.posted_at)}</td>
                    <td class="sm-num g-num">{fmt(p.likes)}</td>
                    <td class="sm-num g-num">{fmt(p.comments_count)}</td>
                    <td class="sm-num g-num">{fmt(p.views)}</td>
                    <td class="sm-pr__mood">
                      <MoodStrip p={p} />
                      {p.waiting > 0 && (
                        <span class="sm-pill-c sm-pill-c--wait">
                          {t('{n} to answer', { n: p.waiting })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section class="sm-pr__block sm-pr__comments">
          <h2>
            {reply.some((c) => c.needs_reply === 1 && c.reply_status === 'open')
              ? t('Waiting for an answer')
              : t('Newest comments')}
          </h2>
          {reply.length ? (
            <CommentList comments={reply} brands={[brand]} />
          ) : (
            <p class="sm-quiet">{t('Nothing waits for an answer.')}</p>
          )}
        </section>

        <div class="sm-pr__two">
          <section class="sm-pr__block">
            <h2>{t('When people comment')}</h2>
            <Heatmap grid={ins.heatmap} days={weekdays} caption={t('When people comment')} />
          </section>
          <section class="sm-pr__block">
            <h2>{t('Words people use')}</h2>
            <ul class="sm-pr__words">
              {ins.words.slice(0, 18).map((w) => (
                <li style={{ '--w': 0.3 + (w.n / maxWord) * 0.7 }}>
                  {w.word} <b class="g-num">{w.n}</b>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer class="sm-pr__foot">
          {t('SocialMonitor. Free and open source. Built by Shades Media Group.')}
        </footer>
      </article>
    </div>
  )
}

/**
 * The negative comments on paper: every comment rated negative or sorted as a complaint, in
 * groups by kind, largest group first, each as the bubbles the dashboard shows. From the last
 * days, or only those an update just read (`since`).
 */
export function PrintBad({ brand }: { brand: BrandRow }) {
  const q = new URLSearchParams(location.search)
  const days = Number(q.get('days') ?? 0)
  const since = q.get('since')
  const network = (q.get('network') ?? '') as Network | ''
  const [rows, setRows] = useState<CommentRow[] | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = 'light'
    const p = new URLSearchParams({
      brand: String(brand.id),
      bad: '1',
      others: '1',
      threads: '1',
      limit: '2000',
    })
    if (network) p.set('network', network)
    if (since) p.set('since', since)
    else if (days) p.set('from', new Date(Date.now() - days * 86400_000).toISOString())
    api
      .get<CommentRow[]>(`/api/comments?${p}`)
      .then(setRows)
      .catch(() => setRows([]))
  }, [brand.id])
  useEffect(() => {
    if (rows)
      requestAnimationFrame(() => requestAnimationFrame(() => (document.body.dataset.ready = '1')))
  }, [rows])
  if (!rows) return null

  const names = new Map(brandCategories(brand).map((c) => [c.key, c.name]))
  const groups = new Map<string, CommentRow[]>()
  for (const c of rows) {
    const k = c.category && names.has(c.category) ? names.get(c.category)! : t('Without a kind')
    groups.set(k, [...(groups.get(k) ?? []), c])
  }
  const list = [...groups].sort((a, b) => b[1].length - a[1].length)
  const max = Math.max(1, ...list.map(([, cs]) => cs.length))
  const period = since
    ? t('New since {when}', { when: when(since) })
    : days
      ? t('Last {n} days', { n: days })
      : t('All time')

  return (
    <div class="sm-shell sm-shell--print">
      <article class="sm-pr sm-body">
        <PrHead
          title={brand.name}
          kind={t('Negative comments')}
          facts={[
            [t('Period'), period],
            [t('Networks'), network ? NETWORK_NAME[network] : t('All networks')],
            [t('Negative comments'), fmt(rows.length)],
            [t('Prepared'), new Date().toLocaleDateString(locale, { dateStyle: 'long' })],
          ]}
        />

        <section class="sm-pr__block">
          <h2>
            {fmt(rows.length)} {t('negative comments, by kind')}
          </h2>
          {list.length ? (
            <ul class="sm-bars">
              {list.map(([name, cs]) => (
                <li>
                  <span class="sm-bars__name">{name}</span>
                  <span class="sm-bars__track">
                    <span
                      class="sm-bars__fill sm-c-complaint"
                      style={{ width: `${(cs.length / max) * 100}%` }}
                    />
                  </span>
                  <b class="g-num">{cs.length}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p class="sm-quiet">{t('No negative comments in this period.')}</p>
          )}
        </section>

        {list.map(([name, cs]) => (
          <section class="sm-pr__block sm-pr__comments">
            <h2>
              {name} <span class="sm-quiet">· {fmt(cs.length)}</span>
            </h2>
            <CommentList comments={cs} brands={[brand]} />
          </section>
        ))}

        <footer class="sm-pr__foot">
          {t('SocialMonitor. Free and open source. Built by Shades Media Group.')}
        </footer>
      </article>
    </div>
  )
}
