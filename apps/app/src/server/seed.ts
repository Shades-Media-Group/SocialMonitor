import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../core/db.ts'
import { DATA_DIR } from '../core/db.ts'
import { addBrand, listBrands } from '../core/store.ts'

/**
 * data/brands.seed.json adds brands on first start, for a local test setup that never
 * enters the repository. Brands that already exist are left alone.
 */
export function seedFromFile(db: DB) {
  const file = join(DATA_DIR, 'brands.seed.json')
  if (!existsSync(file)) return
  const seed = JSON.parse(readFileSync(file, 'utf8')) as {
    brands?: { name: string; website?: string; profiles?: Record<string, string> }[]
  }
  const known = new Set(listBrands(db).map((b) => b.name))
  for (const b of seed.brands ?? []) {
    if (known.has(b.name)) continue
    addBrand(db, b.name, Object.values(b.profiles ?? {}), b.website ?? null)
  }
}
