import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('accepts its own render tokens and refuses forged, long, expired and revoked ones', () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, {
      email: 'a@example.com',
      password: 'long enough pw',
      verified: true,
    })
    const token = auth.signSession(u)
    expect(auth.readSession(db, token)).toMatchObject({ user: { id: u.id }, session: null })
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

describe('password hashing', () => {
  it('stores scrypt parameters in the hash and upgrades older hashes on sign-in', () => {
    const h = auth.hashPassword('correct horse battery')
    expect(h).toMatch(/^scrypt\$17\$8\$1\$/)
    expect(auth.needsRehash(h)).toBe(false)
    // The format before: scrypt$salt$hash, N=2^14, 16-byte salt, 64-byte key.
    const salt = randomBytes(16)
    const old = `scrypt$${salt.toString('base64')}$${scryptSync('correct horse battery', salt, 64).toString('base64')}`
    expect(auth.checkPassword('correct horse battery', old)).toBe(true)
    expect(auth.needsRehash(old)).toBe(true)

    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: 'old@example.com', verified: true })
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(old, u.id)
    auth.upgradeHash(db, u.id, 'correct horse battery', old)
    const now = auth.findLogin(db, 'old@example.com')!.pass_hash
    expect(now).toMatch(/^scrypt\$17\$/)
    expect(auth.checkPassword('correct horse battery', now)).toBe(true)
    expect(auth.checkPassword('correct horse battery', 'scrypt$99$8$1$a$b')).toBe(false)
  })
})

describe('breached passwords', () => {
  const sha = createHash('sha1').update('password123456').digest('hex').toUpperCase()
  const reply = (body: string, status = 200) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> })
      return new Response(body, { status })
    }) as typeof fetch
  let calls: { url: string; headers: Record<string, string> }[] = []
  beforeEach(() => {
    calls = []
  })

  it('sends only the first five characters, padded, and matches suffixes here', async () => {
    const body = `0000000000000000000000000000000000A:0\r\n${sha.slice(5)}:42\r\n`
    expect(await auth.breached('password123456', reply(body))).toBe(true)
    expect(calls[0]!.url).toBe(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`)
    expect(calls[0]!.headers['Add-Padding']).toBe('true')
    // Padding rows carry a count of 0 and never count as a match.
    expect(await auth.breached('password123456', reply(`${sha.slice(5)}:0\r\n`))).toBe(false)
    expect(await auth.breached('password123456', reply('ABCDEF:3\r\n'))).toBe(false)
    await expect(auth.newPassword('password123456', reply(body))).rejects.toThrow(/breach/)
  })

  it('fails open with a warning when the service is unreachable', async () => {
    const warnings: string[] = []
    const down = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    expect(await auth.breached('password123456', down, (l) => warnings.push(l))).toBe(false)
    expect(await auth.breached('password123456', reply('', 503), (l) => warnings.push(l))).toBe(
      false,
    )
    expect(warnings).toHaveLength(2)
  })
})

describe('sessions', () => {
  const client = {
    ua: 'Mozilla/5.0 (Macintosh; Mac OS X 14_0) Chrome/130.0',
    ip: '1.2.3.4',
    country: 'MD',
  }
  const setup = () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: 's@example.com', verified: true })
    return { db, u }
  }
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps only a hash of the id, and ends after 12 idle hours', () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T08:00:00Z') })
    const { db, u } = setup()
    const s = auth.createSession(db, u, false, client)
    expect(s.maxAge).toBeUndefined()
    expect(db.prepare('SELECT count(*) AS n FROM sessions WHERE id = ?').get(s.token)).toEqual({
      n: 0,
    })
    expect(auth.readSession(db, s.token, client)?.user.id).toBe(u.id)
    vi.setSystemTime(new Date('2026-10-01T19:00:00Z'))
    expect(auth.readSession(db, s.token, client)).not.toBeNull() // used at 19:00, idle clock restarts
    vi.setSystemTime(new Date('2026-10-02T06:59:00Z'))
    expect(auth.readSession(db, s.token, client)).not.toBeNull()
    vi.setSystemTime(new Date('2026-10-02T19:00:01Z'))
    expect(auth.readSession(db, s.token, client)).toBeNull()
    expect(auth.listSessions(db, u.id)).toHaveLength(0)
  })

  it('with Keep me signed in, outlives 12 hours but never 30 days', () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T08:00:00Z') })
    const { db, u } = setup()
    const s = auth.createSession(db, u, true, client)
    expect(s.maxAge).toBe(30 * 86400)
    for (let day = 1; day < 30; day++) {
      vi.setSystemTime(new Date(Date.parse('2026-10-01T08:00:00Z') + day * 86400_000))
      expect(auth.readSession(db, s.token, client)).not.toBeNull()
    }
    vi.setSystemTime(new Date('2026-10-31T08:00:01Z'))
    expect(auth.readSession(db, s.token, client)).toBeNull()
  })

  it('rotates the id after a change of role, and ends with session_version', () => {
    const { db, u } = setup()
    const s = auth.createSession(db, u, false, client)
    auth.updateUser(db, u.id, { super: true })
    const read = auth.readSession(db, s.token, client)!
    expect(read.session!.rotate).toBe(1)
    const next = auth.rotateSession(db, read.session!)
    expect(auth.readSession(db, s.token, client)).toBeNull()
    expect(auth.readSession(db, next.token, client)!.session!.rotate).toBe(0)
    const other = auth.createSession(db, u, false, client)
    auth.endSessions(db, u.id)
    expect(auth.readSession(db, next.token, client)).toBeNull()
    expect(auth.readSession(db, other.token, client)).toBeNull()
  })

  it('names the cookie __Host- over https only', () => {
    expect(auth.sessionCookie('x', true, 60)).toBe(
      '__Host-sm_session=x; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure',
    )
    expect(auth.sessionCookie('x', false)).toBe('sm_session=x; Path=/; HttpOnly; SameSite=Strict')
    expect(auth.device(client.ua)).toEqual({ browser: 'Chrome', os: 'macOS' })
  })
})

describe('sign-in tickets', () => {
  it('passes a ticket on a right second step, and voids it after five wrong ones', () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: 'k@example.com' })
    const t = auth.issue(db, u.id, 'code')
    expect(auth.ticketOwner(db, t.id)).toEqual({ id: u.id, email: 'k@example.com' })
    expect(auth.spend(db, t.id, 'code', () => true)).toBe(u.id)
    expect(() => auth.spend(db, t.id, 'code', () => true)).toThrow(/expired/)
    const t2 = auth.issue(db, u.id, 'code')
    for (let i = 0; i < 5; i++) expect(() => auth.spend(db, t2.id, 'code', () => false)).toThrow()
    expect(() => auth.spend(db, t2.id, 'code', () => true)).toThrow(/expired/)
  })
})
