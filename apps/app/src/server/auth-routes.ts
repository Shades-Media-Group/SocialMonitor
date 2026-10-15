import * as auth from '../core/auth.ts'
import type { Role, User } from '../core/auth.ts'
import { accessMail, codeMail, linkMail, mailReady, sendMail } from '../core/mail.ts'
import { mailLang, mailText } from '../core/mail-text.ts'
import * as store from '../core/store.ts'
import * as tf from '../core/two-factor.ts'
import { securityEvent } from '../core/security-events.ts'
import { publicHost } from './access.ts'
import type { Ctx } from './routes.ts'
import { HttpError, r } from './routes.ts'

/**
 * Signing in, invitations and the people who may use the dashboard. A password, then a code
 * sent by email; invitations and resets are links that work once.
 */
const b = (c: Ctx) => c.body as Record<string, unknown>
/** The dashboard language the request was made in. */
const langOf = (c: Ctx) => mailLang(b(c).lang)

/** Where links in emails point: the tunnel's address when there is one, else this computer. */
const base = () => {
  const host = publicHost()
  if (host) return `https://${host}`
  return (
    process.env.SOCIALMONITOR_UI ??
    `http://127.0.0.1:${process.env.SOCIALMONITOR_API_PORT ?? process.env.PORT ?? 4400}`
  )
}

/** What a security event needs to know about the request. */
const who = (c: Ctx, userId: number) => ({ userId, ip: c.ip, ua: c.client.ua })

/**
 * Starts a session. Any session this browser already had ends, so the id always changes when
 * someone signs in.
 */
const signIn = (c: Ctx, user: User, keep = false, method = 'password') => {
  if (c.session) auth.deleteSession(c.db, c.session.id)
  const newDevice = !auth.knownDevice(c.db, user.id, c.client.ua)
  const s = auth.createSession(c.db, user, keep, c.client)
  c.session = auth.getSession(c.db, s.id) ?? null
  c.cookies.push(auth.sessionCookie(s.token, c.secure, s.maxAge))
  auth.touch(c.db, user.id)
  securityEvent(c.db, { type: 'signed_in', ...who(c, user.id), detail: { method, newDevice } })
}
const signOut = (c: Ctx) => c.cookies.push(auth.sessionCookie('', c.secure, 0))

const me = (c: Ctx, user: User) => ({
  id: user.id,
  email: user.email,
  username: user.username,
  name: user.name,
  super: !!user.super,
  memberships: auth.memberships(c.db, user.id),
  prefs: auth.readPrefs(c.db, user.id),
})

const mask = (email: string) =>
  email.replace(/^(.)(.*)(@.*)$/, (_, a, m: string, d) => a + '•'.repeat(Math.min(6, m.length)) + d)

async function invite(c: Ctx & { user: User }, user: User) {
  const kind = user.verified_at ? 'reset' : 'invite'
  const t = auth.issue(c.db, user.id, kind)
  const link = `${base()}/${kind === 'invite' ? 'invite' : 'reset'}/${t.id}.${t.secret}`
  const from = c.user.name || c.user.email
  // A new person reads the email in the inviter's language; someone set up, in their own.
  const lang = kind === 'invite' ? langOf(c) : user.lang
  await sendMail(user.email, linkMail(lang, kind, link, from))
  if (kind === 'invite') auth.setLang(c.db, user.id, lang)
}

/** Emails a six-digit code for signing in; the ticket names it without revealing it. */
async function sendCode(userId: number, email: string, lang: ReturnType<typeof langOf>, c: Ctx) {
  const t = auth.issue(c.db, userId, 'code')
  await sendMail(email, codeMail(lang, t.secret))
  return { ticket: t.id, to: mask(email), mail: mailReady() }
}

/** Which second steps this person can use instead of the emailed code. */
const secondSteps = (c: Ctx, userId: number) => {
  const f = tf.factors(c.db, userId)
  return { totp: f.totp, recovery: f.recovery > 0 }
}

/**
 * Checks the second step in a request: an authenticator code (`totp`) or a recovery code
 * (`recovery`). False when none was given or it is wrong.
 */
