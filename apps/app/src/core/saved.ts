import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR, now } from './db.ts'

/**
 * Reports and exports are kept once made: the file goes to data/reports/<brand>/ and a row
 * records what it was, for which period and network, who made it and when. The Reports tab
 * lists them so any can be opened again instead of being generated anew.
 */
export interface SavedReport {
  id: number
  brand_id: number | null
  kind: string
  filename: string
  type: string
  size: number
  params: string
  created_by: number | null
  created_by_name: string | null
  created_at: string
}

const ROOT = join(DATA_DIR, 'reports')

export function saveReport(
  db: DB,
  input: {
    brandId: number | null
    kind: string
    filename: string
    type: string
    data: string | Uint8Array
    params?: Record<string, unknown>
    userId?: number | null
  },
) {
  const dir = join(ROOT, String(input.brandId ?? 'all'))
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `${stamp}-${input.filename.replace(/[^\w.-]+/g, '-')}`)
  const bytes =
    typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : Buffer.from(input.data)
  writeFileSync(path, bytes)
  db.prepare(
    `INSERT INTO saved_reports (brand_id, kind, filename, path, type, size, params, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.brandId,
    input.kind,
    input.filename,
    path,
    input.type,
    bytes.length,
    JSON.stringify(input.params ?? {}),
    input.userId ?? null,
    now(),
  )
}

export const listSaved = (db: DB, brandId: number) =>
  db
    .prepare(
      `SELECT s.id, s.brand_id, s.kind, s.filename, s.type, s.size, s.params, s.created_by, s.created_at,
              coalesce(nullif(u.name, ''), u.email) AS created_by_name
       FROM saved_reports s LEFT JOIN users u ON u.id = s.created_by
       WHERE s.brand_id = ? ORDER BY s.created_at DESC LIMIT 500`,
    )
    .all(brandId) as unknown as SavedReport[]

export const getSaved = (db: DB, id: number) =>
  db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(id) as
    (SavedReport & { path: string }) | undefined

export const readSaved = (r: { path: string }) => readFileSync(r.path)

export function deleteSaved(db: DB, id: number) {
  const r = getSaved(db, id)
  if (!r) return
  rmSync(r.path, { force: true })
  db.prepare('DELETE FROM saved_reports WHERE id = ?').run(id)
}
