import { useEffect, useState } from 'preact/hooks'
import type { AppState } from '../app.tsx'
import type { Network, Schedule } from '../api.ts'
import { api } from '../api.ts'
import { Chips, Empty, NETWORK_NAME, Row, Segmented, when } from '../ui.tsx'

const NET_OPTIONS: [Network, string][] = [
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['tiktok', 'TikTok'],
]

function describe(s: Schedule) {
  const what =
    s.kind === 'interval' ? `Every ${s.every_hours} hours` : `Daily at ${s.times.join(', ')}`
  return `${what} · ${s.networks.map((n) => NETWORK_NAME[n]).join(', ')} · ${s.range === 'all' ? 'all posts' : 'new posts'}`
}

export function Schedules({ brands, brandId, notify }: AppState) {
  const [rows, setRows] = useState<Schedule[]>([])
  const [form, setForm] = useState<Partial<Schedule> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api.get<Schedule[]>('/api/schedules').then(setRows)
  useEffect(() => void load(), [])

  const scope = rows.filter((s) => !brandId || s.brand_id === brandId)
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
      notify('Schedule saved.')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div class="sm-stack">
      <p class="sm-quiet">
        Updates are manual unless you add a schedule. Networks you are signed in to wait at least
        the gap set in Settings between updates, and every start time moves by a few random minutes.
      </p>
      {scope.length ? (
        <ul class="sm-list">
          {scope.map((s) => (
            <li class="sm-brand-row">
              <div class="sm-brand-row__main">
                <h2>{brands.find((b) => b.id === s.brand_id)?.name}</h2>
                <p class="sm-quiet">{describe(s)}</p>
                <p class="sm-quiet">{s.enabled ? `Next: ${when(s.next_run_at)}` : 'Paused'}</p>
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
                  {s.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  class="g-btn g-btn--ghost g-btn--sm"
                  type="button"
                  onClick={() => setForm(s)}
                >
                  Edit
                </button>
                <button
                  class="g-btn g-btn--ghost g-btn--sm"
                  type="button"
                  onClick={async () => {
                    await api.del(`/api/schedules/${s.id}`)
                    load()
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        !form && (
          <Empty title="No schedules.">
            Add one to update a brand every few hours, daily, or at set times.
          </Empty>
        )
      )}

      {form ? (
        <form class="sm-form" onSubmit={save}>
          <Row label="Brand">
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
          <Row label="When">
            <Segmented
              label="When"
              value={form.kind!}
              onChange={(kind) => setForm({ ...form, kind })}
              options={[
                ['times', 'At set times'],
                ['interval', 'Every few hours'],
              ]}
            />
          </Row>
          {form.kind === 'interval' ? (
            <Row label="Every" hint="hours">
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
            <Row label="Times" hint="Separate with commas, e.g. 09:00, 18:30">
              <input
                class="g-input"
                value={(form.times ?? []).join(', ')}
                onInput={(e) =>
                  setForm({
                    ...form,
                    times: (e.target as HTMLInputElement).value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Row>
          )}
          <Row label="Networks">
            <Chips
              label="Networks"
              values={form.networks ?? []}
              onChange={(networks) => setForm({ ...form, networks })}
              options={NET_OPTIONS}
            />
          </Row>
          <Row label="Posts">
            <Segmented
              label="Posts"
              value={form.range ?? 'new'}
              onChange={(range) => setForm({ ...form, range })}
              options={[
                ['new', 'New since last update'],
                ['all', 'Latest, again'],
              ]}
            />
          </Row>
          {error && <p class="g-error">{error}</p>}
          <div class="sm-form__actions">
            <button class="g-btn g-btn--primary g-btn--sm" type="submit">
              Save schedule
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => setForm(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        brands.length > 0 && (
          <div>
            <button class="g-btn g-btn--sm" type="button" onClick={() => setForm(blank())}>
              Add a schedule
            </button>
          </div>
        )
      )}
    </div>
  )
}
