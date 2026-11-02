import { useEffect, useRef, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import { api } from '../api.ts'
import { JsonPanel } from '../json.tsx'
import { locale, t } from '../i18n.ts'
import { Empty, Segmented, ago, fmt } from '../ui.tsx'
import { getPref, setPref, usePref } from '../prefs.ts'
import type { Ad, Owner } from './ad-cards.tsx'
import {
  AdCard,
  AdDialog,
  Masonry,
  PLATFORM,
  day,
  host,
  libraryLink,
  nameOf,
  runLine,
} from './ad-cards.tsx'

interface Advertiser extends Owner {
  id: number
  last_read_at: string | null
  last_status: string | null
  last_error: string | null
  last_total: number | null
  total: number
  active: number
  new_week: number
  first_start: string | null
  last_start: string | null
  months: number[]
}
interface Run {
  id: number
  status: string
  started_at: string
  finished_at: string | null
  progress: string | null
  stats: string | null
  log: string
}
interface Facets {
  pages: Record<string, number>
  status: { active: number; stopped: number }
  platform: Record<string, number>
  media: Record<string, number>
  cta: { type: string; text: string | null; n: number }[]
}
interface View {
  country: string
  cap: number
  run: Run | null
  advertisers: Advertiser[]
  months: string[]
  ads: Ad[]
  matching: number
  focus: Ad | null
  facets: Facets
}

/** What the Ads screen shows: kept in the address, so a view can be linked, and per brand. */
interface Filters {
  page: string[]
  status: 'all' | 'active' | 'stopped'
  platform: string
  media: string
  /** 0 (any), 7, 30, 90 days, or custom between from and to. */
  started: string
  from: string
  to: string
  cta: string
  q: string
  sort: 'newest' | 'longest' | 'versions'
}
const NONE: Filters = {
  page: [],
  status: 'all',
  platform: '',
  media: '',
  started: '0',
  from: '',
  to: '',
  cta: '',
  q: '',
  sort: 'newest',
}
const KEYS = ['page', 'status', 'platform', 'media', 'started', 'from', 'to', 'cta', 'q', 'sort']
const STARTED = ['0', '7', '30', '90', 'custom']
const DATE = /^\d{4}-\d{2}-\d{2}$/
const isoDay = (daysBack: number) =>
  new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10)

/** The filters an address carries; null when it carries none, so the saved ones apply. */
function fromQuery(q: URLSearchParams): Filters | null {
  if (!KEYS.some((k) => q.has(k))) return null
  const pick = <T extends string>(v: string | null, ok: readonly T[], d: T) =>
    ok.includes(v as T) ? (v as T) : d
  return {
    page: (q.get('page') ?? '').split(',').filter((p) => /^\d{5,20}$/.test(p)),
    status: pick(q.get('status'), ['all', 'active', 'stopped'] as const, 'all'),
    platform: pick(q.get('platform'), Object.keys(PLATFORM), ''),
    media: pick(q.get('media'), ['image', 'video', 'carousel', 'text'], ''),
    started: pick(q.get('started'), STARTED, '0'),
    from: DATE.test(q.get('from') ?? '') ? q.get('from')! : '',
    to: DATE.test(q.get('to') ?? '') ? q.get('to')! : '',
    cta: /^[A-Z_]{2,40}$/.test(q.get('cta') ?? '') ? q.get('cta')! : '',
    q: (q.get('q') ?? '').slice(0, 100),
    sort: pick(q.get('sort'), ['newest', 'longest', 'versions'] as const, 'newest'),
  }
}
function toQuery(f: Filters) {
  const q = new URLSearchParams()
  if (f.page.length) q.set('page', f.page.join(','))
  if (f.status !== 'all') q.set('status', f.status)
  if (f.platform) q.set('platform', f.platform)
  if (f.media) q.set('media', f.media)
  if (f.started !== '0') q.set('started', f.started)
  if (f.started === 'custom' && f.from) q.set('from', f.from)
  if (f.started === 'custom' && f.to) q.set('to', f.to)
  if (f.cta) q.set('cta', f.cta)
  if (f.q.trim()) q.set('q', f.q.trim())
  if (f.sort !== 'newest') q.set('sort', f.sort)
  return q
}
/**
 * The filters to start with: the address's, else the ones this person last used on this brand,
 * else the ones the first release kept (one advertiser, running or all, a platform, a start
 * window), so nobody's choice is dropped.
 */
