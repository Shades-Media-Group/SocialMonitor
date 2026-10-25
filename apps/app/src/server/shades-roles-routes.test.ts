import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../core/db.ts'
import type { DB } from '../core/db.ts'
import * as auth from '../core/auth.ts'
import { addBrand } from '../core/store.ts'
import { shadesRolesRoutes } from './shades-roles-routes.ts'
import type { Ctx } from './routes.ts'

const TOKEN = 'a-roles-token-that-is-long-enough-0123456789'

beforeAll(() => {
  process.env.SOCIALMONITOR_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256'
  process.env.SOCIALMONITOR_HIBP = 'off'
})
beforeEach(() => {
  process.env.SHADES_ROLES_TOKEN = TOKEN
})
afterEach(() => {
  delete process.env.SHADES_ROLES_TOKEN
})

let n = 0
/** The CRM calling, from its own address each test so the rate limit starts fresh. */
function crm(db: DB, headers: Record<string, string> = {}) {
  const ip = `10.7.0.${++n}`
  const base = { authorization: `Bearer ${TOKEN}`, 'x-acting-user': 'boss@shades.md', ...headers }
  return async (method: string, path: string, body: unknown = {}, h = base) => {
    const url = new URL(path, 'https://socialmonitor-app.test')
    const route = shadesRolesRoutes.find((x) => x.method === method && x.path.test(url.pathname))!
    const c = {
      db,
      params: route.path.exec(url.pathname)!.groups ?? {},
      query: url.searchParams,
      body,
      local: false,
      user: null,
      cookies: [],
      secure: true,
      ip,
      country: null,
      ua: 'shades-crm/1',
      session: null,
      client: { ua: 'shades-crm/1', ip, country: null },
      origin: 'https://socialmonitor-app.test',
      headers: Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)),
    } as unknown as Ctx
    return (await route.handle(c)) as Record<string, unknown>
  }
}
const status = (s: number) => expect.objectContaining({ status: s }) as unknown as Error

/** Boss: a super admin who signs in with Shades, so a change can't leave nobody in charge. */
function setup() {
  const db = openDb(':memory:')
  const boss = auth.createUser(db, { email: 'boss@shades.md', super: true, verified: true })
  const other = auth.createUser(db, { email: 'eve@shades.md', super: true, verified: true })
  db.prepare('UPDATE users SET shades_sub = ? WHERE id = ?').run('sub-boss', boss.id)
  db.prepare('UPDATE users SET shades_sub = ? WHERE id = ?').run('sub-eve', other.id)
  return { db, boss, other }
}
const audits = (db: DB) =>
  (
    db.prepare("SELECT * FROM audit WHERE event LIKE 'person.%' ORDER BY id").all() as {
      event: string
      target: string
      actor: number | null
      detail: string
    }[]
  ).map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }))

describe('Shades roles API, access', () => {
  it('answers 503 on every route without a token of 32 characters', async () => {
    const { db } = setup()
    for (const value of [undefined, 'too-short']) {
      if (value === undefined) delete process.env.SHADES_ROLES_TOKEN
      else process.env.SHADES_ROLES_TOKEN = value
      const call = crm(db)
      await expect(call('GET', '/api/shades-roles/roles')).rejects.toThrow(status(503))
      await expect(call('GET', '/api/shades-roles/roles')).rejects.toThrow('not configured')
      await expect(
        call('PUT', '/api/shades-roles/accounts/x', { level: 'none', email: 'x@shades.md' }),
      ).rejects.toThrow(status(503))
      await expect(call('DELETE', '/api/shades-roles/accounts/x')).rejects.toThrow(status(503))
    }
  })

  it('answers 401 for a wrong or missing token, and rate-limits wrong ones', async () => {
    const { db } = setup()
    const call = crm(db)
    for (const authorization of [undefined, `Bearer ${TOKEN}x`, TOKEN, 'Bearer '])
      await expect(
        call(
          'GET',
          '/api/shades-roles/roles',
          {},
          {
            authorization: authorization!,
            'x-acting-user': 'boss@shades.md',
          },
        ),
      ).rejects.toThrow(status(401))
    for (let i = 0; i < 6; i++)
      await expect(
        call(
          'GET',
          '/api/shades-roles/roles',
          {},
          { authorization: 'Bearer nope', 'x-acting-user': 'a@b.cd' },
        ),
      ).rejects.toThrow(status(401))
    // Ten wrong tokens: even the right one waits now.
    await expect(call('GET', '/api/shades-roles/roles')).rejects.toThrow(status(429))
  })

  it('answers 400 without an acting user, or with one that is not an email', async () => {
    const { db } = setup()
    const call = crm(db)
    for (const who of [undefined, '', 'boss', 'boss@shades'])
      await expect(
        call(
          'GET',
          '/api/shades-roles/roles',
          {},
          {
            authorization: `Bearer ${TOKEN}`,
            'x-acting-user': who!,
          },
        ),
      ).rejects.toThrow(status(400))
  })
})

