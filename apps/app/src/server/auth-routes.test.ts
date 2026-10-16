import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openDb } from '../core/db.ts'
import type { DB } from '../core/db.ts'
import * as auth from '../core/auth.ts'
import * as tf from '../core/two-factor.ts'
import { authRoutes } from './auth-routes.ts'
import type { Ctx } from './routes.ts'
import { HttpError } from './routes.ts'

beforeAll(() => {
  process.env.SOCIALMONITOR_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256'
  process.env.SOCIALMONITOR_HIBP = 'off'
  delete process.env.SMTP_HOST
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

let n = 0
/** A browser talking to the routes: keeps its session cookie between calls, like the real one. */
function browser(db: DB) {
  const ip = `10.0.0.${++n}`
  let token: string | undefined
  return async (method: string, path: string, body: Record<string, unknown> = {}) => {
    const route = authRoutes.find((x) => x.method === method && x.path.test(path))!
    const signed = auth.readSession(db, token)
    const c: Ctx = {
      db,
      params: route.path.exec(path)!.groups ?? {},
      query: new URLSearchParams(),
      body,
      local: true,
      user: signed?.user ?? null,
      cookies: [],
      secure: false,
      ip,
      country: null,
      ua: 'Mozilla/5.0 (Macintosh) Chrome/130.0',
      session: signed?.session ?? null,
      client: { ua: 'Mozilla/5.0 (Macintosh) Chrome/130.0', ip, country: null },
      origin: 'http://localhost:4400',
    }
    if (route.need !== 'public' && !c.user) throw new HttpError(401, 'Sign in first.')
    const out = await route.handle(c)
    for (const cookie of c.cookies) token = /^sm_session=([^;]*)/.exec(cookie)?.[1] || undefined
    return out as Record<string, unknown>
  }
}

/** The six digits in the last email printed to the console (no SMTP in tests). */
function mailbox() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  return () => {
    const last = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('Subject:'))
      .at(-1)
    return /Subject: (\d{6})/.exec(last ?? '')?.[1] ?? ''
  }
}

const setup = () => {
  const db = openDb(':memory:')
  const u = auth.createUser(db, {
    email: `p${++n}@example.com`,
    password: 'first password here',
    verified: true,
  })
  return { db, u }
}

describe('forgotten password, by code', () => {
  it('answers the same for unknown accounts, then the code sets the password and signs in', async () => {
    const { db, u } = setup()
    const code = mailbox()
    const other = auth.createSession(db, u, false, { ua: 'x', ip: '1.1.1.1', country: null })
    const call = browser(db)

    const unknown = await call('POST', '/api/auth/forgot', { login: 'nobody@example.com' })
    const known = await call('POST', '/api/auth/forgot', { login: u.email })
    expect(Object.keys(unknown)).toEqual(Object.keys(known))
    expect(String(unknown.ticket)).toHaveLength(String(known.ticket).length)
    await expect(
      call('POST', '/api/auth/reset', {
        ticket: unknown.ticket,
        code: '123456',
        password: 'second password here',
      }),
    ).rejects.toThrow('That code is not right, or it has expired.')

    await new Promise((r) => setTimeout(r, 0)) // the email goes out after the reply
    const me = await call('POST', '/api/auth/reset', {
      ticket: known.ticket,
      code: code(),
      password: 'second password here',
    })
    expect(me.email).toBe(u.email)
    const row = auth.findLogin(db, u.email)!
    expect(auth.checkPassword('second password here', row.pass_hash)).toBe(true)
    // Every other session ended; this browser is signed in with a new one.
    expect(auth.readSession(db, other.token)).toBeNull()
    expect(auth.listSessions(db, u.id)).toHaveLength(1)
    // The code worked once.
    await expect(
      call('POST', '/api/auth/reset', {
        ticket: known.ticket,
        code: code(),
        password: 'x'.repeat(12),
      }),
    ).rejects.toThrow('That code is not right, or it has expired.')
  })

  it('refuses wrong and expired codes with the same words, and voids a code after five tries', async () => {
    const { db, u } = setup()
    const code = mailbox()
    const call = browser(db)
    const t = await call('POST', '/api/auth/forgot', { login: u.email })
    await new Promise((r) => setTimeout(r, 0))
    const right = code()
    const wrong = right === '000000' ? '000001' : '000000'
    for (let i = 0; i < 4; i++)
      await expect(
        call('POST', '/api/auth/reset', {
          ticket: t.ticket,
          code: wrong,
          password: 'y'.repeat(12),
        }),
      ).rejects.toThrow('That code is not right, or it has expired.')
    // The fifth try is refused by the account's limit, and the code is gone too.
    await expect(
      call('POST', '/api/auth/reset', { ticket: t.ticket, code: wrong, password: 'y'.repeat(12) }),
    ).rejects.toThrow()
    await expect(
      call('POST', '/api/auth/reset', { ticket: t.ticket, code: right, password: 'y'.repeat(12) }),
    ).rejects.toThrow(/Too many tries|not right/)

    const { db: db2, u: u2 } = setup()
    const call2 = browser(db2)
    vi.useFakeTimers({ now: new Date('2026-10-01T08:00:00Z'), toFake: ['Date'] })
    const t2 = await call2('POST', '/api/auth/forgot', { login: u2.email })
    await vi.waitFor(() => expect(code()).toMatch(/^\d{6}$/))
    const right2 = code()
    vi.setSystemTime(new Date('2026-10-01T08:10:01Z'))
    await expect(
      call2('POST', '/api/auth/reset', {
        ticket: t2.ticket,
        code: right2,
        password: 'z'.repeat(12),
      }),
    ).rejects.toThrow('That code is not right, or it has expired.')
  })

  it('limits how many codes one account can ask for', async () => {
    const { db, u } = setup()
    mailbox()
    const call = browser(db)
    for (let i = 0; i < 3; i++) await call('POST', '/api/auth/forgot', { login: u.email })
    await expect(call('POST', '/api/auth/forgot', { login: u.email })).rejects.toThrow(
      'Too many tries',
    )
  })

  it('needs the second step too when the account has one', async () => {
    const { db, u } = setup()
    const code = mailbox()
    const secret = tf.newTotpSecret()
    expect(tf.enableTotp(db, u.id, secret, tf.totp(tf.fromBase32(secret), tf.stepAt() - 1))).toBe(
      true,
    )
    const call = browser(db)
    const t = await call('POST', '/api/auth/forgot', { login: u.email })
    await new Promise((r) => setTimeout(r, 0))
    const body = { ticket: t.ticket, code: code(), password: 'second password here' }
    const asked = await call('POST', '/api/auth/reset', body).catch((e: HttpError) => e)
    expect(asked).toBeInstanceOf(HttpError)
    expect((asked as HttpError).status).toBe(403)
    expect((asked as HttpError).extra?.second).toMatchObject({ totp: true })
    // The emailed code alone changed nothing.
    expect(auth.checkPassword('first password here', auth.findLogin(db, u.email)!.pass_hash)).toBe(
      true,
    )
    await expect(call('POST', '/api/auth/reset', { ...body, totp: '000000' })).rejects.toThrow(
      'That second step is not right.',
    )
    const me = await call('POST', '/api/auth/reset', {
      ...body,
      totp: tf.totp(tf.fromBase32(secret), tf.stepAt()),
    })
    expect(me.email).toBe(u.email)
    expect(auth.checkPassword('second password here', auth.findLogin(db, u.email)!.pass_hash)).toBe(
      true,
    )
  })
})

