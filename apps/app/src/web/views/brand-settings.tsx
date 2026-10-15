import { useEffect, useRef, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { Network, Schedule } from '../api.ts'
import { api } from '../api.ts'
import { BadReport } from '../bad-report.tsx'
import { t } from '../i18n.ts'
import { NETWORK_NAME, NetworkMark, Row, Segmented, when } from '../ui.tsx'
import { textOn, validColor } from '../../core/color.ts'
import { CampaignSettings } from '../campaigns.tsx'

type Range = 'new' | 'due' | 'all'

const EVERY: [number, string][] = [
  [1, 'Every hour'],
  [2, 'Every 2 hours'],
  [4, 'Every 4 hours'],
  [6, 'Every 6 hours'],
  [12, 'Every 12 hours'],
  [24, 'Once a day'],
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
