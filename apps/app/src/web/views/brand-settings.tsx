import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { Network, Schedule } from '../api.ts'
import type { Digest } from '../../core/types.ts'
import { RUN } from '../../core/types.ts'
import { api } from '../api.ts'
import { BadReport } from '../bad-report.tsx'
import { t } from '../i18n.ts'
import { NETWORK_NAME, NetworkMark, Row, Segmented, when } from '../ui.tsx'

type Range = 'new' | 'due' | 'all'

const EVERY: [number, string][] = [
  [1, 'Every hour'],
  [2, 'Every 2 hours'],
  [4, 'Every 4 hours'],
  [6, 'Every 6 hours'],
  [12, 'Every 12 hours'],
  [24, 'Once a day'],
]

type Trigger = 'urgent' | 'bad' | 'watched'

const TRIGGERS: [Trigger, string, string][] = [
  [
    'urgent',
    'Urgent comments',
    'An email as soon as an update finds a comment that needs an answer urgently.',
  ],
  [
    'bad',
    'A run of complaints',
    'An email once {n} new negative comments have come in since the last alert.',
  ],
  [
    'watched',
    'Words to watch',
    'An email when a new comment names one of the words to watch on the About tab.',
  ],
]

/**
 * How SocialMonitor works for one brand on its own: whether it updates by itself and how often,
 * what it reads, whether Claude sorts the comments, and whether the negative-comments report
 * goes out after each update. Only the brand's admins and super admins see it.
 */
