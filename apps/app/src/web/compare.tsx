import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import { api } from './api.ts'
import { Chips, Empty, Head, fmt, short } from './ui.tsx'
import { usePref } from './prefs.ts'
import { BrandLines } from './charts.tsx'
import { JsonPanel } from './json.tsx'
import { t } from './i18n.ts'

/** One brand's figures for the period, as /api/compare sends them. */
export interface CompareRow {
  id: number
  name: string
  comments: number
  complaints: number
  questions: number
  praise: number
  positive_share: number | null
  negative_share: number | null
  posts: number
  likes: number
  reach: number
  engagement_rate: number | null
  response_rate: number | null
  overdue: number
  share_of_voice: number | null
  per_day: { day: string; n: number }[]
}

const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`)
const pct1 = (x: number | null) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`)

type Key = Exclude<keyof CompareRow, 'id' | 'name' | 'per_day'>
/** Each row of the table: its name, the figure, whether more is better, and how it reads. */
export const METRICS: [string, Key, 'high' | 'low', (v: number | null) => string][] = [
  [t('Comments'), 'comments', 'high', fmt],
  [t('Complaints'), 'complaints', 'low', fmt],
  [t('Questions'), 'questions', 'high', fmt],
  [t('Praise'), 'praise', 'high', fmt],
  [t('Positive'), 'positive_share', 'high', pct],
  [t('Negative'), 'negative_share', 'low', pct],
  [t('Share of voice'), 'share_of_voice', 'high', pct],
  [t('Posts'), 'posts', 'high', fmt],
  [t('Likes'), 'likes', 'high', short],
  [t('Views'), 'reach', 'high', short],
  [t('Engagement rate'), 'engagement_rate', 'high', pct1],
  [t('Reply rate'), 'response_rate', 'high', pct],
  [t('Overdue'), 'overdue', 'low', fmt],
]

/** The best value in a row, or null when there is no contest (one brand, or all the same). */
export function leader(values: (number | null)[], better: 'high' | 'low') {
  const known = values.filter((v): v is number => v != null)
  if (known.length < 2 || known.every((v) => v === known[0])) return null
  return better === 'high' ? Math.max(...known) : Math.min(...known)
}

/** Brands across, figures down; the leader of each row in bold. */
export function CompareTable({
  rows,
  only = METRICS,
}: {
  rows: CompareRow[]
  only?: typeof METRICS
}) {
  return (
    <div class="sm-scroll">
      <table class="sm-dtable sm-cmp">
        <thead>
          <tr>
            <th>{t('Period figures')}</th>
            {rows.map((r, i) => (
              <th class="sm-num" scope="col">
                <span class="sm-cmp__brand">
                  <i class={`sm-swatch sm-c-b${i % 6}`} aria-hidden="true" />
                  {r.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {only.map(([label, key, better, show]) => {
            const best = leader(
              rows.map((r) => r[key]),
              better,
            )
            return (
              <tr>
                <th scope="row">{label}</th>
                {rows.map((r) => (
                  <td class="sm-num g-num">
                    {best != null && r[key] === best ? <b>{show(r[key])}</b> : show(r[key])}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Days into weeks when the period is long, so a year reads as 52 points instead of 365. */
export function bucket(perDay: { day: string; n: number }[], size: number) {
  const out = { days: [] as string[], values: [] as number[] }
  for (let i = 0; i < perDay.length; i += size) {
    out.days.push(perDay[i]!.day)
    out.values.push(perDay.slice(i, i + size).reduce((a, d) => a + d.n, 0))
  }
  return out
}

/** Two to four brands you can see, side by side over the same period. */
export function Compare({ brands, mode, actions, notify, version }: AppState) {
  const [picked, setPicked] = usePref<string[]>(
    'compare.brands',
    brands.slice(0, 2).map((b) => String(b.id)),
  )
  const [days, setDays] = usePref<number>('compare.days', 30)
  const ids = picked.filter((id) => brands.some((b) => String(b.id) === id))
  const [rows, setRows] = useState<CompareRow[] | null>(null)
  useEffect(() => {
    if (!ids.length) {
      setRows([])
      return
    }
    api
      .get<CompareRow[]>(`/api/compare?days=${days}&brands=${ids.join(',')}`)
      .then((list) =>
        setRows(ids.map((id) => list.find((r) => String(r.id) === id)!).filter(Boolean)),
      )
      .catch(() => setRows([]))
  }, [ids.join(), days, version])

  const week = days > 90 ? 7 : 1
  const series = (rows ?? []).map((r, i) => ({
    name: r.name,
    tone: `b${i % 6}`,
    ...bucket(r.per_day, week),
  }))

  return (
    <main class="sm-page">
      <Head title={t('Compare brands')} sub={t('Same period, side by side')} actions={actions}>
        <Chips
          label={t('Brands')}
          values={ids}
          options={brands.map((b) => [String(b.id), b.name])}
          onChange={(next) =>
            next.length > 4 ? notify(t('Compare up to four brands at a time.')) : setPicked(next)
          }
        />
        <span class="sm-pagehead__spacer" />
        <select
          class="g-select sm-select-sm"
          aria-label={t('Period')}
          value={days}
          onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}
        >
          <option value={7}>{t('Last 7 days')}</option>
          <option value={30}>{t('Last 30 days')}</option>
          <option value={90}>{t('Last 90 days')}</option>
          <option value={365}>{t('Last 12 months')}</option>
        </select>
      </Head>
      <div class="sm-body sm-stack">
        {ids.length < 2 ? (
          <Empty title={t('Choose two brands or more.')}>
            {t('Pick up to four above to see them side by side.')}
          </Empty>
        ) : !rows ? null : mode === 'json' ? (
          <JsonPanel value={rows} />
        ) : (
          <>
            <section class="sm-box sm-box--table">
              <header class="sm-box__head">
                <h2>{t('Side by side')}</h2>
                <span class="sm-box__meta">{t('The leader of each row is in bold')}</span>
              </header>
              <CompareTable rows={rows} />
            </section>
            <section class="sm-box">
              <header class="sm-box__head">
                <h2>{week > 1 ? t('Comments per week') : t('Comments per day')}</h2>
              </header>
              <BrandLines
                label={week > 1 ? t('Comments per week') : t('Comments per day')}
                days={series[0]?.days ?? []}
                series={series}
              />
            </section>
          </>
        )}
      </div>
    </main>
  )
}