describe('changing the password while signed in', () => {
  /** Signs a browser in with password and emailed code. */
  async function signedIn(db: DB, email: string, password = 'first password here') {
    const code = mailbox()
    const call = browser(db)
    const t = await call('POST', '/api/auth/login', { login: email, password })
    await call('POST', '/api/auth/code', { ticket: t.ticket, code: code() })
    return { call, code }
  }

  it('works with the current password and ends the other sessions', async () => {
    const { db, u } = setup()
    const other = auth.createSession(db, u, false, { ua: 'x', ip: '1.1.1.1', country: null })
    const { call } = await signedIn(db, u.email)
    await expect(
      call('POST', '/api/auth/password', { current: 'wrong password!!', password: 'n'.repeat(12) }),
    ).rejects.toThrow('Your current password is not right.')
    await call('POST', '/api/auth/password', {
      current: 'first password here',
      password: 'second password here',
    })
    expect(auth.checkPassword('second password here', auth.findLogin(db, u.email)!.pass_hash)).toBe(
      true,
    )
    expect(auth.readSession(db, other.token)).toBeNull()
    // This browser stays signed in, with a new session.
    expect((await call('GET', '/api/auth/sessions')) as unknown as unknown[]).toHaveLength(1)
  })

  it('works with an emailed code instead, and only with this person’s code', async () => {
    const { db, u } = setup()
    const { call, code } = await signedIn(db, u.email)
    const t = await call('POST', '/api/auth/password/code')
    expect(t.to).toMatch(/•/)
    await expect(
      call('POST', '/api/auth/password', {
        ticket: t.ticket,
        code: 'nope',
        password: 'n'.repeat(12),
      }),
    ).rejects.toThrow('That code is not right, or it has expired.')
    await call('POST', '/api/auth/password', {
      ticket: t.ticket,
      code: code(),
      password: 'second password here',
    })
    expect(auth.checkPassword('second password here', auth.findLogin(db, u.email)!.pass_hash)).toBe(
      true,
    )
  })

  it('asks for the second step when the account has one', async () => {
    const { db, u } = setup()
    const { call } = await signedIn(db, u.email)
    const secret = tf.newTotpSecret()
    tf.enableTotp(db, u.id, secret, tf.totp(tf.fromBase32(secret), tf.stepAt() - 1))
    const recovery = tf.newRecoveryCodes(db, u.id)
    const body = { current: 'first password here', password: 'second password here' }
    const asked = await call('POST', '/api/auth/password', body).catch((e: HttpError) => e)
    expect((asked as HttpError).extra?.second).toMatchObject({ totp: true, recovery: true })
    await call('POST', '/api/auth/password', { ...body, recovery: recovery[0] })
    expect(auth.checkPassword('second password here', auth.findLogin(db, u.email)!.pass_hash)).toBe(
      true,
    )
    expect(tf.recoveryLeft(db, u.id)).toBe(9)
  })
})

