import { beforeAll, describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { addBrand } from './store.ts'
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
})

describe('super admin from .env', () => {
  const env = {
    SOCIALMONITOR_ADMIN_EMAIL: 'boss@example.com',
    SOCIALMONITOR_ADMIN_USERNAME: 'boss',
    SOCIALMONITOR_ADMIN_NAME: 'The Boss',
    SOCIALMONITOR_ADMIN_PASSWORD: 'first long password',
  }

  it('creates a verified super admin once and never changes it', () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    auth.seedAdmin(db, env, (l) => logs.push(l))
    const u = auth.findLogin(db, 'boss')!
    expect(u).toMatchObject({ email: 'boss@example.com', name: 'The Boss', super: 1 })
    expect(u.verified_at).not.toBeNull()
    expect(auth.checkPassword('first long password', u.pass_hash)).toBe(true)
    expect(logs).toEqual(['Created the super admin boss@example.com from .env.'])

    const changed = {
      ...env,
      SOCIALMONITOR_ADMIN_USERNAME: 'other',
      SOCIALMONITOR_ADMIN_PASSWORD: 'second long password',
    }
    auth.seedAdmin(db, changed, (l) => logs.push(l))
    const again = auth.findLogin(db, 'boss')!
    expect(again.pass_hash).toBe(u.pass_hash)
    expect(again.username).toBe('boss')
    expect(auth.countUsers(db)).toBe(1)
    expect(logs).toHaveLength(1)
  })

  it('reports bad values without throwing and does nothing when unset', () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const log = (l: string) => logs.push(l)
    auth.seedAdmin(db, { ...env, SOCIALMONITOR_ADMIN_EMAIL: 'not-an-email' }, log)
    expect(logs).toEqual(['The super admin in .env was not created: Give a valid email.'])
    auth.seedAdmin(db, { ...env, SOCIALMONITOR_ADMIN_PASSWORD: 'tiny pass' }, log)
    expect(logs[1]).toContain('at least 10 characters')
    expect(logs.join()).not.toContain('tiny pass')
    auth.seedAdmin(db, {}, log)
    auth.seedAdmin(db, { SOCIALMONITOR_ADMIN_EMAIL: 'boss@example.com' }, log)
    expect(logs).toHaveLength(2)
    expect(auth.countUsers(db)).toBe(0)
  })
})
