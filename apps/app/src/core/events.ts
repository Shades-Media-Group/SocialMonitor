/**
 * "Something changed" signals for open dashboards: a write through the API, a step of a
 * running update, a finished report. Coalesced so a busy update sends one signal per second.
 */
type Listener = (event: string) => void
const listeners = new Set<Listener>()
let timer: ReturnType<typeof setTimeout> | null = null

export function onChange(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function changed() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    for (const fn of listeners) fn('changed')
  }, 1000)
}
