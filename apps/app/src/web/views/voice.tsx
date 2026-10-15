import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import { api } from '../api.ts'
import { Empty, fmt } from '../ui.tsx'
import { BrandLines } from '../charts.tsx'
import { JsonPanel } from '../json.tsx'
import { t } from '../i18n.ts'
import type { CompareRow, Metric } from '../compare.tsx'
import { CompareTable, METRICS, pct } from '../compare.tsx'
import { useRivals } from './rivals.tsx'
import { voiceTrend } from '../trend.ts'

/** Below this many comments in the period, a brand's shares swing on a handful of people. */
const LITTLE = 20

const ROWS: Metric[] = [
  [t('Share of voice'), 'share_of_voice', 'high', pct],
  ...METRICS.filter(([, k]) => k === 'comments'),
  [t('Positive'), 'positive_share', 'high', pct],
  [t('Neutral'), 'neutral_share', 'none', pct],
  [t('Negative'), 'negative_share', 'low', pct],
  ...METRICS.filter(([, k]) => k === 'posts'),
  [t('Engagement per post'), 'interactions_per_post', 'high', fmt],
  ...METRICS.filter(([, k]) => k === 'engagement_rate'),
]

/** Days per point on the trend: daily for a week, then wider steps so each point has comments. */
const STEP: Record<number, number> = { 7: 1, 30: 3, 90: 7, 365: 30 }

/** The brand against the rivals it watches: who gets talked about, how warmly, and over time. */
export function Voice({ brand, network, days, version, mode }: BrandView) {
  const [rivals] = useRivals(brand.id, version)
  const [rows, setRows] = useState<CompareRow[] | null>(null)
  useEffect(() => {
    api
      .get<CompareRow[]>(
        `/api/brands/${brand.id}/voice?days=${days}${network ? `&network=${network}` : ''}`,
      )
      .then(setRows)
      .catch(() => setRows([]))
  }, [brand.id, network, days, version, rivals?.length])

  if (!rows || !rivals) return null
  if (rows.length < 2)
    return (
      <Empty title={t('No rivals yet.')}>
        {brand.my_role === 'admin' ? (
          <>
            {t('Add the brands you compete with in Settings, then press Update.')}{' '}
            <a href={`/b/${brand.id}/settings`}>{t('Open Settings')}</a>
          </>
        ) : (
          t("Ask one of this brand's admins to add the brands it competes with.")
        )}
      </Empty>
    )
  if (mode === 'json') return <JsonPanel value={rows} />

  const thin = rows.filter((r) => r.comments < LITTLE).map((r) => r.name)
  const trend = voiceTrend(
    rows.map((r) => r.per_day),
    STEP[days] ?? 30,
  )
  const tone = (i: number) => `b${i % 6}`
  return (
    <div class="sm-stack">
      {thin.length > 0 && (
        <p class="sm-quiet">
          {t(
            'Little to go on for {names}: fewer than {n} comments in this period, so their shares can swing on a few people.',
            { names: thin.join(', '), n: LITTLE },
          )}
        </p>
      )}
      <div class="sm-layout">
        <section class="sm-box sm-span-4">
          <header class="sm-box__head">
            <h2>{t('Share of voice')}</h2>
            <span class="sm-box__meta">{t('Of all comments under their posts')}</span>
          </header>
          <ul class="sm-bars">
            {rows.map((r, i) => (
              <li>
                <span class="sm-bars__name">{r.name}</span>
                <span class="sm-bars__track">
                  <span
                    class={`sm-bars__fill sm-c-${tone(i)}`}
                    style={{ width: `${Math.max(2, (r.share_of_voice ?? 0) * 100)}%` }}
                  />
                </span>
                <b class="g-num">{pct(r.share_of_voice)}</b>
              </li>
            ))}
          </ul>
          <h3 class="sm-voice__sub">{t('How people feel')}</h3>
          <ul class="sm-netbars">
            {rows.map((r) => (
              <li>
                <span class="sm-bars__name">{r.name}</span>
                <span
                  class="sm-netbars__track"
                  title={`${t('Positive')} ${pct(r.positive_share)} · ${t('Neutral')} ${pct(r.neutral_share)} · ${t('Negative')} ${pct(r.negative_share)}`}
                >
                  {r.positive_share == null ? null : (
                    <>
                      <span class="sm-c-praise" style={{ flex: r.positive_share }} />
                      <span class="sm-c-other" style={{ flex: r.neutral_share ?? 0 }} />
                      <span class="sm-c-complaint" style={{ flex: r.negative_share ?? 0 }} />
                    </>
                  )}
                </span>
                <b class="g-num">{pct(r.positive_share)}</b>
              </li>
            ))}
          </ul>
          <div class="sm-legend">
            <span>
              <i class="sm-swatch sm-c-praise" aria-hidden="true" />
              {t('Positive')}
            </span>
            <span>
              <i class="sm-swatch sm-c-other" aria-hidden="true" />
              {t('Neutral')}
            </span>
            <span>
              <i class="sm-swatch sm-c-complaint" aria-hidden="true" />
              {t('Negative')}
            </span>
          </div>
        </section>
        <section class="sm-box sm-span-8">
          <header class="sm-box__head">
            <h2>{t('Share of voice over time')}</h2>
          </header>
          <BrandLines
            percent
            label={t('Share of voice over time')}
            days={trend.days}
            series={rows.map((r, i) => ({
              name: r.name,
              tone: tone(i),
              values: trend.shares[i]!,
            }))}
          />
        </section>
      </div>
      <section class="sm-box sm-box--table">
        <header class="sm-box__head">
          <h2>{t('Side by side')}</h2>
          <span class="sm-box__meta">{t('The leader of each row is in bold')}</span>
        </header>
        <CompareTable rows={rows} only={ROWS} />
      </section>
    </div>
  )
}
