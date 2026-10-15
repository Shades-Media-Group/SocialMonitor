import { useCallback, useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { Lang } from './i18n.ts'
import { LANGS, lang, setLang, t } from './i18n.ts'
import { loadPrefs } from './prefs.ts'
import type { BrandRow, Network, RunRow } from './api.ts'
import { api } from './api.ts'
import { Icon, Mark, Menu, ago, fmt } from './ui.tsx'
import type { IconName } from 'shades-gradient'
import { Palette } from './palette.tsx'
import { UpdateSheet } from './update.tsx'
import { SettingsSheet } from './settings.tsx'
import type { ViewMode } from './json.tsx'
import { readMode, saveMode } from './json.tsx'
import { Home } from './home.tsx'
import { BrandPage } from './brand-page.tsx'
import { PrintBad, PrintCampaign, PrintReport } from './print.tsx'
import type { AuthInfo, Me } from './auth.tsx'
import { AuthScreen, linkFromPath } from './auth.tsx'
import { People } from './people.tsx'
import { Compare } from './compare.tsx'
import { Activity } from './activity.tsx'

export const TABS = [
  ['overview', 'Overview'],
  ['posts', 'Posts'],
  ['stats', 'Statistics'],
  ['voice', 'Share of voice'],
  ['comments', 'Comments'],
  ['calendar', 'Calendar'],
  ['reports', 'Reports'],
  ['schedules', 'Schedules'],
  ['about', 'About'],
  ['settings', 'Settings'],
] as const
/** Tabs only a brand's admins (and super admins) see. */
const ADMIN_TABS: string[] = ['schedules', 'settings']
/** The tabs someone with this role on a brand sees. */
export const tabsFor = (role: string | null | undefined) =>
  TABS.filter(([k]) => role === 'admin' || !ADMIN_TABS.includes(k))
export type Tab = (typeof TABS)[number][0]
export const TAB_ICON: Record<Tab, IconName> = {
  overview: 'grid',
  comments: 'chat',
  posts: 'image',
  stats: 'arrowOutward',
  voice: 'contrast',
  calendar: 'calendar',
  reports: 'file',
  schedules: 'schedule',
  about: 'info',
  settings: 'settings',
}

/** Where the app is: the brand list, a new brand, or one brand's tab. Kept in the address path. */
export type Route =
  | { page: 'home' }
  | { page: 'new' }
  | { page: 'brand'; brandId: number; tab: Tab }
  | { page: 'print'; brandId: number }
  | { page: 'people' }
  | { page: 'compare' }
  | { page: 'activity' }

export function readRoute(): Route {
  // Old bookmarks and links used #/b/1/overview; they move to the clean address.
  if (location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1))
  const [, a, b, c] = location.pathname.split('/')
  if (a === 'new') return { page: 'new' }
  if (a === 'people') return { page: 'people' }
  if (a === 'compare') return { page: 'compare' }
  if (a === 'activity') return { page: 'activity' }
  if (a === 'print' && Number(b) > 0) return { page: 'print', brandId: Number(b) }
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
  /** The signed-in person. */
  me: Me
  /** The header's right side: freshness, view switch, Update. Set by the shell. */
  actions?: ComponentChildren
}

/** What a brand's tabs receive besides the app state. */
export interface BrandView extends AppState {
  brand: BrandRow
  /** '' means every network. */
  network: Network | ''
  /** The window, in days back from today; 0 is all time. */
  days: number
  setNetwork: (n: Network | '') => void
  setDays: (d: number) => void
  /** A place in the page header's filter row a tab can fill, such as Comments' saved views. */
  viewSlot?: HTMLElement | null
}

/** Signs in first, then shows the dashboard. Any 401 from the server comes back here. */
export function App() {
  const [info, setInfo] = useState<AuthInfo | null>(null)
  const [link, setLink] = useState(linkFromPath)
  const check = () =>
    api
      .get<AuthInfo>('/api/auth/me')
      .then(setInfo)
      .catch(() => setInfo({ user: null, setup: false, local: false, mail: false }))
  useEffect(() => {
    check()
    const out = () => check()
    const onHash = () => setLink(linkFromPath())
    addEventListener('sm-signed-out', out)
    addEventListener('popstate', onHash)
    return () => {
      removeEventListener('sm-signed-out', out)
      removeEventListener('popstate', onHash)
    }
  }, [])
  if (!info) return null
  if (info.user && !link) {
    loadPrefs(info.user.prefs)
    // The account's language and theme win over this browser's, so they follow the person.
    const want = info.user.prefs?.lang as Lang | undefined
    if (want && want !== lang && LANGS.some(([l]) => l === want)) {
      setLang(want)
      return null
    }
    const theme = info.user.prefs?.theme as string | undefined
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
    else if (theme === 'auto') delete document.documentElement.dataset.theme
  }
  if (!info.user || link)
    return <AuthScreen info={info} onIn={(user) => setInfo({ ...info, user, setup: false })} />
  return <Dashboard me={info.user} />
}

