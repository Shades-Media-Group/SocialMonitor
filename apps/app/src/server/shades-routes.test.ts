import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../core/db.ts'
import type { DB } from '../core/db.ts'
import * as auth from '../core/auth.ts'
import { addBrand } from '../core/store.ts'
import * as shades from '../core/shades-id.ts'
import { authRoutes } from './auth-routes.ts'
import { shadesRoutes } from './shades-routes.ts'
import type { Ctx } from './routes.ts'
import { HttpError, guard, routes } from './routes.ts'

const ISSUER = 'https://id.test'
const HOST = 'socialmonitor-app.test'
const ENV = {
  SHADES_ID_ISSUER: ISSUER,
  SHADES_ID_CLIENT_ID: 'socialmonitor',
  SHADES_ID_CLIENT_SECRET: 'not-a-real-secret',
  SOCIALMONITOR_PUBLIC_HOST: HOST,
}
const configure = () => Object.assign(process.env, ENV)
const unconfigure = () => {
  for (const k of Object.keys(ENV)) delete process.env[k]
}

beforeAll(() => {
  process.env.SOCIALMONITOR_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256'
  process.env.SOCIALMONITOR_HIBP = 'off'
  delete process.env.SMTP_HOST
})
afterAll(unconfigure)
beforeEach(() => {
  configure()
  shades.resetShadesCache()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- A fake Shades ID ------------------------------------------------------------------------

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
type Alg = 'ES256' | 'RS256' | 'EdDSA'
const keyPair = (alg: Alg) =>
  alg === 'ES256'
    ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : alg === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ed25519')
const KEYS = Object.fromEntries(
  (['ES256', 'RS256', 'EdDSA'] as Alg[]).map((alg) => [alg, keyPair(alg)]),
) as Record<Alg, { publicKey: KeyObject; privateKey: KeyObject }>

function jwt(claims: Record<string, unknown>, alg: Alg = 'ES256', header: object = {}) {
  const data = `${b64({ alg, kid: alg, typ: 'JWT', ...header })}.${b64(claims)}`
  const key = KEYS[alg].privateKey
  const sig =
    alg === 'ES256'
      ? sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
      : sign(alg === 'RS256' ? 'sha256' : null, Buffer.from(data), key)
  return `${data}.${sig.toString('base64url')}`
}

const DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  end_session_endpoint: `${ISSUER}/logout`,
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic'],
  id_token_signing_alg_values_supported: ['ES256'],
}

/** Shades ID as fetch sees it: discovery, keys, and a token endpoint that checks PKCE. */
function issuer(doc: Record<string, unknown> = DOC) {
  const seen: { auth?: string; form?: URLSearchParams } = {}
  const state = {
    challenge: '',
    /** What the next ID token says, besides what the test overrides. */
    claims: {} as Record<string, unknown>,
    alg: 'ES256' as Alg,
    seen,
  }
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json(doc)
    if (url === `${ISSUER}/jwks`)
      return json({
        keys: (['ES256', 'RS256', 'EdDSA'] as Alg[]).map((alg) => ({
          ...KEYS[alg].publicKey.export({ format: 'jwk' }),
          kid: alg,
          use: 'sig',
          alg,
        })),
      })
    if (url === `${ISSUER}/token` && init?.method === 'POST') {
      seen.auth = String((init.headers as Record<string, string>).authorization ?? '')
      seen.form = new URLSearchParams(String(init.body))
      const verifier = seen.form.get('code_verifier') ?? ''
      if (createHash('sha256').update(verifier).digest('base64url') !== state.challenge)
        return json({ error: 'invalid_grant' }, 400)
      return json({
        id_token: jwt(state.claims, state.alg),
        access_token: 'at',
        token_type: 'Bearer',
      })
    }
    return json({ error: 'not found' }, 404)
  })
  vi.stubGlobal('fetch', fake)
  return state
}

