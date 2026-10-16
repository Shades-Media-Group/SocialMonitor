import type { DB } from './db.ts'
import * as store from './store.ts'
import type { Schedule } from './types.ts'
import { catchUp, queueRun } from './run.ts'
import { sendDigests } from './alerts.ts'

/** A few random minutes on every start, so updates never land on the same second twice. */
const jitter = (maxMinutes: number) => Math.round(Math.random() * maxMinutes * 60_000)

/** The next start after `from`. */
export function nextRun(s: Schedule, from = new Date()): Date | null {
  if (s.kind === 'interval') {
    const ms = (s.every_hours ?? 24) * 3600_000
    return new Date(from.getTime() + ms + jitter(Math.min(20, (ms / 60_000) * 0.1)))
  }
  const candidates = s.times.flatMap((t) => {
    const [h, m] = t.split(':').map(Number)
    return [0, 1].map((d) => {
      const at = new Date(from)
      at.setDate(at.getDate() + d)
      at.setHours(h!, m!, 0, 0)
      return at
    })
  })
  const next = candidates.filter((d) => d > from).sort((a, b) => a.getTime() - b.getTime())[0]
  return next ? new Date(next.getTime() + jitter(12)) : null
}

/** Checks the schedules once a minute and queues the ones that are due. */
export function startScheduler(db: DB) {
  const tick = () => {
    for (const s of store.listSchedules(db)) {
      if (!s.enabled) continue
      if (!s.next_run_at) {
        store.setNextRun(db, s.id, nextRun(s)?.toISOString() ?? null)
        continue
      }
      if (new Date(s.next_run_at) > new Date()) continue
      // The next start is set first: an update that finds Claude at its limit moves it to the reset.
      store.setNextRun(db, s.id, nextRun(s)?.toISOString() ?? null)
      try {
        queueRun(
          db,
          // A schedule for new posts also refreshes the numbers of posts that are due, so they stay light.
          {
            brandIds: [s.brand_id],
            networks: s.networks,
            range: s.range === 'all' ? 'all' : 'due',
            limit: 10,
          },
          'schedule',
          { scheduleId: s.id },
        )
      } catch {
        /* a brand with no profiles left: skip quietly, the schedule stays */
      }
    }
    // Comments a usage limit left unsorted, once Claude takes work again.
    void catchUp(db).catch((e: Error) => console.error(`Catch-up: ${e.message}`))
    // Weekly and monthly summary emails, each sent once when its time comes.
    void sendDigests(db)
  }
  tick()
  return setInterval(tick, 60_000)
}
