import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import { api } from '../api.ts'
import { JsonPanel } from '../json.tsx'
import { locale, t } from '../i18n.ts'
import { BrandLines, Heatmap } from '../charts.tsx'
import {
  Empty,
  Icon,
  Modal,
  NETWORK_NAME,
  NetworkMark,
  Segmented,
  ago,
  count,
  fmt,
  when,
} from '../ui.tsx'
import { getPref, setPref, usePref } from '../prefs.ts'
import type { Network } from '../api.ts'

/**
 * Stories: everything the brand and its competitors posted for a day, kept after it is gone. The
 * archive as tiles at their own shape, grouped by day, with a player that steps through them the
 * way a phone does; and the figures over them. What the brand's people see follows its plan.
 */

interface StoryFile {
  position: number
  kind: string
  width: number | null
  height: number | null
  duration: number | null
  src: string | null
  poster: string | null
  status: string
  original: boolean
  original_until: string | null
  original_bytes: number | null
  compact_bytes: number | null
}
interface Story {
  id: number
  brand_id: number
  own: boolean
  account: string
  network: Network
  handle: string
  posted_at: string | null
  expires_at: string | null
  live: boolean
  first_seen_at: string
  last_seen_at: string
  caption: string
  stickers: string[]
  mentions: string[]
  links: string[]
  music: { title: string; author: string | null } | null
  views: number | null
  likes: number | null
  shares: number | null
  replies: number | null
  insights: Record<string, number> | null
  permalink: string | null
  about: string | null
  kind: string | null
  text: string | null
  tone: string | null
  repost_of: string | null
  ai_error: string | null
  files: StoryFile[]
}
interface Account {
  brand_id: number
  name: string
  own: boolean
  profiles: { network: Network; handle: string }[]
  total: number
  last: string | null
}
interface Run {
  id: number
  status: string
  started_at: string
  finished_at: string | null
  stats: string | null
  log: string
}
interface View {
  scope: { own: boolean; rivals: boolean }
  plan: { stories: boolean; rival_stories: boolean } | null
  run: Run | null
  can_check: boolean
  original_days: number
  meta: { enabled: boolean; connected: boolean }
  accounts: Account[]
  stories: Story[]
  matching: number
  facets: {
    brands: Record<string, number>
    network: Record<string, number>
    kind: Record<string, number>
    state: { live: number; expired: number }
  }
}
interface Stats {
  days: string[]
  series: {
    brand_id: number
    name: string
    own: boolean
    values: number[]
    total: number
    per_day: number
    days_posted: number
  }[]
  weekly: { brand_id: number; values: number[] }[]
  heatmap: number[][]
  kinds: { kind: string | null; n: number }[]
  mentioned: { handle: string; n: number }[]
  reposts: { handle: string; n: number }[]
  insights: Record<string, number | null> | null
  views: { brand_id: number; views: number; likes: number | null }[]
}

/** The kinds Claude sorts stories into, in the order the filter lists them. */
const KINDS: [string, string][] = [
  ['promo', 'Promotion'],
  ['product', 'Product'],
  ['event', 'Event'],
  ['announcement', 'Announcement'],
  ['behind-the-scenes', 'Behind the scenes'],
  ['user-content', 'Customer content'],
  ['repost', 'Repost'],
  ['other', 'Other'],
]
const kindName = (k: string | null) => t(KINDS.find(([x]) => x === k)?.[1] ?? 'Not read yet')
const TONE: Record<string, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
}

interface Filters {
  account: number[]
  network: string
  kind: string
  has: '' | 'mentions' | 'reposts'
  state: 'all' | 'live' | 'expired'
  posted: string
}
const NONE: Filters = { account: [], network: '', kind: '', has: '', state: 'all', posted: '0' }

const isoDay = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10)
const profileUrl = (network: string, handle: string) =>
  network === 'tiktok'
    ? `https://www.tiktok.com/@${encodeURIComponent(handle)}`
    : network === 'instagram'
      ? `https://www.instagram.com/${encodeURIComponent(handle)}/`
      : `https://www.facebook.com/${encodeURIComponent(handle)}`
const dayHead = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' })
const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
const posted = (s: Story) => s.posted_at ?? s.first_seen_at
const ratio = (f: StoryFile | undefined) =>
  f?.width && f.height ? `${f.width} / ${f.height}` : '9 / 16'
const seconds = (n: number | null) =>
  n == null ? '' : `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`