const now = () => Math.floor(Date.now() / 1000)
const claimsFor = (nonce: string, x: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: 'socialmonitor',
  sub: '8f14e45f-ceea-4f6a-9d2b-0d4c1a6f0001',
  exp: now() + 300,
  iat: now(),
  nonce,
  email: 'ana@shades.md',
  email_verified: true,
  name: 'Ana Pop',
  preferred_username: 'ana',
  amr: ['mfa', 'pwd', 'otp'],
  acr: 'urn:shades:id:mfa',
  ...x,
})

// --- A browser on the tunnel's address -------------------------------------------------------

let n = 0
function browser(db: DB, secure = true) {
  const ip = `10.9.0.${++n}`
  const jar = new Map<string, string>()
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    const url = new URL(path, `https://${HOST}`)
    const route = [...authRoutes, ...shadesRoutes].find(
      (x) => x.method === method && x.path.test(url.pathname),
    )!
    const signed = auth.readSession(db, jar.get(auth.cookieName(secure)))
    const c: Ctx = {
      db,
      params: route.path.exec(url.pathname)!.groups ?? {},
      query: url.searchParams,
      body,
      local: !secure,
      user: signed?.user ?? null,
      cookies: [],
      secure,
      ip,
      country: null,
      ua: 'Mozilla/5.0 (Macintosh) Chrome/130.0',
      session: signed?.session ?? null,
      client: { ua: 'Mozilla/5.0 (Macintosh) Chrome/130.0', ip, country: null },
      origin: `https://${HOST}`,
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    }
    if (route.need !== 'public' && !c.user) throw new HttpError(401, 'Sign in first.')
    const out = (await route.handle(c)) as Record<string, unknown>
    for (const cookie of c.cookies) {
      const [pair = '', ...attrs] = cookie.split('; ')
      const [k = '', v = ''] = pair.split('=')
      if (!v || attrs.includes('Max-Age=0')) jar.delete(k)
      else jar.set(k, v)
    }
    return { out, cookies: c.cookies }
  }
  return { call, jar, session: () => auth.readSession(db, jar.get(auth.cookieName(secure))) }
}

/** Start, read what Shades ID was asked, then come back with the ID token the test wants. */
async function signInWithShades(
  db: DB,
  x: Record<string, unknown> | ((nonce: string) => Record<string, unknown>) = {},
  b = browser(db),
  fake = issuer(),
) {
  const start = await b.call('GET', '/api/auth/shades/start')
  const to = new URL(String(start.out.__redirect))
  fake.challenge = to.searchParams.get('code_challenge') ?? ''
  const nonce = to.searchParams.get('nonce') ?? ''
  fake.claims = typeof x === 'function' ? x(nonce) : claimsFor(nonce, x)
  const back = await b.call(
    'GET',
    `/api/auth/shades/callback?code=the-code&state=${to.searchParams.get('state')}`,
  )
  return { to, back: String(back.out.__redirect), b, fake }
}

const sub = (db: DB, id: number) =>
  (db.prepare('SELECT shades_sub AS s FROM users WHERE id = ?').get(id) as { s: string | null }).s
const events = (db: DB, event: string) =>
  db.prepare('SELECT * FROM audit WHERE event = ?').all(event) as {
    target: string
    detail: string
  }[]

// --- The tests -------------------------------------------------------------------------------

describe('Shades login, unconfigured', () => {
  it('is hidden: no flag for the sign-in page, and every route answers 404', async () => {
    unconfigure()
    const db = openDb(':memory:')
    const b = browser(db)
    expect((await b.call('GET', '/api/auth/me')).out.shades).toBe(false)
    for (const [m, p] of [
      ['GET', '/api/auth/shades/start'],
      ['GET', '/api/auth/shades/callback?code=x&state=y'],
      ['POST', '/api/auth/shades/ticket'],
    ] as const)
      await expect(b.call(m, p)).rejects.toMatchObject({ status: 404 })
    // Any one value missing hides it, the public address included.
    configure()
    delete process.env.SOCIALMONITOR_PUBLIC_HOST
    expect(shades.shadesConfig()).toBeNull()
    configure()
    process.env.SHADES_ID_CLIENT_SECRET = ' '
    expect(shades.shadesConfig()).toBeNull()
  })
})

