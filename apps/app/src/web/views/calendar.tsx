import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { PostRow } from '../api.ts'
import { api } from '../api.ts'
import { locale, t } from '../i18n.ts'
import { JsonPanel } from '../json.tsx'
import { Menu, NetworkMark, Segmented, fmt, short } from '../ui.tsx'

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
const today = () => iso(new Date())

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

export function Calendar({ brand, network, version, mode }: BrandView) {
  const [range, setRange] = useState<[string, string]>(
    () => presets()[1]!.slice(1) as [string, string],
  )
  const [look, setLook] = useState<Look>('days')
  const [measure, setMeasure] = useState<Measure>('comments')
  const [rows, setRows] = useState<DayRow[] | null>(null)
  const [before, setBefore] = useState<DayRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
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
        onClick={() => setPicked(picked === day ? null : day)}
        title={`${fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' })} · ${name}: ${fmt(n)}`}
      >
        <span class="sm-cal__date">{Number(day.slice(8))}</span>
        {n > 0 && <span class="sm-cal__n g-num">{short(n)}</span>}
      </button>
    )
  }

  const monthList: string[] = []
  for (let m = monthStart(from); m <= to; m = monthStart(addDays(m, 32))) monthList.push(m)
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
          <dd class="sm-kpi__sub">{t('Against the period before')}</dd>
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

      <div class={`sm-cal sm-tone--${tone}${picked ? ' has-picked' : ''}`}>
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
            <span>{t('Less')}</span>
            {[0, 0.25, 0.5, 0.75, 1].map((a) => (
              <i style={{ '--a': a }} />
            ))}
            <span>{t('More')}</span>
          </div>
        </div>

        {pickedRow && (
          <aside class="sm-box sm-cal__detail">
            <header class="sm-box__head">
              <h2>{fmtDay(pickedRow.day, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
              <button class="sm-textbtn" type="button" onClick={() => setPicked(null)}>
                {t('Close')}
              </button>
            </header>
            <dl class="sm-attr">
              {MEASURES.map(([k, label]) => (
                <>
                  <dt>{t(label)}</dt>
                  <dd class="g-num">{fmt(pickedRow[k])}</dd>
                </>
              ))}
            </dl>
            {pickedPosts.length > 0 && (
              <>
                <h3 class="sm-attr__title">{t('Posts')}</h3>
                <ul class="sm-cal__posts">
                  {pickedPosts.map((p) => (
                    <li>
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.thumb_url && <img src={p.thumb_url} alt="" />}
                        <span>
                          <NetworkMark network={p.network} size={12} /> {p.description ?? p.caption}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
