import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import { api } from '../api.ts'
import { JsonPanel } from '../json.tsx'
import { locale, t } from '../i18n.ts'
import { Empty, Segmented, ago, fmt } from '../ui.tsx'
import { usePref } from '../prefs.ts'

interface Advertiser {
  id: number
  page_id: string
  label: string | null
  own: number
  page_name: string | null
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
interface Ad {
  library_id: string
  page_id: string
  page_name: string | null
  active: number
  started_on: string | null
  ended_on: string | null
  platforms: string
  body: string
  title: string | null
  caption: string | null
  link_url: string | null
  cta: string | null
  format: string | null
  media_kind: string | null
  media_path: string | null
  versions: number | null
  reach: string | null
  spend: string | null
  impressions: string | null
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
interface View {
  country: string
  cap: number
  run: Run | null
  advertisers: Advertiser[]
  months: string[]
  ads: Ad[]
  matching: number
}

const PLATFORM: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  messenger: 'Messenger',
  audience_network: 'Audience Network',
  whatsapp: 'WhatsApp',
  threads: 'Threads',
}
const SINCE: [string, string][] = [
  ['0', 'Any start date'],
  ['7', 'Started in the last 7 days'],
  ['30', 'Started in the last 30 days'],
  ['90', 'Started in the last 90 days'],
  ['365', 'Started in the last 12 months'],
]
const COUNTRIES = ['MD', 'RO', 'UA', 'ALL']
/** Ads shown at a time. */
const STEP = 50

const dayFmt = new Intl.DateTimeFormat(locale, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})
const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
const day = (d: string | null) => (d ? dayFmt.format(new Date(`${d}T00:00:00Z`)) : '–')
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
const nameOf = (a: Pick<Advertiser, 'label' | 'page_name' | 'page_id'>) =>
  a.label || a.page_name || a.page_id
const libraryLink = (id: string) =>
  `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`

/**
 * Super admins only: the ads Meta's public Ad Library shows for the brand's own Facebook Page and
 * its competitors', read logged out and kept, stopped ones included.
 */
export function Ads({ brand, mode, version }: BrandView) {
  const [v, setV] = useState<View | null>(null)
  const [failed, setFailed] = useState('')
  const [page, setPage] = usePref<string>(`ads.page:${brand.id}`, '')
  const [status, setStatus] = usePref<'active' | 'all'>('ads.status', 'all')
  const [platform, setPlatform] = usePref<string>('ads.platform', '')
  const [since, setSince] = usePref<string>('ads.since', '0')
  const [tick, setTick] = useState(0)
  const [readError, setReadError] = useState('')

  // Fifty at a time; a filter change starts again from fifty.
  const [limit, setLimit] = useState(STEP)
  useEffect(() => setLimit(STEP), [brand.id, page, status, platform, since])
  const query = new URLSearchParams({ status, limit: String(limit) })
  if (page) query.set('page', page)
  if (platform) query.set('platform', platform)
  if (since !== '0')
    query.set('since', new Date(Date.now() - Number(since) * 86_400_000).toISOString().slice(0, 10))
  const load = () =>
    api
      .get<View>(`/api/brands/${brand.id}/ads?${query}`)
      .then((x) => {
        setV(x)
        setFailed('')
      })
      .catch((e: Error) => setFailed(e.message))
  useEffect(() => void load(), [brand.id, version, tick, page, status, platform, since, limit])
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
  const filtered = !!(page || status === 'active' || platform || since !== '0')

  return (
    <div class="sm-stack sm-ads">
      <Advertisers
        v={v}
        brandId={brand.id}
        reload={load}
        onRead={read}
        onStop={stop}
        readError={readError}
        page={page}
        setPage={setPage}
      />
      {v.advertisers.length > 0 && (
        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{t('Ads')}</h2>
            <span class="sm-box__meta g-num">
              {v.matching > v.ads.length
                ? t('{shown} of {n} ads, running first', {
                    shown: fmt(v.ads.length),
                    n: fmt(v.matching),
                  })
                : t('{n} ads, running first', { n: fmt(v.matching) })}
            </span>
          </header>
          <div class="sm-ads__filters">
            <select
              class="g-select sm-select-sm"
              aria-label={t('Advertiser')}
              value={page}
              onChange={(e) => setPage((e.target as HTMLSelectElement).value)}
            >
              <option value="">{t('Every advertiser')}</option>
              {v.advertisers.map((a) => (
                <option value={a.page_id}>{nameOf(a)}</option>
              ))}
            </select>
            <Segmented
              label={t('Status')}
              value={status}
              onChange={setStatus}
              options={[
                ['all', t('All')],
                ['active', t('Running now')],
              ]}
            />
            <select
              class="g-select sm-select-sm"
              aria-label={t('Platform')}
              value={platform}
              onChange={(e) => setPlatform((e.target as HTMLSelectElement).value)}
            >
              <option value="">{t('Every platform')}</option>
              {Object.entries(PLATFORM).map(([k, name]) => (
                <option value={k}>{name}</option>
              ))}
            </select>
            <select
              class="g-select sm-select-sm"
              aria-label={t('Started')}
              value={since}
              onChange={(e) => setSince((e.target as HTMLSelectElement).value)}
            >
              {SINCE.map(([k, label]) => (
                <option value={k}>{t(label)}</option>
              ))}
            </select>
            {filtered && (
              <button
                class="sm-textbtn"
                type="button"
                onClick={() => {
                  setPage('')
                  setStatus('all')
                  setPlatform('')
                  setSince('0')
                }}
              >
                {t('Clear filters')}
              </button>
            )}
          </div>
          {v.ads.length ? (
            <ul class="sm-ads__list">
              {v.ads.map((a) => (
                <AdLine ad={a} advertisers={v.advertisers} />
              ))}
              {v.matching > v.ads.length && v.ads.length < 500 && (
                <li class="sm-ads__more">
                  <button
                    class="g-btn g-btn--ghost g-btn--sm"
                    type="button"
                    onClick={() => setLimit(Math.min(500, limit + STEP))}
                  >
                    {t('Show {n} more ads', { n: Math.min(STEP, v.matching - v.ads.length) })}
                  </button>
                </li>
              )}
            </ul>
          ) : v.advertisers.some((a) => a.total > 0) ? (
            <Empty title={t('No ads match these filters.')}>
              {t('Clear a filter to see more.')}
            </Empty>
          ) : (
            <Empty title={t('Nothing read yet.')}>
              {t('Press Update ads to read what the Ad Library shows for these Pages.')}
            </Empty>
          )}
        </section>
      )}
    </div>
  )
}

/** One ad: its picture, what it says, where it leads, who ran it, when and where. */
function AdLine({ ad, advertisers }: { ad: Ad; advertisers: Advertiser[] }) {
  const owner = advertisers.find((x) => x.page_id === ad.page_id)
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
          <span class="g-num">
            {ad.active
              ? t('Since {date}', { date: day(ad.started_on) })
              : `${day(ad.started_on)} – ${day(ad.ended_on)}`}
          </span>
          {platforms.length > 0 && <span>{platforms.join(', ')}</span>}
          {ad.link_url && (
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