describe('signing in with a second step', () => {
  it('skips the email for an authenticator code, and counts wrong ones', async () => {
    const { db, u } = setup()
    const secret = tf.newTotpSecret()
    tf.enableTotp(db, u.id, secret, tf.totp(tf.fromBase32(secret), tf.stepAt() - 1))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = browser(db)
    const t = await call('POST', '/api/auth/login', {
      login: u.email,
      password: 'first password here',
    })
    expect(t.second).toMatchObject({ totp: true, passkey: null })
    expect(log).not.toHaveBeenCalled() // no email until asked for
    await expect(
      call('POST', '/api/auth/code', { ticket: t.ticket, totp: '000000' }),
    ).rejects.toThrow('That code is not right.')
    const me = await call('POST', '/api/auth/code', {
      ticket: t.ticket,
      totp: tf.totp(tf.fromBase32(secret), tf.stepAt()),
    })
    expect(me).toMatchObject({ email: u.email, needs_second: false })
  })

  it('never lets an emailed code stand in for the second step', async () => {
    const { db, u } = setup()
    const secret = tf.newTotpSecret()
    tf.enableTotp(db, u.id, secret, tf.totp(tf.fromBase32(secret), tf.stepAt() - 1))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = browser(db)
    const t = await call('POST', '/api/auth/login', {
      login: u.email,
      password: 'first password here',
    })
    await expect(call('POST', '/api/auth/resend', { ticket: t.ticket })).rejects.toThrow(
      'Use a recovery code',
    )
    expect(log).not.toHaveBeenCalled() // no code was emailed
    await expect(
      call('POST', '/api/auth/code', { ticket: t.ticket, code: '123456' }),
    ).rejects.toThrow('Use a recovery code')
  })
})

describe('changing how someone signs in', () => {
  it('asks for the password again after 15 minutes, then allows it', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T08:00:00Z'), toFake: ['Date'] })
    const { db, u } = setup()
    const code = mailbox()
    const call = browser(db)
    const t = await call('POST', '/api/auth/login', {
      login: u.email,
      password: 'first password here',
    })
    await call('POST', '/api/auth/code', { ticket: t.ticket, code: code() })
    // Just signed in: no need to confirm.
    expect(await call('POST', '/api/auth/totp/start')).toHaveProperty('secret')
    vi.setSystemTime(new Date('2026-10-01T08:16:00Z'))
    const asked = await call('POST', '/api/auth/totp/start').catch((e: HttpError) => e)
    expect((asked as HttpError).extra).toEqual({ confirm: true })
    await expect(call('POST', '/api/auth/confirm', { password: 'wrong one here' })).rejects.toThrow(
      'Your current password is not right.',
    )
    await call('POST', '/api/auth/confirm', { password: 'first password here' })
    expect(await call('POST', '/api/auth/totp/start')).toHaveProperty('uri')
  })
})

describe('accepting an invitation', () => {
  const invited = () => {
    const db = openDb(':memory:')
    const u = auth.createUser(db, { email: `new${++n}@example.com` })
    const t = auth.issue(db, u.id, 'invite')
    return { db, u, token: `${t.id}.${t.secret}` }
  }

  it('keeps the link working after a mistake in the form, then signs the person in', async () => {
    const { db, u, token } = invited()
    auth.createUser(db, { email: `taken${n}@example.com`, username: 'taken.name', verified: true })
    const call = browser(db)
    const send = (username: string) =>
      call('POST', '/api/auth/accept', {
        token,
        kind: 'invite',
        name: 'New Person',
        username,
        password: 'a long enough password',
      })

    await expect(send(u.email)).rejects.toThrow('A username is not an email.')
    await expect(send('Taken.Name')).rejects.toThrow('That username is taken.')
    expect(auth.getUser(db, u.id)!.verified_at).toBeNull()

    const out = await send('new.person')
    expect(out.me).toMatchObject({ email: u.email, username: 'new.person', name: 'New Person' })
    expect(await call('GET', '/api/auth/me')).toMatchObject({ user: { email: u.email } })
    // Done its job: the link is gone.
    await expect(send('other.name')).rejects.toThrow('This link has expired.')
  })

  it('still refuses a wrong secret', async () => {
    const { db, token } = invited()
    const [id] = token.split('.')
    await expect(
      browser(db)('POST', '/api/auth/accept', {
        token: `${id}.wrong`,
        kind: 'invite',
        password: 'a long enough password',
      }),
    ).rejects.toThrow('This link is not valid.')
  })
})
