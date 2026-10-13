import { useEffect, useState } from 'preact/hooks'
import type { BrandRow, Schedule } from './api.ts'
import { api } from './api.ts'
import { when } from './ui.tsx'
import { t } from './i18n.ts'

const EVERY: [number, string][] = [
  [0, 'Off'],
  [4, 'Every 4 hours'],
  [12, 'Every 12 hours'],
  [24, 'Once a day'],
]

/**
 * A brand's automatic updates in one choice: off, or every few hours. It keeps one simple
 * schedule for the brand (new posts plus older ones due for fresh numbers, on every network it
 * has); detailed schedules stay on the Schedules page.
 */
export function AutoUpdate({ brand, onSaved }: { brand: BrandRow; onSaved?: () => void }) {
  const [own, setOwn] = useState<Schedule | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const load = () =>
    api
      .get<Schedule[]>('/api/schedules')
      .then((list) =>
        setOwn(list.find((s) => s.brand_id === brand.id && s.kind === 'interval') ?? null),
      )
      .catch(() => setOwn(null))
  useEffect(() => void load(), [brand.id])
  if (own === undefined) return null
  const admin = brand.my_role === 'admin'
  const value = own?.enabled ? (own.every_hours ?? 0) : 0
  const set = async (hours: number) => {
    setBusy(true)
    try {
      const body = {
        brand_id: brand.id,
        kind: 'interval',
        every_hours: hours || own?.every_hours || 24,
        times: [],
        networks: own?.networks?.length ? own.networks : brand.profiles.map((p) => p.network),
        range: 'due',
        enabled: hours ? 1 : 0,
      }
      if (own) await api.put(`/api/schedules/${own.id}`, body)
      else if (hours) await api.post('/api/schedules', body)
      await load()
      onSaved?.()
    } finally {
      setBusy(false)
    }
  }
  return (
    <span class="sm-auto">
      <select
        class="g-select sm-select-sm"
        value={String(EVERY.some(([h]) => h === value) ? value : 24)}
        disabled={!admin || busy || !brand.profiles.length}
        aria-label={t('Automatic updates for {brand}', { brand: brand.name })}
        onChange={(e) => void set(Number((e.target as HTMLSelectElement).value))}
      >
        {EVERY.map(([h, label]) => (
          <option value={String(h)}>{t(label)}</option>
        ))}
      </select>
      {own?.enabled ? (
        <small class="sm-quiet">{t('Next: {when}', { when: when(own.next_run_at) })}</small>
      ) : null}
    </span>
  )
}