function Dashboard({ me }: { me: Me }) {
  const [brands, setBrands] = useState<BrandRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [route, setRoute] = useState<Route>(readRoute)
  const [update, setUpdate] = useState<{ open: boolean; brandId?: number }>({ open: false })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [running, setRunning] = useState<RunRow | null>(null)
  const [version, setVersion] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [finished, setFinished] = useState<RunRow | null>(null)
  const [mode, setMode] = useState<ViewMode>(readMode)
  const [navOpen, setNavOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])

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
    addEventListener('popstate', onHash)
    return () => removeEventListener('popstate', onHash)
  }, [reload])

  // Live: the server says when anything changed (an update's progress, Claude, another tab).
  // The screen refreshes its data then, unless the person is in the middle of something.
  // A print page is a snapshot for a PDF: it never listens.
  useEffect(() => {
    if (readRoute().page === 'print') return
    let alive = true
    let pending = false
    const refresh = async () => {
      pending = false
      const runs = await api.get<RunRow[]>('/api/runs').catch(() => [])
      const live = runs.find((r) => r.status === 'running') ?? null
      if (!alive) return
      setRunning((prev) => {
        if (prev && !live) setFinished(runs.find((r) => r.id === prev.id) ?? prev)
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

  const brand =
    route.page === 'brand' || route.page === 'print'
      ? brands.find((b) => b.id === route.brandId)
      : undefined
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
    openUpdate: (brandId) =>
      brandId && brands.find((b) => b.id === brandId)?.my_role !== 'admin'
        ? setToast(t("Only this brand's admins can run updates."))
        : setUpdate({ open: true, brandId }),
    notify: setToast,
    mode,
    me,
  }
  const canRun = me.super || me.memberships.some((m) => m.role === 'admin')
  const manages = canRun

  if (route.page === 'print')
    return loaded && brand ? (
      new URLSearchParams(location.search).get('kind') === 'bad' ? (
        <PrintBad brand={brand} />
      ) : Number(new URLSearchParams(location.search).get('campaign')) > 0 ? (
        <PrintCampaign
          brand={brand}
          campaignId={Number(new URLSearchParams(location.search).get('campaign'))}
        />
      ) : (
        <PrintReport brand={brand} />
      )
    ) : null

  // What every page header carries on its right: freshness, the view switch and the one red action.
  const actions = (
    <>
      <button class="sm-kbd-btn" type="button" onClick={() => setPalette(true)}>
        <Icon name="search" size={14} /> {t('Search')} <kbd>⌘K</kbd>
      </button>
      <div class="g-segmented sm-seg sm-mode" role="radiogroup" aria-label={t('View')}>
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
            {m === 'visual' ? t('Visual') : 'JSON'}
          </button>
        ))}
      </div>
      {canRun &&
        route.page !== 'people' &&
        route.page !== 'activity' &&
        (!brand || brand.my_role === 'admin') && (
          <button
            class="g-btn g-btn--primary g-btn--sm"
            type="button"
            disabled={!brands.length || !!running}
            onClick={() => setUpdate({ open: true, brandId: brand?.id })}
          >
            {t('Update')}
          </button>
        )}
    </>
  )
  const page = { ...state, actions }

  return (
    <div class={`sm-shell${navOpen ? ' is-nav-open' : ''}`}>
      <aside class="sm-nav" aria-label={t('Navigation')}>
        <div class="sm-rail">
          <a class="sm-rail__logo" href="/" aria-label={t('SocialMonitor, all brands')}>
            <Mark />
          </a>
          <a
            class="sm-rail__btn"
            href="/"
            aria-current={route.page === 'home' ? 'page' : undefined}
            title={t('All brands')}
          >
            <Icon name="home" size={18} />
          </a>
          <button
            class="sm-rail__btn"
            type="button"
            title={t('Search and jump (⌘K)')}
            onClick={() => setPalette(true)}
          >
            <Icon name="search" size={18} />
          </button>
          {manages && (
            <a
              class="sm-rail__btn"
              href="/people"
              aria-current={route.page === 'people' ? 'page' : undefined}
              title={t('People')}
            >
              <Icon name="group" size={18} />
            </a>
          )}
          {manages && (
            <a
              class="sm-rail__btn"
              href="/activity"
              aria-current={route.page === 'activity' ? 'page' : undefined}
              title={t('Activity')}
            >
              <Icon name="lock" size={18} />
            </a>
          )}
          <span class="sm-rail__spacer" />
          <button
            class="sm-rail__btn"
            type="button"
            title={t('Settings')}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={18} />
          </button>
          <div class="sm-rail__me">
            <Menu
              label={t('Account')}
              align="start"
              items={[
                { label: me.name || me.email, onSelect: () => setSettingsOpen(true) },
                { label: t('Settings'), onSelect: () => setSettingsOpen(true) },
                {
                  label: t('Sign out'),
                  onSelect: () =>
                    api
                      .post('/api/auth/logout')
                      .then(() => dispatchEvent(new Event('sm-signed-out'))),
                },
              ]}
            >
              <span class="sm-nav__avatar" aria-hidden="true">
                {(me.name || me.email).slice(0, 1).toUpperCase()}
              </span>
            </Menu>
          </div>
        </div>

        <div class="sm-navpanel">
          <div class="sm-navpanel__head">
            <b>{route.page === 'people' ? t('People') : t('Brands')}</b>
            <button
              class="sm-navpanel__icon"
              type="button"
              aria-label={t('Search and jump (⌘K)')}
              onClick={() => setPalette(true)}
            >
              <Icon name="search" size={15} />
            </button>
            {me.super && (
              <a
                class="sm-navpanel__icon"
                href="/new"
                aria-label={t('Add a brand')}
                title={t('Add a brand')}
              >
                <Icon name="add" size={15} />
              </a>
            )}
            <button
              class="sm-navpanel__icon sm-nav__close"
              type="button"
              aria-label={t('Close menu')}
              onClick={() => setNavOpen(false)}
            >
              <Icon name="close" size={15} />
            </button>
          </div>
          <nav class="sm-nav__list" onClick={() => setNavOpen(false)}>
            <a
              class="sm-nav__item"
              href="/"
              aria-current={route.page === 'home' ? 'page' : undefined}
            >
              <Icon name="grid" size={15} />
              <span class="sm-nav__name">{t('All brands')}</span>
              <span class="sm-nav__num g-num">{brands.length}</span>
            </a>
            {brands.length > 1 && (
              <a
                class="sm-nav__item"
                href="/compare"
                aria-current={route.page === 'compare' ? 'page' : undefined}
              >
                <Icon name="layers" size={15} />
                <span class="sm-nav__name">{t('Compare brands')}</span>
              </a>
            )}
            <p class="sm-nav__group">{t('Brands')}</p>
            {brands.map((b) => {
              const open = brand?.id === b.id
              const waiting = b.counts.needs_reply ?? 0
              return (
                <div class={`sm-nav__brand${open ? ' is-open' : ''}`}>
                  <a
                    class="sm-nav__item"
                    href={`/b/${b.id}/overview`}
                    aria-current={
                      open && route.page === 'brand' && route.tab === 'overview'
                        ? 'page'
                        : undefined
                    }
                  >
                    <span class="sm-nav__initial" aria-hidden="true">
                      {b.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span class="sm-nav__name">{b.name}</span>
                    {waiting > 0 ? (
                      <span class="sm-nav__count g-num" title={t('Waiting for an answer')}>
                        {waiting}
                      </span>
                    ) : (
                      <span class="sm-nav__num g-num">{fmt(b.counts.total ?? 0)}</span>
                    )}
                  </a>
                  {open && route.page === 'brand' && (
                    <div class="sm-nav__sub">
                      {tabsFor(b.my_role).map(([k, text]) => (
                        <a
                          class="sm-nav__item"
                          href={`/b/${b.id}/${k}`}
                          aria-current={route.tab === k ? 'page' : undefined}
                        >
                          <Icon name={TAB_ICON[k]} size={15} />
                          <span class="sm-nav__name">{t(text)}</span>
                          {k === 'comments' && (
                            <span class="sm-nav__num g-num">{fmt(b.counts.total ?? 0)}</span>
                          )}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </nav>
          <div class="sm-navpanel__foot">
            <span class="sm-live-dot" aria-hidden="true" data-on={running ? '1' : undefined} />
            <span class="sm-navpanel__status">
              {running ? t('Reading…') : t('Updated {when}', { when: ago(lastRun) })}
            </span>
            <button
              class="sm-navpanel__out"
              type="button"
              title={me.name || me.email}
              onClick={() =>
                api.post('/api/auth/logout').then(() => dispatchEvent(new Event('sm-signed-out')))
              }
            >
              {t('Sign out')}
            </button>
          </div>
        </div>
      </aside>
      <button
        class="sm-nav__scrim"
        type="button"
        aria-label={t('Close menu')}
        onClick={() => setNavOpen(false)}
      />

      <div class="sm-main">
        <button
          class="g-icon-btn sm-nav__open"
          type="button"
          aria-label={t('Menu')}
          onClick={() => setNavOpen(true)}
        >
          <Icon name="menu" />
        </button>
        {!loaded ? null : route.page === 'people' && manages ? (
          <People {...page} />
        ) : route.page === 'compare' ? (
          <Compare {...page} />
        ) : route.page === 'activity' && manages ? (
          <Activity {...page} />
        ) : route.page === 'brand' && brand ? (
          <BrandPage {...page} brand={brand} tab={route.tab} />
        ) : (
          <Home {...page} adding={route.page === 'new'} />
        )}
      </div>

      <RunNotice
        running={running}
        finished={finished}
        brands={brands}
        onClose={() => setFinished(null)}
      />
      <UpdateSheet
        open={update.open}
        brandId={update.brandId}
        onClose={() => setUpdate({ open: false })}
        {...state}
      />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} {...state} />
      {palette && (
        <Palette
          {...state}
          brand={brand}
          manages={manages}
          onClose={() => setPalette(false)}
          openSettings={() => setSettingsOpen(true)}
          openUpdate={(id) => setUpdate({ open: true, brandId: id })}
        />
      )}
      {toast && (
        <div class="g-toast sm-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

const NET_NAME: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
}

/**
 * The running update, in the corner of every page: what it reads now, a progress bar and Stop.
 * It follows the run on the server, so leaving a page or reopening the dashboard changes nothing.
 * When it ends, it links to its report until closed.
 */
function RunNotice({
  running,
  finished,
  brands,
  onClose,
}: {
  running: RunRow | null
  finished: RunRow | null
  brands: BrandRow[]
  onClose: () => void
}) {
  const [stopping, setStopping] = useState(false)
  useEffect(() => setStopping(false), [running?.id])
  if (running) {
    const p = JSON.parse(running.progress || '{}') as {
      step?: 'read' | 'sort'
      brand?: string
      network?: string
      profile?: number
      profiles?: number
      done?: number
      total?: number
    }
    // Reading counts per profile; the bar moves across profiles, then through each one's posts.
    const share =
      p.step === 'sort'
        ? p.total
          ? (p.done ?? 0) / p.total
          : 0
        : p.profiles
          ? ((p.profile ?? 1) - 1 + (p.total ? (p.done ?? 0) / p.total : 0)) / p.profiles
          : 0
    const text =
      p.step === 'sort'
        ? t('Sorting comments with AI: post {done} of {total}', {
            done: (p.done ?? 0) + 1,
            total: p.total ?? 0,
          })
        : p.brand
          ? `${p.brand} · ${NET_NAME[p.network ?? ''] ?? ''}${p.total ? ` · ${t('post {done} of {total}', { done: (p.done ?? 0) + 1, total: p.total })}` : ''}`
          : t('Starting…')
    return (
      <div class="sm-run" role="status">
        <div class="sm-run__head">
          <b>{p.step === 'sort' ? t('Almost done') : t('Updating')}</b>
          {p.profiles && p.step !== 'sort' ? (
            <span class="sm-quiet">
              {t('account {n} of {total}', { n: p.profile ?? 1, total: p.profiles })}
            </span>
          ) : null}
          <button
            class="sm-textbtn"
            type="button"
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void api.post(`/api/runs/${running.id}/stop`).catch(() => setStopping(false))
            }}
          >
            {stopping ? t('Stopping…') : t('Stop')}
          </button>
        </div>
        <p class="sm-run__text">{text}</p>
        <span class="sm-run__bar">
          <span style={{ width: `${Math.max(3, Math.round(share * 100))}%` }} />
        </span>
      </div>
    )
  }
  if (!finished) return null
  const scope = JSON.parse(finished.scope || '{}') as { brandIds?: number[] }
  const brandId = scope.brandIds?.find((id) => brands.some((b) => b.id === id))
  return (
    <div class="sm-run sm-run--done" role="status">
      <div class="sm-run__head">
        <b>
          {finished.status === 'stopped'
            ? t('Update stopped')
            : finished.status === 'error'
              ? t('Update failed')
              : t('Update finished')}
        </b>
        <button class="g-icon-btn" type="button" aria-label={t('Close')} onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {brandId && (
        <a class="sm-run__link" href={`/b/${brandId}/reports`} onClick={onClose}>
          {t('Open the report')}
        </a>
      )}
    </div>
  )
}