export function BrandSettings({ brand, reload, notify }: BrandView) {
  const nets = brand.profiles.map((p) => p.network)
  const [own, setOwn] = useState<Schedule | null | undefined>(undefined)
  const [engine, setEngine] = useState<'claude' | 'api' | null | undefined>(undefined)
  const [aiError, setAiError] = useState<{ at: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(false)

  const load = () =>
    api
      .get<Schedule[]>('/api/schedules')
      .then((list) =>
        setOwn(list.find((s) => s.brand_id === brand.id && s.kind === 'interval') ?? null),
      )
      .catch(() => setOwn(null))
  useEffect(() => {
    void load()
    api
      .get<{ engine: 'claude' | 'api' | null; error: { at: string; message: string } | null }>(
        '/api/ai',
      )
      .then((r) => {
        setEngine(r.engine)
        setAiError(r.error)
      })
      .catch(() => setEngine(null))
  }, [brand.id])

  if (own === undefined) return null

  const on = !!own?.enabled
  const hours = own?.every_hours ?? 24
  const chosen: Network[] = own?.networks?.length ? own.networks : nets
  const range: Range = (own?.range as Range | undefined) ?? 'due'

  /** Saves the brand's one automatic schedule with these changes. */
  const save = async (
    patch: Partial<{ enabled: boolean; hours: number; networks: Network[]; range: Range }>,
  ) => {
    setBusy(true)
    try {
      const body = {
        brand_id: brand.id,
        kind: 'interval',
        every_hours: patch.hours ?? hours,
        times: [],
        networks: patch.networks ?? chosen,
        range: patch.range ?? range,
        enabled: (patch.enabled ?? on) ? 1 : 0,
      }
      if (own) await api.put(`/api/schedules/${own.id}`, body)
      else await api.post('/api/schedules', body)
      await load()
      notify(t('Saved.'))
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const setAi = async (value: boolean) => {
    await api.patch(`/api/brands/${brand.id}`, { ai_sort: value })
    await reload()
    notify(
      value
        ? t('Claude sorts new comments after each update.')
        : t('The AI is off for {brand}.', { brand: brand.name }),
    )
  }

  /** Instant-alert triggers and the summary email; both go to the report's addresses. */
  const saveNotify = async (patch: { [k in Trigger]?: boolean } & { digest?: Digest }) => {
    setBusy(true)
    try {
      await api.put(`/api/brands/${brand.id}/notify`, patch)
      await reload()
      notify(t('Saved.'))
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const emails = (() => {
    try {
      return JSON.parse(brand.alert_emails || '[]') as string[]
    } catch {
      return []
    }
  })()

  return (
    <div class="sm-about">
      <section class="sm-box">
        <header class="sm-box__head">
          <h2>{t('Automatic updates')}</h2>
        </header>
        <Row
          label={t('Update by itself')}
          hint={
            on && own?.next_run_at
              ? t('Next: {when}', { when: when(own.next_run_at) })
              : t('Off: nothing runs until someone presses Update.')
          }
        >
          <label class="g-check">
            <input
              class="g-switch"
              type="checkbox"
              checked={on}
              disabled={busy || !nets.length}
              onChange={(e) => void save({ enabled: (e.target as HTMLInputElement).checked })}
            />
            {on ? t('On') : t('Off')}
          </label>
        </Row>
        <Row label={t('How often')}>
          <select
            class="g-select sm-select-sm"
            value={String(hours)}
            disabled={busy || !on}
            onChange={(e) => void save({ hours: Number((e.target as HTMLSelectElement).value) })}
          >
            {EVERY.map(([h, label]) => (
              <option value={String(h)}>{t(label)}</option>
            ))}
          </select>
        </Row>
        <Row label={t('Networks')}>
          <span class="sm-setnets">
            {nets.map((n) => (
              <label class="g-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(n)}
                  disabled={busy || !on || (chosen.length === 1 && chosen.includes(n))}
                  onChange={(e) =>
                    void save({
                      networks: (e.target as HTMLInputElement).checked
                        ? [...chosen, n]
                        : chosen.filter((x) => x !== n),
                    })
                  }
                />
                <NetworkMark network={n} size={14} /> {NETWORK_NAME[n]}
              </label>
            ))}
          </span>
        </Row>
        <Row
          label={t('What it reads')}
          hint={
            range === 'new'
              ? t('Only posts it has not seen yet.')
              : range === 'due'
                ? t(
                    'New posts, plus older ones due for fresh numbers: weekly for a month, then monthly.',
                  )
                : t('The latest 15 posts on each network again, with all their comments.')
          }
        >
          <Segmented
            label={t('What it reads')}
            value={range}
            onChange={(v) => void save({ range: v })}
            options={[
              ['new', t('New posts')],
              ['due', t('New and due')],
              ['all', t('Latest, again')],
            ]}
          />
        </Row>
      </section>

      <section class="sm-box">
        <header class="sm-box__head">
          <h2>{t('AI')}</h2>
        </header>
        <Row
          label={t('Sort with Claude')}
          hint={t(
            'After each update, Claude describes new posts and sorts new comments, reading the thread, emoji and pictures. Off: comments stay unsorted until someone rates them.',
          )}
        >
          <label class="g-check">
            <input
              class="g-switch"
              type="checkbox"
              checked={brand.ai_sort !== 0}
              onChange={(e) => void setAi((e.target as HTMLInputElement).checked)}
            />
            {brand.ai_sort !== 0 ? t('On') : t('Off')}
          </label>
        </Row>
        <Row label={t('On this computer')}>
          <span class="sm-quiet">
            {engine === undefined
              ? '…'
              : engine === 'claude'
                ? t('Claude Code')
                : engine === 'api'
                  ? t('Anthropic API key')
                  : t('No AI yet: install Claude Code, or set ANTHROPIC_API_KEY in .env.')}
          </span>
        </Row>
        {aiError && (
          <Row label={t('Last problem')}>
            <p class="g-error" role="alert">
              {when(aiError.at)}: {aiError.message}
            </p>
          </Row>
        )}
      </section>

      <section class="sm-box">
        <header class="sm-box__head">
          <h2>{t('Negative comments report')}</h2>
        </header>
        <Row
          label={t('After each update')}
          hint={
            emails.length
              ? t('Goes to {list}.', { list: emails.join(', ') })
              : t('Nobody gets it yet.')
          }
        >
          <span class="sm-inline">
            <span>{brand.alert_auto ? t('Sent by itself') : t('Sent by hand only')}</span>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => setReport(true)}
            >
              {t('Change')}
            </button>
          </span>
        </Row>
      </section>

      <section class="sm-box">
        <header class="sm-box__head">
          <h2>{t('Instant alerts')}</h2>
        </header>
        {TRIGGERS.map(([key, label, hint]) => {
          const on = !!brand[`instant_${key}`]
          return (
            <Row label={t(label)} hint={t(hint, { n: RUN })}>
              <label class="g-check">
                <input
                  class="g-switch"
                  type="checkbox"
                  checked={on}
                  disabled={busy}
                  onChange={(e) =>
                    void saveNotify({ [key]: (e.target as HTMLInputElement).checked })
                  }
                />
                {on ? t('On') : t('Off')}
              </label>
            </Row>
          )
        })}
        <Row label={t('Sent to')}>
          <span class="sm-inline">
            <span class="sm-quiet">
              {emails.length ? emails.join(', ') : t('Nobody gets it yet.')}
            </span>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => setReport(true)}
            >
              {t('Change')}
            </button>
          </span>
        </Row>
      </section>

      <section class="sm-box">
        <header class="sm-box__head">
          <h2>{t('Summary email')}</h2>
        </header>
        <Row
          label={t('Send a summary')}
          hint={
            brand.digest === 'weekly'
              ? t('Every Monday at 08:00, with the brand report as a PDF, to the same addresses.')
              : brand.digest === 'monthly'
                ? t(
                    'On the 1st of each month at 08:00, with the brand report as a PDF, to the same addresses.',
                  )
                : t('Off: nobody gets a summary.')
          }
        >
          <Segmented
            label={t('Send a summary')}
            value={brand.digest}
            onChange={(v) => void saveNotify({ digest: v })}
            options={[
              ['off', t('Off')],
              ['weekly', t('Weekly')],
              ['monthly', t('Monthly')],
            ]}
          />
        </Row>
      </section>

      <BadReport
        brand={brand}
        network=""
        open={report}
        onClose={() => setReport(false)}
        notify={notify}
        reload={reload}
      />
    </div>
  )
}
