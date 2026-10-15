import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { addBrand } from './store.ts'
import { createUser, deleteUser } from './auth.ts'
import { audit, failedStreak, listAudit, purgeAudit } from './audit.ts'

const old = (db: ReturnType<typeof openDb>, at: string) =>
  db.prepare("INSERT INTO audit (at, event, detail) VALUES (?, 'signin.ok', '{}')").run(at)

describe('the audit log', () => {
  it('refuses to change or delete a row', () => {
    const db = openDb(':memory:')
    audit(db, { event: 'signin.ok', actor: 1, ip: '203.0.113.7', ua: 'Firefox' })
    expect(() => db.prepare("UPDATE audit SET event = 'signin.failed'").run()).toThrow(
      /append-only/,
    )
    expect(() => db.prepare('DELETE FROM audit').run()).toThrow(/kept for a year/)
    expect(purgeAudit(db)).toBe(0)
    expect(listAudit(db, { brands: null }).total).toBe(1)
  })

  it('lets only rows older than a year go, and only through purgeAudit', () => {
    const db = openDb(':memory:')
    old(db, new Date(Date.now() - 400 * 86400_000).toISOString())
    old(db, new Date(Date.now() - 300 * 86400_000).toISOString())
    // Asking for a shorter retention still keeps a year.
    expect(purgeAudit(db, 30)).toBe(1)
    expect(listAudit(db, { brands: null }).total).toBe(1)
  })

  it('keeps history when a person or a brand is removed', () => {
    const db = openDb(':memory:')
    const u = createUser(db, { email: 'ana@example.com' })
    const b = addBrand(db, 'Tavelo', [])
    audit(db, { event: 'brand.created', actor: u.id, brandId: b.id, target: 'Tavelo' })
    deleteUser(db, u.id)
    db.prepare('DELETE FROM brands WHERE id = ?').run(b.id)
    expect(listAudit(db, { brands: null }).rows[0]).toMatchObject({
      event: 'brand.created',
      actor: u.id,
      target: 'Tavelo',
    })
  })

  it('shows brand admins only their brands, newest first, a page at a time', () => {
    const db = openDb(':memory:')
    const a = addBrand(db, 'A', [])
    const b = addBrand(db, 'B', [])
    for (let i = 0; i < 5; i++) audit(db, { event: 'download', brandId: a.id, target: `a${i}` })
    audit(db, { event: 'brand.created', brandId: b.id, target: 'B' })
    audit(db, { event: 'settings.changed' })
    expect(listAudit(db, { brands: null }).total).toBe(7)
    const mine = listAudit(db, { brands: [a.id], size: 2, page: 1 })
    expect(mine.total).toBe(5)
    expect(mine.rows.map((r) => r.target)).toEqual(['a2', 'a1'])
    expect(listAudit(db, { brands: [] }).total).toBe(0)
    expect(listAudit(db, { brands: null, event: 'brand' }).rows[0]!.brand_name).toBe('B')
    expect(listAudit(db, { brands: null, q: 'a4' }).total).toBe(1)
    expect(listAudit(db, { brands: null, q: '%' }).total).toBe(0)
  })

  it('counts failed sign-ins since the last good one', () => {
    const db = openDb(':memory:')
    for (let i = 0; i < 3; i++) audit(db, { event: 'signin.failed', actor: 7 })
    audit(db, { event: 'signin.ok', actor: 7 })
    audit(db, { event: 'signin.failed', actor: 7 })
    expect(failedStreak(db, 7)).toBe(1)
  })

  it('keeps detail small', () => {
    const db = openDb(':memory:')
    audit(db, { event: 'export', detail: { big: 'x'.repeat(5000) } })
    expect(listAudit(db, { brands: null }).rows[0]!.detail).toBe('{"truncated":true}')
  })
})
