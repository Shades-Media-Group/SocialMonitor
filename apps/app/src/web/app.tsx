import { useCallback, useEffect, useState } from 'preact/hooks'
import type { BrandRow, Network, RunRow } from './api.ts'
import { api } from './api.ts'
import { Icon, Logo, ago } from './ui.tsx'
import { UpdateSheet } from './update.tsx'
import { SettingsSheet } from './settings.tsx'
import type { ViewMode } from './json.tsx'
import { readMode, saveMode } from './json.tsx'
import { Home } from './home.tsx'
import { BrandPage } from './brand.tsx'

export const TABS = [
  ['overview', 'Overview'],
  ['comments', 'Comments'],
  ['posts', 'Posts'],
  ['reports', 'Reports'],
  ['schedules', 'Schedules'],
  ['about', 'About'],
] as const
export type Tab = (typeof TABS)[number][0]

/** Where the app is: the brand list, a new brand, or one brand's tab. Kept in the URL hash. */
export type Route =
  { page: 'home' } | { page: 'new' } | { page: 'brand'; brandId: number; tab: Tab }

export function readRoute(): Route {
  const [, a, b, c] = location.hash.split('/')
  if (a === 'new') return { page: 'new' }
  if (a === 'b' && Number(b) > 0) {
    const tab = (TABS.some(([t]) => t === c) ? c : 'overview') as Tab
    return { page: 'brand', brandId: Number(b), tab }
  }
  return { page: 'home' }
}

let lastInput = 0
addEventListener('pointerdown', () => (lastInput = Date.now()), { capture: true })
addEventListener('keydown', () => (lastInput = Date.now()), { capture: true })

/**
 * True while the person is in the middle of something a refresh would disturb: typing in a
 * field, an open menu or sheet, unsaved JSON, or a click in the last two seconds.
 */
function isBusy() {
  const el = document.activeElement as HTMLElement | null
  if (el?.matches('input, textarea, select, [contenteditable="true"]')) return true
  if (document.querySelector('dialog[open], [data-dirty="true"]')) return true
  return Date.now() - lastInput < 2000
}

export interface AppState {
  brands: BrandRow[]
  reload: () => Promise<void>
  /** The update now running, followed every three seconds. */
  running: RunRow | null
  /** Bumps when an update ends, so screens fetch again. */
  version: number
  openUpdate: (brandId?: number) => void
  notify: (text: string) => void
  mode: ViewMode
}

/** What a brand's tabs receive besides the app state. */
export interface BrandView extends AppState {
  brand: BrandRow
  /** '' means every network. */
  network: Network | ''
}

export function App() {
  const [brands, setBrands] = useState<BrandRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [route, setRoute] = useState<Route>(readRoute)
  const [update, setUpdate] = useState<{ open: boolean; brandId?: number }>({ open: false })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [running, setRunning] = useState<RunRow | null>(null)
  const [version, setVersion] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>(readMode)

  const reload = useCallback(async () => {
    setBrands(await api.get<BrandRow[]>('/api/brands'))
    setLoaded(true)
  }, [])

  useEffect(() => {
    reload().catch((e: Error) => setToast(e.message))
    const onHash = () => {
      setRoute(readRoute())
      scrollTo({ top: 0 })
    }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [reload])

  // Live: the server says when anything changed (an update's progress, Claude, another tab).
  // The screen refreshes its data then, unless the person is in the middle of something.
  useEffect(() => {
    let alive = true
    let pending = false
    const refresh = async () => {
      pending = false
      const runs = await api.get<RunRow[]>('/api/runs').catch(() => [])
      const live = runs.find((r) => r.status === 'running') ?? null
      if (!alive) return
      setRunning((prev) => {
        if (prev && !live) setToast('Update finished. The report is ready.')
        return live
      })
      await reload().catch(() => {})
      setVersion((v) => v + 1)
    }
    const nudge = () => (isBusy() ? (pending = true) : void refresh())
    const events = new EventSource('/api/events')
    events.onmessage = nudge
    // Catch up once the person is done: focus leaves a field, a sheet closes, an edit is saved.
    const later = setInterval(() => pending && !isBusy() && refresh(), 1000)
    // A slow safety net in case the event stream is cut by a proxy.
    const fallback = setInterval(nudge, 30000)
    refresh()
    return () => {
      alive = false
      events.close()
      clearInterval(later)
      clearInterval(fallback)
    }
  }, [reload])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const brand = route.page === 'brand' ? brands.find((b) => b.id === route.brandId) : undefined
  const scope = brand ? [brand] : brands
  const lastRun = scope
    .flatMap((b) => b.profiles.map((p) => p.last_run_at))
    .filter(Boolean)
    .sort()
    .at(-1)

  const state: AppState = {
    brands,
    reload,
    running,
    version,
    openUpdate: (brandId) => setUpdate({ open: true, brandId }),
    notify: setToast,
    mode,
  }

  return (
    <div class="sm-app">
      <header class="sm-top">
        <a class="sm-top__home" href="#/" aria-label="SocialMonitor, all brands">
          <Logo />
        </a>
        {brand && (
          <nav class="sm-crumb" aria-label="You are here">
            <a href="#/">Brands</a>
            <span aria-hidden="true">/</span>
            <span>{brand.name}</span>
          </nav>
        )}
        <span class="sm-top__spacer" />
        <span class="sm-top__fresh" aria-live="polite">
          {running ? (
            <>
              <span class="sm-live" aria-hidden="true" /> Reading…
            </>
          ) : (
            <>Updated {ago(lastRun)}</>
          )}
        </span>
        <div class="g-segmented sm-seg sm-mode" role="radiogroup" aria-label="View">
          {(['visual', 'json'] as const).map((m) => (
            <button
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m)
                saveMode(m)
              }}
            >
              {m === 'visual' ? 'Visual' : 'JSON'}
            </button>
          ))}
        </div>
        <button
          class="g-btn g-btn--primary g-btn--sm"
          type="button"
          disabled={!brands.length || !!running}
          onClick={() => setUpdate({ open: true, brandId: brand?.id })}
        >
          Update{brand ? ` ${brand.name}` : ''}
        </button>
        <button
          class="g-icon-btn"
          type="button"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings" />
        </button>
      </header>

      {!loaded ? null : route.page === 'brand' && brand ? (
        <BrandPage {...state} brand={brand} tab={route.tab} />
      ) : (
        <Home {...state} adding={route.page === 'new'} />
      )}

      <UpdateSheet
        open={update.open}
        brandId={update.brandId}
        onClose={() => setUpdate({ open: false })}
        {...state}
      />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} {...state} />
      {toast && (
        <div class="g-toast sm-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