describe('Shades login, start', () => {
  it('sends the browser to the discovered authorize endpoint with PKCE, state and nonce', async () => {
    const db = openDb(':memory:')
    issuer()
    const b = browser(db)
    expect((await b.call('GET', '/api/auth/me')).out.shades).toBe(true)
    const { out, cookies } = await b.call('GET', '/api/auth/shades/start')
    const to = new URL(String(out.__redirect))
    expect(`${to.origin}${to.pathname}`).toBe(`${ISSUER}/authorize`)
    const q = Object.fromEntries(to.searchParams)
    expect(q).toMatchObject({
      response_type: 'code',
      client_id: 'socialmonitor',
      redirect_uri: `https://${HOST}/api/auth/shades/callback`,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    })
    expect(q.state!.length).toBeGreaterThanOrEqual(43)
    expect(q.nonce!.length).toBeGreaterThanOrEqual(43)
    expect(q.code_challenge).toMatch(/^[\w-]{43}$/)
    expect(JSON.stringify(q)).not.toContain('not-a-real-secret')
    expect(cookies[0]).toBe(
      `__Host-sm_shades=${q.state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    )
  })

  it('starts on the public address when asked on this computer', async () => {
    const db = openDb(':memory:')
    issuer()
    const { out, cookies } = await browser(db, false).call('GET', '/api/auth/shades/start')
    expect(out.__redirect).toBe(`https://${HOST}/api/auth/shades/start`)
    expect(cookies).toEqual([])
  })

  it('refuses a discovery document whose endpoints are on another origin', async () => {
    const db = openDb(':memory:')
    issuer({ ...DOC, authorization_endpoint: 'https://evil.test/authorize' })
    const { out } = await browser(db).call('GET', '/api/auth/shades/start')
    expect(out.__redirect).toBe('/?shades=unavailable')
    shades.resetShadesCache()
    issuer({ ...DOC, issuer: 'https://other.test' })
    expect((await browser(db).call('GET', '/api/auth/shades/start')).out.__redirect).toBe(
      '/?shades=unavailable',
    )
  })
})

describe('Shades login, callback', () => {
  it('creates someone new with no role, linked to their Shades subject, and signs them in', async () => {
    const db = openDb(':memory:')
    const { back, b, fake } = await signInWithShades(db)
    expect(back).toBe('/')
    // The code went with client_secret_basic and the PKCE verifier.
    expect(fake.seen.auth).toBe(
      `Basic ${Buffer.from('socialmonitor:not-a-real-secret').toString('base64')}`,
    )
    expect(fake.seen.form?.get('redirect_uri')).toBe(`https://${HOST}/api/auth/shades/callback`)
    expect(fake.seen.form?.get('client_secret')).toBeNull()
    const s = b.session()!
    expect(s.user).toMatchObject({ email: 'ana@shades.md', name: 'Ana Pop', super: 0 })
    expect(s.user.verified_at).toBeTruthy()
    expect(auth.memberships(db, s.user.id)).toEqual([])
    expect(auth.findLogin(db, 'ana@shades.md')!.pass_hash).toBeNull()
    expect(sub(db, s.user.id)).toBe('8f14e45f-ceea-4f6a-9d2b-0d4c1a6f0001')
    const me = (await b.call('GET', '/api/auth/me')).out.user as Record<string, unknown>
    expect(me).toMatchObject({ super: false, memberships: [], shades: true, needs_second: false })
    expect(events(db, 'person.joined')).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(events(db, 'signin.ok')[0]!.detail)).toMatchObject({ method: 'shades' })
    // The state worked once.
    expect(shades.shadesSession(db, s.session!.id)?.mfa).toBe(true)
  })

  it('matches an existing person by email, then by subject, and keeps their roles', async () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
    const u = auth.createUser(db, { email: 'Ana@Shades.md', verified: true })
    auth.setMembership(db, u.id, brand.id, 'admin')
    const first = await signInWithShades(db)
    expect(first.back).toBe('/')
    expect(first.b.session()!.user.id).toBe(u.id)
    expect(auth.countUsers(db)).toBe(1)
    expect(auth.memberships(db, u.id)).toEqual([{ brand_id: brand.id, role: 'admin' }])
    expect(events(db, 'person.joined')).toHaveLength(0)
    // Linked now: the subject finds them even under another @shades.md address.
    const again = await signInWithShades(db, { email: 'ana.pop@shades.md' })
    expect(again.b.session()!.user.id).toBe(u.id)
  })

  it('finishes an open invitation: Shades ID proved the address', async () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: 'ana@shades.md' })
    expect(u.verified_at).toBeNull()
    const { back, b } = await signInWithShades(db)
    expect(back).toBe('/')
    expect(b.session()!.user.verified_at).toBeTruthy()
  })

  it('refuses an email already linked to another Shades subject', async () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: 'ana@shades.md', verified: true })
    db.prepare('UPDATE users SET shades_sub = ? WHERE id = ?').run('someone-else', u.id)
    const { back, b } = await signInWithShades(db)
    expect(back).toBe('/?shades=conflict')
    expect(b.session()).toBeNull()
  })

  it('keeps a blocked person out', async () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: 'ana@shades.md', verified: true })
    auth.updateUser(db, u.id, { disabled: true })
    const { back, b } = await signInWithShades(db)
    expect(back).toBe('/?shades=blocked')
    expect(b.session()).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(events(db, 'signin.failed')[0]!.detail)).toMatchObject({
      step: 'shades:blocked',
    })
  })

  const refusals: [
    string,
    Record<string, unknown> | ((nonce: string) => Record<string, unknown>),
    string,
  ][] = [
    ['a wrong nonce', { nonce: 'another-nonce' }, 'failed'],
    ['a wrong audience', { aud: 'crm' }, 'failed'],
    ['several audiences without azp', { aud: ['socialmonitor', 'crm'] }, 'failed'],
    ['another issuer', { iss: 'https://other.test' }, 'failed'],
    ['an expired token', { exp: now() - 120, iat: now() - 400 }, 'failed'],
    ['a token issued long ago', { iat: now() - 3600 }, 'failed'],
    ['a token not valid yet', { nbf: now() + 600 }, 'failed'],
    ['an unverified email', { email_verified: false }, 'unverified'],
    ['email_verified as a string', { email_verified: 'true' }, 'unverified'],
    ['an email outside shades.md', { email: 'ana@gmail.com' }, 'domain'],
    ['a look-alike domain', { email: 'ana@shades.md.evil.test' }, 'domain'],
    ['a sub-domain', { email: 'ana@mail.shades.md' }, 'domain'],
  ]
  for (const [what, x, why] of refusals)
    it(`refuses ${what}, with no session`, async () => {
      const db = openDb(':memory:')
      const { back, b } = await signInWithShades(db, x)
      expect(back).toBe(`/?shades=${why}`)
      expect(b.session()).toBeNull()
      expect(auth.countUsers(db)).toBe(0)
    })

  it('accepts several audiences when azp names this client', async () => {
    const db = openDb(':memory:')
    const { back } = await signInWithShades(db, {
      aud: ['socialmonitor', 'crm'],
      azp: 'socialmonitor',
    })
    expect(back).toBe('/')
  })

  it('refuses a wrong state, a missing cookie and a state used twice', async () => {
    const db = openDb(':memory:')
    issuer()
    const b = browser(db)
    const start = await b.call('GET', '/api/auth/shades/start')
    const state = new URL(String(start.out.__redirect)).searchParams.get('state')!
    const wrong = await b.call('GET', `/api/auth/shades/callback?code=c&state=${state}x`)
    expect(wrong.out.__redirect).toBe('/?shades=failed')
    // The callback spent the cookie: coming back again reads as too late.
    const late = await b.call('GET', `/api/auth/shades/callback?code=c&state=${state}`)
    expect(late.out.__redirect).toBe('/?shades=expired')

    const ok = await signInWithShades(db)
    expect(ok.back).toBe('/')
    ok.b.jar.set('__Host-sm_shades', new URL(ok.to).searchParams.get('state')!)
    const twice = await ok.b.call(
      'GET',
      `/api/auth/shades/callback?code=c&state=${ok.to.searchParams.get('state')}`,
    )
    expect(twice.out.__redirect).toBe('/?shades=expired')
  })

  it('says cancelled when the person said no at Shades ID', async () => {
    const db = openDb(':memory:')
    issuer()
    const b = browser(db)
    const start = await b.call('GET', '/api/auth/shades/start')
    const state = new URL(String(start.out.__redirect)).searchParams.get('state')!
    const back = await b.call('GET', `/api/auth/shades/callback?error=access_denied&state=${state}`)
    expect(back.out.__redirect).toBe('/?shades=cancelled')
  })

  it('is rate-limited per address, like the other sign-in endpoints', async () => {
    const db = openDb(':memory:')
    issuer()
    const b = browser(db)
    for (let i = 0; i < 20; i++) await b.call('GET', '/api/auth/shades/callback?code=c&state=s')
    const blocked = await b.call('GET', '/api/auth/shades/callback?code=c&state=s')
    expect(blocked.out.__redirect).toBe('/?shades=rate')
  })

  it('never logs the code, the tokens or the secret', async () => {
    const db = openDb(':memory:')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await signInWithShades(db, { aud: 'crm' })
    const text = [...warn.mock.calls, ...log.mock.calls].flat().join('\n')
    expect(text).toContain('Shades login refused')
    for (const secret of ['the-code', 'not-a-real-secret', 'eyJ'])
      expect(text).not.toContain(secret)
  })
})

