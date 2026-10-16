import * as auth from '../core/auth.ts'
import type { Role, User } from '../core/auth.ts'
import { randomBytes } from 'node:crypto'
import { accessMail, codeMail, linkMail, mailReady, sendMail } from '../core/mail.ts'
import { mailLang, mailText } from '../core/mail-text.ts'
import * as store from '../core/store.ts'
import { audit } from '../core/audit.ts'
import { appUrl, securityEvent, signInFailed, signedIn } from '../core/security-events.ts'
import * as tf from '../core/two-factor.ts'
import * as pk from '../core/passkeys.ts'
import * as shades from '../core/shades-id.ts'
import type { Ctx } from './routes.ts'
import { HttpError, by, r } from './routes.ts'

/**
 * Signing in, invitations and the people who may use the dashboard. A password, then a code
 * sent by email; invitations and resets are links that work once.
 */
const b = (c: Ctx) => c.body as Record<string, unknown>
/** The dashboard language the request was made in. */
const langOf = (c: Ctx) => mailLang(b(c).lang)

/** Where links in emails point: the tunnel's address when there is one, else this computer. */
const base = () => appUrl()
/** Alerts go out after the reply; a failure is logged, never thrown at the person. */
const later = (p: Promise<unknown>) =>
  void p.catch((e: unknown) =>
    console.warn(`A security event failed: ${e instanceof Error ? e.message : String(e)}`),
  )
/** Security-relevant facts about the request, for securityEvent. */
const from = (c: Ctx) => ({ ip: c.ip, ua: c.ua, country: c.country })
/** Tells the person and the super admins about a new admin. */
const newAdmin = (c: Ctx & { user: User }, userId: number, brandId: number | null) =>
  later(
    securityEvent(c.db, {
      type: 'new_admin',
      userId,
      ...from(c),
      detail: {
        byId: c.user.id,
        by: c.user.name || c.user.email,
        ...(brandId ? { brandId, brand: store.getBrand(c.db, brandId)?.name } : {}),
      },
    }),
  )

/** What a security event needs to know about the request. */
const who = (c: Ctx, userId: number) => ({ userId, ip: c.ip, ua: c.client.ua, country: c.country })

/**
 * Starts a session. Any session this browser already had ends, so the id always changes when
 * someone signs in.
 */
export const signIn = (c: Ctx, user: User, keep = false, method = 'password') => {
  if (c.session) auth.deleteSession(c.db, c.session.id)
  const newDevice = !auth.knownDevice(c.db, user.id, c.client.ua)
  const s = auth.createSession(c.db, user, keep, c.client)
  c.session = auth.getSession(c.db, s.id) ?? null
  c.cookies.push(auth.sessionCookie(s.token, c.secure, s.maxAge))
  auth.touch(c.db, user.id)
  // Logged, and alerted when it is a device or country this account hasn't used before.
  later(signedIn(c.db, { userId: user.id, keep, method, newDevice, ...from(c) }))
}
const signOut = (c: Ctx) => c.cookies.push(auth.sessionCookie('', c.secure, 0))

export const me = (c: Ctx, user: User) => {
  // A session from Shades ID; when Shades ID did the second step, it stands in for a passkey.
  const viaShades = shades.shadesSession(c.db, c.session?.id)
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    super: !!user.super,
    memberships: auth.memberships(c.db, user.id),
    prefs: auth.readPrefs(c.db, user.id),
    // Super admins are asked to add a passkey or an authenticator; until then, email codes only.
    needs_second: !!user.super && !viaShades?.mfa && !tf.hasSecondFactor(c.db, user.id),
    shades: !!viaShades,
  }
}

export const mask = (email: string) =>
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
export async function sendCode(
  userId: number,
  email: string,
  lang: ReturnType<typeof langOf>,
  c: Ctx,
) {
  const t = auth.issue(c.db, userId, 'code')
  await sendMail(email, codeMail(lang, t.secret, 'signin', t.minutes))
  audit(c.db, { ...by(c), actor: userId, event: 'code.sent', target: email })
  return { ticket: t.id, to: mask(email), mail: mailReady() }
}

