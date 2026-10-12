import * as auth from '../core/auth.ts'
import type { Role, User } from '../core/auth.ts'
import { mailReady, sendMail } from '../core/mail.ts'
import { mailLang, mailText } from '../core/mail-text.ts'
import * as store from '../core/store.ts'
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

const signIn = (c: Ctx, user: User) => {
  c.cookies.push(auth.sessionCookie(auth.signSession(user), c.secure))
  auth.touch(c.db, user.id)
}

const me = (c: Ctx, user: User) => ({
  id: user.id,
  email: user.email,
  username: user.username,
  name: user.name,
  super: !!user.super,
  memberships: auth.memberships(c.db, user.id),
})

const mask = (email: string) =>
  email.replace(/^(.)(.*)(@.*)$/, (_, a, m: string, d) => a + '•'.repeat(Math.min(6, m.length)) + d)

async function invite(c: Ctx & { user: User }, user: User) {
  const kind = user.verified_at ? 'reset' : 'invite'
  const t = auth.issue(c.db, user.id, kind)
  const link = `${base()}/#/${kind === 'invite' ? 'invite' : 'reset'}/${t.id}.${t.secret}`
  const from = c.user.name || c.user.email
  // A new person reads the email in the inviter's language; someone set up, in their own.
  const lang = kind === 'invite' ? langOf(c) : user.lang
  await sendMail(
    user.email,
    mailText(lang, kind === 'invite' ? 'inviteSubject' : 'resetSubject', { from }),
    mailText(lang, kind === 'invite' ? 'inviteBody' : 'resetBody', { from, link }),
    lang,
  )
  if (kind === 'invite') auth.setLang(c.db, user.id, lang)
}

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
  r('POST', '/api/auth/setup', 'public', (c) => {
    if (auth.countUsers(c.db) > 0) throw new HttpError(403, 'SocialMonitor is already set up.')
    if (!c.local)
      throw new HttpError(403, 'Create the first account on the computer SocialMonitor runs on.')
    const x = b(c)
    const user = auth.createUser(c.db, {
      email: String(x.email ?? ''),
      name: String(x.name ?? ''),
      username: (x.username as string) ?? null,
      password: String(x.password ?? ''),
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
      throw new HttpError(401, 'Wrong email, username or password.')
    }
    const t = auth.issue(c.db, u.id, 'code')
    const lang = langOf(c)
    auth.setLang(c.db, u.id, lang)
    await sendMail(
      u.email,
      mailText(lang, 'codeSubject', { code: t.secret }),
      mailText(lang, 'codeBody', { code: t.secret }),
      lang,
    )
    return { ticket: t.id, to: mask(u.email), mail: mailReady() }
  }),

  r('POST', '/api/auth/code', 'public', (c) => {
    const ticket = String(b(c).ticket ?? '')
    // Wrong codes count against the account too, so new tickets don't buy new guesses.
    const owner = auth.ticketOwner(c.db, ticket)
    if (owner) auth.checkRate(`login:${owner}`)
    let userId: number
    try {
      userId = auth.consume(c.db, ticket, String(b(c).code ?? ''), 'code')
    } catch (e) {
      if (owner) auth.noteFailure(`login:${owner}`)
      throw e
    }
    const user = auth.getUser(c.db, userId)!
    signIn(c, user)
    return me(c, user)
  }),

  r('POST', '/api/auth/logout', 'public', (c) => {
    c.cookies.push(auth.sessionCookie('', c.secure, 0))
  }),
  r('POST', '/api/auth/logout-everywhere', 'user', (c) => {
    auth.endSessions(c.db, c.user.id)
    c.cookies.push(auth.sessionCookie('', c.secure, 0))
  }),

  // Invitation and reset links: "<id>.<secret>" from the email.
  r('POST', '/api/auth/accept', 'public', (c) => {
    const [tid, secret] = String(b(c).token ?? '').split('.')
    const purpose = b(c).kind === 'reset' ? 'reset' : 'invite'
    const userId = auth.consume(c.db, tid ?? '', secret ?? '', purpose)
    const x = b(c)
    auth.updateUser(c.db, userId, {
      password: String(x.password ?? ''),
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
      await sendMail(
        u.email,
        mailText(lang, 'resetSubject'),
        mailText(lang, 'forgotBody', { link: `${base()}/#/reset/${t.id}.${t.secret}` }),
        lang,
      )
    }
    return { ok: true }
  }),

  r('PATCH', '/api/auth/me', 'user', (c) => {
    const x = b(c)
    if (x.password !== undefined) {
      const row = auth.findLogin(c.db, c.user.email)
      if (!auth.checkPassword(String(x.current ?? ''), row?.pass_hash ?? null))
        throw new HttpError(403, 'Your current password is not right.')
    }
    auth.updateUser(c.db, c.user.id, {
      ...(x.name !== undefined ? { name: String(x.name) } : {}),
      ...(x.username !== undefined ? { username: (x.username as string) || null } : {}),
      ...(x.password !== undefined ? { password: String(x.password) } : {}),
    })
    const user = auth.getUser(c.db, c.user.id)!
    if (x.password !== undefined) signIn(c, user) // the old sessions just ended; keep this one
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
        mailText(user.lang, 'accessSubject'),
        mailText(user.lang, 'accessBody', {
          from: c.user.name || c.user.email,
          brands:
            ms
              .filter((m) => m.role)
              .map((m) => store.getBrand(c.db, m.brand_id)!.name)
              .join(', ') || mailText(user.lang, 'everyBrand'),
        }),
        user.lang,
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