describe('Shades login and the second step', () => {
  it('counts as the second step only when amr says mfa', () => {
    expect(shades.provesSecondStep({ amr: ['mfa', 'pwd', 'hwk'] })).toBe(true)
    expect(shades.provesSecondStep({ amr: ['pwd', 'otp'], acr: 'urn:shades:id:mfa' })).toBe(false)
    expect(shades.provesSecondStep({})).toBe(false)
  })

  it('without mfa, asks for SocialMonitor’s own step, then the session keeps the ID token', async () => {
    const db = openDb(':memory:')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { back, b } = await signInWithShades(db, { amr: ['pwd'], acr: undefined })
    const ticket = /^\/#shades=([\w-]+)$/.exec(back)?.[1]
    expect(ticket).toBeTruthy()
    expect(b.session()).toBeNull()
    const reply = (await b.call('POST', '/api/auth/shades/ticket', { ticket })).out
    expect(reply).toMatchObject({ ticket, login: 'ana@shades.md' })
    // Once only.
    await expect(b.call('POST', '/api/auth/shades/ticket', { ticket })).rejects.toThrow('expired')
    const code = /Subject: (\d{6})/.exec(
      log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('Subject:')) ?? '',
    )?.[1]
    const me = (await b.call('POST', '/api/auth/code', { ticket, code })).out
    expect(me.email).toBe('ana@shades.md')
    expect(me.shades).toBe(true)
    expect(shades.shadesSession(db, b.session()!.session!.id)?.mfa).toBe(false)
  })
})