const UNITS = ['kilobyte', 'megabyte', 'gigabyte'] as const
function size(n: number | null) {
  if (!n) return '–'
  const i = Math.min(2, Math.max(0, Math.floor(Math.log(n) / Math.log(1024)) - 1))
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: UNITS[i],
    unitDisplay: 'short',
    maximumFractionDigits: i ? 1 : 0,
  }).format(n / 1024 ** (i + 1))
}

/** "Live, ends in 5 hours" or "Expired". */
function lifeLine(s: Story) {
  if (!s.live || !s.expires_at) return t('Expired')
  const h = Math.floor((Date.parse(s.expires_at) - Date.now()) / 3_600_000)
  return h < 1
    ? t('Live, ends within the hour')
    : t('Live, ends in {time}', { time: count(h, 'hour') })
}

const readHash = () => Number(/^#story=(\d{1,12})$/.exec(location.hash)?.[1]) || null

export function Stories({ brand, mode, version, me }: BrandView) {
  const [v, setV] = useState<View | null>(null)
  const [failed, setFailed] = useState('')
  const [tab, setTab] = usePref<'archive' | 'stats'>('stories.view', 'archive')
  const [f, setF] = useState<Filters>(() => ({
    ...NONE,
    ...getPref<Partial<Filters>>(`stories.filters:${brand.id}`, {}),
  }))
  const [tick, setTick] = useState(0)
  const [checkError, setCheckError] = useState('')
  const [open, setOpen] = useState<number | null>(readHash)
  const pushed = useRef(false)
  const change = (patch: Partial<Filters>) =>
    setF((old) => {
      const next = { ...old, ...patch }
      setPref(`stories.filters:${brand.id}`, next)
      return next
    })

  const query = new URLSearchParams({ limit: '300' })
  if (f.account.length) query.set('account', f.account.join(','))
  if (f.network) query.set('network', f.network)
  if (f.kind) query.set('kind', f.kind)
  if (f.has) query.set('has', f.has)
  if (f.state !== 'all') query.set('state', f.state)
  if (f.posted !== '0') query.set('since', isoDay(Number(f.posted) - 1))
  const key = query.toString()
  const load = () =>
    api
      .get<View>(`/api/brands/${brand.id}/stories?${key}`)
      .then((x) => {
        setV(x)
        setFailed('')
      })
      .catch((e: Error) => setFailed(e.message))
  useEffect(() => void load(), [brand.id, version, tick, key])
  // While a check runs, follow it.
  const running = v?.run?.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick((n) => n + 1), 3000)
    return () => clearInterval(timer)
  }, [running])
  useEffect(() => {
    const sync = () => {
      setOpen(readHash())
      if (!readHash()) pushed.current = false
    }
    addEventListener('hashchange', sync)
    addEventListener('popstate', sync)
    return () => {
      removeEventListener('hashchange', sync)
      removeEventListener('popstate', sync)
    }
  }, [])

  if (failed && !v) return <Empty title={t('The stories did not load.')}>{failed}</Empty>
  if (!v) return null
  if (mode === 'json') return <JsonPanel value={v} />

  const check = async () => {
    setCheckError('')
    try {
      await api.post(`/api/brands/${brand.id}/stories/check`)
      setTick((n) => n + 1)
    } catch (e) {
      setCheckError((e as Error).message)
    }
  }
  const base = () => `${location.pathname}${location.search}`
  const openStory = (id: number) => {
    history.pushState(history.state, '', `${base()}#story=${id}`)
    pushed.current = true
    setOpen(id)
  }
  const close = () => {
    setOpen(null)
    if (pushed.current) {
      pushed.current = false
      history.back()
    } else history.replaceState(history.state, '', base())
  }
  const move = (id: number) => {
    history.replaceState(history.state, '', `${base()}#story=${id}`)
    setOpen(id)
  }
  const filtered = JSON.stringify(f) !== JSON.stringify(NONE)
  const total = v.facets.state.live + v.facets.state.expired

  return (
    <div class="sm-stack sm-stories">
      <Sources v={v} me={!!me.super} running={running} onCheck={check} error={checkError} />
      <div class="sm-stories__switch">
        <Segmented
          label={t('Show')}
          value={tab}
          onChange={setTab}
          options={[
            ['archive', t('Archive')],
            ['stats', t('Statistics')],
          ]}
        />
      </div>
      {tab === 'stats' ? (
        <StoryStats brandId={brand.id} version={version + tick} />
      ) : (
        <>
          <section class="sm-box sm-adsbar" aria-labelledby="sm-stories-title">
            <header class="sm-box__head">
              <h2 id="sm-stories-title">{t('Stories')}</h2>
              <span class="sm-box__meta g-num" role="status">
                {v.matching > v.stories.length
                  ? t('{shown} of {n} stories', {
                      shown: fmt(v.stories.length),
                      n: fmt(v.matching),
                    })
                  : t('{n} stories', { n: fmt(v.matching) })}
              </span>
            </header>
            <div class="sm-adsbar__row">
              <Segmented
                label={t('Status')}
                value={f.state}
                onChange={(state) => change({ state })}
                options={[
                  ['all', `${t('All')} (${fmt(total)})`],
                  ['live', `${t('Live')} (${fmt(v.facets.state.live)})`],
                  ['expired', `${t('Expired')} (${fmt(v.facets.state.expired)})`],
                ]}
              />
              <select
                class="g-select sm-select-sm"
                aria-label={t('Network')}
                value={f.network}
                onChange={(e) => change({ network: (e.target as HTMLSelectElement).value })}
              >
                <option value="">{t('All networks')}</option>
                {(['tiktok', 'instagram', 'facebook'] as const).map((n) => (
                  <option
                    value={n}
                  >{`${NETWORK_NAME[n]} (${fmt(v.facets.network[n] ?? 0)})`}</option>
                ))}
              </select>
              <select
                class="g-select sm-select-sm"
                aria-label={t('Type')}
                value={f.kind}
                onChange={(e) => change({ kind: (e.target as HTMLSelectElement).value })}
              >
                <option value="">{t('Any type')}</option>
                {KINDS.map(([k, name]) => (
                  <option value={k}>{`${t(name)} (${fmt(v.facets.kind[k] ?? 0)})`}</option>
                ))}
              </select>
              <select
                class="g-select sm-select-sm"
                aria-label={t('Mentions and reposts')}
                value={f.has}
                onChange={(e) =>
                  change({ has: (e.target as HTMLSelectElement).value as Filters['has'] })
                }
              >
                <option value="">{t('Any mentions')}</option>
                <option value="mentions">{t('Names another account')}</option>
                <option value="reposts">{t('Reposts')}</option>
              </select>
              <select
                class="g-select sm-select-sm"
                aria-label={t('Posted')}
                value={f.posted}
                onChange={(e) => change({ posted: (e.target as HTMLSelectElement).value })}
              >
                <option value="0">{t('Any date')}</option>
                <option value="1">{t('Today')}</option>
                <option value="7">{t('Last 7 days')}</option>
                <option value="30">{t('Last 30 days')}</option>
                <option value="90">{t('Last 90 days')}</option>
              </select>
              {filtered && (
                <button class="sm-textbtn" type="button" onClick={() => change(NONE)}>
                  {t('Clear filters')}
                </button>
              )}
            </div>
            {v.accounts.length > 1 && (
              <div class="sm-adpicks" role="group" aria-label={t('Accounts')}>
                {v.accounts.map((a) => {
                  const on = f.account.includes(a.brand_id)
                  return (
                    <button
                      type="button"
                      class="sm-adpick"
                      aria-pressed={on}
                      onClick={() =>
                        change({
                          account: on
                            ? f.account.filter((x) => x !== a.brand_id)
                            : [...f.account, a.brand_id],
                        })
                      }
                    >
                      <span aria-hidden="true">{a.name.slice(0, 1)}</span>
                      {a.name}
                      <span class="g-num">{fmt(v.facets.brands[a.brand_id] ?? 0)}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {!v.stories.length &&
              (v.accounts.some((a) => a.total > 0) ? (
                <Empty title={t('No stories match these filters.')}>
                  {t('Clear a filter to see more.')}
                </Empty>
              ) : (
                <Empty title={t('No stories kept yet.')}>
                  {t(
                    'Stories last a day. SocialMonitor checks every three hours and keeps each one it finds, with its video or picture, after it is gone. They show here, newest first.',
                  )}
                </Empty>
              ))}
          </section>
          <Gallery stories={v.stories} onOpen={openStory} />
        </>
      )}
      {open != null && (
        <Player
          stories={v.stories}
          id={open}
          days={v.original_days}
          onClose={close}
          onMove={move}
        />
      )}
    </div>
  )
}

/**
 * Where the stories come from: the accounts read, the last check and the button, and what the
 * Meta route waits for.
 */
function Sources({
  v,
  me,
  running,
  onCheck,
  error,
}: {
  v: View
  me: boolean
  running: boolean
  onCheck: () => void
  error: string
}) {
  const stats = JSON.parse(v.run?.stats || '{}') as { read?: number; fresh?: number }
  const own = v.accounts.find((a) => a.own)
  const rivals = v.accounts.filter((a) => !a.own)
  return (
    <section class="sm-box sm-stsrc">
      <header class="sm-box__head">
        <h2>{t('Accounts')}</h2>
        <span class="sm-box__meta">{t('Checked every three hours, read logged out')}</span>
      </header>
      <div class="sm-stsrc__row">
        <ul class="sm-stsrc__list">
          {[...(own ? [own] : []), ...rivals].map((a) => (
            <li>
              <b>{a.name}</b>
              <span class="sm-stsrc__sub">
                {a.own ? t('This brand') : t('Competitor')}
                {a.profiles.map((p) => (
                  <a href={profileUrl(p.network, p.handle)} target="_blank" rel="noreferrer">
                    <NetworkMark network={p.network} size={12} />@{p.handle}
                  </a>
                ))}
              </span>
              <span class="sm-stsrc__n g-num">{count(a.total, 'story')}</span>
            </li>
          ))}
        </ul>
        <div class="sm-stsrc__check">
          <p class="sm-ads__status" role="status">
            {error && !running ? (
              <span class="g-error">{error}</span>
            ) : running ? (
              t('Checking the accounts for stories now.')
            ) : v.run?.status === 'wall' ? (
              <span class="g-error">
                {t(
                  'TikTok asked to prove a person was there, so the check stopped. Nothing was signed in to. It tries again in three hours.',
                )}
              </span>
            ) : v.run?.status === 'error' ? (
              <span class="g-error">
                {t('The last check failed. It tries again in three hours.')}
              </span>
            ) : v.run ? (
              t('Last checked {when}: {read} found, {fresh} new.', {
                when: ago(v.run.finished_at ?? v.run.started_at),
                read: fmt(stats.read ?? 0),
                fresh: fmt(stats.fresh ?? 0),
              })
            ) : (
              t('Not checked yet.')
            )}
          </p>
          {v.can_check && (
            <button class="g-btn g-btn--sm" type="button" disabled={running} onClick={onCheck}>
              {running ? t('Checking…') : t('Check stories now')}
            </button>
          )}
        </div>
      </div>
      <p class="sm-box__note">
        {v.meta.enabled
          ? v.meta.connected
            ? t(
                'Instagram and Facebook stories come through Meta for the brand’s own connected Page, with their reach and replies.',
              )
            : t(
                'Instagram and Facebook stories start once the brand connects its Facebook Page on About.',
              )
          : t(
              'Instagram and Facebook stories start once Meta approves SocialMonitor and the brand connects its Facebook Page on About. Competitors’ stories come from TikTok only.',
            )}
      </p>
      {me && v.plan && !v.plan.stories && !v.plan.rival_stories && (
        <p class="sm-box__note">
          {t(
            'Stories are off in this brand’s plan: only super admins see this tab, and checks run only when one presses the button. Turn them on in Admin.',
          )}
        </p>
      )}
    </section>
  )
}

/** The archive: a day at a time, newest first, each story a tile at its own shape. */
function Gallery({ stories, onOpen }: { stories: Story[]; onOpen: (id: number) => void }) {
  const days = new Map<string, Story[]>()
  for (const s of stories) {
    const d = new Date(posted(s)).toLocaleDateString('en-CA')
    days.set(d, [...(days.get(d) ?? []), s])
  }
  if (!stories.length) return null
  return (
    <div class="sm-stdays">
      {[...days].map(([day, list]) => (
        <section class="sm-stday" aria-label={dayHead.format(new Date(`${day}T12:00:00`))}>
          <h3 class="sm-stday__head">
            {dayHead.format(new Date(`${day}T12:00:00`))}
            <span class="g-num">{count(list.length, 'story')}</span>
          </h3>
          <ul class="sm-sttiles">
            {list.map((s) => (
              <li>
                <Tile s={s} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Tile({ s, onOpen }: { s: Story; onOpen: (id: number) => void }) {
  const f = s.files[0]
  return (
    <button type="button" class="sm-sttile" onClick={() => onOpen(s.id)}>
      <span class="sm-sttile__frame" style={{ '--ar': ratio(f) }}>
        {f?.poster ? (
          <img src={f.poster} alt="" loading="lazy" decoding="async" />
        ) : (
          <span class="sm-sttile__none">
            {f?.status === 'pending' ? t('Being saved') : t('No file kept')}
          </span>
        )}
        <span class="sm-sttile__top">
          <NetworkMark network={s.network} size={12} />
          <span>@{s.handle}</span>
        </span>
        <span class="sm-sttile__foot g-num">
          <span>{clock.format(new Date(posted(s)))}</span>
          {f?.kind === 'video' && f.duration ? (
            <span class="sm-sttile__dur">
              <Icon name="play" size={10} />
              {seconds(f.duration)}
            </span>
          ) : s.files.length > 1 ? (
            <span>{t('{n} pictures', { n: s.files.length })}</span>
          ) : null}
        </span>
      </span>
      <span class={s.live ? 'sm-sttile__life is-live' : 'sm-sttile__life'}>{lifeLine(s)}</span>
      <span class="sm-sttile__about">
        {s.about ?? (s.caption || s.stickers.join(' · ') || kindName(s.kind))}
      </span>
    </button>
  )
}

/** How long a picture stays on screen, as on the networks. */
const IMAGE_MS = 6000

/**
 * The story player: the story large on the dark stage with a bar per file, tap or arrow keys for
 * the next and previous, a swipe on a phone, space to pause; everything kept about it beside.
 */
function Player({
  stories,
  id,
  days,
  onClose,
  onMove,
}: {
  stories: Story[]
  id: number
  days: number
  onClose: () => void
  onMove: (id: number) => void
}) {
  const index = stories.findIndex((s) => s.id === id)
  const s = stories[index]
  const [at, setAt] = useState(0)
  const [progress, setProgress] = useState(0)
  const [paused, setPaused] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    setAt(0)
    setProgress(0)
  }, [id])
  const f = s?.files[at]
  const go = (d: 1 | -1) => {
    if (!s) return
    const next = at + d
    if (next >= 0 && next < s.files.length) {
      setAt(next)
      setProgress(0)
      return
    }
    const other = stories[index + d]
    if (other) onMove(other.id)
  }
  // Pictures advance on a timer; videos when they end. Paused, nothing moves.
  useEffect(() => {
    if (!f || paused || f.kind === 'video' || !f.src) return
    const start = Date.now() - progress * IMAGE_MS
    const timer = setInterval(() => {
      const p = (Date.now() - start) / IMAGE_MS
      if (p >= 1) {
        clearInterval(timer)
        go(1)
      } else setProgress(p)
    }, 50)
    return () => clearInterval(timer)
  }, [id, at, paused, f?.src])
  useEffect(() => {
    const el = video.current
    if (!el) return
    if (paused) el.pause()
    else void el.play().catch(() => setPaused(true))
  }, [paused, id, at])
  if (!s) return null
  const daysLeft = (until: string | null) =>
    until ? Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 86_400_000)) : 0
  const ins = s.insights ?? {}
  const facts = (
    [
      [t('Posted'), when(posted(s))],
      [t('Status'), lifeLine(s)],
      [t('Kept since'), when(s.first_seen_at)],
      s.views != null && [t('Views'), fmt(s.views)],
      s.likes != null && [t('Likes'), fmt(s.likes)],
      s.shares != null && [t('Shares'), fmt(s.shares)],
      s.replies != null && [t('Replies'), fmt(s.replies)],
      ins.reach != null && [t('Reach'), fmt(ins.reach)],
      ins.taps_forward != null && [t('Taps forward'), fmt(ins.taps_forward)],
      ins.taps_back != null && [t('Taps back'), fmt(ins.taps_back)],
      ins.exits != null && [t('Exits'), fmt(ins.exits)],
      ins.follows != null && [t('Follows'), fmt(ins.follows)],
      ins.profile_visits != null && [t('Profile visits'), fmt(ins.profile_visits)],
      s.music && [t('Music'), [s.music.title, s.music.author].filter(Boolean).join(' · ')],
      f?.width && [
        t('File'),
        <span class="g-num">
          {f.width} × {f.height}
          {f.duration ? ` · ${seconds(f.duration)}` : ''}
        </span>,
      ],
    ] as ([string, ComponentChildren] | false | null | undefined | 0)[]
  ).filter((r): r is [string, ComponentChildren] => !!r)
  const handleLink = (h: string) => (
    <a href={profileUrl(s.network, h)} target="_blank" rel="noreferrer">
      @{h}
    </a>
  )
  return (
    <Modal title={t('Story by {name}', { name: `@${s.handle}` })} onClose={onClose} wide>
      <div
        class="sm-addlg sm-stplay"
        onKeyDown={(e) => {
          if ((e.target as Element).tagName === 'A') return
          if (e.key === 'ArrowRight') go(1)
          else if (e.key === 'ArrowLeft') go(-1)
          else if (e.key === ' ') {
            e.preventDefault()
            setPaused((p) => !p)
          } else return
          e.stopPropagation()
        }}
      >
        <div
          class="sm-addlg__stage sm-stplay__stage"
          onPointerDown={(e) => (touch.current = { x: e.clientX, y: e.clientY })}
          onPointerUp={(e) => {
            const t0 = touch.current
            touch.current = null
            if (!t0 || (e.target as Element).closest('button, a, video[controls]')) return
            const dx = e.clientX - t0.x
            if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - t0.y)) go(dx < 0 ? 1 : -1)
            else {
              const r = e.currentTarget.getBoundingClientRect()
              go(e.clientX - r.left < r.width / 3 ? -1 : 1)
            }
          }}
        >
          <div class="sm-stplay__bars" aria-hidden="true">
            {s.files.map((_, i) => (
              <span>
                <i style={{ width: `${i < at ? 100 : i === at ? progress * 100 : 0}%` }} />
              </span>
            ))}
          </div>
          <div class="sm-stplay__media" style={{ '--ar': ratio(f) }}>
            {!f?.src ? (
              <span class="sm-cr__none">
                {f?.status === 'pending'
                  ? t('The file is being saved.')
                  : t('No file was kept for this story.')}
              </span>
            ) : f.kind === 'video' ? (
              <video
                key={`${s.id}-${at}`}
                ref={video}
                src={f.src}
                poster={f.poster ?? undefined}
                playsInline
                autoplay
                preload="auto"
                onTimeUpdate={(e) => {
                  const el = e.currentTarget
                  if (el.duration) setProgress(el.currentTime / el.duration)
                }}
                onEnded={() => go(1)}
              />
            ) : (
              <img key={`${s.id}-${at}`} src={f.src} alt={s.text ?? s.about ?? ''} />
            )}
          </div>
          <span class="sm-stplay__pause">
            <button
              type="button"
              class="g-icon-btn"
              aria-label={paused ? t('Play') : t('Pause')}
              onClick={() => setPaused((p) => !p)}
            >
              <Icon name={paused ? 'play' : 'pause'} size={16} />
            </button>
          </span>
        </div>
        <div class="sm-addlg__side">
          <header class="sm-addlg__head">
            <span class="sm-adface" style={{ width: 36, height: 36 }} aria-hidden="true">
              <span>{s.account.slice(0, 1)}</span>
            </span>
            <span class="sm-adcard__who">
              <a href={profileUrl(s.network, s.handle)} target="_blank" rel="noreferrer">
                <b>{s.account}</b>
              </a>
              <span>
                <span class={s.live ? 'sm-adstate is-on' : 'sm-adstate'}>{lifeLine(s)}</span>
                <span>
                  {' '}
                  · @{s.handle} · {NETWORK_NAME[s.network]}
                </span>
              </span>
            </span>
            <span class="sm-addlg__steps">
              <button
                type="button"
                class="g-icon-btn"
                aria-label={t('Previous story')}
                disabled={index <= 0 && at === 0}
                onClick={() => go(-1)}
              >
                <Icon name="chevronLeft" />
              </button>
              <button
                type="button"
                class="g-icon-btn"
                aria-label={t('Next story')}
                disabled={index >= stories.length - 1 && at >= s.files.length - 1}
                onClick={() => go(1)}
              >
                <Icon name="chevronRight" />
              </button>
            </span>
          </header>
          <div class="sm-addlg__scroll">
            {s.about ? (
              <p class="sm-stplay__about">{s.about}</p>
            ) : (
              <p class="sm-stplay__about is-quiet">
                {s.ai_error
                  ? t('Claude could not read this story yet; it tries again later.')
                  : t('Claude reads each story once its file is saved.')}
              </p>
            )}
            {(s.kind || s.tone) && (
              <p class="sm-stplay__tags">
                {s.kind && <span>{kindName(s.kind)}</span>}
                {s.tone && <span>{t(TONE[s.tone] ?? s.tone)}</span>}
              </p>
            )}
            <dl class="sm-addl">
              {s.repost_of && (
                <>
                  <dt>{t('Reposted from')}</dt>
                  <dd>{handleLink(s.repost_of)}</dd>
                </>
              )}
              {s.mentions.length > 0 && (
                <>
                  <dt>{t('Accounts named')}</dt>
                  <dd class="sm-stplay__handles">{s.mentions.map(handleLink)}</dd>
                </>
              )}
              {s.text && (
                <>
                  <dt>{t('Words on the story')}</dt>
                  <dd>{s.text}</dd>
                </>
              )}
              {s.caption && (
                <>
                  <dt>{t('Caption')}</dt>
                  <dd>{s.caption}</dd>
                </>
              )}
              {s.stickers.length > 0 && (
                <>
                  <dt>{t('Stickers')}</dt>
                  <dd>{s.stickers.join(' · ')}</dd>
                </>
              )}
              {s.links.length > 0 && (
                <>
                  <dt>{t('Links')}</dt>
                  <dd>
                    {s.links.map((u) => (
                      <a class="sm-addl__url" href={u} target="_blank" rel="noreferrer">
                        {u}
                      </a>
                    ))}
                  </dd>
                </>
              )}
              {facts.map(([k, val]) => (
                <>
                  <dt>{k}</dt>
                  <dd>{val}</dd>
                </>
              ))}
            </dl>
          </div>
          {f && (f.original || f.src) && (
            <footer class="sm-addlg__foot sm-stplay__foot">
              {f.src && (
                <a
                  class={f.original ? 'sm-textbtn' : 'g-btn g-btn--sm'}
                  href={`/api/stories/${s.id}/download?pos=${at}`}
                  download
                >
                  <Icon name="download" size={14} />
                  {t('Download')}
                  <span class="g-num">{size(f.compact_bytes)}</span>
                </a>
              )}
              {f.original && (
                <a
                  class="g-btn g-btn--sm"
                  href={`/api/stories/${s.id}/download?pos=${at}&file=original`}
                  download
                  title={t('The best quality the network served, kept for {n} days', { n: days })}
                >
                  <Icon name="download" size={14} />
                  {t('Download original ({left} left)', {
                    left: count(daysLeft(f.original_until), 'day'),
                  })}
                  <span class="g-num">{size(f.original_bytes)}</span>
                </a>
              )}
            </footer>
          )}
        </div>
      </div>
    </Modal>
  )
}

const TONES = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']

/** The figures: how often each account posts, when, what, and whom it names. */
function StoryStats({ brandId, version }: { brandId: number; version: number }) {
  const [days, setDays] = usePref<number>('stories.days', 30)
  const [s, setS] = useState<Stats | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    api
      .get<Stats>(`/api/brands/${brandId}/stories/stats?days=${days}`)
      .then(setS)
      .catch((e: Error) => setFailed(e.message))
  }, [brandId, days, version])
  if (failed && !s) return <Empty title={t('The figures did not load.')}>{failed}</Empty>
  if (!s) return null
  const any = s.series.some((x) => x.total > 0)
  const weekdays = Array.from({ length: 7 }, (_, d) =>
    new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(locale, {
      weekday: 'short',
      timeZone: 'UTC',
    }),
  )
  const kinds = s.kinds.filter((k) => k.n)
  const maxKind = Math.max(1, ...kinds.map((k) => k.n))
  const views = new Map(s.views.map((x) => [x.brand_id, x]))
  return (
    <div class="sm-stack">
      <div class="sm-stories__switch">
        <select
          class="g-select sm-select-sm"
          aria-label={t('Period')}
          value={days}
          onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}
        >
          <option value={7}>{t('Last 7 days')}</option>
          <option value={30}>{t('Last 30 days')}</option>
          <option value={90}>{t('Last 90 days')}</option>
          <option value={365}>{t('Last 12 months')}</option>
        </select>
      </div>
      {!any ? (
        <Empty title={t('No stories in this period yet.')}>
          {t(
            'Each story kept counts here: how often every account posts, at what hours, what kind of story, and whom it names.',
          )}
        </Empty>
      ) : (
        <>
          <section class="sm-box sm-box--table">
            <header class="sm-box__head">
              <h2>{t('Stories per day')}</h2>
              <span class="sm-box__meta">{t('The brand and each competitor')}</span>
            </header>
            <BrandLines
              label={t('Stories per day')}
              days={s.days}
              series={s.series.map((x, i) => ({
                name: x.name,
                tone: TONES[i % 6]!,
                values: x.values,
              }))}
            />
            <div class="sm-scroll">
              <table class="sm-dtable sm-sttable">
                <thead>
                  <tr>
                    <th>{t('Account')}</th>
                    <th class="sm-num">{t('Stories')}</th>
                    <th class="sm-num">{t('A day on average')}</th>
                    <th class="sm-num sm-ads__wide">{t('Days with a story')}</th>
                    <th class="sm-num sm-ads__wide">{t('Last 7 days')}</th>
                    <th class="sm-num sm-ads__wide">{t('Views on average')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.series.map((x) => (
                    <tr class={x.own ? 'is-current' : undefined}>
                      <td>
                        <b>{x.name}</b>
                        <span class="sm-ads__sub">{x.own ? t('This brand') : t('Competitor')}</span>
                      </td>
                      <td class="sm-num g-num">{fmt(x.total)}</td>
                      <td class="sm-num g-num">
                        {new Intl.NumberFormat(locale, {
                          maximumFractionDigits: x.per_day && x.per_day < 1 ? 2 : 1,
                        }).format(x.per_day)}
                      </td>
                      <td class="sm-num g-num sm-ads__wide">{fmt(x.days_posted)}</td>
                      <td class="sm-num g-num sm-ads__wide">
                        {fmt(s.weekly.find((w) => w.brand_id === x.brand_id)?.values.at(-1) ?? 0)}
                      </td>
                      <td class="sm-num g-num sm-ads__wide">
                        {views.has(x.brand_id)
                          ? fmt(Math.round(views.get(x.brand_id)!.views))
                          : '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div class="sm-layout">
            <section class="sm-box sm-span-8">
              <header class="sm-box__head">
                <h2>{t('When they post')}</h2>
                <span class="sm-box__meta">{t('Hours in UTC')}</span>
              </header>
              <Heatmap grid={s.heatmap} days={weekdays} caption={t('When they post')} />
            </section>
            <section class="sm-box sm-span-4">
              <header class="sm-box__head">
                <h2>{t('What they post')}</h2>
                <span class="sm-box__meta">{t('As Claude reads it')}</span>
              </header>
              <ul class="sm-stbars">
                {kinds.map((k) => (
                  <li>
                    <span>{kindName(k.kind)}</span>
                    <span class="sm-stbars__track">
                      <i style={{ width: `${(k.n / maxKind) * 100}%` }} />
                    </span>
                    <b class="g-num">{fmt(k.n)}</b>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <div class="sm-layout">
            <section class="sm-box sm-span-6">
              <header class="sm-box__head">
                <h2>{t('Accounts they name most')}</h2>
              </header>
              {s.mentioned.length ? (
                <ol class="sm-strank">
                  {s.mentioned.map((m) => (
                    <li>
                      <a href={profileUrl('tiktok', m.handle)} target="_blank" rel="noreferrer">
                        @{m.handle}
                      </a>
                      <span class="g-num">{count(m.n, 'story')}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p class="sm-quiet">{t('No story named another account in this period.')}</p>
              )}
            </section>
            <section class="sm-box sm-span-6">
              <header class="sm-box__head">
                <h2>{t('Reposted from')}</h2>
              </header>
              {s.reposts.length ? (
                <ol class="sm-strank">
                  {s.reposts.map((m) => (
                    <li>
                      <a href={profileUrl('tiktok', m.handle)} target="_blank" rel="noreferrer">
                        @{m.handle}
                      </a>
                      <span class="g-num">{count(m.n, 'story')}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p class="sm-quiet">{t('No reposts in this period.')}</p>
              )}
            </section>
          </div>
          <section class="sm-box">
            <header class="sm-box__head">
              <h2>{t('Reach and replies')}</h2>
              <span class="sm-box__meta">
                {t('The brand’s own Instagram stories, through Meta')}
              </span>
            </header>
            {s.insights ? (
              <dl class="sm-admin__rows">
                {(
                  [
                    ['reach', 'Reach'],
                    ['replies', 'Replies'],
                    ['taps_forward', 'Taps forward'],
                    ['exits', 'Exits'],
                    ['profile_visits', 'Profile visits'],
                  ] as const
                ).map(([k, name]) => (
                  <>
                    <dt>{t(name)}</dt>
                    <dd class="g-num">
                      {s.insights![k] == null ? '–' : fmt(Math.round(s.insights![k]!))}
                      <span>{t('on average')}</span>
                    </dd>
                  </>
                ))}
              </dl>
            ) : (
              <p class="sm-quiet">
                {t(
                  'Reach, replies, taps and exits come once the brand’s Instagram is connected and Meta approves SocialMonitor. Networks do not show these for other accounts.',
                )}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