function initialFilters(brandId: number): Filters {
  const url = fromQuery(new URLSearchParams(location.search))
  if (url) return url
  const saved = getPref<Partial<Filters> | null>(`ads.filters:${brandId}`, null)
  if (saved) return { ...NONE, ...saved }
  const page = getPref<string>(`ads.page:${brandId}`, '')
  const since = getPref<string>('ads.since', '0')
  return {
    ...NONE,
    page: page ? [page] : [],
    status: getPref<string>('ads.status', 'all') === 'active' ? 'active' : 'all',
    platform: getPref<string>('ads.platform', ''),
    ...(STARTED.includes(since)
      ? { started: since }
      : Number(since) > 0
        ? { started: 'custom', from: isoDay(Number(since)) }
        : {}),
  }
}

const readHash = () => /^#ad=([\w-]{1,40})$/.exec(location.hash)?.[1] ?? null

const COUNTRIES = ['MD', 'RO', 'UA', 'ALL']
/** Ads drawn at a time: a multiple of two, three and four columns. */
const STEP = 48
const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
const withCount = (label: string, n: number | undefined) => `${label} (${fmt(n ?? 0)})`

/**
 * Super admins only: the ads Meta's public Ad Library shows for the brand's own Facebook Page and
 * its competitors', read logged out and kept, stopped ones included. Cards by default, the
 * compact list as the other view, both behind the same filters.
 */