describe('Shades roles API, listing', () => {
  it('lists the levels and every Shades account, set up in advance included, never local ones', async () => {
    const { db, boss } = setup()
    const brand = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
    const ana = auth.createUser(db, { email: 'ana@shades.md', name: 'Ana', verified: true })
    db.prepare('UPDATE users SET shades_sub = ? WHERE id = ?').run('sub-ana', ana.id)
    auth.setMembership(db, ana.id, brand.id, 'viewer')
    auth.touch(db, boss.id)
    auth.createUser(db, { email: 'local@example.com', verified: true })
    const call = crm(db)
    await call('PUT', '/api/shades-roles/accounts/sub-new', {
      email: 'New@Shades.md',
      name: 'New Person',
      level: 'member',
    })
    const out = await call('GET', '/api/shades-roles/roles')
    expect(out.levels).toEqual([
      { value: 'none', label: 'No access' },
      { value: 'member', label: 'Member' },
      { value: 'super', label: 'Super admin' },
    ])
    expect(out).not.toHaveProperty('roles')
    const accounts = out.accounts as Record<string, unknown>[]
    expect(accounts.map((a) => a.email)).toEqual([
      'ana@shades.md',
      'boss@shades.md',
      'eve@shades.md',
      'new@shades.md',
    ])
    expect(accounts[0]).toEqual({
      sub: 'sub-ana',
      email: 'ana@shades.md',
      name: 'Ana',
      level: 'member',
      active: true,
      lastSignInAt: null,
    })
    expect(accounts[1]).toMatchObject({ level: 'super', lastSignInAt: expect.any(String) })
    expect(accounts[3]).toEqual({
      sub: 'sub-new',
      email: 'new@shades.md',
      name: 'New Person',
      level: 'member',
      active: true,
      lastSignInAt: null,
    })
  })

  it('shows someone who signed in but was never let in as none, still active', async () => {
    const { db } = setup()
    const u = auth.createUser(db, { email: 'wait@shades.md', verified: true })
    db.prepare('UPDATE users SET shades_sub = ? WHERE id = ?').run('sub-wait', u.id)
    const accounts = (await crm(db)('GET', '/api/shades-roles/roles')).accounts as {
      sub: string
    }[]
    expect(accounts.find((a) => a.sub === 'sub-wait')).toMatchObject({
      level: 'none',
      active: true,
    })
  })
})

