import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { PostRow } from '../api.ts'
import { api } from '../api.ts'
import { GrowthChart, Sparkline } from '../charts.tsx'
import type { Growth } from '../charts.tsx'
import { t } from '../i18n.ts'
import { usePref } from '../prefs.ts'
import { count, Empty, fmt, NetworkMark, Segmented, when } from '../ui.tsx'

type Metric = 'views' | 'likes' | 'comments' | 'shares'
type Reading = {
  post_id: number
  at: string
  likes: number | null
  comments: number | null
  shares: number | null
  views: number | null
}
type SortKey = 'posted' | Metric | 'rate' | 'grew'

/** The figure a post shows now, from its own row. */
const now = (p: PostRow, m: Metric) =>
  m === 'comments' ? p.comments_count : m === 'views' ? p.views : m === 'likes' ? p.likes : p.shares
/** Likes, comments and shares per view: null when the network gives no views. */
const rate = (p: PostRow) =>
  p.views ? ((p.likes ?? 0) + (p.comments_count ?? 0) + (p.shares ?? 0)) / p.views : null
const name = (p: PostRow) => (p.description ?? p.caption ?? t('No caption.')).slice(0, 80)
const pct = (r: number | null) => (r == null ? '–' : `${(r * 100).toFixed(1)}%`)

/**
 * Statistics: every post in the period as a table with its trend, one post's growth as a chart,
 * or two side by side at the same age.
 */