export function Ads({ brand, mode, version }: BrandView) {
  const [v, setV] = useState<View | null>(null)
  const [failed, setFailed] = useState('')
  const [f, setF] = useState<Filters>(() => initialFilters(brand.id))
  const [q, setQ] = useState(f.q)
  const [view, setView] = usePref<'cards' | 'list'>('ads.view', 'cards')
  const [tick, setTick] = useState(0)
  const [readError, setReadError] = useState('')
  const [open, setOpen] = useState<string | null>(readHash)
  const pushed = useRef(false)

  // A filter change goes into the address (replacing it, so Back leaves the screen) and is kept.
  const change = (patch: Partial<Filters>) => setF((old) => ({ ...old, ...patch }))
  useEffect(() => {
    const s = toQuery(f).toString()
    history.replaceState(
      history.state,
      '',
      `${location.pathname}${s ? `?${s}` : ''}${location.hash}`,
    )
    setPref(`ads.filters:${brand.id}`, f)
  }, [f])
  // Words are searched once typing pauses.
  useEffect(() => {
    if (q === f.q) return
    const timer = setTimeout(() => change({ q }), 300)
    return () => clearTimeout(timer)
  }, [q])
  // Back and Forward: the pop-up follows the address, and so do the filters.
  useEffect(() => {
    const sync = () => {
      setOpen(readHash())
      if (!readHash()) pushed.current = false
      const url = fromQuery(new URLSearchParams(location.search))
      if (url && toQuery(url).toString() !== toQuery(f).toString()) {
        setF(url)
        setQ(url.q)
      }
    }
    addEventListener('popstate', sync)
    addEventListener('hashchange', sync)
    return () => {
      removeEventListener('popstate', sync)
      removeEventListener('hashchange', sync)
    }
  }, [f])

  // Forty-eight at a time; a filter change starts again from forty-eight.
  const [limit, setLimit] = useState(STEP)
  const filterKey = toQuery(f).toString()
  useEffect(() => setLimit(STEP), [brand.id, filterKey])
  const query = new URLSearchParams({ status: f.status, limit: String(limit) })
  if (f.page.length) query.set('page', f.page.join(','))
  if (f.platform) query.set('platform', f.platform)
  if (f.media) query.set('media', f.media)
  if (f.cta) query.set('cta', f.cta)
  if (f.q.trim()) query.set('q', f.q.trim())
  if (f.sort !== 'newest') query.set('sort', f.sort)
  if (f.started === 'custom') {
    if (f.from) query.set('since', f.from)
    if (f.to) query.set('until', f.to)
  } else if (f.started !== '0') query.set('since', isoDay(Number(f.started)))
  // A linked ad that is not in the list is asked for by itself.
  const missing = open && !v?.ads.some((a) => a.library_id === open) ? open : ''
  if (missing) query.set('ad', missing)
  const load = () =>
    api
      .get<View>(`/api/brands/${brand.id}/ads?${query}`)
      .then((x) => {
        setV(x)
        setFailed('')
      })
      .catch((e: Error) => setFailed(e.message))
  useEffect(() => void load(), [brand.id, version, tick, filterKey, limit, missing])
  // While a read runs, follow it every two seconds.
  const live = v?.run?.status === 'running'
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setTick((n) => n + 1), 2000)
    return () => clearInterval(timer)
  }, [live])

  if (failed && !v) return <Empty title={t('The ads did not load.')}>{failed}</Empty>
  if (!v) return null
  if (mode === 'json') return <JsonPanel value={v} />

  const read = async () => {
    setReadError('')
    try {
      await api.post(`/api/brands/${brand.id}/ads/read`)
      setTick((n) => n + 1)
    } catch (e) {
      setReadError((e as Error).message)
    }
  }
  const stop = () =>
    void api.post(`/api/brands/${brand.id}/ads/stop`).then(() => setTick((n) => n + 1))
  const filtered = filterKey !== '' && toQuery({ ...f, sort: 'newest' }).toString() !== ''

  // The pop-up: opening adds #ad=<id> to the address, so Back closes it and a link opens it.
  const base = () => `${location.pathname}${location.search}`
  const openAd = (id: string) => {
    history.pushState(history.state, '', `${base()}#ad=${id}`)
    pushed.current = true
    setOpen(id)
  }
  const closeAd = () => {
    setOpen(null)
    if (pushed.current) {
      pushed.current = false
      history.back()
    } else history.replaceState(history.state, '', base())
  }
  const index = open ? v.ads.findIndex((a) => a.library_id === open) : -1
  const shown = index >= 0 ? v.ads[index] : open && v.focus?.library_id === open ? v.focus : null
  const step = (d: -1 | 1) => {
    const next = v.ads[index + d]
    if (!next) return
    history.replaceState(history.state, '', `${base()}#ad=${next.library_id}`)
    setOpen(next.library_id)
  }
  const owner = (pageId: string) => v.advertisers.find((a) => a.page_id === pageId)
  const total = v.facets.status.active + v.facets.status.stopped

  return (
    <div class="sm-stack sm-ads">
      <Advertisers
        v={v}
        brandId={brand.id}
        reload={load}
        onRead={read}
        onStop={stop}
        readError={readError}
        page={f.page.length === 1 ? f.page[0]! : ''}
        setPage={(p) => change({ page: p ? [p] : [] })}
      />
      {v.advertisers.length > 0 && (
        <section class="sm-box sm-adsbar" aria-labelledby="sm-ads-title">
          <header class="sm-box__head">
            <h2 id="sm-ads-title">{t('Ads')}</h2>
            <span class="sm-box__meta g-num" role="status">
              {v.matching > v.ads.length
                ? t('{shown} of {n} ads', { shown: fmt(v.ads.length), n: fmt(v.matching) })
                : t('{n} ads', { n: fmt(v.matching) })}
            </span>
            <span class="sm-adsbar__view">
              <Segmented
                label={t('Show ads as')}
                value={view}
                onChange={setView}
                options={[
                  ['cards', t('Cards')],
                  ['list', t('List')],
                ]}
              />
            </span>
          </header>
          <div class="sm-adsbar__row">
            <input
              class="g-input sm-search"
              type="search"
              placeholder={t('Search headlines, text and links')}
              aria-label={t('Search headlines, text and links')}
              value={q}
              maxLength={100}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            />
            <Segmented
              label={t('Status')}
              value={f.status}
              onChange={(status) => change({ status })}
              options={[
                ['all', withCount(t('All'), total)],
                ['active', withCount(t('Running'), v.facets.status.active)],
                ['stopped', withCount(t('Stopped'), v.facets.status.stopped)],
              ]}
            />
            <select
              class="g-select sm-select-sm"
              aria-label={t('Media')}
              value={f.media}
              onChange={(e) => change({ media: (e.target as HTMLSelectElement).value })}
            >
              <option value="">{t('Any media')}</option>
              {(
                [
                  ['image', t('Picture')],
                  ['video', t('Video')],
                  ['carousel', t('Carousel')],
                  ['text', t('Text only')],
                ] as const
              ).map(([k, label]) => (
                <option value={k}>{withCount(label, v.facets.media[k])}</option>
              ))}
            </select>
            <select
              class="g-select sm-select-sm"
              aria-label={t('Platform')}
              value={f.platform}
              onChange={(e) => change({ platform: (e.target as HTMLSelectElement).value })}
            >
              <option value="">{t('Every platform')}</option>
              {Object.entries(PLATFORM).map(([k, name]) => (
                <option value={k}>{withCount(name, v.facets.platform[k])}</option>
              ))}
            </select>
            <select
              class="g-select sm-select-sm"
              aria-label={t('Call to action')}
              value={f.cta}
              onChange={(e) => change({ cta: (e.target as HTMLSelectElement).value })}
            >
              <option value="">{t('Any call to action')}</option>
              {[
                ...v.facets.cta,
                ...(f.cta && !v.facets.cta.some((c) => c.type === f.cta)
                  ? [{ type: f.cta, text: null, n: 0 }]
                  : []),
              ].map((c) => (
                <option value={c.type}>
                  {withCount(c.text ?? c.type.replace(/_/g, ' ').toLowerCase(), c.n)}
                </option>
              ))}
            </select>
            <select
              class="g-select sm-select-sm"
              aria-label={t('Started')}
              value={f.started}
              onChange={(e) => {
                const started = (e.target as HTMLSelectElement).value
                change(
                  started === 'custom' && !f.from && !f.to
                    ? { started, from: isoDay(30), to: isoDay(0) }
                    : { started },
                )
              }}
            >
              <option value="0">{t('Any start date')}</option>
              <option value="7">{t('Started in the last 7 days')}</option>
              <option value="30">{t('Started in the last 30 days')}</option>
              <option value="90">{t('Started in the last 90 days')}</option>
              <option value="custom">{t('Started between…')}</option>
            </select>
            {f.started === 'custom' && (
              <span class="sm-adsbar__dates">
                <input
                  class="g-input"
                  type="date"
                  aria-label={t('Started on or after')}
                  value={f.from}
                  max={f.to || undefined}
                  onChange={(e) => change({ from: (e.target as HTMLInputElement).value })}
                />
                <span aria-hidden="true">–</span>
                <input
                  class="g-input"
                  type="date"
                  aria-label={t('Started on or before')}
                  value={f.to}
                  min={f.from || undefined}
                  onChange={(e) => change({ to: (e.target as HTMLInputElement).value })}
                />
              </span>
            )}
            <select
              class="g-select sm-select-sm"
              aria-label={t('Sort')}
              value={f.sort}
              onChange={(e) =>
                change({ sort: (e.target as HTMLSelectElement).value as Filters['sort'] })
              }
            >
              <option value="newest">{t('Newest first')}</option>
              <option value="longest">{t('Longest running first')}</option>
              <option value="versions">{t('Most versions first')}</option>
            </select>
            {filtered && (
              <button
                class="sm-textbtn"
                type="button"
                onClick={() => {
                  setF({ ...NONE, sort: f.sort })
                  setQ('')
                }}
              >
                {t('Clear filters')}
              </button>
            )}
          </div>
          {v.advertisers.length > 1 && (
            <div class="sm-adpicks" role="group" aria-label={t('Advertisers')}>
              {v.advertisers.map((a) => {
                const on = f.page.includes(a.page_id)
                return (
                  <button
                    type="button"
                    class="sm-adpick"
                    aria-pressed={on}
                    onClick={() =>
                      change({
                        page: on ? f.page.filter((p) => p !== a.page_id) : [...f.page, a.page_id],
                      })
                    }
                  >
                    {a.avatar ? (
                      <img src={a.avatar} alt="" loading="lazy" />
                    ) : (
                      <span aria-hidden="true">{nameOf(a).slice(0, 1)}</span>
                    )}
                    {nameOf(a)}
                    <span class="g-num">{fmt(v.facets.pages[a.page_id] ?? 0)}</span>
                  </button>
                )
              })}
            </div>
          )}
          {view === 'list' && v.ads.length > 0 && (
            <ul class="sm-ads__list">
              {v.ads.map((a) => (
                <AdLine ad={a} owner={owner(a.page_id)} />
              ))}
            </ul>
          )}
          {!v.ads.length &&
            (v.advertisers.some((a) => a.total > 0) ? (
              <Empty title={t('No ads match these filters.')}>
                {t('Clear a filter to see more.')}
              </Empty>
            ) : (
              <Empty title={t('Nothing read yet.')}>
                {t('Press Update ads to read what the Ad Library shows for these Pages.')}
              </Empty>
            ))}
        </section>
      )}
      {view === 'cards' && v.ads.length > 0 && (
        <Masonry>
          {v.ads.map((a) => (
            <AdCard ad={a} owner={owner(a.page_id)} onOpen={openAd} />
          ))}
        </Masonry>
      )}
      {v.matching > v.ads.length && v.ads.length < 500 && (
        <div class="sm-ads__more">
          <button
            class="g-btn g-btn--ghost g-btn--sm"
            type="button"
            onClick={() => setLimit(Math.min(500, limit + STEP))}
          >
            {t('Show {n} more ads', { n: Math.min(STEP, v.matching - v.ads.length) })}
          </button>
        </div>
      )}
      {shown && (
        <AdDialog
          ad={shown}
          owner={owner(shown.page_id)}
          onClose={closeAd}
          onStep={step}
          prev={index > 0}
          next={index >= 0 && index < v.ads.length - 1}
        />
      )}
    </div>
  )
}

