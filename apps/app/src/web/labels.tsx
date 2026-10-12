import type { IconName } from 'shades-gradient'
import { Icon } from './ui.tsx'

/**
 * Each AI label has one colour and one icon, from Gradient 0.5.0's roles and ramps. Colour
 * carries meaning here (trouble, a question waiting, good news), so it is never decoration.
 */
export const LABELS: Record<string, { name: string; icon: IconName; tone: string }> = {
  complaint: { name: 'Complaint', icon: 'warning', tone: 'danger' },
  question: { name: 'Question', icon: 'help', tone: 'info' },
  praise: { name: 'Praise', icon: 'favorite', tone: 'success' },
  suggestion: { name: 'Suggestion', icon: 'feedback', tone: 'warning' },
  neutral: { name: 'Neutral', icon: 'chat', tone: 'neutral' },
  spam: { name: 'Spam', icon: 'remove', tone: 'quiet' },
}

/** The order the mood bar and its legend read in: trouble first. */
export const MOOD_ORDER = [
  'complaint',
  'question',
  'suggestion',
  'praise',
  'neutral',
  'spam',
] as const

export function LabelPill({ label, reply }: { label: string; reply?: boolean }) {
  const l = LABELS[label]
  if (!l) return null
  return (
    <span class={`sm-pill sm-pill--${l.tone}`}>
      <Icon name={l.icon} size={13} />
      {l.name}
      {reply ? ' · reply' : ''}
    </span>
  )
}

/** A 100% bar of how comments split across labels, with its legend. */
export function MoodBar({ counts }: { counts: Record<string, number> }) {
  const parts = MOOD_ORDER.map((k) => ({ k, n: counts[k] ?? 0 })).filter((p) => p.n)
  const total = parts.reduce((s, p) => s + p.n, 0)
  if (!total) return null
  return (
    <figure class="sm-mood" aria-label="How comments split">
      <div class="sm-mood__bar">
        {parts.map((p) => (
          <span
            class={`sm-mood__part sm-mood__part--${p.k}`}
            style={{ flexGrow: p.n }}
            title={`${LABELS[p.k]!.name}: ${p.n}`}
          />
        ))}
      </div>
      <figcaption class="sm-mood__legend">
        {parts.map((p) => (
          <span>
            <i class={`sm-mood__dot sm-mood__part--${p.k}`} aria-hidden="true" />
            {LABELS[p.k]!.name} <b class="g-num">{Math.round((p.n / total) * 100)}%</b>
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