describe('Shades roles API, PUT', () => {
  it('creates an account in advance: no password, linked to the subject, audited', async () => {
    const { db, boss } = setup()
    const out = await crm(db)('PUT', '/api/shades-roles/accounts/sub-ana', {
      email: 'ana@shades.md',
      name: 'Ana Pop',
      level: 'super',
    })
    expect(out.account).toMatchObject({ sub: 'sub-ana', level: 'super', active: true })
    const row = auth.findLogin(db, 'ana@shades.md')!
    expect(row.pass_hash).toBeNull()
    expect(row.verified_at).toBeNull()
    expect(row.super).toBe(1)
    expect(audits(db).at(-1)).toMatchObject({
      event: 'person.role',
      target: 'ana@shades.md',
      actor: boss.id,
      detail: {
        via: 'shades-roles',
        by: 'boss@shades.md',
        sub: 'sub-ana',
        action: 'create',
        from: null,
        to: 'super',
      },
    })
  })

  it('needs a known level, and an email to create', async () => {
    const { db } = setup()
    const call = crm(db)
    for (const body of [
      { email: 'a@shades.md', level: 'admin' },
      { email: 'a@shades.md' },
      { level: 'member' },
      { email: 'not-an-email', level: 'member' },
    ])
      await expect(call('PUT', '/api/shades-roles/accounts/sub-a', body)).rejects.toThrow(
        status(400),
      )
  })

  it('changes a level, the email and the name, and ends sessions on losing super', async () => {
    const { db, other } = setup()
    const s = auth.createSession(db, other, false, { ua: 'x', ip: '1.1.1.1', country: null })
    const call = crm(db)
    const out = await call('PUT', '/api/shades-roles/accounts/sub-eve', {
      email: 'eve.new@shades.md',
      name: 'Eve',
      level: 'member',
    })
    expect(out.account).toMatchObject({ email: 'eve.new@shades.md', name: 'Eve', level: 'member' })
    expect(auth.readSession(db, s.token)).toBeNull()
    expect(audits(db).at(-1)!.detail).toMatchObject({
      action: 'change',
      from: 'super',
      to: 'member',
    })
    // Back to none: blocked, and none again in the list.
    await call('PUT', '/api/shades-roles/accounts/sub-eve', { level: 'none' })
    expect(auth.getUser(db, other.id)).toMatchObject({ disabled: 1, super: 0 })
  })

  it('links an account here by email (any case) when it has no subject yet', async () => {
    const { db } = setup()
    const brand = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
    const u = auth.createUser(db, {
      email: 'Ana@Shades.md',
      verified: true,
      password: 'a long password 1',
    })
    auth.setMembership(db, u.id, brand.id, 'admin')
    const out = await crm(db)('PUT', '/api/shades-roles/accounts/sub-ana', {
      email: 'ana@shades.md',
      level: 'member',
    })
    expect(out.account).toMatchObject({ sub: 'sub-ana', level: 'member' })
    expect(auth.countUsers(db)).toBe(3)
    // Memberships are SocialMonitor's own: never changed here.
    expect(auth.memberships(db, u.id)).toEqual([{ brand_id: brand.id, role: 'admin' }])
    expect(audits(db).at(-1)!.detail).toMatchObject({ action: 'link', to: 'member' })
  })

  it('refuses an email already linked to another subject', async () => {
    const { db } = setup()
    await expect(
      crm(db)('PUT', '/api/shades-roles/accounts/sub-x', {
        email: 'eve@shades.md',
        level: 'member',
      }),
    ).rejects.toThrow(status(409))
  })

  it('refuses anyone changing their own level', async () => {
    const { db } = setup()
    const call = crm(db, { 'x-acting-user': 'EVE@shades.md' })
    await expect(
      call('PUT', '/api/shades-roles/accounts/sub-eve', { level: 'member' }),
    ).rejects.toThrow(status(403))
    await expect(call('DELETE', '/api/shades-roles/accounts/sub-eve')).rejects.toThrow(status(403))
    expect(auth.findByEmail(db, 'eve@shades.md')!.super).toBe(1)
  })

  it('keeps at least one active super admin', async () => {
    const { db } = setup()
    const call = crm(db, { 'x-acting-user': 'someone@shades.md' })
    await call('PUT', '/api/shades-roles/accounts/sub-eve', { level: 'member' })
    for (const level of ['member', 'none'])
      await expect(call('PUT', '/api/shades-roles/accounts/sub-boss', { level })).rejects.toThrow(
        status(409),
      )
    await expect(call('DELETE', '/api/shades-roles/accounts/sub-boss')).rejects.toThrow(status(409))
    expect(auth.findByEmail(db, 'boss@shades.md')).toMatchObject({ super: 1, disabled: 0 })
  })
})

describe('Shades roles API, DELETE', () => {
  it('sets none and keeps an account that was used, ending its sessions', async () => {
    const { db, other } = setup()
    const s = auth.createSession(db, other, false, { ua: 'x', ip: '1.1.1.1', country: null })
    const out = await crm(db)('DELETE', '/api/shades-roles/accounts/sub-eve')
    expect(out).toEqual({ __status: 204 })
    expect(auth.getUser(db, other.id)).toMatchObject({ disabled: 1, super: 0 })
    expect(auth.readSession(db, s.token)).toBeNull()
    expect(audits(db).at(-1)).toMatchObject({
      event: 'person.role',
      detail: { action: 'revoke', from: 'super', to: 'none', sub: 'sub-eve' },
    })
  })

  it('removes an account set up in advance and never used', async () => {
    const { db } = setup()
    const call = crm(db)
    await call('PUT', '/api/shades-roles/accounts/sub-new', {
      email: 'new@shades.md',
      level: 'member',
    })
    expect(await call('DELETE', '/api/shades-roles/accounts/sub-new')).toEqual({ __status: 204 })
    expect(auth.findByEmail(db, 'new@shades.md')).toBeUndefined()
    expect(audits(db).at(-1)).toMatchObject({
      event: 'person.removed',
      target: 'new@shades.md',
      detail: { action: 'delete', from: 'member', sub: 'sub-new' },
    })
  })

  it('answers 404 for an unknown subject', async () => {
    const { db } = setup()
    await expect(crm(db)('DELETE', '/api/shades-roles/accounts/nobody')).rejects.toThrow(
      status(404),
    )
  })
})
