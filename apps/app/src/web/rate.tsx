import { useState } from 'preact/hooks'
import type { BrandRow, CommentRow } from './api.ts'
import { api } from './api.ts'
import { t } from './i18n.ts'

export interface Category {
  key: string
  name: string
  sentiment: 'positive' | 'negative'
}

export const brandCategories = (b: BrandRow | undefined): Category[] => {
  try {
    return JSON.parse(b?.categories ?? '[]') as Category[]
  } catch {
    return []
  }
}

/**
 * Positive or negative, then which kind. Empty until a person or Claude sets it; pressing
 * the chosen side again clears it. The kinds come from the brand's own list.
 */
export function Rate({
  comment,
  brand,
  onChange,
}: {
  comment: CommentRow
  brand?: BrandRow
  onChange?: () => void
}) {
  const [sentiment, setSentiment] = useState(comment.sentiment)
  const [category, setCategory] = useState(comment.category)
  const [by, setBy] = useState(comment.sentiment_by)
  const cats = brandCategories(brand)

  const save = async (s: typeof sentiment, c: string | null) => {
    setSentiment(s)
    setCategory(c)
    setBy(s ? 'you' : null)
    await api.post('/api/comments/sentiment', {
      ids: [comment.id],
      sentiment: s,
      category: c,
      by: 'you',
    })
    onChange?.()
  }
  const side = (s: 'positive' | 'negative' | 'neutral') =>
    sentiment === s ? save(null, null) : save(s, null)
  const options = cats.filter((c) => c.sentiment === sentiment)

  return (
    <span class="sm-rate" role="group" aria-label={t('Rate this comment')}>
      <button
        type="button"
        class="sm-rate__btn sm-rate__btn--positive"
        aria-pressed={sentiment === 'positive'}
        onClick={() => side('positive')}
      >
        {t('Positive')}
      </button>
      <button
        type="button"
        class="sm-rate__btn sm-rate__btn--negative"
        aria-pressed={sentiment === 'negative'}
        onClick={() => side('negative')}
      >
        {t('Negative')}
      </button>
      <button
        type="button"
        class="sm-rate__btn sm-rate__btn--neutral"
        aria-pressed={sentiment === 'neutral'}
        title={t('An ordinary comment: counts neither way')}
        onClick={() => side('neutral')}
      >
        {t('Neutral')}
      </button>
      {sentiment && sentiment !== 'neutral' && options.length > 0 && (
        <select
          class="g-select sm-rate__cat"
          aria-label={t('Kind')}
          value={category ?? ''}
          onChange={(e) => save(sentiment, (e.target as HTMLSelectElement).value || null)}
        >
          <option value="">{t('Choose a kind')}</option>
          {options.map((o) => (
            <option value={o.key}>{o.name}</option>
          ))}
        </select>
      )}
      {by === 'ai' && <span class="sm-quiet">{t('by Claude')}</span>}
    </span>
  )
}