/** One ad in the compact list: its picture, what it says, where it leads, who ran it, when. */
function AdLine({ ad, owner }: { ad: Ad; owner?: Owner }) {
  const platforms = (JSON.parse(ad.platforms || '[]') as string[]).map((p) => PLATFORM[p] ?? p)
  const extra = [
    ad.versions && ad.versions > 1 ? t('{n} ads use this creative', { n: ad.versions }) : null,
    ad.reach ? t('Reach {n}', { n: ad.reach }) : null,
    ad.impressions ? t('Impressions {n}', { n: ad.impressions }) : null,
    ad.spend ? t('Spent {n}', { n: ad.spend }) : null,
  ].filter(Boolean)
  return (
    <li class="sm-ad">
      <a
        class="sm-ad__media"
        href={libraryLink(ad.library_id)}
        target="_blank"
        rel="noreferrer"
        aria-label={t('Open in the Ad Library')}
      >
        {ad.media_path ? (
          <img src={ad.media_path} alt="" loading="lazy" />
        ) : (
          <span class="sm-ad__blank" />
        )}
        {ad.media_kind === 'video' && <span class="sm-ad__kind">{t('Video')}</span>}
      </a>
      <div class="sm-ad__main">
        <p class="sm-ad__who">
          <b>{owner ? nameOf(owner) : (ad.page_name ?? ad.page_id)}</b>
          <span class={ad.active ? 'sm-ad__state is-on' : 'sm-ad__state'}>
            {ad.active ? t('Running') : t('Stopped')}
          </span>
        </p>
        {ad.title && <p class="sm-ad__title">{ad.title}</p>}
        {/* An event's text is often its title again: said once. */}
        {(ad.body || ad.caption) && (ad.body || ad.caption) !== ad.title ? (
          <p class="sm-ad__body">{ad.body || ad.caption}</p>
        ) : !ad.title ? (
          <p class="sm-ad__body">{t('No text.')}</p>
        ) : null}
        <p class="sm-ad__meta">
          <span class="g-num">{runLine(ad)}</span>
          {platforms.length > 0 && <span>{platforms.join(', ')}</span>}
          {ad.link_url && /^https?:\/\//i.test(ad.link_url) && (
            <a href={ad.link_url} target="_blank" rel="noreferrer">
              {host(ad.link_url)}
            </a>
          )}
          {extra.length > 0 && <span class="g-num">{extra.join(' · ')}</span>}
          <a href={libraryLink(ad.library_id)} target="_blank" rel="noreferrer">
            {t('Library ID {id}', { id: ad.library_id })}
          </a>
        </p>
      </div>
    </li>
  )
}

