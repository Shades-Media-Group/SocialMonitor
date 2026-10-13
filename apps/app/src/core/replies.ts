import type { DB } from './db.ts'
import { now } from './db.ts'
import { getBrand } from './store.ts'

/**
 * Saved replies: answers a brand's team keeps for questions that come up again. "Draft a reply"
 * lets Claude pick the one that fits a comment and fill in its placeholders, such as {name}.
 */
export interface SavedReply {
  id: number
  brand_id: number
  title: string
  text: string
  /** One of the brand's kinds (its key), or null for any comment. */
  category: string | null
  created_at: string
}

const MAX = 100

export const listReplies = (db: DB, brandId: number) =>
  db
    .prepare('SELECT * FROM saved_replies WHERE brand_id = ? ORDER BY title COLLATE NOCASE')
    .all(brandId) as unknown as SavedReply[]

/** A title, a text and a kind the brand has; anything else is refused or dropped. */
function clean(db: DB, brandId: number, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>
  const title = String(b.title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const text = String(b.text ?? '')
    .trim()
    .slice(0, 1000)
  if (!title) throw new Error('A saved reply needs a title.')
  if (!text) throw new Error('A saved reply needs its text.')
  const keys = (JSON.parse(getBrand(db, brandId)?.categories || '[]') as { key: string }[]).map(
    (k) => k.key,
  )
  const category = typeof b.category === 'string' && keys.includes(b.category) ? b.category : null
  return { title, text, category }
}

export function addReply(db: DB, brandId: number, body: unknown) {
  const r = clean(db, brandId, body)
  if (listReplies(db, brandId).length >= MAX)
    throw new Error('A brand keeps at most 100 saved replies.')
  return db
    .prepare(
      'INSERT INTO saved_replies (brand_id, title, text, category, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
    )
    .get(brandId, r.title, r.text, r.category, now()) as unknown as SavedReply
}

export function updateReply(db: DB, brandId: number, id: number, body: unknown) {
  const r = clean(db, brandId, body)
  const row = db
    .prepare(
      'UPDATE saved_replies SET title = ?, text = ?, category = ? WHERE id = ? AND brand_id = ? RETURNING *',
    )
    .get(r.title, r.text, r.category, id, brandId) as SavedReply | undefined
  if (!row) throw new Error('No such saved reply.')
  return row
}

export const deleteReply = (db: DB, brandId: number, id: number) =>
  void db.prepare('DELETE FROM saved_replies WHERE id = ? AND brand_id = ?').run(id, brandId)

/**
 * The saved replies worth showing Claude for one comment: those for its kind first, then those
 * for any kind, then the rest, at most `max`, so the prompt stays small.
 */
export function candidates(list: SavedReply[], category: string | null | undefined, max = 25) {
  const rank = (r: SavedReply) => (r.category && r.category === category ? 0 : r.category ? 2 : 1)
  return [...list].sort((a, b) => rank(a) - rank(b)).slice(0, max)
}

/** Fills {placeholders} it knows, in any case ({Name}, {NAME}); the others stay for a person. */
export const fillReply = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k.toLowerCase()] ?? m)
