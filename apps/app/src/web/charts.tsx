import { useEffect, useRef, useState } from 'preact/hooks'
import { fmt } from './ui.tsx'
import { locale, t } from './i18n.ts'

/**
 * Charts drawn as plain SVG, in Gradient's ramps (validated for colour-blind separation and
 * contrast in light and dark). One axis each, thin marks with a 2px gap and rounded tops, a
 * legend whenever there is more than one series, a hover tooltip, and a table behind every
 * chart for screen readers.
 */

export const SERIES = [
  { key: 'complaint', name: t('Complaints') },
  { key: 'question', name: t('Questions') },
  { key: 'suggestion', name: t('Suggestions') },
  { key: 'praise', name: t('Praise') },
  { key: 'other', name: t('Other') },
] as const

type Day = { day: string } & Record<(typeof SERIES)[number]['key'], number>

const H = 220

/** The plot's real width, so text and bars keep their size instead of scaling with the page. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(720)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(
      ([e]) => e && setW(Math.max(280, Math.round(e.contentRect.width))),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}
const PAD = { l: 32, r: 8, t: 8, b: 24 }

const niceMax = (n: number) => {
  if (n <= 4) return 4
  const p = 10 ** Math.floor(Math.log10(n))
  return Math.ceil(n / p) * p
}
const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' })

function Legend({ items }: { items: { key: string; name: string }[] }) {
  return (
    <div class="sm-legend">
      {items.map((s) => (
        <span>
          <i class={`sm-swatch sm-c-${s.key}`} aria-hidden="true" />
          {s.name}
        </span>
      ))}
    </div>
  )
}

/** Comments per day, stacked by type. */
export function TimelineChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const [ref, W] = useWidth()
  const totals = days.map((d) => SERIES.reduce((n, s) => n + d[s.key], 0))
  const max = niceMax(Math.max(0, ...totals))
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const slot = iw / Math.max(1, days.length)
  const bw = Math.max(2, Math.min(18, slot - 2))
  const y = (v: number) => PAD.t + ih - (v / max) * ih
  const ticks = [0, max / 2, max]
  const every = Math.ceil(days.length / Math.max(2, Math.floor(W / 90)))
  const h = hover === null ? null : days[hover]!

  return (
    <figure class="sm-chart">
      <Legend items={SERIES.filter((s) => days.some((d) => d[s.key]))} />
      <div class="sm-chart__plot" ref={ref}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t('Comments per day, by type')}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g>
              <line class="sm-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
              <text class="sm-axis" x={PAD.l - 6} y={y(v) + 4} text-anchor="end">
                {fmt(v)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const x = PAD.l + i * slot + (slot - bw) / 2
            let acc = 0
            const parts = SERIES.filter((s) => d[s.key]).map((s) => {
              const y0 = y(acc)
              acc += d[s.key]
              return { s, y0, y1: y(acc) }
            })
            return (
              <g>
                {parts.map((p, j) => {
                  const top = j === parts.length - 1
                  const hgt = Math.max(0, p.y0 - p.y1 - (j > 0 ? 2 : 0))
                  return top && hgt > 4 ? (
                    <path
                      class={`sm-c-${p.s.key}`}
                      d={`M${x} ${p.y1 + hgt}V${p.y1 + 3}Q${x} ${p.y1} ${x + 3} ${p.y1}H${x + bw - 3}Q${x + bw} ${p.y1} ${x + bw} ${p.y1 + 3}V${p.y1 + hgt}Z`}
                    />
                  ) : (
                    <rect class={`sm-c-${p.s.key}`} x={x} y={p.y1} width={bw} height={hgt} />
                  )
                })}
                {i % every === 0 && (
                  <text class="sm-axis" x={x + bw / 2} y={H - 6} text-anchor="middle">
                    {dayLabel(d.day)}
                  </text>
                )}
                <rect
                  class="sm-hit"
                  x={PAD.l + i * slot}
                  y={PAD.t}
                  width={slot}
                  height={ih}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                />
              </g>
            )
          })}
        </svg>
        {h && (
          <div
            class="sm-tip"
            style={{
              left: `clamp(120px, ${PAD.l + hover! * slot + slot / 2}px, calc(100% - 120px))`,
            }}
          >
            <b>{dayLabel(h.day)}</b>
            {SERIES.filter((s) => h[s.key]).map((s) => (
              <span>
                <i class={`sm-swatch sm-c-${s.key}`} aria-hidden="true" /> {s.name}{' '}
                <b class="g-num">{h[s.key]}</b>
              </span>
            ))}
            {!SERIES.some((s) => h[s.key]) && <span>{t('No comments')}</span>}
          </div>
        )}
      </div>
      <table class="sm-sr">
        <caption>{t('Comments per day')}</caption>
        <thead>
          <tr>
            <th>{t('Day')}</th>
            {SERIES.map((s) => (
              <th>{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days
            .filter((_, i) => totals[i])
            .map((d) => (
              <tr>
                <td>{d.day}</td>
                {SERIES.map((s) => (
                  <td>{d[s.key]}</td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </figure>
  )
}

export interface PostPoint {
  id: number
  day: string | null
  likes: number | null
  comments: number | null
  views: number | null
  url: string
  about: string
}

/** Likes per post, oldest to newest; the tooltip adds comments and views. */
export function EngagementChart({ posts }: { posts: PostPoint[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const [ref, W] = useWidth()
  const max = niceMax(Math.max(0, ...posts.map((p) => p.likes ?? 0)))
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const slot = iw / Math.max(1, posts.length)
  const bw = Math.max(4, Math.min(36, slot - 6))
  const y = (v: number) => PAD.t + ih - (v / max) * ih
  const p = hover === null ? null : posts[hover]!

  return (
    <figure class="sm-chart">
      <div class="sm-chart__plot" ref={ref}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={t('Likes per post')}
          onMouseLeave={() => setHover(null)}
        >
          {[0, max / 2, max].map((v) => (
            <g>
              <line class="sm-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
              <text class="sm-axis" x={PAD.l - 6} y={y(v) + 4} text-anchor="end">
                {fmt(v)}
              </text>
            </g>
          ))}
          {posts.map((q, i) => {
            const x = PAD.l + i * slot + (slot - bw) / 2
            const top = y(q.likes ?? 0)
            const hgt = PAD.t + ih - top
            return (
              <g>
                {hgt > 4 ? (
                  <path
                    class={`sm-c-likes${hover === i ? ' is-hover' : ''}`}
                    d={`M${x} ${top + hgt}V${top + 4}Q${x} ${top} ${x + 4} ${top}H${x + bw - 4}Q${x + bw} ${top} ${x + bw} ${top + 4}V${top + hgt}Z`}
                  />
                ) : (
                  <rect class="sm-c-likes" x={x} y={top} width={bw} height={Math.max(1, hgt)} />
                )}
                {q.day && i % Math.ceil(posts.length / Math.max(2, Math.floor(W / 90))) === 0 && (
                  <text class="sm-axis" x={x + bw / 2} y={H - 6} text-anchor="middle">
                    {dayLabel(q.day)}
                  </text>
                )}
                <a
                  href={q.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('Open the post of {day}', { day: q.day ?? '' })}
                >
                  <rect
                    class="sm-hit"
                    x={PAD.l + i * slot}
                    y={PAD.t}
                    width={slot}
                    height={ih}
                    onMouseEnter={() => setHover(i)}
                  />
                </a>
              </g>
            )
          })}
        </svg>
        {p && (
          <div
            class="sm-tip"
            style={{
              left: `clamp(120px, ${PAD.l + hover! * slot + slot / 2}px, calc(100% - 120px))`,
            }}
          >
            <b>{p.day ? dayLabel(p.day) : t('Post')}</b>
            <span class="sm-tip__about">{p.about}</span>
            <span>
              {t('Likes')} <b class="g-num">{fmt(p.likes)}</b>
            </span>
            <span>
              {t('Comments')} <b class="g-num">{fmt(p.comments)}</b>
            </span>
            {p.views != null && (
              <span>
                {t('Views')} <b class="g-num">{fmt(p.views)}</b>
              </span>
            )}
          </div>
        )}
      </div>
      <table class="sm-sr">
        <caption>{t('Likes per post')}</caption>
        <thead>
          <tr>
            <th>{t('Published')}</th>
            <th>{t('Likes')}</th>
            <th>{t('Comments')}</th>
            <th>{t('Views')}</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((q) => (
            <tr>
              <td>{q.day}</td>
              <td>{q.likes}</td>
              <td>{q.comments}</td>
              <td>{q.views}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

/** A small trend line for a figure: one series, no axes, the area under it softly filled. */
export function Sparkline({ values, tone }: { values: number[]; tone: string }) {
  const w = 96
  const h = 28
  if (values.length < 2) return null
  const max = Math.max(1, ...values)
  const pts = values.map(
    (v, i) => [(i / (values.length - 1)) * w, h - 2 - (v / max) * (h - 4)] as const,
  )
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('')
  return (
    <svg
      class={`sm-spark sm-tone--${tone}`}
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
    >
      <path class="sm-spark__area" d={`${line}L${w} ${h}L0 ${h}Z`} />
      <path class="sm-spark__line" d={line} />
    </svg>
  )
}

/** Parts of a whole as a ring, with the total in the middle and a legend beside it. */
export function Donut({
  parts,
  total,
  caption,
}: {
  parts: { key: string; name: string; n: number }[]
  total: string
  caption: string
}) {
  const sum = parts.reduce((n, p) => n + p.n, 0)
  const r = 52
  const c = 2 * Math.PI * r
  let at = 0
  return (
    <div class="sm-donut">
      <svg viewBox="0 0 132 132" width="132" height="132" role="img" aria-label={caption}>
        <circle class="sm-donut__track" cx="66" cy="66" r={r} />
        {sum > 0 &&
          parts
            .filter((p) => p.n)
            .map((p) => {
              const len = (p.n / sum) * c
              const seg = (
                <circle
                  class={`sm-donut__seg sm-c-${p.key}`}
                  cx="66"
                  cy="66"
                  r={r}
                  stroke-dasharray={`${Math.max(0, len - 2)} ${c}`}
                  stroke-dashoffset={-at}
                />
              )
              at += len
              return seg
            })}
        <text class="sm-donut__total" x="66" y="64" text-anchor="middle">
          {total}
        </text>
        <text class="sm-donut__cap" x="66" y="82" text-anchor="middle">
          {caption}
        </text>
      </svg>
      <ul class="sm-donut__legend">
        {parts.map((p) => (
          <li>
            <i class={`sm-swatch sm-c-${p.key}`} aria-hidden="true" />
            <span>{p.name}</span>
            <b class="g-num">{fmt(p.n)}</b>
            <span class="sm-donut__pct g-num">
              {sum ? `${Math.round((p.n / sum) * 100)}%` : '–'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** When people comment: weekdays down, hours across, darker blue for more comments. */
export function Heatmap({
  grid,
  days,
  caption,
}: {
  grid: number[][]
  days: string[]
  caption: string
}) {
  const max = Math.max(1, ...grid.flat())
  // Monday first, as calendars in most of the dashboard's languages are.
  const order = [1, 2, 3, 4, 5, 6, 0]
  return (
    <div class="sm-heat" role="img" aria-label={caption}>
      {order.map((d) => (
        <div class="sm-heat__row">
          <span class="sm-heat__day">{days[d]}</span>
          {grid[d]!.map((n, h) => (
            <span
              class="sm-heat__cell"
              style={{ '--a': n ? 0.12 + (n / max) * 0.88 : 0 }}
              title={`${days[d]} ${String(h).padStart(2, '0')}:00 · ${n}`}
            />
          ))}
        </div>
      ))}
      <div class="sm-heat__row sm-heat__hours" aria-hidden="true">
        <span class="sm-heat__day" />
        {Array.from({ length: 24 }, (_, h) => (
          <span class="sm-heat__hour">{h % 6 === 0 ? `${h}` : ''}</span>
        ))}
      </div>
    </div>
  )
}
