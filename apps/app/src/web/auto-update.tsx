import { useEffect, useState } from 'preact/hooks'
import type { BrandRow, Schedule } from './api.ts'
import { api } from './api.ts'
import type { ScheduleRange } from '../core/types.ts'
import { SCHEDULE_POSTS } from '../core/types.ts'
import { NETWORK_NAME, count, when } from './ui.tsx'
import { t } from './i18n.ts'

/**
 * A brand's automatic updates are its schedules, one list for the whole dashboard: the Schedules
 * page edits them, Settings and About show them, and "Update by itself" pauses or resumes them
 * all. The quick choices below only create a first schedule when a brand has none.
 */

/** What a schedule reads, the same two choices everywhere. */
export const READS: [ScheduleRange, string][] = [
  ['due', 'New posts and fresh numbers'],
  ['all', 'Latest, again'],
]
export const readsName = (r: ScheduleRange) => t(READS.find(([k]) => k === r)![1])
/** The hint under "What it reads". The ages are duePosts' own. */
export const readsHint = (r: ScheduleRange) =>
  r === 'all'
    ? t('The newest {n} posts on each network again, with all their comments.', {
        n: SCHEDULE_POSTS,
      })
    : t(
        'New posts, plus fresh likes, views and comment counts for older posts: at every update in their first week, weekly for their first month, monthly for their first year, then every three months.',
      )

/** "Daily at 00:00, 12:00 · TikTok, Facebook, Instagram · New posts and fresh numbers". */
export function describeSchedule(s: Schedule) {
  const what =
    s.kind === 'interval'
      ? t('Every {hours}', { hours: count(s.every_hours, 'hour') })
      : t('Daily at {times}', { times: s.times.join(', ') })
  return `${what} · ${s.networks.map((n) => NETWORK_NAME[n]).join(', ')} · ${readsName(s.range)}`
}

/** The soonest next start among the schedules that are on, or null when none is. */
export const nextOf = (list: Schedule[]) =>
  list
    .filter((s) => s.enabled && s.next_run_at)
    .map((s) => s.next_run_at!)
    .sort()[0] ?? null

export const schedulesHref = (brandId: number) => `/b/${brandId}/schedules`

/** One brand's schedules; undefined while they load. */
export function useBrandSchedules(brandId: number) {
  const [list, setList] = useState<Schedule[] | undefined>(undefined)
  const reload = () =>
    api
      .get<Schedule[]>('/api/schedules')
      .then((all) => setList(all.filter((s) => s.brand_id === brandId)))
      .catch(() => setList([]))
  useEffect(() => {
    setList(undefined)
    void reload()
  }, [brandId])
  return { list, reload }
}

const EVERY: [number, string][] = [
  [0, 'Off'],
  [4, 'Every 4 hours'],
  [12, 'Every 12 hours'],
  [24, 'Once a day'],
]

/**
 * A brand's automatic updates in one line, on About and in the Update panel. With schedules it
 * says whether they run and when next, and links to Schedules; with none, one choice creates a
 * schedule for new posts and fresh numbers on every network the brand has.
 */
export function AutoUpdate({ brand, onLeave }: { brand: BrandRow; onLeave?: () => void }) {
  const { list, reload } = useBrandSchedules(brand.id)
  const [busy, setBusy] = useState(false)
  if (list === undefined) return null
  const admin = brand.my_role === 'admin'

  if (list.length) {
    const on = list.some((s) => s.enabled)
    return (
      <span class="sm-auto">
        <span>
          {on ? `${t('On')} · ${t('Next: {when}', { when: when(nextOf(list)) })}` : t('Paused')}
        </span>
        <a class="sm-textbtn" href={schedulesHref(brand.id)} onClick={onLeave}>
          {t('Edit on Schedules')}
        </a>
      </span>
    )
  }

  const create = async (hours: number) => {
    if (!hours) return
    setBusy(true)
    try {
      await api.post('/api/schedules', {
        brand_id: brand.id,
        kind: 'interval',
        every_hours: hours,
        times: [],
        networks: [...new Set(brand.profiles.map((p) => p.network))],
        range: 'due',
        enabled: true,
      })
      await reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <span class="sm-auto">
      <select
        class="g-select sm-select-sm"
        value="0"
        disabled={!admin || busy || !brand.profiles.length}
        aria-label={t('Automatic updates for {brand}', { brand: brand.name })}
        onChange={(e) => void create(Number((e.target as HTMLSelectElement).value))}
      >
        {EVERY.map(([h, label]) => (
          <option value={String(h)}>{t(label)}</option>
        ))}
      </select>
    </span>
  )
}