async function secondStep(c: Ctx, userId: number, x: Record<string, unknown>) {
  if (typeof x.totp === 'string') return tf.checkTotp(c.db, userId, x.totp)
  if (typeof x.recovery === 'string') {
    const ok = tf.useRecoveryCode(c.db, userId, x.recovery)
    if (ok)
      securityEvent(c.db, {
        type: 'recovery_code_used',
        ...who(c, userId),
        detail: { left: tf.recoveryLeft(c.db, userId) },
      })
    return ok
  }
  return false
}
const stepName = (x: Record<string, unknown>) =>
  typeof x.totp === 'string' ? 'totp' : typeof x.recovery === 'string' ? 'recovery' : 'code'

/** Changing how someone signs in needs their password, entered in the last 15 minutes. */
const CONFIRM_MINUTES = 15
const confirmed = (c: Ctx & { user: User }) => {
  const at = c.session?.confirmed_at ?? c.session?.created_at
  if (!at || Date.now() - Date.parse(at) > CONFIRM_MINUTES * 60_000)
    throw new HttpError(403, 'Enter your password again to change how you sign in.', {
      confirm: true,
    })
}
/** Authenticator secrets waiting for their first code, by person. */
const pendingTotp = new Map<number, { secret: string; at: number }>()

/** Someone who manages people: a super admin, or the admin of at least one brand. */
const manager = (c: Ctx & { user: User }) => {
  if (!c.user.super && !auth.memberships(c.db, c.user.id).some((m) => m.role === 'admin'))
    throw new HttpError(403, 'Only admins manage people.')
}
const adminOf = (c: Ctx & { user: User }, brandId: number) => {
  if (auth.roleFor(c.db, c.user, brandId) !== 'admin')
    throw new HttpError(403, "You can only give access to brands you're an admin of.")
}
const role = (x: unknown): Role | null =>
  x === 'admin' || x === 'viewer'
    ? x
    : x === null || x === '' || x === 'none'
      ? null
      : (() => {
          throw new Error('A role is viewer or admin.')
        })()

const target = (c: Ctx, id: string | undefined) => {
  const u = auth.getUser(c.db, Number(id))
  if (!u) throw new Error('No such person.')
  return u
}
/** A brand admin may act on people only within their own brands. */
const reachable = (c: Ctx & { user: User }, u: User) => {
  if (c.user.super) return
  if (u.super || !auth.listPeople(c.db, c.user).some((p) => p.id === u.id))
    throw new HttpError(403, 'That person is not in a brand you manage.')
}
const supers = (c: Ctx) =>
  (
    c.db.prepare('SELECT count(*) AS n FROM users WHERE super = 1 AND disabled = 0').get() as {
      n: number
    }
  ).n

