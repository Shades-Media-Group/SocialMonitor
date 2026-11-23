import { useEffect, useState } from 'preact/hooks'
import { t } from './i18n.ts'
import type { RunRow } from './api.ts'
import { api } from './api.ts'
import { Sheet } from './ui.tsx'
import { retell, took } from './run-story.ts'

export interface RunProgress {
  step?: 'read' | 'sort'
  brand?: string
  network?: string
  profile?: number
  profiles?: number
  done?: number
  total?: number
}

export const readProgress = (r: RunRow | null) =>
  JSON.parse(r?.progress || '{}') as RunProgress

/** Reading counts per account; the bar moves across accounts, then through each one's posts. */
export function progressShare(p: RunProgress) {
  if (p.step === 'sort') return p.total ? (p.done ?? 0) / p.total : 0
  return p.profiles
    ? ((p.profile ?? 1) - 1 + (p.total ? (p.done ?? 0) / p.total : 0)) / p.profiles
    : 0
}

const STAGES = ['read', 'sort', 'report'] as const

/**
 * The update, opened from its corner card: where it is, what it has done in plain words, and the
 * raw log folded away for whoever needs it. Follows the run live while the sheet is open.
 */
export function RunActivity({
  runId,
  version,
  open,
  onClose,
}: {
  runId: number
  version: number
  open: boolean
  onClose: () => void
}) {
  const [run, setRun] = useState<RunRow | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!open) return
    let alive = true
    api
      .get<RunRow>(`/api/runs/${runId}`)
      .then((r) => alive && setRun(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, runId, version])
  // The clock moves while the update runs, between the server's nudges.
  useEffect(() => {
    if (!open || (run && run.status !== 'running')) return
    const i = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(i)
  }, [open, run?.status])

  const running = run?.status === 'running'
  const p = readProgress(run)
  const story = retell(run?.log ?? '', t)
  const stage = !run ? 'read' : running ? (p.step === 'sort' ? 'sort' : 'read') : 'done'
  const share = running ? progressShare(p) : 1
  const ended = run?.finished_at ? Date.parse(run.finished_at) : now

  const headline = !run
    ? t('Loading the update…')
    : running
      ? p.step === 'sort'
        ? t('Sorting comments with AI: post {done} of {total}', {
            done: (p.done ?? 0) + 1,
            total: p.total ?? 0,
          })
        : p.brand
          ? t('Reading {brand} on {network}', {
              brand: p.brand,
              network: ({ instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' } as Record<string, string>)[p.network ?? ''] ?? '',
            })
          : t('Starting…')
      : run.status === 'stopped'
        ? t('Update stopped')
        : run.status === 'error'
          ? t('Update failed')
          : run.status === 'postponed'
            ? t('Update postponed')
            : t('Update finished')

  const stageText: Record<(typeof STAGES)[number], string> = {
    read: p.profiles
      ? t('Read the accounts ({n} of {total})', {
          n: stage === 'read' ? (p.profile ?? 1) : p.profiles,
          total: p.profiles,
        })
      : t('Read the accounts'),
    sort: t('Sort new comments with AI'),
    report: t('Write the report'),
  }
  const stateOf = (s: (typeof STAGES)[number]) => {
    if (stage === 'done') return 'done'
    const at = STAGES.indexOf(stage as (typeof STAGES)[number])
    const i = STAGES.indexOf(s)
    return i < at ? 'done' : i === at ? 'now' : 'next'
  }
  const items = [...story.items].reverse()

  return (
    <Sheet open={open} title={t('Update details')} onClose={onClose}>
      <div class="sm-act">
        <section class="sm-act__now" aria-live="polite">
          <p class="sm-act__headline">{headline}</p>
          <span class="sm-run__bar sm-act__bar">
            <span style={{ width: `${Math.max(3, Math.round(share * 100))}%` }} />
          </span>
          <p class="sm-act__meta">
            {run &&
              (running
                ? t('{pct}% · running for {time}', {
                    pct: Math.round(share * 100),
                    time: took(run.started_at, now, t),
                  })
                : t('Took {time}', { time: took(run.started_at, ended, t) }))}
          </p>
        </section>

        <ol class="sm-act__stages">
          {STAGES.map((s) => (
            <li key={s} class={`sm-act__stage sm-act__stage--${stateOf(s)}`}>
              <span class="sm-act__dot" aria-hidden="true" />
              <span>{stageText[s]}</span>
              <span class="sm-act__state">
                {stateOf(s) === 'done' ? t('Done') : stateOf(s) === 'now' ? t('Now') : ''}
              </span>
            </li>
          ))}
        </ol>

        {run && (
          <p class="sm-act__sum">
            {[
              t('Accounts read: {n}', { n: story.accounts }),
              t('New comments: {n}', { n: story.newComments }),
              story.problems
                ? t('Needs attention: {n}', { n: story.problems })
                : t('No problems'),
            ].join(' · ')}
          </p>
        )}

        <h3 class="sm-act__h">{t('What happened')}</h3>
        {!run ? (
          <p class="sm-quiet">{t('Loading…')}</p>
        ) : items.length ? (
          <ol class="sm-act__feed">
            {items.map((i, n) => (
              <li key={n} class={`sm-act__item sm-act__item--${i.kind}`}>
                <time>{i.time}</time>
                <div>
                  <p>{i.text}</p>
                  {i.detail && <p class="sm-act__detail">{i.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p class="sm-quiet">{t('Nothing has happened yet. The first account opens in a moment.')}</p>
        )}

        {run?.log && (
          <details class="sm-act__raw">
            <summary>{t('Technical log')}</summary>
            <pre>{run.log}</pre>
          </details>
        )}
      </div>
    </Sheet>
  )
}
