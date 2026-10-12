import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { IconName } from 'shades-gradient'
import { renderIcon } from 'shades-gradient'
import { MARK, WORDMARK } from './brand.ts'
import type { Network } from './api.ts'

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

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
/** "3 hours ago", "yesterday", or "never". */
export function ago(iso: string | null | undefined) {
  if (!iso) return 'never'
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
  return 'just now'
}

/** "1 like", "3 likes", "no likes" with tabular numbers left to the caller's markup. */
export const count = (n: number | null | undefined, one: string, many = `${one}s`) =>
  n == null ? `– ${many}` : `${fmt(n)} ${n === 1 ? one : many}`

export const fmt = (n: number | null | undefined) =>
  n == null ? '–' : new Intl.NumberFormat('en').format(n)
export const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '–'

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
        <button class="g-icon-btn" type="button" onClick={onClose} aria-label="Close">
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
