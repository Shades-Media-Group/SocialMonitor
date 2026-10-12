import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { Network, Schedule } from '../api.ts'
import { api } from '../api.ts'
import { Chips, Empty, NETWORK_NAME, Row, Segmented, count, when } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import { t } from '../i18n.ts'

const NET_OPTIONS: [Network, string][] = [
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['tiktok', 'TikTok'],
]

function describe(s: Schedule) {
  const what =
    s.kind === 'interval'
      ? t('Every {hours}', { hours: count(s.every_hours, 'hour') })
      : t('Daily at {times}', { times: s.times.join(', ') })
  return `${what} · ${s.networks.map((n) => NETWORK_NAME[n]).join(', ')} · ${s.range === 'all' ? t('all posts') : t('new posts')}`
}

export function Schedules({ brand, brands, notify, mode }: BrandView) {
  const brandId = brand.id
  const [rows, setRows] = useState<Schedule[]>([])
  const [form, setForm] = useState<Partial<Schedule> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api.get<Schedule[]>('/api/schedules').then(setRows)
  useEffect(() => void load(), [])

  const scope = rows.filter((s) => !brandId || s.brand_id === brandId)
  if (mode === 'json') {
    const value = scope.map((s) => ({
      id: s.id,
      brand: brands.find((b) => b.id === s.brand_id)?.name ?? s.brand_id,
      kind: s.kind,
      every_hours: s.every_hours,
      times: s.times,
      networks: s.networks,
      range: s.range,
      enabled: !!s.enabled,
      next_run_at: s.next_run_at,
    }))
    const save = async (next: unknown) => {
      if (!Array.isArray(next)) throw new Error(t('Expected a list of schedules.'))
      let n = 0
      for (const x of next as typeof value) {
        const brand = brands.find((b) => b.name === x.brand || b.id === x.brand)
        if (!brand) throw new Error(t('No brand "{brand}".', { brand: String(x.brand) }))
        const body = {
          brand_id: brand.id,
          kind: x.kind,
          every_hours: x.every_hours,
          times: x.times,
          networks: x.networks,
          range: x.range,
          enabled: x.enabled,
        }
        if (x.id && rows.some((r) => r.id === x.id)) await api.put(`/api/schedules/${x.id}`, body)
        else await api.post('/api/schedules', body)
        n++
      }
      await load()
      notify(t('Schedules saved.'))
      return t('Saved {n}. A schedule left out of the list is kept: delete it in Visual.', { n })
    }
    return (
      <JsonPanel
        value={value}
        onSave={save}
        note={t(
          'kind is "interval" (every_hours) or "times" (["09:00"]). Add one without an id. next_run_at is read-only.',
        )}
      />
    )
  }
  const blank = (): Partial<Schedule> => ({
    brand_id: brandId || brands[0]?.id,
    kind: 'times',
    times: ['09:00'],
    every_hours: 6,
    networks: ['instagram', 'facebook', 'tiktok'],
    range: 'new',
    enabled: 1,
  })

  const save = async (e: Event) => {
    e.preventDefault()
    setError(null)
    try {
      const body = { ...form, enabled: form!.enabled !== 0 }
      if (form!.id) await api.put(`/api/schedules/${form!.id}`, body)
      else await api.post('/api/schedules', body)
      setForm(null)
      notify(t('Schedule saved.'))
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div class="sm-stack">
      <p class="sm-quiet">
        {t(
          'Updates are manual unless you add a schedule. Networks you are signed in to wait at least the gap set in Settings between updates, and every start time moves by a few random minutes.',
        )}
      </p>
      {scope.length ? (
        <ul class="sm-list">
          {scope.map((s) => (
            <li class="sm-brand-row">
              <div class="sm-brand-row__main">
                <h2>{brands.find((b) => b.id === s.brand_id)?.name}</h2>
                <p class="sm-quiet">{describe(s)}</p>
                <p class="sm-quiet">
                  {s.enabled ? t('Next: {when}', { when: when(s.next_run_at) }) : t('Paused')}
                </p>
              </div>
              <div class="sm-brand-row__actions">
                <button
                  class="g-btn g-btn--ghost g-btn--sm"
                  type="button"
                  onClick={async () => {
                    await api.put(`/api/schedules/${s.id}`, { ...s, enabled: !s.enabled })
                    load()
                  }}
                >
                  {s.enabled ? t('Pause') : t('Resume')}
                </button>
                <button
                  class="g-btn g-btn--ghost g-btn--sm"
                  type="button"
                  onClick={() => setForm(s)}
                >
                  {t('Edit')}
                </button>
                <button
                  class="g-btn g-btn--ghost g-btn--sm"
                  type="button"
                  onClick={async () => {
                    await api.del(`/api/schedules/${s.id}`)
                    load()
                  }}
                >
                  {t('Delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        !form && (
          <Empty title={t('No schedules.')}>
            {t('Add one to update a brand every few hours, daily, or at set times.')}
          </Empty>
        )
      )}

      {form ? (
        <form class="sm-form" onSubmit={save}>
          <Row label={t('Brand')}>
            <select
              class="g-select"
              value={form.brand_id}
              onChange={(e) =>
                setForm({ ...form, brand_id: Number((e.target as HTMLSelectElement).value) })
              }
            >
              {brands.map((b) => (
                <option value={b.id}>{b.name}</option>
              ))}
            </select>
          </Row>
          <Row label={t('When')}>
            <Segmented
              label={t('When')}
              value={form.kind!}
              onChange={(kind) => setForm({ ...form, kind })}
              options={[
                ['times', t('At set times')],
                ['interval', t('Every few hours')],
              ]}
            />
          </Row>
          {form.kind === 'interval' ? (
            <Row label={t('Every')} hint={t('hours')}>
              <input
                class="g-input sm-input-num"
                type="number"
                min={1}
                max={168}
                value={form.every_hours ?? 6}
                onInput={(e) =>
                  setForm({ ...form, every_hours: Number((e.target as HTMLInputElement).value) })
                }
              />
            </Row>
          ) : (
            <Row label={t('Times')} hint={t('Separate with commas, e.g. 09:00, 18:30')}>
              <input
                class="g-input"
                value={(form.times ?? []).join(', ')}
                onInput={(e) =>
                  setForm({
                    ...form,
                    times: (e.target as HTMLInputElement).value
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Row>
          )}
          <Row label={t('Networks')}>
            <Chips
              label={t('Networks')}
              values={form.networks ?? []}
              onChange={(networks) => setForm({ ...form, networks })}
              options={NET_OPTIONS}
            />
          </Row>
          <Row label={t('Posts')}>
            <Segmented
              label={t('Posts')}
              value={form.range ?? 'new'}
              onChange={(range) => setForm({ ...form, range })}
              options={[
                ['new', t('New since last update')],
                ['all', t('Latest, again')],
              ]}
            />
          </Row>
          {error && <p class="g-error">{error}</p>}
          <div class="sm-form__actions">
            <button class="g-btn g-btn--primary g-btn--sm" type="submit">
              {t('Save schedule')}
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => setForm(null)}
            >
              {t('Cancel')}
            </button>
          </div>
        </form>
      ) : (
        brands.length > 0 && (
          <div>
            <button class="g-btn g-btn--sm" type="button" onClick={() => setForm(blank())}>
              {t('Add a schedule')}
            </button>
          </div>
        )
      )}
    </div>
  )
}