/** Twelve months of start dates as small bars, this month last. */
function Spread({ months, labels }: { months: number[]; labels: string[] }) {
  const max = Math.max(1, ...months)
  const text = labels
    .map((m, i) => `${monthFmt.format(new Date(`${m}-01T00:00:00Z`))} ${months[i]}`)
    .join(', ')
  // One baseline for the year; a bar only where ads started.
  return (
    <svg class="sm-ads__spread" viewBox="0 0 84 20" role="img" aria-label={text}>
      <title>{text}</title>
      <rect x="0" y="19" width="82" height="1" />
      {months.map((n, i) =>
        n ? (
          <rect
            class="is-on"
            x={i * 7}
            y={19 - Math.max(2, Math.round((n / max) * 18))}
            width="5"
            height={Math.max(2, Math.round((n / max) * 18))}
            rx="1"
          />
        ) : null,
      )}
    </svg>
  )
}

/**
 * The Pages the brand watches, with their figures, how to add one, the country searched and the
 * read itself: its button, its progress and how the last one ended.
 */
function Advertisers({
  v,
  brandId,
  reload,
  onRead,
  onStop,
  readError,
  page,
  setPage,
}: {
  v: View
  brandId: number
  reload: () => Promise<void>
  onRead: () => void
  onStop: () => void
  readError: string
  page: string
  setPage: (p: string) => void
}) {
  const [input, setInput] = useState('')
  const [label, setLabel] = useState('')
  const [own, setOwn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = v.run
  const running = run?.status === 'running'
  const progress = JSON.parse(run?.progress || '{}') as {
    at?: number
    of?: number
    name?: string
    read?: number
  }
  const stats = JSON.parse(run?.stats || '{}') as {
    read?: number
    fresh?: number
    failed?: number
  }

  const add = async (e: Event) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.post(`/api/brands/${brandId}/ads/advertisers`, { page: input, label, own })
      setInput('')
      setLabel('')
      setOwn(false)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (a: Advertiser) => {
    if (!confirm(t('Stop watching {name}? The ads already read stay.', { name: nameOf(a) }))) return
    await api.del(`/api/brands/${brandId}/ads/advertisers/${a.id}`)
    if (page === a.page_id) setPage('')
    await reload()
  }
  const setCountry = async (cc: string) => {
    await api.put(`/api/brands/${brandId}/dashboards`, { ads_country: cc })
    await reload()
  }

  return (
    <section class="sm-box">
      <header class="sm-box__head">
        <h2>{t('Advertisers')}</h2>
        <span class="sm-box__meta">{t('From Meta’s public Ad Library, read logged out')}</span>
      </header>

      <div class="sm-ads__bar">
        <label class="sm-ads__country">
          <span>{t('Country')}</span>
          <select
            class="g-select sm-select-sm"
            value={v.country}
            disabled={running}
            onChange={(e) => void setCountry((e.target as HTMLSelectElement).value)}
          >
            {[...new Set([...COUNTRIES, v.country])].map((c) => (
              <option value={c}>{c === 'ALL' ? t('All countries') : c}</option>
            ))}
          </select>
        </label>
        <p class="sm-ads__status" role="status">
          {readError && !running ? (
            <span class="g-error">{readError}</span>
          ) : running ? (
            t('Reading {name}, Page {at} of {of}. {n} ads so far.', {
              name: progress.name ?? '…',
              at: progress.at ?? 1,
              of: progress.of ?? v.advertisers.length,
              n: fmt(progress.read ?? 0),
            })
          ) : run?.status === 'login' ? (
            <span class="g-error">
              {t(
                'Meta asked for a login, so the read stopped. Nothing was signed in to. Try again later.',
              )}
            </span>
          ) : run?.status === 'error' ? (
            <span class="g-error">{t('The last read failed. Its log says why.')}</span>
          ) : run ? (
            t('Last read {when}: {read} ads, {fresh} new.', {
              when: ago(run.finished_at ?? run.started_at),
              read: fmt(stats.read ?? 0),
              fresh: fmt(stats.fresh ?? 0),
            })
          ) : (
            t('Not read yet.')
          )}
        </p>
        {running ? (
          <button class="g-btn g-btn--sm" type="button" onClick={onStop}>
            {t('Stop reading')}
          </button>
        ) : (
          <button
            class="g-btn g-btn--sm"
            type="button"
            disabled={!v.advertisers.length}
            onClick={onRead}
          >
            {t('Update ads')}
          </button>
        )}
      </div>

      {v.advertisers.length > 0 ? (
        <div class="sm-scroll">
          <table class="sm-dtable sm-ads__table">
            <thead>
              <tr>
                <th>{t('Page')}</th>
                <th class="sm-num">{t('Running now')}</th>
                <th class="sm-num sm-ads__wide">{t('Started this week')}</th>
                <th class="sm-num sm-ads__wide">{t('Kept')}</th>
                <th class="sm-ads__wide">{t('First and latest start')}</th>
                <th class="sm-ads__wide">{t('Starts by month')}</th>
                <th>
                  <span class="sm-sr">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {v.advertisers.map((a) => (
                <tr class={page === a.page_id ? 'is-current' : undefined}>
                  <td class="sm-ads__page">
                    <button
                      type="button"
                      class="sm-ads__pick"
                      aria-pressed={page === a.page_id}
                      onClick={() => setPage(page === a.page_id ? '' : a.page_id)}
                    >
                      {nameOf(a)}
                    </button>
                    <span class="sm-ads__sub">
                      {a.own ? t('This brand') : t('Competitor')}
                      <span class="sm-ads__wide"> · {a.page_id}</span>
                      {a.last_status === 'error' && (
                        <span class="sm-ads__err" title={a.last_error ?? ''}>
                          {' · '}
                          {t('Last read failed')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td class="sm-num g-num">{fmt(a.active)}</td>
                  <td class="sm-num g-num sm-ads__wide">{fmt(a.new_week)}</td>
                  <td class="sm-num g-num sm-ads__wide">
                    {fmt(a.total)}
                    {a.last_total != null && a.last_total > a.total && (
                      <span class="sm-ads__sub">
                        {t('of {n} in the Library', { n: fmt(a.last_total) })}
                      </span>
                    )}
                  </td>
                  <td class="g-num sm-nowrap sm-ads__wide">
                    {a.first_start ? `${day(a.first_start)} – ${day(a.last_start)}` : '–'}
                  </td>
                  <td class="sm-ads__wide">
                    <Spread months={a.months} labels={v.months} />
                  </td>
                  <td class="sm-num">
                    <button
                      class="sm-textbtn"
                      type="button"
                      disabled={running}
                      onClick={() => void remove(a)}
                    >
                      {t('Remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title={t('No Pages yet.')}>
          {t(
            'Add the brand’s own Facebook Page and its competitors’ by Page ID. The Ad Library link of a Page carries it after view_all_page_id=.',
          )}
        </Empty>
      )}

      <form class="sm-ads__add" onSubmit={add}>
        <label class="sm-ads__field sm-ads__field--wide">
          <span>{t('Page ID or Ad Library link')}</span>
          <input
            class="g-input"
            required
            inputMode="url"
            autocomplete="off"
            value={input}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? 'sm-ads-error' : undefined}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="sm-ads__field">
          <span>{t('Name (optional)')}</span>
          <input
            class="g-input"
            autocomplete="off"
            value={label}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="g-check sm-ads__own">
          <input
            type="checkbox"
            checked={own}
            onChange={(e) => setOwn((e.target as HTMLInputElement).checked)}
          />
          {t('This brand’s own Page')}
        </label>
        <button class="g-btn g-btn--sm" type="submit" disabled={busy}>
          {t('Add Page')}
        </button>
        {error && (
          <p class="g-error sm-ads__error" id="sm-ads-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  )
}
