import { useEffect, useRef, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { AiStatus, Network } from '../api.ts'
import type { ScheduleRange } from '../../core/types.ts'
import type { Digest } from '../../core/types.ts'
import { RUN } from '../../core/types.ts'
import { api } from '../api.ts'
import { BadReport } from '../bad-report.tsx'
import { t } from '../i18n.ts'
import { NETWORK_NAME, NetworkMark, Row, Segmented, when } from '../ui.tsx'
import { brandCategories } from '../rate.tsx'
import {
  READS,
  describeSchedule,
  nextOf,
  readsHint,
  schedulesHref,
  useBrandSchedules,
} from '../auto-update.tsx'

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
import { Rivals } from './rivals.tsx'
import { textOn, validColor } from '../../core/color.ts'
import { CampaignSettings } from '../campaigns.tsx'

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
 * How SocialMonitor works for one brand on its own: whether it updates by itself (its schedules),
 * whether Claude sorts the comments, and whether the negative-comments report goes out after
 * each update. Only the brand's admins and super admins see it.
 */
export function BrandSettings({ brand, reload, notify }: BrandView) {
  const nets = [...new Set(brand.profiles.map((p) => p.network))]
  const { list: schedules, reload: loadSchedules } = useBrandSchedules(brand.id)
  // The first schedule, set up here while the brand has none; afterwards it is edited on Schedules.
  const [draft, setDraft] = useState<{ hours: number; networks: Network[]; range: ScheduleRange }>({
    hours: 24,
    networks: nets,
    range: 'due',
  })
  const [engine, setEngine] = useState<'claude' | 'api' | null | undefined>(undefined)
  const [aiError, setAiError] = useState<{ at: string; message: string } | null>(null)
  const [pause, setPause] = useState<AiStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(false)

  useEffect(() => {
    setDraft({ hours: 24, networks: nets, range: 'due' })
    api
      .get<{
        engine: 'claude' | 'api' | null
        error: { at: string; message: string } | null
        pause: AiStatus
      }>('/api/ai')
      .then((r) => {
        setEngine(r.engine)
        setAiError(r.error)
        setPause(r.pause)
      })
      .catch(() => setEngine(null))
  }, [brand.id])

  if (schedules === undefined) return null

  const on = schedules.some((s) => s.enabled)
  const chosen = draft.networks.filter((n) => nets.includes(n))

  /**
   * "Update by itself": with schedules, pauses or resumes them all; with none, turning it on
   * creates the first one from the choices beneath.
   */
  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try {
      if (schedules.length) {
        await api.put(`/api/brands/${brand.id}/schedules`, { enabled })
        notify(enabled ? t('Schedules resumed.') : t('Schedules paused.'))
      } else if (enabled) {
        await api.post('/api/schedules', {
          brand_id: brand.id,
          kind: 'interval',
          every_hours: draft.hours,
          times: [],
          networks: chosen,
          range: draft.range,
          enabled: true,
        })
        notify(t('Saved.'))
      }
      await loadSchedules()
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const waits =
    pause?.paused && brand.ai_sort !== 0
      ? ` · ${t('Waits for Claude until {time}', { time: when(pause.until) })}`
      : ''

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

  // Claude at its usage limit, and this brand's comments waiting for it, in one line.
  const waitingHere = !!pause?.waiting?.brands.includes(brand.id)
  const limit = [
    pause?.paused &&
      (pause.kind === 'busy'
        ? t('Claude is busy. It is tried again at {time}.', { time: when(pause.until) })
        : t('Claude is at its usage limit until {time}.', { time: when(pause.until) })),
    waitingHere &&
      t('Comments here wait to be sorted; Claude sorts them after {time}.', {
        time: when(pause?.paused ? pause.resumes_at : pause!.waiting!.after),
      }),
  ]
    .filter(Boolean)
    .join(' ')

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
          {schedules.length > 0 && (
            <a class="sm-box__link" href={schedulesHref(brand.id)}>
              {t('Edit on Schedules')}
            </a>
          )}
        </header>
        <Row
          label={t('Update by itself')}
          hint={
            on
              ? t('Next: {when}', { when: when(nextOf(schedules)) }) + waits
              : t('Nothing runs until someone presses Update.')
          }
        >
          <label class="g-check">
            <input
              class="g-switch"
              type="checkbox"
              checked={on}
              disabled={busy || (!schedules.length && !chosen.length)}
              onChange={(e) => void toggle((e.target as HTMLInputElement).checked)}
            />
            {on ? t('On') : t('Off')}
          </label>
        </Row>
        {schedules.length ? (
          <Row label={schedules.length > 1 ? t('Schedules') : t('Schedule')}>
            <ul class="sm-schedlines">
              {schedules.map((s) => (
                <li>
                  <span>{describeSchedule(s)}</span>
                  {schedules.length > 1 && (
                    <span class="sm-quiet">
                      {s.enabled
                        ? t('Next: {when}', { when: when(s.next_run_at) }) + waits
                        : t('Paused')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Row>
        ) : (
          <>
            <Row label={t('How often')}>
              <select
                class="g-select sm-select-sm"
                value={String(draft.hours)}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, hours: Number((e.target as HTMLSelectElement).value) })
                }
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
                      disabled={busy || (chosen.length === 1 && chosen.includes(n))}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
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
            <Row label={t('What it reads')} hint={readsHint(draft.range)}>
              <Segmented
                label={t('What it reads')}
                value={draft.range}
                onChange={(range) => setDraft({ ...draft, range })}
                options={READS.map(([k, label]) => [k, t(label)])}
              />
            </Row>
          </>
        )}
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
        {limit && (
          <Row
            label={t('Usage limit')}
            hint={
              pause?.paused
                ? t('Updates and sorting wait, then start again by themselves.')
                : undefined
            }
          >
            <span class="sm-quiet">{limit}</span>
          </Row>
        )}
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
      <Rivals brand={brand} notify={notify} />
      <ReportBranding brand={brand} reload={reload} notify={notify} />

      <BadReport
        brand={brand}
        network=""
        open={report}
        onClose={() => setReport(false)}
        notify={notify}
        reload={reload}
      />

      <CampaignSettings brand={brand} reload={reload} notify={notify} />
    </div>
  )
}

/**
 * The brand's own look on its PDF reports: its logo at the top in place of SocialMonitor's,
 * and an accent colour for the rules and the report's label. Empty, reports look as before.
 */
function ReportBranding({ brand, reload, notify }: Pick<BrandView, 'brand' | 'reload' | 'notify'>) {
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [hex, setHex] = useState(brand.report_color ?? '')
  useEffect(() => setHex(brand.report_color ?? ''), [brand.report_color])

  const save = async (body: { logo?: string | null; color?: string | null }, done: string) => {
    setBusy(true)
    try {
      await api.put(`/api/brands/${brand.id}/report-branding`, body)
      await reload()
      notify(done)
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const upload = (f: File) => {
    if (f.size > 1024 * 1024) return notify(t('The logo is larger than 1 MB.'))
    const r = new FileReader()
    r.onload = () => void save({ logo: String(r.result) }, t('Logo saved.'))
    r.readAsDataURL(f)
  }
  const setColor = (v: string) => {
    const c = validColor(v)
    if (v.trim() && !c) return notify(t('The colour is a hex value like #1a6bd6.'))
    if (c !== brand.report_color) void save({ color: c }, c ? t('Saved.') : t('Colour removed.'))
  }
  const color = brand.report_color

  return (
    <section class="sm-box">
      <header class="sm-box__head">
        <h2>{t('Report branding')}</h2>
      </header>
      <Row
        label={t('Logo')}
        hint={t(
          'PNG, JPG or SVG, up to 1 MB. It replaces the SocialMonitor logo at the top of PDF reports.',
        )}
      >
        <span class="sm-inline sm-brandlogo">
          {brand.report_logo && (
            <img src={brand.report_logo} alt={t('{brand} logo', { brand: brand.name })} />
          )}
          <button
            class="g-btn g-btn--sm"
            type="button"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            {brand.report_logo ? t('Replace') : t('Upload logo')}
          </button>
          {brand.report_logo && (
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              disabled={busy}
              onClick={() => void save({ logo: null }, t('Logo removed.'))}
            >
              {t('Remove')}
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0]
              if (f) upload(f)
              ;(e.target as HTMLInputElement).value = ''
            }}
          />
        </span>
      </Row>
      <Row
        label={t('Accent colour')}
        hint={
          !color
            ? t('None: reports keep their usual ink.')
            : textOn(color)
              ? t("Used for the rule under the brand's name and the report's label.")
              : t(
                  "No text reads well on this colour, so it marks only the rule under the brand's name.",
                )
        }
      >
        <span class="sm-inline">
          <input
            class="sm-colorpick"
            type="color"
            value={color ?? '#16181d'}
            disabled={busy}
            aria-label={t('Pick a colour')}
            onChange={(e) => setColor((e.target as HTMLInputElement).value)}
          />
          <input
            class="g-input sm-hexinput"
            value={hex}
            placeholder="#1a6bd6"
            disabled={busy}
            aria-label={t('Colour as a hex value')}
            onInput={(e) => setHex((e.target as HTMLInputElement).value)}
            onChange={(e) => setColor((e.target as HTMLInputElement).value)}
          />
          {color && (
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              disabled={busy}
              onClick={() => setColor('')}
            >
              {t('Remove')}
            </button>
          )}
        </span>
      </Row>
    </section>
  )
}
