import { beforeAll, describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { addBrand, addCompetitor } from './store.ts'
import * as auth from './auth.ts'

beforeAll(() => {
  process.env.SOCIALMONITOR_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256'
})

describe('sign-in', () => {
  it('checks passwords and rejects short ones', () => {
    const h = auth.hashPassword('correct horse battery')
    expect(auth.checkPassword('correct horse battery', h)).toBe(true)
    expect(auth.checkPassword('wrong horse battery', h)).toBe(false)
    expect(() => auth.validPassword('short')).toThrow()
  })

  it('accepts its own sessions and refuses forged, expired and revoked ones', () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, {
      email: 'a@example.com',
      password: 'long enough pw',
      verified: true,
    })
    const token = auth.signSession(u)
    expect(auth.readSession(db, token)?.id).toBe(u.id)
    expect(auth.readSession(db, token.slice(0, -2) + 'xx')).toBeNull()
    expect(auth.readSession(db, auth.signSession(u, -1))).toBeNull()
    auth.endSessions(db, u.id)
    expect(auth.readSession(db, token)).toBeNull()
  })

  it('uses a code once and drops it after five wrong guesses', () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: 'b@example.com' })
    const t = auth.issue(db, u.id, 'code')
    expect(auth.consume(db, t.id, t.secret, 'code')).toBe(u.id)
    expect(() => auth.consume(db, t.id, t.secret, 'code')).toThrow()
    const t2 = auth.issue(db, u.id, 'code')
    for (let i = 0; i < 5; i++) expect(() => auth.consume(db, t2.id, 'nope', 'code')).toThrow()
    expect(() => auth.consume(db, t2.id, t2.secret, 'code')).toThrow()
  })

  it('shows each person only the brands they belong to', () => {
    const db = openDb(':memory:')
    const one = addBrand(db, 'One', [], null)
    const two = addBrand(db, 'Two', [], null)
    const boss = auth.createUser(db, { email: 'boss@example.com', super: true })
    const ann = auth.createUser(db, { email: 'ann@example.com' })
    auth.setMembership(db, ann.id, one.id, 'viewer')
    expect(auth.visibleBrands(db, boss)).toBeNull()
    expect(auth.visibleBrands(db, ann)).toEqual([one.id])
    expect(auth.roleFor(db, ann, one.id)).toBe('viewer')
    expect(auth.roleFor(db, ann, two.id)).toBeNull()
    expect(auth.roleFor(db, boss, two.id)).toBe('admin')
  })

  it("lets a brand's people reach its rivals, and no one else", () => {
    const db = openDb(':memory:')
    const one = addBrand(db, 'One', [], null)
    const two = addBrand(db, 'Two', [], null)
    const rival = addCompetitor(db, one.id, 'Rival', ['https://www.tiktok.com/@rival'])
    const ann = auth.createUser(db, { email: 'ann@example.com' })
    const bob = auth.createUser(db, { email: 'bob@example.com' })
    auth.setMembership(db, ann.id, one.id, 'admin')
    auth.setMembership(db, bob.id, two.id, 'admin')
    expect(auth.roleFor(db, ann, rival.id)).toBe('admin')
    expect(auth.roleFor(db, bob, rival.id)).toBeNull()
    expect(auth.visibleBrands(db, ann)).toEqual([one.id])
  })
})
