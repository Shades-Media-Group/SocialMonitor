import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { Network, Schedule } from '../api.ts'
import type { Digest } from '../../core/types.ts'
import { RUN } from '../../core/types.ts'
import { api } from '../api.ts'
import { BadReport } from '../bad-report.tsx'
import { t } from '../i18n.ts'
import { NETWORK_NAME, NetworkMark, Row, Segmented, when } from '../ui.tsx'
import { brandCategories } from '../rate.tsx'

interface SavedReply {
  id: number
  title: string
  text: string
  category: string | null
}
type Draft = { title: string; text: string; category: string }
const EMPTY: Draft = { title: '', text: '', category: '' }

/**
 * Answers the team gives again and again. "Draft a reply" on a comment picks the one that fits
 * and fills in {name} and the other details; it writes a fresh reply when none fits.
 */
function SavedReplies({ brand, notify }: Pick<BrandView, 'brand' | 'notify'>) {
  const [list, setList] = useState<SavedReply[] | null>(null)
  // The reply being edited: its id, 'new' for one being added, or null.
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [f, setF] = useState<Draft>(EMPTY)
  const [removing, setRemoving] = useState<number | null>(null)
  const [error, setError] = useState('')
  const cats = brandCategories(brand)

  const load = () =>
    api
      .get<SavedReply[]>(`/api/brands/${brand.id}/replies`)
      .then(setList)
      .catch(() => setList([]))
  useEffect(() => {
    void load()
    setEditing(null)
  }, [brand.id])

  const open = (r: SavedReply | null) => {
    setError('')
    setRemoving(null)
    setEditing(r ? r.id : 'new')
    setF(r ? { title: r.title, text: r.text, category: r.category ?? '' } : EMPTY)
  }
  const save = async (e: Event) => {
    e.preventDefault()
    try {
      const body = { ...f, category: f.category || null }
      if (editing === 'new') await api.post(`/api/brands/${brand.id}/replies`, body)
      else await api.put(`/api/brands/${brand.id}/replies/${editing}`, body)
      setEditing(null)
      await load()
      notify(t('Saved.'))
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const remove = async (r: SavedReply) => {
    if (removing !== r.id) return setRemoving(r.id)
    await api.del(`/api/brands/${brand.id}/replies/${r.id}`)
    setRemoving(null)
    await load()
    notify(t('{name} removed.', { name: r.title }))
  }
  const kindName = (key: string | null) => cats.find((k) => k.key === key)?.name

  const form = (
    <form class="sm-saved__form" onSubmit={(e) => void save(e)}>
      <Row label={t('Title')}>
        <input
          class="g-input"
          value={f.title}
          maxLength={80}
          required
          placeholder={t('Where is my refund?')}
          onInput={(e) => setF({ ...f, title: (e.target as HTMLInputElement).value })}
        />
      </Row>
      <Row
        label={t('Reply')}
        hint={t(
          'Write {name} where the person’s name goes, and other details in braces, like {order}. Claude fills in what the comment tells it.',
        )}
      >
        <textarea
          class="g-input sm-textarea"
          rows={4}
          maxLength={1000}
          required
          value={f.text}
          onInput={(e) => setF({ ...f, text: (e.target as HTMLTextAreaElement).value })}
        />
      </Row>
      <Row label={t('For comments about')}>
        <select
          class="g-select sm-select-sm"
          value={f.category}
          onChange={(e) => setF({ ...f, category: (e.target as HTMLSelectElement).value })}
        >
          <option value="">{t('Any kind')}</option>
          {cats.map((k) => (
            <option value={k.key}>{k.name}</option>
          ))}
        </select>
      </Row>
      {error && (
        <p class="g-error" role="alert">
          {error}
        </p>
      )}
      <div class="sm-inline sm-saved__actions">
        <button class="g-btn g-btn--sm" type="submit">
          {t('Save')}
        </button>
        <button class="g-btn g-btn--ghost g-btn--sm" type="button" onClick={() => setEditing(null)}>
          {t('Cancel')}
        </button>
      </div>
    </form>
  )

  if (!list) return null
  return (
    <section class="sm-box">
      <header class="sm-box__head">
        <h2>{t('Saved replies')}</h2>
        {editing === null && (
          <button class="sm-textbtn" type="button" onClick={() => open(null)}>
            {t('Add a saved reply')}
          </button>
        )}
      </header>
      <p class="sm-quiet">
        {t(
          'Answers your team gives again and again. Draft a reply picks the one that fits a comment and fills in the person’s name; when none fits, it writes a new one.',
        )}
      </p>
      {list.map((r) =>
        editing === r.id ? (
          form
        ) : (
          <Row label={r.title}>
            <p class="sm-saved__text">{r.text}</p>
            <span class="sm-inline sm-saved__meta">
              <span class="sm-quiet">{kindName(r.category) ?? t('Any kind')}</span>
              <button class="sm-textbtn" type="button" onClick={() => open(r)}>
                {t('Edit')}
              </button>
              <button class="sm-textbtn" type="button" onClick={() => void remove(r)}>
                {removing === r.id ? t('Remove it for good') : t('Remove')}
              </button>
            </span>
          </Row>
        ),
      )}
      {editing === 'new' && form}
      {!list.length && editing !== 'new' && <p class="sm-quiet">{t('None yet.')}</p>}
    </section>
  )
}

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

      <SavedReplies brand={brand} notify={notify} />

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
