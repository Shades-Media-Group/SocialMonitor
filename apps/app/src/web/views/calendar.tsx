import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { CommentRow, PostRow } from '../api.ts'
import { api } from '../api.ts'
import { locale, t } from '../i18n.ts'
import { usePref } from '../prefs.ts'
import { JsonPanel } from '../json.tsx'
import { Icon, Menu, NetworkMark, Segmented, count, fmt, short } from '../ui.tsx'
import { MoodStrip, PostDrawer } from '../social.tsx'
import { CommentList } from './comments.tsx'

/**
 * The calendar: every day, week or month of a period, shaded darker the more happened, with the
 * number on each square and, for weeks and months, how it moved against the one before. Pick
 * what to count, the period, and click a day for its details.
 */
interface DayRow {
  day: string
  comments: number
  complaints: number
  questions: number
  praise: number
  posts: number
  likes: number
  views: number
  interactions: number
}
type Measure = Exclude<keyof DayRow, 'day'>
type Look = 'days' | 'weeks' | 'months'

const MEASURES: [Measure, string, string][] = [
  ['comments', 'Comments', 'blue'],
  ['complaints', 'Complaints', 'red'],
  ['questions', 'Questions', 'violet'],
  ['praise', 'Praise', 'green'],
  ['posts', 'Posts', 'ink'],
  ['likes', 'Likes', 'pink'],
  ['views', 'Views', 'amber'],
  ['interactions', 'Interactions', 'orange'],
]

const iso = (d: Date) => d.toISOString().slice(0, 10)
const at = (day: string) => new Date(`${day}T12:00:00Z`)
const addDays = (day: string, n: number) => {
  const d = at(day)
  d.setUTCDate(d.getUTCDate() + n)
  return iso(d)
}
const monthStart = (day: string) => `${day.slice(0, 7)}-01`
/** Today on this computer's calendar, not in UTC. */
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function presets(): [string, string, string][] {
  const now = today()
  const y = now.slice(0, 4)
  const back = (months: number) => {
    const d = at(now)
    d.setUTCMonth(d.getUTCMonth() - months + 1, 1)
    return iso(d)
  }
  return [
    [t('This month'), monthStart(now), now],
    [t('Last 3 months'), back(3), now],
    [t('Last 6 months'), back(6), now],
    [t('Last 12 months'), back(12), now],
    [t('This year'), `${y}-01-01`, now],
  ]
}

/** Darker for more: square root, so a few big days don't wash the rest out. */
const level = (n: number, max: number) => (max ? Math.sqrt(n / max) : 0)

const pct = (now: number, before: number | undefined) =>
  before == null
    ? null
    : before === 0
      ? now
        ? null
        : 0
      : Math.round(((now - before) / before) * 100)

function Change({ v }: { v: number | null }) {
  if (v == null) return null
  return (
    <span class={`sm-cal__badge${v > 0 ? ' is-up' : v < 0 ? ' is-down' : ''}`}>
      {v > 0 ? '+' : ''}
      {v}%
    </span>
  )
}

/**
 * A day's details float next to the day that was clicked, the way a calendar shows an event,
 * so the months never move. Escape, a click outside or a scroll closes it.
 */
function DayPop({
  anchor,
  title,
  onClose,
  children,
}: {
  anchor: DOMRect
  title: string
  onClose: () => void
  children: ComponentChildren
}) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const w = box.current!.offsetWidth
    const h = box.current!.offsetHeight
    const gap = 8
    let left = anchor.right + gap
    if (left + w > innerWidth - 12) left = anchor.left - w - gap
    if (left < 12) left = Math.min(Math.max(12, anchor.left), innerWidth - w - 12)
    const top = Math.max(12, Math.min(anchor.top, innerHeight - h - 12))
    setPos({ top, left })
  }, [anchor])
  useEffect(() => {
    const inside = (e: Event) => box.current?.contains(e.target as Node)
    const down = (e: Event) => {
      // Another day takes over through its own click; anything else outside closes.
      if (!inside(e) && !(e.target as Element).closest?.('.sm-cal__day')) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const scroll = (e: Event) => !inside(e) && onClose()
    addEventListener('pointerdown', down)
    addEventListener('keydown', key)
    addEventListener('scroll', scroll, true)
    return () => {
      removeEventListener('pointerdown', down)
      removeEventListener('keydown', key)
      removeEventListener('scroll', scroll, true)
    }
  }, [onClose])
  return (
    <div
      ref={box}
      class="sm-daypop"
      role="dialog"
      aria-label={title}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      <header class="sm-daypop__head">
        <h2>{title}</h2>
        <button class="g-icon-btn" type="button" onClick={onClose} aria-label={t('Close')}>
          <Icon name="close" size={15} />
        </button>
      </header>
      {children}
    </div>
  )
}

