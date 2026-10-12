import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db.ts'

/** A kind of positive or negative comment, set per brand. `key` is what is stored on a comment. */
export interface Category {
  key: string
  name: string
  sentiment: 'positive' | 'negative'
}

export const SENTIMENTS = ['positive', 'negative'] as const
export type Sentiment = (typeof SENTIMENTS)[number]

const c = (sentiment: Sentiment, key: string, name: string): Category => ({ key, name, sentiment })

/** Starting points; every brand edits its own copy. More can be added locally in data/templates.json. */
const BUILT_IN: Record<string, { name: string; categories: Category[] }> = {
  general: {
    name: 'General',
    categories: [
      c('negative', 'product', 'Product problem'),
      c('negative', 'service', 'Poor customer service'),
      c('negative', 'price', 'Price or billing'),
      c('negative', 'delivery', 'Delivery or availability'),
      c('negative', 'other-negative', 'Other complaint'),
      c('positive', 'thanks', 'Thanks and praise'),
      c('positive', 'interest', 'Interested in an offer'),
      c('positive', 'other-positive', 'Other positive'),
    ],
  },
}

/** Checks a list of categories from the UI, JSON or Claude; throws with what to fix. */
export function validCategories(v: unknown): Category[] {
  if (!Array.isArray(v)) throw new Error('Categories must be a list.')
  const keys = new Set<string>()
  return v.map((x, i) => {
    const o = x as Partial<Category>
    const key = String(o.key ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
    if (!key) throw new Error(`Category ${i + 1} needs a key.`)
    if (keys.has(key)) throw new Error(`The key "${key}" is used twice.`)
    keys.add(key)
    if (!String(o.name ?? '').trim()) throw new Error(`Category "${key}" needs a name.`)
    if (o.sentiment !== 'positive' && o.sentiment !== 'negative')
      throw new Error(`Category "${key}": sentiment is positive or negative.`)
    return { key, name: String(o.name).trim().slice(0, 60), sentiment: o.sentiment }
  })
}

/** The built-in templates, plus any kept locally in data/templates.json (git-ignored). */
export const TEMPLATES: Record<string, { name: string; categories: Category[] }> = {
  ...BUILT_IN,
  ...localTemplates(),
}

function localTemplates(): Record<string, { name: string; categories: Category[] }> {
  const file = join(DATA_DIR, 'templates.json')
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      { name: string; categories: unknown }
    >
    return Object.fromEntries(
      Object.entries(raw).map(([k, t]) => [
        k,
        { name: t.name, categories: validCategories(t.categories) },
      ]),
    )
  } catch {
    return {}
  }
}
