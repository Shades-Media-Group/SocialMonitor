import { useCallback, useEffect, useState } from 'preact/hooks'
import type { BrandRow, RunRow } from './api.ts'
import { api } from './api.ts'
import { Icon, Logo, ago } from './ui.tsx'
import { UpdateSheet } from './update.tsx'
import { SettingsSheet } from './settings.tsx'
import { Overview } from './views/overview.tsx'
import { Comments } from './views/comments.tsx'
import { Posts } from './views/posts.tsx'
import { Reports } from './views/reports.tsx'
import { Schedules } from './views/schedules.tsx'
import { Brands } from './views/brands.tsx'

const TABS = [
  ['overview', 'Overview'],
  ['comments', 'Comments'],
  ['posts', 'Posts'],
  ['reports', 'Reports'],
  ['schedules', 'Schedules'],
  ['brands', 'Brands'],
] as const
export type Tab = (typeof TABS)[number][0]

export interface AppState {
  brands: BrandRow[]
  /** 0 means every brand. */
  brandId: number
  reload: () => Promise<void>
  go: (tab: Tab) => void
  openUpdate: () => void
  running: RunRow | null
  notify: (text: string) => void
}

const readTab = (): Tab => {
  const h = location.hash.slice(1) as Tab
  return TABS.some(([t]) => t === h) ? h : 'overview'
}

export function App() {
  const [brands, setBrands] = useState<BrandRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [brandId, setBrandId] = useState(() => Number(localStorage.getItem('sm-brand') ?? 0))
  const [tab, setTab] = useState<Tab>(readTab)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [running, setRunning] = useState<RunRow | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const list = await api.get<BrandRow[]>('/api/brands')
    setBrands(list)
    setLoaded(true)
  }, [])

  useEffect(() => {
    reload().catch((e: Error) => setToast(e.message))
    const onHash = () => setTab(readTab())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [reload])

  // While an update runs, follow it; when it ends, refresh everything once.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const runs = await api.get<RunRow[]>('/api/runs').catch(() => [])
      const live = runs.find((r) => r.status === 'running') ?? null
      if (!alive) return
      setRunning((prev) => {
        if (prev && !live) {
          reload()
          setToast('Update finished. The report is ready.')
        }
        return live
      })
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [reload])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const chooseBrand = (id: number) => {
    setBrandId(id)
    try {
      localStorage.setItem('sm-brand', String(id))
    } catch {
      /* private mode */
    }
  }
  const go = (t: Tab) => (location.hash = t)

  const scope = brandId ? brands.filter((b) => b.id === brandId) : brands
  const lastRun = scope
    .flatMap((b) => b.profiles.map((p) => p.last_run_at))
    .filter(Boolean)
    .sort()
    .at(-1)

  const state: AppState = {
    brands,
    brandId,
    reload,
    go,
    openUpdate: () => setUpdateOpen(true),
    running,
    notify: setToast,
  }

  return (
    <div class="sm-app">
      <header class="sm-top">
        <Logo />
        {brands.length > 0 && (
          <select
            class="g-select sm-brand"
            value={brandId}
            onChange={(e) => chooseBrand(Number((e.target as HTMLSelectElement).value))}
            aria-label="Brand"
          >
            <option value={0}>All brands</option>
            {brands.map((b) => (
              <option value={b.id}>{b.name}</option>
            ))}
          </select>
        )}
        <span class="sm-top__spacer" />
        <span class="sm-top__fresh">
          {running ? (
            <>
              <span class="sm-live" aria-hidden="true" /> Updating…
            </>
          ) : (
            <>Updated {ago(lastRun)}</>
          )}
        </span>
        <button
          class="g-btn g-btn--primary g-btn--sm sm-update"
          type="button"
          disabled={!brands.length || !!running}
          onClick={() => setUpdateOpen(true)}
        >
          <Icon name="refresh" size={16} /> Update
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

      <nav class="g-tabs sm-tabs" aria-label="Sections">
        {TABS.map(([t, text]) => (
          <a href={`#${t}`} class="sm-tab" aria-current={t === tab ? 'page' : undefined}>
            {text}
          </a>
        ))}
      </nav>

      <main class="sm-main">
        {!loaded ? null : tab === 'overview' ? (
          <Overview {...state} />
        ) : tab === 'comments' ? (
          <Comments {...state} />
        ) : tab === 'posts' ? (
          <Posts {...state} />
        ) : tab === 'reports' ? (
          <Reports {...state} />
        ) : tab === 'schedules' ? (
          <Schedules {...state} />
        ) : (
          <Brands {...state} />
        )}
      </main>

      <UpdateSheet open={updateOpen} onClose={() => setUpdateOpen(false)} {...state} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} {...state} />
      {toast && (
        <div class="g-toast sm-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