export function Stats({ brand, network, days, version }: BrandView) {
  const [posts, setPosts] = useState<PostRow[] | null>(null)
  const [history, setHistory] = useState<Reading[]>([])
  const [metric, setMetric] = usePref<Metric>('stats.metric', 'views')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'posted', desc: true })
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<number[]>([])

  useEffect(() => {
    const net = network ? `&network=${network}` : ''
    Promise.all([
      api.get<PostRow[]>(`/api/posts?brand=${brand.id}&limit=500${net}`),
      api.get<Reading[]>(`/api/post-history?brand=${brand.id}${net}`),
    ])
      .then(([p, h]) => {
        setPosts(p)
        setHistory(h)
      })
      .catch(() => setPosts([]))
  }, [brand.id, network, version])

  if (posts === null) return null
  if (!posts.length)
    return (
      <Empty title={t('No posts yet.')}>{t('Read the latest posts and their comments.')}</Empty>
    )

  const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : ''
  const q = query.trim().toLowerCase()
  const rows = posts
    .filter((p) => !since || (p.posted_at ?? '') >= since)
    .filter((p) => !q || `${p.caption ?? ''} ${p.description ?? ''}`.toLowerCase().includes(q))
  const value = (p: PostRow, k: SortKey) =>
    k === 'posted'
      ? Date.parse(p.posted_at ?? '') || 0
      : k === 'rate'
        ? (rate(p) ?? -1)
        : k === 'grew'
          ? (p.grew_7d ?? -1)
          : (now(p, k) ?? -1)
  rows.sort((a, b) => (value(b, sort.key) - value(a, sort.key)) * (sort.desc ? 1 : -1))

  const readings = new Map<number, Reading[]>()
  for (const r of history) readings.set(r.post_id, [...(readings.get(r.post_id) ?? []), r])

  // Nothing picked yet: the post with the most of the chosen figure in the period.
  const top = [...rows].sort((a, b) => (now(b, metric) ?? 0) - (now(a, metric) ?? 0))[0]
  const shown = (picked.length ? picked : top ? [top.id] : [])
    .map((id) => posts.find((p) => p.id === id))
    .filter((p): p is PostRow => !!p)
  const toggle = (id: number) =>
    setPicked((list) => {
      const base = list.length ? list : top ? [top.id] : []
      if (base.includes(id)) return base.filter((x) => x !== id)
      // Two at most: a third pick replaces the older one.
      return [...base, id].slice(-2)
    })

  /**
   * A post's line: 0 when it went out (every post starts there), then each reading. A post read
   * before history was kept still has its latest figure, from the last time it was read.
   */
  const line = (p: PostRow) => {
    const posted = Date.parse(p.posted_at ?? '')
    const kept = (readings.get(p.id) ?? []).filter((r) => r[metric] != null)
    const read = kept.length
      ? kept.map((r) => ({ at: r.at, value: r[metric]! }))
      : now(p, metric) != null
        ? [{ at: p.fetched_at, value: now(p, metric)! }]
        : []
    const start = Number.isFinite(posted) ? posted : Date.parse(read[0]?.at ?? '')
    const pts = read.map((r) => ({
      day: Math.max(0, (Date.parse(r.at) - start) / 86400_000),
      at: r.at,
      value: r.value,
    }))
    return Number.isFinite(posted) && pts.length && pts[0]!.day > 0
      ? [{ day: 0, at: p.posted_at!, value: 0 }, ...pts]
      : pts
  }
  const series: Growth[] = shown.map((p, i) => ({
    key: i ? 'b1' : 'b0',
    name: name(p),
    points: line(p),
  }))
  const METRICS: [Metric, string][] = [
    ['views', t('Views')],
    ['likes', t('Likes')],
    ['comments', t('Comments')],
    ['shares', t('Shares')],
  ]
  const metricName = METRICS.find(([k]) => k === metric)![1]
  const head = (k: SortKey, label: string, num = true) => (
    <th
      class={num ? 'sm-num' : undefined}
      aria-sort={sort.key === k ? (sort.desc ? 'descending' : 'ascending') : undefined}
    >
      <button
        type="button"
        class="sm-sortbtn"
        onClick={() => setSort({ key: k, desc: sort.key === k ? !sort.desc : true })}
      >
        {label}
      </button>
    </th>
  )
  const [a, b] = shown

  return (
    <div class="sm-stats">
      <div class="sm-toolbar">
        <Segmented label={t('Show')} value={metric} onChange={setMetric} options={METRICS} />
        <input
          class="g-input sm-search"
          type="search"
          placeholder={t('Find a post by its words or hashtags')}
          aria-label={t('Find a post by its words or hashtags')}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>

      <section class="sm-box">
        <header class="sm-box__head">
          <h2>
            {shown.length > 1 ? t('Two posts, day by day') : t('How the post grew, day by day')}
          </h2>
          <span class="sm-box__meta">
            {t('Pick a post in the table to see it, or two to compare them.')}
          </span>
        </header>
        {series.some((s) => s.points.length > 1) ? (
          <GrowthChart series={series} label={metricName} />
        ) : (
          <p class="sm-quiet sm-stats__none">
            {t('Its history builds up with each update that reads it again.')}
          </p>
        )}
        {a && b && (
          <table class="sm-dtable sm-stats__cmp">
            <thead>
              <tr>
                <th />
                <th class="sm-num">
                  <i class="sm-swatch sm-c-b0" aria-hidden="true" /> {name(a).slice(0, 40)}
                </th>
                <th class="sm-num">
                  <i class="sm-swatch sm-c-b1" aria-hidden="true" /> {name(b).slice(0, 40)}
                </th>
                <th class="sm-num">{t('Difference')}</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map(([k, label]) => {
                const va = now(a, k)
                const vb = now(b, k)
                return (
                  <tr>
                    <th scope="row">{label}</th>
                    <td class="sm-num g-num">{fmt(va)}</td>
                    <td class="sm-num g-num">{fmt(vb)}</td>
                    <td class="sm-num g-num">
                      {va == null || vb == null
                        ? '–'
                        : `${vb - va > 0 ? '+' : ''}${fmt(vb - va)}${va ? ` (${vb - va > 0 ? '+' : ''}${Math.round(((vb - va) / va) * 100)}%)` : ''}`}
                    </td>
                  </tr>
                )
              })}
              <tr>
                <th scope="row">{t('Engagement')}</th>
                <td class="sm-num g-num">{pct(rate(a))}</td>
                <td class="sm-num g-num">{pct(rate(b))}</td>
                <td class="sm-num g-num">
                  {rate(a) == null || rate(b) == null
                    ? '–'
                    : `${rate(b)! - rate(a)! > 0 ? '+' : ''}${((rate(b)! - rate(a)!) * 100).toFixed(1)} pt`}
                </td>
              </tr>
              <tr>
                <th scope="row">{t('Published')}</th>
                <td class="sm-num">{when(a.posted_at)}</td>
                <td class="sm-num">{when(b.posted_at)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section class="sm-box">
        <header class="sm-box__head">
          <h2>{count(rows.length, 'post')}</h2>
          <span class="sm-box__meta">
            {t('Trend: {metric} at each update', { metric: metricName })}
          </span>
        </header>
        <div class="sm-scroll">
          <table class="sm-dtable sm-dtable--rows sm-stats__table">
            <thead>
              <tr>
                <th class="sm-stats__pick">
                  <span class="sm-sr">{t('Pick')}</span>
                </th>
                <th>{t('Post')}</th>
                {head('posted', t('Published'), false)}
                {head('views', t('Views'))}
                {head('likes', t('Likes'))}
                {head('comments', t('Comments'))}
                {head('shares', t('Shares'))}
                {head('rate', t('Engagement'))}
                {head('grew', t('7 days'))}
                <th>{t('Trend')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const at = shown.findIndex((s) => s.id === p.id)
                // Only real history: two readings or more, without the starting zero.
                const kept = (readings.get(p.id) ?? []).filter((r) => r[metric] != null)
                const trend = kept.length > 1 ? line(p).map((x) => x.value) : []
                return (
                  <tr
                    class={`sm-ctable__row${at >= 0 ? ' is-picked' : ''}`}
                    onClick={() => toggle(p.id)}
                  >
                    <td class="sm-stats__pick">
                      <input
                        type="checkbox"
                        checked={at >= 0}
                        aria-label={t('Pick {post}', { post: name(p).slice(0, 40) })}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(p.id)}
                      />
                      {at >= 0 && <i class={`sm-swatch sm-c-b${at}`} aria-hidden="true" />}
                    </td>
                    <td>
                      <span class="sm-postcell">
                        {p.thumb_url ? (
                          <img src={p.thumb_url} alt="" loading="lazy" />
                        ) : (
                          <span class="sm-postcell__blank" />
                        )}
                        <NetworkMark network={p.network} size={14} />
                        <span class="sm-postcell__text">{name(p)}</span>
                      </span>
                    </td>
                    <td class="sm-nowrap">{when(p.posted_at)}</td>
                    <td class="sm-num g-num">{fmt(p.views)}</td>
                    <td class="sm-num g-num">{fmt(p.likes)}</td>
                    <td class="sm-num g-num">{fmt(p.comments_count)}</td>
                    <td class="sm-num g-num">{fmt(p.shares)}</td>
                    <td class="sm-num g-num">{pct(rate(p))}</td>
                    <td class="sm-num g-num sm-grew">
                      {p.grew_7d == null ? '–' : `${p.grew_7d > 0 ? '+' : ''}${fmt(p.grew_7d)}`}
                    </td>
                    <td>{trend.length > 1 ? <Sparkline values={trend} tone="blue" /> : '–'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
