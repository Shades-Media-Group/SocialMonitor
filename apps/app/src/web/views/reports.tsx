import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { RunRow } from '../api.ts'
import { api } from '../api.ts'
import { Empty, when } from '../ui.tsx'
import { renderReport } from '../markdown.tsx'
import { JsonPanel } from '../json.tsx'

const STATUS: Record<string, string> = {
  ok: 'Done',
  partial: 'Done, with gaps',
  error: 'Failed',
  running: 'Reading now',
}

/** Every update of this brand on the left; the report of the chosen one on the right. */
export function Reports({ brand, version, running, mode, openUpdate }: BrandView) {
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
      <Empty title="No reports yet.">
        Every update ends with one: the posts read, the comments to answer, and what changed.{' '}
        <button class="sm-textbtn" type="button" onClick={() => openUpdate(brand.id)}>
          Update now
        </button>
      </Empty>
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
        note="The chosen report as data. Switch to Visual to choose another."
      />
    )

  return (
    <div class="sm-split">
      <ul class="sm-runs" aria-label="Updates">
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
                  ? 'on schedule'
                  : r.trigger === 'mcp'
                    ? 'by Claude'
                    : 'by you'}
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
                Download as Markdown
              </a>
            </p>
          </>
        ) : open ? (
          <pre class="sm-report__log">{open.log || 'Starting…'}</pre>
        ) : null}
      </article>
    </div>
  )
}