describe('Shades login and signing out', () => {
  it('signs out at Shades ID too, with the ID token as the hint', async () => {
    const db = openDb(':memory:')
    const { b } = await signInWithShades(db)
    const { out } = await b.call('POST', '/api/auth/logout')
    const to = new URL(String(out.logout))
    expect(`${to.origin}${to.pathname}`).toBe(`${ISSUER}/logout`)
    expect(to.searchParams.get('post_logout_redirect_uri')).toBe(`https://${HOST}/`)
    expect(to.searchParams.get('id_token_hint')?.split('.')).toHaveLength(3)
    expect(b.session()).toBeNull()
  })

  it('signs out here only for a password session', async () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: 'p@example.com', verified: true })
    const b = browser(db)
    const s = auth.createSession(db, u, false, { ua: 'x', ip: '1.1.1.1', country: null })
    b.jar.set(auth.cookieName(true), s.token)
    expect((await b.call('POST', '/api/auth/logout')).out).toEqual({ ok: true })
  })
})

describe('someone with no role', () => {
  it('is refused every brand’s data', async () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
    const { b } = await signInWithShades(db)
    const user = b.session()!.user
    /** A GET as this person: the route's guard, then its answer. */
    const get = (path: string) => {
      const url = new URL(path, 'https://x')
      const route = [...authRoutes, ...routes].find(
        (x) => x.method === 'GET' && x.path.test(url.pathname),
      )!
      const c = {
        db,
        params: route.path.exec(url.pathname)!.groups ?? {},
        query: url.searchParams,
        body: {},
        user,
      } as unknown as Ctx
      guard(route, c)
      return route.handle(c)
    }
    expect(get('/api/brands')).toEqual([])
    for (const path of [
      `/api/brands/${brand.id}/summary`,
      `/api/brands/${brand.id}/insights`,
      `/api/comments?brand=${brand.id}`,
      `/api/posts?brand=${brand.id}`,
      '/api/comments',
      '/api/posts',
      '/api/audit',
      '/api/users',
    ])
      expect(() => get(path), path).toThrow(
        expect.objectContaining({ status: 403 }) as unknown as Error,
      )
  })
})

