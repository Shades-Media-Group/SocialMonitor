import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { IconName } from 'shades-gradient'
import { renderIcon } from 'shades-gradient'
import { MARK, WORDMARK } from './brand.ts'
import type { Network } from './api.ts'
import { lang, locale, noun, t } from './i18n.ts'

const MARK_FILLS = ['var(--sm-red)', 'var(--sm-rose)', 'var(--sm-ink)']

export function Logo() {
  const h = 22
  const scale = h / WORDMARK.capHeight / 1.9
  const mark = WORDMARK.capHeight * 1.9 * scale
  return (
    <span class="sm-logo" aria-label="SocialMonitor">
      <svg viewBox="0 0 96 96" width={mark} height={mark} aria-hidden="true">
        {MARK.map((d, i) => (
          <path d={d} fill={MARK_FILLS[i]} />
        ))}
      </svg>
      <svg
        viewBox={`0 ${-WORDMARK.capHeight} ${WORDMARK.width} ${WORDMARK.capHeight * 1.32}`}
        height={h * 0.62}
        aria-hidden="true"
      >
        <path d={WORDMARK.d} fill="currentColor" />
      </svg>
    </span>
  )
}

export const Icon = ({ name, size = 18 }: { name: IconName; size?: number }) => (
  <span
    class="sm-icon"
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: renderIcon(name, size) }}
  />
)

/** The network's own mark, in its own colour, so a list of mixed networks reads at a glance. */
export const NetworkMark = ({ network, size = 16 }: { network: Network; size?: number }) => (
  <span
    class={`sm-net sm-net--${network}`}
    role="img"
    aria-label={NETWORK_NAME[network]}
    dangerouslySetInnerHTML={{ __html: renderIcon(network, size) }}
  />
)

export const NETWORK_NAME: Record<Network, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
}

const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
/** "3 hours ago", "yesterday", or "never". */
export function ago(iso: string | null | undefined) {
  if (!iso) return t('never')
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [u, n] of units) if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u)
  return t('just now')
}

/** "1 like", "3 likes" in the chosen language. */
const SEP = lang === 'zh' ? '' : ' ' // Chinese writes "3条评论", no space
export const count = (n: number | null | undefined, key: string) =>
  n == null ? `–${SEP}${noun(5, key)}` : `${fmt(n)}${SEP}${noun(n, key)}`

const nf = new Intl.NumberFormat(locale)
const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
export const fmt = (n: number | null | undefined) => (n == null ? '–' : nf.format(n))
/** 12.4K, for figures where the exact count doesn't matter. */
export const short = (n: number | null | undefined) =>
  n == null ? '–' : n < 10000 ? nf.format(n) : compact.format(n)
export const pctf = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : '–'
export const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(locale, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '–'

/**
 * Every page's header: the title and one line under it on the left, the shell's actions on the
 * right, and the page's own filters in a row beneath.
 */
export const Head = ({
  title,
  sub,
  actions,
  children,
}: {
  title: string
  sub?: string
  actions?: ComponentChildren
  children?: ComponentChildren
}) => (
  <header class="sm-pagehead">
    <div class="sm-pagehead__title">
      <h1>{title}</h1>
      {sub && <span class="sm-pagehead__sub">{sub}</span>}
    </div>
    <div class="sm-pagehead__actions">{actions}</div>
    {children && <div class="sm-pagehead__bar">{children}</div>}
  </header>
)

/** Two lines: what to do, and what you'll get. */
export const Empty = ({ title, children }: { title: string; children?: ComponentChildren }) => (
  <div class="sm-empty">
    <p class="sm-empty__title">{title}</p>
    {children && <p class="sm-empty__body">{children}</p>}
  </div>
)

/** A modal sheet on the native <dialog>: Escape and the backdrop close it. */
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ComponentChildren
  footer?: ComponentChildren
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      class="sm-sheet"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
    >
      <header class="sm-sheet__head">
        <h2>{title}</h2>
        <button class="g-icon-btn" type="button" onClick={onClose} aria-label={t('Close')}>
          <Icon name="close" />
        </button>
      </header>
      <div class="sm-sheet__body">{children}</div>
      {footer && <footer class="sm-sheet__foot">{footer}</footer>}
    </dialog>
  )
}

/** One labelled row: a short label on the left, one control on the right. */
export const Row = ({
  label,
  children,
  hint,
}: {
  label: string
  children: ComponentChildren
  hint?: string
}) => (
  <div class="sm-row">
    <span class="sm-row__label">{label}</span>
    <div class="sm-row__control">
      {children}
      {hint && <span class="sm-row__hint">{hint}</span>}
    </div>
  </div>
)

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div class="g-segmented sm-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button type="button" role="radio" aria-checked={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** Several choices as pill chips; selected is an ink fill. */
export function Chips<T extends string>({
  values,
  options,
  onChange,
  label,
}: {
  values: T[]
  options: [T, string][]
  onChange: (v: T[]) => void
  label: string
}) {
  return (
    <div class="sm-chips" role="group" aria-label={label}>
      {options.map(([v, text]) => {
        const on = values.includes(v)
        return (
          <button
            type="button"
            class="sm-chip"
            aria-pressed={on}
            onClick={() => onChange(on ? values.filter((x) => x !== v) : [...values, v])}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}
