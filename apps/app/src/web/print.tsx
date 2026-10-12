import { useEffect, useState } from 'preact/hooks'
import type { BrandRow, CommentRow, PostRow } from './api.ts'
import { api } from './api.ts'
import { Logo, NETWORK_NAME, count, fmt, when } from './ui.tsx'
import { MoodBar } from './labels.tsx'
import { EngagementChart, TimelineChart } from './charts.tsx'
import type { PostPoint } from './charts.tsx'
import { brandCategories } from './rate.tsx'
import { locale, t } from './i18n.ts'

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
interface Summary {
  sentiment: { sentiment: string; category: string | null; n: number }[]
}

/**
 * The brand's report on paper: what the server turns into a PDF. A4, the same Gradient type,
 * charts and words as the dashboard, without the controls. Sets data-ready on <body> once
 * everything has loaded, so the PDF is never taken of a half-drawn page.
 */
export function PrintReport({ brand }: { brand: BrandRow }) {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '')
  const days = Number(q.get('days') ?? 30)
  const network = q.get('network') ?? ''
  const n = network ? `&network=${network}` : ''
  const [ins, setIns] = useState<Insights | null>(null)
  const [sum, setSum] = useState<Summary | null>(null)
  const [reply, setReply] = useState<CommentRow[]>([])
  const [posts, setPosts] = useState<PostRow[]>([])

  useEffect(() => {
    document.documentElement.dataset.theme = 'light'
    Promise.all([
      api.get<Insights>(`/api/brands/${brand.id}/insights?days=${days}${n}`).then(setIns),
      api
        .get<Summary>(`/api/brands/${brand.id}/summary${network ? `?network=${network}` : ''}`)
        .then(setSum),
      api
        .get<CommentRow[]>(`/api/comments?brand=${brand.id}&reply=1&others=1&limit=15${n}`)
        .then(setReply),
      api.get<PostRow[]>(`/api/posts?brand=${brand.id}&limit=12${n}`).then(setPosts),
    ]).finally(() => requestAnimationFrame(() => (document.body.dataset.ready = '1')))
  }, [])

  if (!ins || !sum) return null
  const c = ins.labels
  const sorted = (c.total ?? 0) - (c.unsorted ?? 0)
  const pct = (k: string) => (sorted ? Math.round(((c[k] ?? 0) / sorted) * 100) : 0)
  const cats = brandCategories(brand)
  const negatives = sum.sentiment.filter((x) => x.sentiment === 'negative')
  const date = new Date().toLocaleDateString(locale, { dateStyle: 'long' })
  const total = fmt(c.total ?? 0)

  return (
    <article class="sm-print">
      <header class="sm-print__head">
        <Logo />
        <span class="sm-quiet">
          {days
            ? t('Report of {date}, the last {days} days', { date, days })
            : t('Report of {date}, all time', { date })}
          {network ? `, ${NETWORK_NAME[network as keyof typeof NETWORK_NAME]}` : ''}
        </span>
      </header>
      <h1>{brand.name}</h1>
      {brand.industry && <p class="sm-head__industry">{brand.industry}</p>}

      <p class="sm-print__statement">
        {days
          ? t('{n} customer comments in the last {days} days.', { n: total, days })
          : t('{n} customer comments in all time.', { n: total })}{' '}
        {sorted
          ? t('Complaints are {complaint}%, praise {praise}%.', {
              complaint: pct('complaint'),
              praise: pct('praise'),
            })
          : t('None are sorted yet.')}{' '}
        {ins.responses.rate != null &&
          t('{brand} answered {pct}% of them.', {
            brand: brand.name,
            pct: Math.round(ins.responses.rate * 100),
          })}
      </p>

      <dl class="sm-facts sm-facts--row">
        <div>
          <dt>{t('Reputation')}</dt>
          <dd class="g-num">{ins.reputation == null ? '–' : `${ins.reputation} / 100`}</dd>
        </div>
        <div>
          <dt>{t('Reach (views)')}</dt>
          <dd class="g-num">{fmt(ins.reach)}</dd>
        </div>
        <div>
          <dt>{t('Posts')}</dt>
          <dd class="g-num">{fmt(ins.posts.length)}</dd>
        </div>
        <div>
          <dt>{t('Usual time to answer')}</dt>
          <dd class="g-num">
            {ins.responses.median_minutes == null
              ? '–'
              : t('{n} min', { n: ins.responses.median_minutes })}
          </dd>
        </div>
      </dl>

      {sorted > 0 && (
        <section>
          <h2>{t('What people say')}</h2>
          <MoodBar counts={c} />
        </section>
      )}

      <section>
        <h2>{t('Comments over time')}</h2>
        <TimelineChart days={ins.timeline} />
      </section>

      {ins.posts.length > 0 && (
        <section>
          <h2>{t('Likes per post')}</h2>
          <EngagementChart posts={ins.posts} />
        </section>
      )}

      {negatives.length > 0 && (
        <section>
          <h2>{t('Problems people name')}</h2>
          <table class="g-table sm-table">
            <tbody>
              {negatives.map((x) => (
                <tr>
                  <td>{cats.find((k) => k.key === x.category)?.name ?? t('No kind given')}</td>
                  <td class="g-num">{x.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>{t('Waiting for an answer')}</h2>
        {reply.length ? (
          <ul class="sm-print__list">
            {reply.map((r) => (
              <li>
                <b>{r.author}</b> · {NETWORK_NAME[r.network]} · {when(r.posted_at)}
                <p>{r.text}</p>
                {r.reason && <p class="sm-quiet">{r.reason}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p class="sm-quiet">{t('Nothing waits for an answer.')}</p>
        )}
      </section>

      {posts.length > 0 && (
        <section>
          <h2>{t('Latest posts')}</h2>
          <table class="g-table sm-table">
            <thead>
              <tr>
                <th>{t('Published')}</th>
                <th>{t('Network')}</th>
                <th>{t('Topic')}</th>
                <th>{t('Engagement')}</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr>
                  <td>{when(p.posted_at)}</td>
                  <td>{NETWORK_NAME[p.network]}</td>
                  <td>{(p.description ?? p.caption).slice(0, 140)}</td>
                  <td class="g-num">
                    {count(p.likes, 'like')}, {count(p.comments_count, 'comment')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer class="sm-print__foot">
        {t('SocialMonitor. Free and open source. Built by Shades Media Group.')}
      </footer>
    </article>
  )
}