describe('giving someone new a role', () => {
  it('lists them for a super admin, who gives a brand role through People, with the audit trail', async () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Tavelo', ['https://www.instagram.com/tavelo'])
    const boss = auth.createUser(db, { email: 'boss@shades.md', super: true, verified: true })
    const { b } = await signInWithShades(db)
    const ana = b.session()!.user
    const admin = browser(db)
    const s = auth.createSession(db, boss, false, { ua: 'x', ip: '1.1.1.1', country: null })
    admin.jar.set(auth.cookieName(true), s.token)
    const people = (await admin.call('GET', '/api/users')).out as unknown as {
      email: string
      memberships: unknown[]
    }[]
    expect(people.find((p) => p.email === 'ana@shades.md')).toMatchObject({ memberships: [] })
    await admin.call('PATCH', `/api/users/${ana.id}`, {
      memberships: [{ brand_id: brand.id, role: 'viewer' }],
    })
    expect(auth.memberships(db, ana.id)).toEqual([{ brand_id: brand.id, role: 'viewer' }])
    const row = events(db, 'person.role').at(-1)!
    expect(row.target).toBe('ana@shades.md')
    expect(JSON.parse(row.detail)).toEqual({ from: null, to: 'viewer' })
    // Their open session picks the role up on its next request.
    expect((await b.call('GET', '/api/auth/me')).out.user).toMatchObject({
      memberships: [{ brand_id: brand.id, role: 'viewer' }],
    })
  })
})

describe('ID token signatures', () => {
  const cfg = () => shades.shadesConfig()!
  const check = (token: string) => shades.verifyIdToken(token, DOC, cfg(), 'n')

  it('accepts ES256, RS256 and EdDSA from the issuer’s keys', async () => {
    issuer()
    for (const alg of ['ES256', 'RS256', 'EdDSA'] as Alg[])
      await expect(check(jwt(claimsFor('n'), alg))).resolves.toMatchObject({
        sub: expect.any(String),
      })
  })

  it('refuses none, HMAC, a forged signature and a key of the wrong type', async () => {
    issuer()
    const good = jwt(claimsFor('n'))
    const [h, p] = good.split('.')
    await expect(check(`${b64({ alg: 'none' })}.${p}.`)).rejects.toThrow('not accepted')
    await expect(check(`${b64({ alg: 'HS256', kid: 'ES256' })}.${p}.c2ln`)).rejects.toThrow(
      'not accepted',
    )
    const other = jwt({ ...claimsFor('n'), sub: 'someone-else' })
    await expect(check(`${h}.${other.split('.')[1]}.${good.split('.')[2]}`)).rejects.toThrow(
      'signature',
    )
    // An RS256 token claiming the EC key's id finds no key it may use.
    await expect(check(jwt(claimsFor('n'), 'RS256', { kid: 'ES256' }))).rejects.toThrow('no key')
  })
})
