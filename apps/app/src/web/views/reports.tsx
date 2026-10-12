import { useEffect, useState } from 'preact/hooks'
import type { AppState } from '../app.tsx'
import type { RunRow } from '../api.ts'
import { api } from '../api.ts'
import { Empty, when } from '../ui.tsx'
import { renderReport } from '../markdown.tsx'

const STATUS: Record<string, string> = {
  ok: 'Done',
  partial: 'Done, with gaps',
  error: 'Failed',
  running: 'Running',
}

export function Reports({ running, openUpdate }: AppState) {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [open, setOpen] = useState<RunRow | null>(null)

  useEffect(() => {
    api
      .get<RunRow[]>('/api/runs')
      .then((r) => {
        setRuns(r)
        if (r[0] && !open) api.get<RunRow>(`/api/runs/${r[0].id}`).then(setOpen)
      })
      .catch(() => setRuns([]))
  }, [running])

  if (runs === null) return null
  if (!runs.length)
    return (
      <Empty title="No reports yet.">
        Every update ends with a report: new posts, comments to answer, and what changed.{' '}
        <button class="g-link sm-linkbtn" type="button" onClick={openUpdate}>
          Update now
        </button>
      </Empty>
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
                {r.trigger === 'schedule' ? 'scheduled' : r.trigger}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <article class="sm-report">
        {open?.report ? (
          <>
            <div class="sm-report__actions">
              <a
                class="g-link"
                href={`/api/runs/${open.id}/report.md`}
                download={`socialmonitor-report-${open.id}.md`}
              >
                Download as Markdown
              </a>
            </div>
            <div
              class="sm-report__text"
              dangerouslySetInnerHTML={{ __html: renderReport(open.report) }}
            />
          </>
        ) : open ? (
          <pre class="sm-report__log">{open.log || 'Starting…'}</pre>
        ) : null}
      </article>
    </div>
  )
}