export function Calendar({ brand, brands, network, version, mode }: BrandView) {
  const [range, setRange] = useState<[string, string]>(
    () => presets()[1]!.slice(1) as [string, string],
  )
  const [look, setLook] = usePref<Look>('calendar.look', 'days')
  const [measure, setMeasure] = usePref<Measure>('calendar.measure', 'comments')
  const [rows, setRows] = useState<DayRow[] | null>(null)
  const [before, setBefore] = useState<DayRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [openPost, setOpenPost] = useState<PostRow | null>(null)
  const [popTab, setPopTab] = usePref<'posts' | 'comments'>('calendar.popTab', 'posts')
  const [dayComments, setDayComments] = useState<CommentRow[] | null>(null)
  const [dayTick, setDayTick] = useState(0)
  const close = () => setPicked(null)
  useEffect(() => {
    if (!picked || popTab !== 'comments') return
    setDayComments(null)
    api
      .get<CommentRow[]>(
        `/api/comments?brand=${brand.id}&threads=1&day=${picked}&limit=300${network ? `&network=${network}` : ''}`,
      )
      .then(setDayComments)
      .catch(() => setDayComments([]))
  }, [picked, popTab, brand.id, network, dayTick])
  const [posts, setPosts] = useState<PostRow[]>([])

  const [from, to] = range
  const span = Math.round((at(to).getTime() - at(from).getTime()) / 86400_000) + 1
  useEffect(() => {
    const q = (a: string, b: string) =>
      `/api/brands/${brand.id}/daily?from=${a}&to=${b}${network ? `&network=${network}` : ''}`
    setError(null)
    api
      .get<DayRow[]>(q(from, to))
      .then(setRows)
      .catch((e: Error) => setError(e.message))
    // The same length of time just before, for the change.
    api
      .get<DayRow[]>(q(addDays(from, -span), addDays(from, -1)))
      .then(setBefore)
      .catch(() => setBefore([]))
    api
      .get<PostRow[]>(
        `/api/posts?brand=${brand.id}&limit=500${network ? `&network=${network}` : ''}`,
      )
      .then(setPosts)
      .catch(() => setPosts([]))
  }, [brand.id, network, from, to, version])

  const tone = MEASURES.find((m) => m[0] === measure)![2]
  const name = t(MEASURES.find((m) => m[0] === measure)![1])
  const fmtDay = (day: string, o: Intl.DateTimeFormatOptions) =>
    at(day).toLocaleDateString(locale, { timeZone: 'UTC', ...o })

  if (mode === 'json' && rows) return <JsonPanel value={rows} />
  if (error) return <p class="g-error">{error}</p>
  if (!rows) return null

  const v = (r: DayRow) => r[measure]
  const total = rows.reduce((n, r) => n + v(r), 0)
  const totalBefore = before.reduce((n, r) => n + v(r), 0)
  const busiest = rows.reduce((a, r) => (v(r) > v(a) ? r : a), rows[0]!)
  const active = rows.filter((r) => v(r) > 0).length

  // Group into weeks (Monday first) and months for the coarser views.
  const groups = (key: (day: string) => string) => {
    const m = new Map<string, number>()
    for (const r of [...before, ...rows]) m.set(key(r.day), (m.get(key(r.day)) ?? 0) + v(r))
    return m
  }
  const weekOf = (day: string) => addDays(day, -((at(day).getUTCDay() + 6) % 7))
  const weeks = groups(weekOf)
  const months = groups(monthStart)
  const inRange = (keys: string[]) => keys.filter((k) => k >= weekOf(from) && k <= to)

  const pickedRow = picked ? rows.find((r) => r.day === picked) : undefined
  const pickedPosts = picked ? posts.filter((p) => p.posted_at?.slice(0, 10) === picked) : []

  const dayCell = (day: string, max: number) => {
    const r = rows.find((x) => x.day === day)
    if (!r) return <span class="sm-cal__day is-out" />
    const n = v(r)
    const a = level(n, max)
    return (
      <button
        type="button"
        class={`sm-cal__day${a > 0.55 ? ' is-dark' : ''}${picked === day ? ' is-picked' : ''}${day === today() ? ' is-today' : ''}`}
        style={{ '--a': a }}
        aria-expanded={picked === day}
        onClick={(e) => {
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
          setPicked(picked === day ? null : day)
        }}
        title={`${fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' })} · ${name}: ${fmt(n)} · ${count(r.posts, 'post')} · ${count(r.comments, 'comment')}`}
      >
        <span class="sm-cal__date">{Number(day.slice(8))}</span>
        {(r.posts > 0 || r.comments > 0) && (
          <span class="sm-cal__ns">
            {r.posts > 0 && (
              <span class="sm-cal__n sm-cal__n--post g-num" title={t('Posts')}>
                {short(r.posts)}
              </span>
            )}
            {r.comments > 0 && (
              <span class="sm-cal__n g-num" title={t('Comments')}>
                {short(r.comments)}
              </span>
            )}
          </span>
        )}
      </button>
    )
  }

  const monthList: string[] = []
  for (let m = monthStart(from); m <= to; m = monthStart(addDays(m, 32))) monthList.push(m)
  // Months before anything happened are left out, so the view opens on activity.
  while (
    monthList.length > 1 &&
    !rows.some((r) => r.day.startsWith(monthList[0]!.slice(0, 7)) && v(r) > 0)
  )
    monthList.shift()
  const maxDay = Math.max(1, ...rows.map(v))
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    fmtDay(addDays('2024-01-01', i), { weekday: 'narrow' }),
  )

  return (
    <div class="sm-cal-page">
      <div class="sm-toolbar">
        <Segmented<Look>
          label={t('View')}
          value={look}
          onChange={setLook}
          options={[
            ['days', t('Days')],
            ['weeks', t('Weeks')],
            ['months', t('Months')],
          ]}
        />
        <select
          class="g-select sm-select-sm"
          aria-label={t('What to count')}
          value={measure}
          onChange={(e) => setMeasure((e.target as HTMLSelectElement).value as Measure)}
        >
          {MEASURES.map(([k, label]) => (
            <option value={k}>{t(label)}</option>
          ))}
        </select>
        <label class="sm-cal__range">
          <span>{t('From')}</span>
          <input
            class="g-input"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setRange([(e.target as HTMLInputElement).value || from, to])}
          />
        </label>
        <label class="sm-cal__range">
          <span>{t('To')}</span>
          <input
            class="g-input"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setRange([from, (e.target as HTMLInputElement).value || to])}
          />
        </label>
        <Menu
          label={t('Quick periods')}
          items={presets().map(([label, a, b]) => ({ label, onSelect: () => setRange([a, b]) }))}
        >
          {t('Quick periods')}
        </Menu>
      </div>

      <dl class={`sm-kpis sm-kpis--row sm-tone--${tone}`}>
        <div class={`sm-kpi sm-tone--${tone}`}>
          <dt>{name}</dt>
          <dd class="sm-kpi__value">
            <span class="g-num">{fmt(total)}</span>
            <Change v={pct(total, totalBefore)} />
          </dd>
          <dd class="sm-kpi__sub">
            {totalBefore
              ? t('{n} in the period before', { n: fmt(totalBefore) })
              : t('Nothing in the period before')}
          </dd>
        </div>
        <div class="sm-kpi">
          <dt>{t('Per day')}</dt>
          <dd class="sm-kpi__value">
            <span class="g-num">
              {fmt(Math.round((total / Math.max(1, rows.length)) * 10) / 10)}
            </span>
          </dd>
          <dd class="sm-kpi__sub">{t('{n} days with any', { n: active })}</dd>
        </div>
        <div class="sm-kpi">
          <dt>{t('Busiest day')}</dt>
          <dd class="sm-kpi__value">
            <span class="g-num">{fmt(v(busiest))}</span>
          </dd>
          <dd class="sm-kpi__sub">
            {fmtDay(busiest.day, { weekday: 'short', day: 'numeric', month: 'short' })}
          </dd>
        </div>
        <div class="sm-kpi">
          <dt>{t('Period')}</dt>
          <dd class="sm-kpi__value">
            <span class="g-num">{span}</span>
          </dd>
          <dd class="sm-kpi__sub">
            {fmtDay(from, { day: 'numeric', month: 'short' })} –{' '}
            {fmtDay(to, { day: 'numeric', month: 'short', year: 'numeric' })}
          </dd>
        </div>
      </dl>

      <div class={`sm-cal sm-tone--${tone}`}>
        <div class="sm-cal__main">
          {look === 'days' && (
            <div class="sm-cal__months">
              {monthList.map((m) => {
                const first = (at(m).getUTCDay() + 6) % 7
                const dim = new Date(
                  Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0),
                ).getUTCDate()
                const mTotal = months.get(m) ?? 0
                const prevKey = monthStart(addDays(m, -1))
                return (
                  <section class="sm-box sm-cal__month">
                    <header class="sm-box__head">
                      <h2>{fmtDay(m, { month: 'long', year: 'numeric' })}</h2>
                      <span class="sm-cal__mtotal g-num">
                        {fmt(mTotal)} <Change v={pct(mTotal, months.get(prevKey))} />
                      </span>
                    </header>
                    <div class="sm-cal__grid">
                      {weekdays.map((w) => (
                        <span class="sm-cal__wd">{w}</span>
                      ))}
                      {Array.from({ length: first }, () => (
                        <span class="sm-cal__day is-out" />
                      ))}
                      {Array.from({ length: dim }, (_, i) =>
                        dayCell(`${m.slice(0, 8)}${String(i + 1).padStart(2, '0')}`, maxDay),
                      )}
                    </div>
                  </section>
                )
              })}
            </div>
          )}

          {look !== 'days' &&
            (() => {
              const map = look === 'weeks' ? weeks : months
              const keys = look === 'weeks' ? inRange([...map.keys()].sort()) : monthList
              const max = Math.max(1, ...keys.map((k) => map.get(k) ?? 0))
              return (
                <div class={`sm-cal__tiles sm-cal__tiles--${look}`}>
                  {keys.map((k) => {
                    const n = map.get(k) ?? 0
                    const prev = look === 'weeks' ? addDays(k, -7) : monthStart(addDays(k, -1))
                    const a = level(n, max)
                    return (
                      <div class={`sm-cal__tile${a > 0.55 ? ' is-dark' : ''}`} style={{ '--a': a }}>
                        <Change v={pct(n, map.get(prev))} />
                        <span class="sm-cal__tlabel">
                          {look === 'weeks'
                            ? `${fmtDay(k, { day: 'numeric', month: 'short' })} – ${fmtDay(addDays(k, 6), { day: 'numeric', month: 'short' })}`
                            : fmtDay(k, { month: 'long', year: 'numeric' })}
                        </span>
                        <b class="g-num">{fmt(n)}</b>
                      </div>
                    )
                  })}
                </div>
              )
            })()}

          <div class="sm-cal__legend" aria-hidden="true">
            <span class="sm-cal__key">
              <span class="sm-cal__n sm-cal__n--post">3</span> {t('Posts')}
            </span>
            <span class="sm-cal__key">
              <span class="sm-cal__n">5</span> {t('Comments')}
            </span>
            <span>{t('Less')}</span>
            {[0, 0.25, 0.5, 0.75, 1].map((a) => (
              <i style={{ '--a': a }} />
            ))}
            <span>{t('More')}</span>
          </div>
        </div>

        {pickedRow && anchor && (
          <DayPop
            anchor={anchor}
            title={fmtDay(pickedRow.day, { weekday: 'long', day: 'numeric', month: 'long' })}
            onClose={close}
          >
            <dl class="sm-daypop__stats">
              {MEASURES.map(([k, label]) => (
                <div class={k === measure ? 'is-on' : ''}>
                  <dt>{t(label)}</dt>
                  <dd class="g-num">{fmt(pickedRow[k])}</dd>
                </div>
              ))}
            </dl>
            <Segmented
              value={popTab}
              onChange={setPopTab}
              options={[
                ['posts', `${t('Posts')} · ${fmt(pickedPosts.length)}`],
                ['comments', `${t('Comments')} · ${fmt(pickedRow.comments)}`],
              ]}
              label={t('Show')}
            />
            {popTab === 'posts' &&
              (pickedPosts.length > 0 ? (
                <ul class="sm-daypop__posts">
                  {pickedPosts.map((p) => (
                    <li>
                      <button type="button" onClick={() => setOpenPost(p)}>
                        {p.thumb_url ? (
                          <img src={p.thumb_url} alt="" />
                        ) : (
                          <span class="sm-postcell__blank" />
                        )}
                        <span class="sm-daypop__post">
                          <span class="sm-daypop__cap">
                            <NetworkMark network={p.network} size={11} />{' '}
                            {p.description ?? p.caption ?? t('No caption.')}
                          </span>
                          <dl class="sm-daypop__pstats">
                            {(
                              [
                                ['Likes', p.likes],
                                ['Comments', p.comments_count],
                                ['Shares', p.shares],
                                ['Views', p.views],
                              ] as const
                            ).map(([label, v]) => (
                              <div>
                                <dt>{t(label)}</dt>
                                <dd class="g-num">{short(v)}</dd>
                              </div>
                            ))}
                          </dl>
                          <MoodStrip p={p} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="sm-daypop__none">{t('No posts this day.')}</p>
              ))}
            {popTab === 'comments' &&
              (dayComments === null ? (
                <p class="sm-daypop__none">{t('Loading…')}</p>
              ) : dayComments.length ? (
                <CommentList
                  comments={dayComments}
                  brands={brands}
                  onChange={() => setDayTick((x) => x + 1)}
                />
              ) : (
                <p class="sm-daypop__none">{t('No comments this day.')}</p>
              ))}
          </DayPop>
        )}
      </div>
      <PostDrawer post={openPost} brands={brands} onClose={() => setOpenPost(null)} />
    </div>
  )
}
