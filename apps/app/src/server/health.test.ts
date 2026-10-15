import { describe, expect, it } from 'vitest'
import { openDb } from '../core/db.ts'
import { health, HttpError, routes } from './routes.ts'

describe('GET /api/health', () => {
  it('is public and reports only the version, the commit and the database', () => {
    const route = routes.find((r) => r.method === 'GET' && r.path.test('/api/health'))!
    expect(route.need).toBe('public')
    const out = health(openDb(':memory:'))
    expect(Object.keys(out).sort()).toEqual(['commit', 'db', 'ok', 'version'])
    expect(out).toMatchObject({ ok: true, db: 'ok' })
    expect(out.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(out.commit).toMatch(/^([0-9a-f]{7,}|unknown)$/)
  })

  it('answers 503 when the database is gone', () => {
    const db = openDb(':memory:')
    db.close()
    expect(() => health(db)).toThrow(HttpError)
    try {
      health(db)
    } catch (e) {
      expect((e as HttpError).status).toBe(503)
      expect((e as HttpError).extra).toEqual({ ok: false, db: 'error' })
    }
  })
})