/** Which second steps this person can use instead of the emailed code. */
export const secondSteps = async (c: Ctx, userId: number, key: string) => {
  const f = tf.factors(c.db, userId)
  return {
    totp: f.totp,
    recovery: f.recovery > 0,
    // Options for the browser to sign with a passkey made on this host, if there is one.
    passkey: await pk.authenticationOptions(c.db, userId, pk.relyingParty(c.origin), key),
  }
}

/**
 * Checks the second step in a request: a passkey's answer (`passkey`, to the challenge stored
 * under `key`), an authenticator code (`totp`) or a recovery code (`recovery`). False when none
 * was given or it is wrong.
 */
async function secondStep(c: Ctx, userId: number, x: Record<string, unknown>, key: string) {
  if (x.passkey && typeof x.passkey === 'object')
    return pk.checkPasskey(
      c.db,
      userId,
      pk.relyingParty(c.origin),
      key,
      x.passkey as Parameters<typeof pk.checkPasskey>[4],
    )
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
  x.passkey
    ? 'passkey'
    : typeof x.totp === 'string'
      ? 'totp'
      : typeof x.recovery === 'string'
        ? 'recovery'
        : 'code'

/**
 * A password change or reset on an account with a passkey or an authenticator needs that too,
 * so an emailed code alone can't take the account over. Without one in the request, the reply
 * asks for it (403 with `second`: what this person can use) and nothing changes; a wrong one
 * counts against the account and against `token`, the code that came with it.
 */
async function secondFor(
  c: Ctx,
  userId: number,
  x: Record<string, unknown>,
  key: string,
  token?: string,
) {
  if (!tf.hasSecondFactor(c.db, userId)) return null
  const via = stepName(x)
  if (via !== 'code' && (await secondStep(c, userId, x, key))) return via
  if (via !== 'code') {
    auth.noteFailure(`login:${auth.getUser(c.db, userId)?.email ?? ''}`)
    if (token) auth.failToken(c.db, token)
  }
  throw new HttpError(
    403,
    via === 'code'
      ? 'This account has two-step sign-in. Confirm it is you to change the password.'
      : 'That second step is not right.',
    { second: await secondSteps(c, userId, key) },
  )
}

/** Sets the new password: every other session ends, this browser gets a new one. */
function newPassword(
  c: Ctx,
  userId: number,
  password: string,
  how: string,
  second: string | null,
  keep: boolean,
) {
  auth.updateUser(c.db, userId, { password })
  const user = auth.getUser(c.db, userId)!
  signIn(c, user, keep, how)
  securityEvent(c.db, { type: 'password_changed', ...who(c, userId), detail: { how, second } })
  return user
}

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
    // Shades login is offered only when Shades ID is configured (core/shades-id.ts).
    shades: !!shades.shadesConfig(),
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
      later(
        signInFailed(c.db, {
          userId: u?.id ?? null,
          email: u?.email ?? null,
          step: 'password',
          ...from(c),
        }),
      )
      throw new HttpError(401, "That email or username and password don't match.")
    }
    auth.upgradeHash(c.db, u.id, password, u.pass_hash)
    const lang = langOf(c)
    auth.setLang(c.db, u.id, lang)
    // With an authenticator or a passkey, the ticket waits for that (or a recovery code). The
    // emailed code is never offered then: the mailbox alone must not stand in for the second step.
    if (tf.hasSecondFactor(c.db, u.id)) {
      const t = auth.issue(c.db, u.id, 'code')
      return {
        ticket: t.id,
        to: mask(u.email),
        mail: mailReady(),
        second: await secondSteps(c, u.id, `ticket:${t.id}`),
      }
    }
    return sendCode(u.id, u.email, lang, c)
  }),

  // A new code for the same sign-in, when the first one did not arrive. The old one stops working.
  r('POST', '/api/auth/resend', 'public', async (c) => {
    const owner = auth.ticketOwner(c.db, String(b(c).ticket ?? ''))
    if (!owner) throw new Error('That code has expired. Sign in again.')
    if (tf.hasSecondFactor(c.db, owner.id))
      throw new HttpError(
        403,
        'This account signs in with its passkey or authenticator. Lost it? Use a recovery code.',
      )
    auth.checkRate(`resend:${owner.email}`, 3)
    auth.noteFailure(`resend:${owner.email}`)
    const out = await sendCode(owner.id, owner.email, langOf(c), c)
    shades.ticketMoved(String(b(c).ticket ?? ''), out.ticket)
    return out
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
      // An emailed code never completes the sign-in of an account with a second step.
      if (via === 'code' && owner && tf.hasSecondFactor(c.db, owner.id))
        throw new HttpError(
          403,
          'This account signs in with its passkey or authenticator. Lost it? Use a recovery code.',
        )
      if (via === 'code') userId = auth.consume(c.db, ticket, String(x.code ?? ''), 'code')
      else {
        const ok = owner ? await secondStep(c, owner.id, x, `ticket:${ticket}`) : false
        userId = auth.spend(c.db, ticket, 'code', () => ok)
      }
    } catch (e) {
      if (owner) {
        auth.noteFailure(`login:${owner.email}`)
        later(
          signInFailed(c.db, {
            userId: owner.id ?? null,
            email: owner.email,
            step: 'code',
            ...from(c),
          }),
        )
      }
      throw e
    }
    const user = auth.getUser(c.db, userId)!
    signIn(c, user, x.keep === true, via)
    // A Shades login that waited for this step: its session keeps the ID token for signing out.
    shades.ticketUsed(c.db, ticket, c.session?.id)
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
    const rp = pk.relyingParty(c.origin)
    return {
      totp: f.totp,
      recovery: f.recovery,
      passkeys: pk.listPasskeys(c.db, c.user.id).map((p) => ({
        id: p.id,
        name: p.name,
        created_at: p.created_at,
        last_used_at: p.last_used_at,
        here: p.rp_id === rp?.rpID,
      })),
      // Passkeys can be made here (not on a bare IP address such as 127.0.0.1).
      passkeysHere: !!rp,
    }
  }),

  // Passkeys: options for the browser, then its answer and a name.
  r('POST', '/api/auth/passkeys/options', 'user', (c) => {
    confirmed(c)
    const rp = pk.relyingParty(c.origin)
    if (!rp) throw new Error('Passkeys need a name such as localhost, not an IP address.')
    return pk.registrationOptions(c.db, c.user, rp)
  }),
  r('POST', '/api/auth/passkeys', 'user', async (c) => {
    confirmed(c)
    const rp = pk.relyingParty(c.origin)
    if (!rp) throw new Error('Passkeys need a name such as localhost, not an IP address.')
    const x = b(c)
    const name = String(x.name ?? '')
    await pk.addPasskey(
      c.db,
      c.user.id,
      rp,
      x.response as Parameters<typeof pk.addPasskey>[3],
      name,
    )
    securityEvent(c.db, {
      type: 'second_factor_added',
      ...who(c, c.user.id),
      detail: { method: 'passkey', name: name.slice(0, 60) },
    })
    const recovery =
      tf.recoveryLeft(c.db, c.user.id) === 0 ? tf.newRecoveryCodes(c.db, c.user.id) : null
    return { recovery }
  }),
  r('DELETE', '/api/auth/passkeys/:id', 'user', (c) => {
    confirmed(c)
    if (!pk.deletePasskey(c.db, c.user.id, String(c.params.id)))
      throw new HttpError(404, 'No such passkey.')
    if (!tf.hasSecondFactor(c.db, c.user.id)) tf.dropRecoveryCodes(c.db, c.user.id)
    securityEvent(c.db, {
      type: 'second_factor_removed',
      ...who(c, c.user.id),
      detail: { method: 'passkey' },
    })
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

  // Signing out; a session from Shades ID also signs out there: the page goes to `logout` next.
  r('POST', '/api/auth/logout', 'public', async (c) => {
    const from = shades.shadesSession(c.db, c.session?.id)
    if (c.session) auth.deleteSession(c.db, c.session.id)
    signOut(c)
    const logout = from ? await shades.logoutUrl(shades.shadesConfig(), from.idToken) : null
    return logout ? { logout } : { ok: true }
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
  // Invitation links, and reset links sent before resets used codes.
  r('POST', '/api/auth/accept', 'public', async (c) => {
    const x = b(c)
    const password = await auth.newPassword(x.password)
    const [tid = '', secret = ''] = String(x.token ?? '').split('.')
    const purpose = x.kind === 'reset' ? 'reset' : 'invite'
    // The link is checked but kept until it has done its job, so a mistake in the form (a taken
    // or malformed username, a missing second step) leaves it working for the next try.
    const userId = auth.consume(c.db, tid, secret, purpose, true)
    if (purpose === 'reset') {
      const how = await secondFor(c, userId, x, `reset:${tid}`, tid)
      auth.dropToken(c.db, tid)
      auth.updateUser(c.db, userId, { password })
      securityEvent(c.db, {
        type: 'password_changed',
        ...who(c, userId),
        detail: { how: 'reset link', second: how },
      })
      return { email: auth.getUser(c.db, userId)!.email }
    }
    const username = x.username ? auth.validUsername(x.username) : null
    if (username && auth.usernameTaken(c.db, username, userId))
      throw new Error('That username is taken. Choose another.')
    auth.updateUser(c.db, userId, {
      password,
      ...(x.name !== undefined ? { name: String(x.name) } : {}),
      ...(username ? { username } : {}),
    })
    auth.dropToken(c.db, tid)
    const user = auth.getUser(c.db, userId)!
    audit(c.db, { ...from(c), actor: userId, event: 'invite.accepted', target: user.email })
    // The emailed link already proved the address, as a code would: the new account is signed in.
    signIn(c, user, false, 'invite')
    return { email: user.email, me: me(c, user) }
  }),

  // A forgotten password: a six-digit code by email. The answer is the same whether or not the
  // account exists, and so is its timing, since the email goes out after the reply.
  r('POST', '/api/auth/forgot', 'public', (c) => {
    const login = String(b(c).login ?? '').trim()
    // Its own limit, so asking for codes can't lock anyone out of signing in.
    auth.checkRate(`forgot:${login}`, 3)
    auth.checkRate(`ip:${c.ip}`, 20)
    auth.noteFailure(`forgot:${login}`)
    auth.noteFailure(`ip:${c.ip}`)
    const u = auth.findLogin(c.db, login)
    if (u && !u.disabled && u.verified_at) {
      const t = auth.issue(c.db, u.id, 'reset', true)
      void sendMail(u.email, codeMail(langOf(c), t.secret, 'reset', t.minutes)).catch(
        (e: unknown) => console.error(`A password code could not be sent: ${String(e)}`),
      )
      return { ticket: t.id, mail: mailReady() }
    }
    return { ticket: randomBytes(16).toString('base64url'), mail: mailReady() }
  }),

  // The code and a new password together; with a second step set up, that too. Signs in.
  r('POST', '/api/auth/reset', 'public', async (c) => {
    const x = b(c)
    const ticket = String(x.ticket ?? '')
    const owner = auth.resetOwner(c.db, ticket)
    auth.checkRate(`ip:${c.ip}`, 20)
    if (owner) auth.checkRate(`login:${owner.email}`)
    const password = await auth.newPassword(x.password)
    let userId: number
    try {
      userId = auth.checkResetCode(c.db, ticket, String(x.code ?? ''), true)
    } catch (e) {
      auth.noteFailure(`ip:${c.ip}`)
      if (owner) auth.noteFailure(`login:${owner.email}`)
      throw e
    }
    const u = auth.getUser(c.db, userId)
    if (!u || u.disabled || !u.verified_at) {
      auth.dropToken(c.db, ticket)
      throw new Error('That code is not right, or it has expired.')
    }
    const how = await secondFor(c, userId, x, `reset:${ticket}`, ticket)
    auth.dropToken(c.db, ticket)
    return me(c, newPassword(c, userId, password, 'reset code', how, x.keep === true))
  }),

  // Changing the password while signed in: with the current one, or with a code by email.
  r('POST', '/api/auth/password/code', 'user', async (c) => {
    auth.checkRate(`forgot:${c.user.email}`, 3)
    auth.noteFailure(`forgot:${c.user.email}`)
    const t = auth.issue(c.db, c.user.id, 'reset', true)
    await sendMail(c.user.email, codeMail(langOf(c), t.secret, 'reset', t.minutes))
    return { ticket: t.id, to: mask(c.user.email), mail: mailReady() }
  }),
  r('POST', '/api/auth/password', 'user', async (c) => {
    const x = b(c)
    const account = `login:${c.user.email}`
    auth.checkRate(account)
    const password = await auth.newPassword(x.password)
    const ticket = typeof x.ticket === 'string' ? x.ticket : null
    if (ticket) {
      try {
        if (auth.resetOwner(c.db, ticket)?.id !== c.user.id)
          throw new Error('That code is not right, or it has expired.')
        auth.checkResetCode(c.db, ticket, String(x.code ?? ''), true)
      } catch (e) {
        auth.noteFailure(account)
        throw e
      }
    } else {
      const row = auth.findLogin(c.db, c.user.email)
      if (!auth.checkPassword(String(x.current ?? ''), row?.pass_hash ?? null)) {
        auth.noteFailure(account)
        throw new HttpError(403, 'Your current password is not right.')
      }
    }
    const how = await secondFor(c, c.user.id, x, `change:${c.user.id}`, ticket ?? undefined)
    if (ticket) auth.dropToken(c.db, ticket)
    const user = newPassword(
      c,
      c.user.id,
      password,
      ticket ? 'emailed code' : 'current password',
      how,
      !!c.session?.keep,
    )
    return me(c, user)
  }),

  r('PATCH', '/api/auth/me', 'user', (c) => {
    const x = b(c)
    if (x.prefs !== undefined) auth.savePrefs(c.db, c.user.id, x.prefs)
    auth.updateUser(c.db, c.user.id, {
      ...(x.name !== undefined ? { name: String(x.name) } : {}),
      ...(x.username !== undefined ? { username: (x.username as string) || null } : {}),
    })
    return me(c, auth.getUser(c.db, c.user.id)!)
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
    const wasSuper = !!user.super
    const wasAdmin = new Set(
      auth
        .memberships(c.db, user.id)
        .filter((m) => m.role === 'admin')
        .map((m) => m.brand_id),
    )
    if (wantSuper) auth.updateUser(c.db, user.id, { super: true })
    for (const m of ms) if (m.role) auth.setMembership(c.db, user.id, m.brand_id, m.role)
    if (wantSuper && !wasSuper) newAdmin(c, user.id, null)
    for (const m of ms)
      if (m.role === 'admin' && !wasAdmin.has(m.brand_id)) newAdmin(c, user.id, m.brand_id)
    // One row per brand, so each brand's admins see who joined it.
    const granted = ms.filter((m) => m.role)
    for (const m of wantSuper ? [{ brand_id: null, role: null }] : granted)
      audit(c.db, {
        ...by(c),
        event: 'person.invited',
        target: email,
        brandId: m.brand_id,
        detail: { role: wantSuper ? 'super' : m.role, existing: !isNew },
      })
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
    if (x.super !== undefined && !!x.super !== !!u.super) {
      audit(c.db, { ...by(c), event: 'person.role', target: u.email, detail: { super: !!x.super } })
      if (x.super) newAdmin(c, u.id, null)
    }
    if (x.disabled !== undefined && !!x.disabled !== !!u.disabled)
      audit(c.db, {
        ...by(c),
        event: x.disabled ? 'person.disabled' : 'person.enabled',
        target: u.email,
      })
    for (const m of (x.memberships ?? []) as { brand_id: unknown; role: unknown }[]) {
      const brandId = Number(m.brand_id)
      adminOf(c, brandId)
      const before = auth.roleFor(c.db, { ...u, super: 0 }, brandId)
      const next = role(m.role)
      auth.setMembership(c.db, u.id, brandId, next)
      if (before !== next) {
        audit(c.db, {
          ...by(c),
          event: 'person.role',
          target: u.email,
          brandId,
          detail: { from: before, to: next },
        })
        if (next === 'admin') newAdmin(c, u.id, brandId)
      }
    }
    return auth.listPeople(c.db, c.user).find((p) => p.id === u.id) ?? { removed: true }
  }),

  r('DELETE', '/api/users/:id', 'super', (c) => {
    const u = target(c, c.params.id)
    if (u.id === c.user.id) throw new Error("You can't remove yourself.")
    if (u.super && supers(c) <= 1) throw new Error('Keep at least one super admin.')
    const brands = auth.memberships(c.db, u.id)
    auth.deleteUser(c.db, u.id)
    for (const m of brands.length ? brands : [{ brand_id: null }])
      audit(c.db, { ...by(c), event: 'person.removed', target: u.email, brandId: m.brand_id })
  }),

  // Sends the invitation again, or a reset link to someone already set up.
  r('POST', '/api/users/:id/invite', manager, async (c) => {
    const u = target(c, c.params.id)
    reachable(c, u)
    await invite(c, u)
    return { sent: true, mail: mailReady() }
  }),
]