export const authRoutes = [
  r('GET', '/api/auth/me', 'public', (c) => ({
    user: c.user ? me(c, c.user) : null,
    setup: auth.countUsers(c.db) === 0,
    local: c.local,
    mail: mailReady(),
  })),

  // The first account, made on the computer SocialMonitor runs on. It is the super admin.
  r('POST', '/api/auth/setup', 'public', async (c) => {
    if (auth.countUsers(c.db) > 0) throw new HttpError(403, 'SocialMonitor is already set up.')
    if (!c.local)
      throw new HttpError(403, 'Create the first account on the computer SocialMonitor runs on.')
    const x = b(c)
    const password = await auth.newPassword(x.password)
    if (auth.countUsers(c.db) > 0) throw new HttpError(403, 'SocialMonitor is already set up.')
    const user = auth.createUser(c.db, {
      email: String(x.email ?? ''),
      name: String(x.name ?? ''),
      username: (x.username as string) ?? null,
      password,
      super: true,
      verified: true,
    })
    auth.setLang(c.db, user.id, langOf(c))
    signIn(c, user)
    return me(c, user)
  }),

  r('POST', '/api/auth/login', 'public', async (c) => {
    const login = String(b(c).login ?? '').trim()
    const password = String(b(c).password ?? '')
    const u = auth.findLogin(c.db, login)
    // Counted per account (whichever name was typed) and per address.
    const account = `login:${u?.email ?? login}`
    auth.checkRate(account)
    auth.checkRate(`ip:${c.ip}`, 20)
    const ok = auth.checkAnyPassword(password, u?.pass_hash)
    if (!u || !ok || u.disabled || !u.verified_at) {
      auth.noteFailure(account)
      auth.noteFailure(`ip:${c.ip}`)
      throw new HttpError(401, "That email or username and password don't match.")
    }
    auth.upgradeHash(c.db, u.id, password, u.pass_hash)
    const lang = langOf(c)
    auth.setLang(c.db, u.id, lang)
    // With an authenticator or a passkey, the ticket waits for that; the emailed code is sent
    // only when asked for ("Email me a code instead").
    if (tf.hasSecondFactor(c.db, u.id)) {
      const t = auth.issue(c.db, u.id, 'code')
      return { ticket: t.id, to: mask(u.email), mail: mailReady(), second: secondSteps(c, u.id) }
    }
    return sendCode(u.id, u.email, lang, c)
  }),

  // A new code for the same sign-in, when the first one did not arrive. The old one stops working.
  r('POST', '/api/auth/resend', 'public', async (c) => {
    const owner = auth.ticketOwner(c.db, String(b(c).ticket ?? ''))
    if (!owner) throw new Error('That code has expired. Sign in again.')
    auth.checkRate(`resend:${owner.email}`, 3)
    auth.noteFailure(`resend:${owner.email}`)
    return sendCode(owner.id, owner.email, langOf(c), c)
  }),

  // The second step: the emailed code, an authenticator code or a recovery code.
  r('POST', '/api/auth/code', 'public', async (c) => {
    const x = b(c)
    const ticket = String(x.ticket ?? '')
    // Wrong codes count against the account too, so new tickets don't buy new guesses.
    const owner = auth.ticketOwner(c.db, ticket)
    if (owner) auth.checkRate(`login:${owner.email}`)
    const via = stepName(x)
    let userId: number
    try {
      if (via === 'code') userId = auth.consume(c.db, ticket, String(x.code ?? ''), 'code')
      else {
        const ok = owner ? await secondStep(c, owner.id, x) : false
        userId = auth.spend(c.db, ticket, 'code', () => ok)
      }
    } catch (e) {
      if (owner) auth.noteFailure(`login:${owner.email}`)
      throw e
    }
    const user = auth.getUser(c.db, userId)!
    signIn(c, user, x.keep === true, via)
    return me(c, user)
  }),

  // The password again, before changing passkeys, the authenticator or recovery codes.
  r('POST', '/api/auth/confirm', 'user', (c) => {
    if (!c.session) throw new HttpError(403, 'Sign in first.')
    const account = `login:${c.user.email}`
    auth.checkRate(account)
    auth.checkRate(`ip:${c.ip}`, 20)
    const row = auth.findLogin(c.db, c.user.email)
    if (!auth.checkPassword(String(b(c).password ?? ''), row?.pass_hash ?? null)) {
      auth.noteFailure(account)
      auth.noteFailure(`ip:${c.ip}`)
      throw new HttpError(403, 'Your current password is not right.')
    }
    auth.confirmSession(c.db, c.session.id)
  }),

  // How this person can sign in.
  r('GET', '/api/auth/security', 'user', (c) => {
    const f = tf.factors(c.db, c.user.id)
    return { totp: f.totp, recovery: f.recovery }
  }),

  // An authenticator app: a new secret, then its first code turns it on.
  r('POST', '/api/auth/totp/start', 'user', (c) => {
    confirmed(c)
    const secret = tf.newTotpSecret()
    pendingTotp.set(c.user.id, { secret, at: Date.now() })
    return { secret, uri: tf.otpauthUri(secret, c.user.email) }
  }),
  r('POST', '/api/auth/totp', 'user', (c) => {
    confirmed(c)
    const p = pendingTotp.get(c.user.id)
    if (!p || Date.now() - p.at > 10 * 60_000)
      throw new Error('Setting up took too long. Start again.')
    const account = `login:${c.user.email}`
    auth.checkRate(account)
    if (!tf.enableTotp(c.db, c.user.id, p.secret, String(b(c).code ?? ''))) {
      auth.noteFailure(account)
      throw new Error('That code is not right.')
    }
    pendingTotp.delete(c.user.id)
    securityEvent(c.db, {
      type: 'second_factor_added',
      ...who(c, c.user.id),
      detail: { method: 'totp' },
    })
    // The first second step comes with recovery codes.
    const recovery =
      tf.recoveryLeft(c.db, c.user.id) === 0 ? tf.newRecoveryCodes(c.db, c.user.id) : null
    return { recovery }
  }),
  r('DELETE', '/api/auth/totp', 'user', (c) => {
    confirmed(c)
    tf.disableTotp(c.db, c.user.id)
    if (!tf.hasSecondFactor(c.db, c.user.id)) tf.dropRecoveryCodes(c.db, c.user.id)
    securityEvent(c.db, {
      type: 'second_factor_removed',
      ...who(c, c.user.id),
      detail: { method: 'totp' },
    })
  }),

  // Ten new recovery codes; the old ones stop working.
  r('POST', '/api/auth/recovery', 'user', (c) => {
    confirmed(c)
    if (!tf.hasSecondFactor(c.db, c.user.id))
      throw new Error('Add a passkey or an authenticator app first.')
    const codes = tf.newRecoveryCodes(c.db, c.user.id)
    securityEvent(c.db, { type: 'recovery_codes_new', ...who(c, c.user.id) })
    return { codes }
  }),

  r('POST', '/api/auth/logout', 'public', (c) => {
    if (c.session) auth.deleteSession(c.db, c.session.id)
    signOut(c)
  }),
  r('POST', '/api/auth/logout-everywhere', 'user', (c) => {
    auth.endSessions(c.db, c.user.id)
    securityEvent(c.db, { type: 'sessions_ended', ...who(c, c.user.id) })
    signOut(c)
  }),

  // The browsers this person is signed in on.
  r('GET', '/api/auth/sessions', 'user', (c) =>
    auth.listSessions(c.db, c.user.id).map((s) => ({
      id: s.id,
      ...auth.device(s.ua),
      country: s.country,
      local: !s.country && /^(::1|127\.|::ffff:127\.)/.test(s.ip),
      created_at: s.created_at,
      seen_at: s.seen_at,
      current: s.id === c.session?.id,
    })),
  ),
  r('DELETE', '/api/auth/sessions/:id', 'user', (c) => {
    const s = auth.getSession(c.db, String(c.params.id))
    if (!s || s.user_id !== c.user.id)
      throw new HttpError(404, 'That device is already signed out.')
    auth.deleteSession(c.db, s.id)
    securityEvent(c.db, {
      type: 'session_revoked',
      ...who(c, c.user.id),
      detail: auth.device(s.ua),
    })
    if (s.id === c.session?.id) signOut(c)
  }),

  // Invitation and reset links: "<id>.<secret>" from the email.
  r('POST', '/api/auth/accept', 'public', async (c) => {
    const password = await auth.newPassword(b(c).password)
    const [tid, secret] = String(b(c).token ?? '').split('.')
    const purpose = b(c).kind === 'reset' ? 'reset' : 'invite'
    const userId = auth.consume(c.db, tid ?? '', secret ?? '', purpose)
    const x = b(c)
    auth.updateUser(c.db, userId, {
      password,
      ...(purpose === 'invite' && x.name !== undefined ? { name: String(x.name) } : {}),
      ...(purpose === 'invite' && x.username ? { username: String(x.username) } : {}),
    })
    return { email: auth.getUser(c.db, userId)!.email }
  }),

  r('POST', '/api/auth/forgot', 'public', async (c) => {
    const login = String(b(c).login ?? '').trim()
    // Its own limit, so asking for links can't lock anyone out of signing in.
    auth.checkRate(`forgot:${login}`, 3)
    auth.checkRate(`ip:${c.ip}`, 20)
    auth.noteFailure(`forgot:${login}`)
    auth.noteFailure(`ip:${c.ip}`)
    const u = auth.findLogin(c.db, login)
    if (u && !u.disabled && u.verified_at) {
      const t = auth.issue(c.db, u.id, 'reset')
      const lang = langOf(c)
      await sendMail(u.email, linkMail(lang, 'forgot', `${base()}/reset/${t.id}.${t.secret}`))
    }
    return { ok: true }
  }),

  r('PATCH', '/api/auth/me', 'user', async (c) => {
    const x = b(c)
    if (x.password !== undefined) {
      const row = auth.findLogin(c.db, c.user.email)
      if (!auth.checkPassword(String(x.current ?? ''), row?.pass_hash ?? null))
        throw new HttpError(403, 'Your current password is not right.')
      x.password = await auth.newPassword(x.password)
    }
    if (x.prefs !== undefined) auth.savePrefs(c.db, c.user.id, x.prefs)
    auth.updateUser(c.db, c.user.id, {
      ...(x.name !== undefined ? { name: String(x.name) } : {}),
      ...(x.username !== undefined ? { username: (x.username as string) || null } : {}),
      ...(x.password !== undefined ? { password: String(x.password) } : {}),
    })
    const user = auth.getUser(c.db, c.user.id)!
    // The old sessions just ended; this browser gets a new one.
    if (x.password !== undefined) signIn(c, user, !!c.session?.keep, 'password change')
    return me(c, user)
  }),

  // People
  r('GET', '/api/users', manager, (c) => auth.listPeople(c.db, c.user)),

  r('POST', '/api/users', manager, async (c) => {
    const x = b(c)
    const wantSuper = !!x.super
    if (wantSuper && !c.user.super) throw new HttpError(403, 'Only super admins make super admins.')
    const ms = ((x.memberships ?? []) as { brand_id: unknown; role: unknown }[]).map((m) => ({
      brand_id: Number(m.brand_id),
      role: role(m.role),
    }))
    for (const m of ms) {
      if (!store.getBrand(c.db, m.brand_id)) throw new Error('No such brand.')
      adminOf(c, m.brand_id)
    }
    if (!wantSuper && !ms.some((m) => m.role)) throw new Error('Give access to at least one brand.')
    const email = auth.validEmail(x.email)
    let user = auth.findByEmail(c.db, email)
    const isNew = !user
    if (!user) user = auth.createUser(c.db, { email, name: String(x.name ?? '') })
    if (wantSuper) auth.updateUser(c.db, user.id, { super: true })
    for (const m of ms) if (m.role) auth.setMembership(c.db, user.id, m.brand_id, m.role)
    if (isNew) await invite(c, user)
    else
      await sendMail(
        user.email,
        accessMail(
          user.lang,
          c.user.name || c.user.email,
          ms
            .filter((m) => m.role)
            .map((m) => store.getBrand(c.db, m.brand_id)!.name)
            .join(', ') || mailText(user.lang, 'everyBrand'),
          base(),
        ),
      )
    // The same reply whether or not the person already had an account.
    return { invited: email }
  }),

  r('PATCH', '/api/users/:id', manager, (c) => {
    const u = target(c, c.params.id)
    reachable(c, u)
    const x = b(c)
    const own = u.id === c.user.id
    if (x.super !== undefined || x.disabled !== undefined) {
      if (!c.user.super) throw new HttpError(403, 'Only super admins change that.')
      if (own) throw new Error("You can't change your own access level or block yourself.")
      if ((x.super === false || x.disabled === true) && u.super && supers(c) <= 1)
        throw new Error('Keep at least one super admin.')
    }
    if (x.name !== undefined && !c.user.super && !own)
      throw new HttpError(403, 'Only super admins rename people.')
    auth.updateUser(c.db, u.id, {
      ...(x.name !== undefined ? { name: String(x.name) } : {}),
      ...(x.super !== undefined ? { super: !!x.super } : {}),
      ...(x.disabled !== undefined ? { disabled: !!x.disabled } : {}),
    })
    for (const m of (x.memberships ?? []) as { brand_id: unknown; role: unknown }[]) {
      adminOf(c, Number(m.brand_id))
      auth.setMembership(c.db, u.id, Number(m.brand_id), role(m.role))
    }
    return auth.listPeople(c.db, c.user).find((p) => p.id === u.id) ?? { removed: true }
  }),

  r('DELETE', '/api/users/:id', 'super', (c) => {
    const u = target(c, c.params.id)
    if (u.id === c.user.id) throw new Error("You can't remove yourself.")
    if (u.super && supers(c) <= 1) throw new Error('Keep at least one super admin.')
    auth.deleteUser(c.db, u.id)
  }),

  // Sends the invitation again, or a reset link to someone already set up.
  r('POST', '/api/users/:id/invite', manager, async (c) => {
    const u = target(c, c.params.id)
    reachable(c, u)
    await invite(c, u)
    return { sent: true, mail: mailReady() }
  }),
]
