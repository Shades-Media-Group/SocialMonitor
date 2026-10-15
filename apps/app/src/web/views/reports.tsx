import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { RunRow } from '../api.ts'
import { api } from '../api.ts'
import { Empty, Menu, NETWORK_NAME, count, when } from '../ui.tsx'
import { renderReport } from '../markdown.tsx'
import { JsonPanel } from '../json.tsx'
import { t } from '../i18n.ts'
import type { Growth } from '../growth.tsx'
import { GrowthLists } from '../growth.tsx'
import { CampaignBox } from '../campaigns.tsx'

const STATUS: Record<string, string> = {
  ok: t('Done'),
  partial: t('Done, with gaps'),
  error: t('Failed'),
  running: t('Reading now'),
}

interface Saved {
  id: number
  kind: string
  filename: string
  size: number
  params: string
  created_by_name: string | null
  created_at: string
}

const KIND: Record<string, string> = { pdf: 'PDF', xlsx: 'Excel', csv: 'CSV' }

/** Every report and export made for this brand, newest first, to open again. */
function SavedFiles({ brand, version, notify }: Pick<BrandView, 'brand' | 'version' | 'notify'>) {
  const [rows, setRows] = useState<Saved[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    api
      .get<Saved[]>(`/api/brands/${brand.id}/saved`)
      .then(setRows)
      .catch(() => setRows([]))
  }, [brand.id, version, tick])
  if (!rows) return null
  const admin = brand.my_role === 'admin'
  return (
    <section class="sm-box sm-box--table sm-saved">
      <header class="sm-box__head">
        <h2>{t('Saved reports and exports')}</h2>
        <span class="sm-box__meta">
          {t('Every PDF, Excel and CSV made for this brand, kept to open again')}
        </span>
      </header>
      {rows.length ? (
        <div class="sm-scroll">
          <table class="sm-dtable sm-dtable--rows">
            <thead>
              <tr>
                <th>{t('Made')}</th>
                <th>{t('File')}</th>
                <th>{t('Period')}</th>
                <th>{t('Network')}</th>
                <th>{t('By')}</th>
                <th class="sm-num">{t('Size')}</th>
                <th class="sm-num">
                  <span class="sm-sr">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = JSON.parse(r.params || '{}') as { days?: string; network?: string }
                return (
                  <tr>
                    <td class="sm-nowrap">{when(r.created_at)}</td>
                    <td>
                      <a class="sm-saved__file" href={`/api/saved/${r.id}/file`} download>
                        <span class="sm-saved__kind">{KIND[r.kind] ?? r.kind}</span>
                        {r.filename}
                      </a>
                    </td>
                    <td class="sm-nowrap">
                      {p.days === '0'
                        ? t('All time')
                        : p.days
                          ? t('Last {days}', { days: count(Number(p.days), 'day') })
                          : '–'}
                    </td>
                    <td>
                      {p.network
                        ? NETWORK_NAME[p.network as keyof typeof NETWORK_NAME]
                        : t('All networks')}
                    </td>
                    <td>{r.created_by_name ?? '–'}</td>
                    <td class="sm-num g-num">
                      {r.size < 1024 * 1024
                        ? `${Math.max(1, Math.round(r.size / 1024))} KB`
                        : `${(r.size / 1024 / 1024).toFixed(1)} MB`}
                    </td>
                    <td class="sm-num">
                      <Menu
                        label={t('Actions')}
                        items={[
                          {
                            label: t('Download'),
                            onSelect: () => (location.href = `/api/saved/${r.id}/file`),
                          },
                          ...(admin
                            ? [
                                {
                                  label: t('Delete'),
                                  danger: true,
                                  onSelect: () =>
                                    confirm(t('Delete {name}?', { name: r.filename })) &&
                                    api
                                      .del(`/api/saved/${r.id}`)
                                      .then(() => setTick((x) => x + 1))
                                      .catch((e: Error) => notify(e.message)),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="sm-quiet">{t('Reports you make with Export are kept here.')}</p>
      )}
    </section>
  )
}

/** The posts that gained most in the chosen period, from each post's own history. */
function GrowthBox({ brand, version, days, network }: BrandView) {
  const [g, setG] = useState<Growth | null>(null)
  useEffect(() => {
    api
      .get<Growth>(
        `/api/brands/${brand.id}/growth?days=${days}${network ? `&network=${network}` : ''}`,
      )
      .then(setG)
      .catch(() => setG(null))
  }, [brand.id, version, days, network])
  if (!g) return null
  return (
    <section class="sm-box sm-box--table">
      <header class="sm-box__head">
        <h2>{t('Posts that grew most')}</h2>
        <span class="sm-box__meta">
          {days ? t('Last {days}', { days: count(days, 'day') }) : t('All time')}
        </span>
      </header>
      <GrowthLists g={g} />
    </section>
  )
}

/** Every update of this brand on the left; the report of the chosen one on the right. */
export function Reports(view: BrandView) {
  const { brand, version, running, mode, openUpdate, notify } = view
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [open, setOpen] = useState<RunRow | null>(null)

  useEffect(() => {
    api
      .get<RunRow[]>(`/api/runs?brand=${brand.id}`)
      .then((r) => {
        setRuns(r)
        const pick = open && r.some((x) => x.id === open.id) ? open.id : r[0]?.id
        if (pick) api.get<RunRow>(`/api/runs/${pick}`).then(setOpen)
        else setOpen(null)
      })
      .catch(() => setRuns([]))
  }, [brand.id, version, running?.id])

  if (runs === null) return null
  if (!runs.length)
    return (
      <div class="sm-stack">
        <SavedFiles brand={brand} version={version} notify={notify} />
        <GrowthBox {...view} />
        <CampaignBox brand={brand} version={version} />
        <Empty title={t('No reports yet.')}>
          {t(
            'Every update ends with one: the posts read, the comments to answer, and what changed.',
          )}{' '}
          <button class="sm-textbtn" type="button" onClick={() => openUpdate(brand.id)}>
            {t('Update now')}
          </button>
        </Empty>
      </div>
    )

  if (mode === 'json')
    return (
      <JsonPanel
        value={
          open
            ? {
                id: open.id,
                status: open.status,
                trigger: open.trigger,
                started_at: open.started_at,
                finished_at: open.finished_at,
                scope: JSON.parse(open.scope),
                stats: open.stats ? JSON.parse(open.stats) : null,
                report: open.report,
                log: open.log,
              }
            : runs.map((r) => ({ id: r.id, status: r.status, started_at: r.started_at }))
        }
        note={t('The chosen report as data. Switch to Visual to choose another.')}
      />
    )

  return (
    <div class="sm-stack">
      <SavedFiles brand={brand} version={version} notify={notify} />
      <GrowthBox {...view} />
      <CampaignBox brand={brand} version={version} />
      <h2 class="sm-sec__title">{t('Update reports')}</h2>
      <div class="sm-split">
        <ul class="sm-runs" aria-label={t('Updates')}>
          {runs.map((r) => (
            <li>
              <button
                type="button"
                class="sm-run"
                aria-current={open?.id === r.id ? 'true' : undefined}
                onClick={() => api.get<RunRow>(`/api/runs/${r.id}`).then(setOpen)}
              >
                <span>{when(r.started_at)}</span>
                <span class={`sm-run__status sm-run__status--${r.status}`}>
                  {STATUS[r.status] ?? r.status} ·{' '}
                  {r.trigger === 'schedule'
                    ? t('on schedule')
                    : r.trigger === 'mcp'
                      ? t('by Claude')
                      : t('by you')}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <article class="sm-report">
          {open?.report ? (
            <>
              <div
                class="sm-report__text"
                dangerouslySetInnerHTML={{ __html: renderReport(open.report) }}
              />
              <p class="sm-report__actions">
                <a
                  class="g-btn g-btn--sm"
                  href={`/api/runs/${open.id}/report.md`}
                  download={`socialmonitor-report-${open.id}.md`}
                >
                  {t('Download as Markdown')}
                </a>
              </p>
            </>
          ) : open ? (
            <pre class="sm-report__log">{open.log || t('Starting…')}</pre>
          ) : null}
        </article>
      </div>
    </div>
  )
}
