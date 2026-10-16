import * as auth from '../core/auth.ts'
import { audit } from '../core/audit.ts'
import { mailLang } from '../core/mail-text.ts'
import { mailReady } from '../core/mail.ts'
import { signInFailed } from '../core/security-events.ts'
import * as shades from '../core/shades-id.ts'
import * as tf from '../core/two-factor.ts'
import { mask, secondSteps, sendCode, signIn } from './auth-routes.ts'
import type { Ctx } from './routes.ts'
import { HttpError, r } from './routes.ts'

/**
 * Shades login (core/shades-id.ts): the "Shades login" link on the sign-in page starts here,
 * Shades ID's sign-in page sends the browser back to the callback, and the callback signs in.
 * Every failure goes back to the sign-in page with a reason it can say in the person's language.
 * Without Shades ID configured, these routes don't exist.
 */
const configured = () => {
  const cfg = shades.shadesConfig()
  if (!cfg) throw new HttpError(404, 'No such endpoint.')
  return cfg
}
const later = (p: Promise<unknown>) => void p.catch(() => {})
/** Back to the sign-in page, saying why. */
const refused = (why: shades.ShadesFailure) => ({ __redirect: `/?shades=${why}` })

export const shadesRoutes = [
  r('GET', '/api/auth/shades/start', 'public', async (c) => {
    const cfg = configured()
    // The state cookie must live on the address Shades ID returns to, so start there.
    if (!c.secure)
      return { __redirect: cfg.redirectUri.replace(/callback$/, 'start') + keepQuery(c) }
    try {
      auth.checkRate(`ip:${c.ip}`, 20)
    } catch {
      return refused('rate')
    }
    try {
      const { url, state } = await shades.startLogin(cfg, c.query.get('keep') === '1')
      c.cookies.push(shades.stateCookie(state))
      return { __redirect: url }
    } catch (e) {
      console.warn(`Shades login could not start: ${e instanceof Error ? e.message : String(e)}`)
      return refused('unavailable')
    }
  }),

  r('GET', '/api/auth/shades/callback', 'public', async (c) => {
    const cfg = configured()
    // The state is spent whatever happens next.
    c.cookies.push(shades.stateCookie('', 0))
    try {
      auth.checkRate(`ip:${c.ip}`, 20)
    } catch {
      return refused('rate')
    }
    let email: string | null = null
    let userId: number | null = null
    try {
      const p = shades.takePending(
        c.query.get('state') ?? '',
        auth.readCookie(c.cookie, shades.STATE_COOKIE),
      )
      if (c.query.get('error')) throw new shades.ShadesError('cancelled', 'Shades ID said no')
      const code = c.query.get('code')
      if (!code) throw new shades.ShadesError('failed', 'no code came back')
      const doc = await shades.discover(cfg)
      const idToken = await shades.exchangeCode(cfg, doc, code, p.verifier)
      const claims = await shades.verifyIdToken(idToken, doc, cfg, p.nonce)
      email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null
      const account = shades.checkAccount(c.db, claims, (x) =>
        auth.createUser(c.db, { email: x.email, name: x.name, verified: true }),
      )
      userId = account.userId
      const user = auth.getUser(c.db, account.userId)!
      if (account.created)
        audit(c.db, {
          actor: user.id,
          ip: c.ip,
          ua: c.ua,
          event: 'person.joined',
          target: user.email,
          detail: { method: 'shades' },
        })
      if (shades.provesSecondStep(claims)) {
        signIn(c, user, p.keep, 'shades')
        if (c.session) shades.keepIdToken(c.db, c.session.id, idToken)
        return { __redirect: '/' }
      }
      // Shades ID did not do a second step: SocialMonitor asks for its own, as after a password.
      const lang = mailLang(user.lang)
      const reply = tf.hasSecondFactor(c.db, user.id)
        ? await (async () => {
            const t = auth.issue(c.db, user.id, 'code')
            return {
              ticket: t.id,
              to: mask(user.email),
              mail: mailReady(),
              second: await secondSteps(c, user.id, `ticket:${t.id}`),
            }
          })()
        : await sendCode(user.id, user.email, lang, c)
      shades.holdTicket(reply.ticket, { ...reply, login: user.email, keep: p.keep }, idToken)
      // The ticket rides in the fragment, which never reaches a server or a log.
      return { __redirect: `/#shades=${reply.ticket}` }
    } catch (e) {
      const err = e instanceof shades.ShadesError ? e : new shades.ShadesError('failed', String(e))
      auth.noteFailure(`ip:${c.ip}`)
      console.warn(`Shades login refused: ${err.message}`)
      later(
        signInFailed(c.db, {
          userId,
          email: err.email ?? email,
          step: `shades:${err.code}`,
          ip: c.ip,
          ua: c.ua,
          country: c.country,
        }),
      )
      return refused(err.code)
    }
  }),

  // The page picks up a Shades login that waits for SocialMonitor's own second step.
  r('POST', '/api/auth/shades/ticket', 'public', (c) => {
    configured()
    auth.checkRate(`ip:${c.ip}`, 20)
    const reply = shades.ticketReply(String((c.body as { ticket?: unknown }).ticket ?? ''))
    if (!reply) {
      auth.noteFailure(`ip:${c.ip}`)
      throw new Error('That code has expired. Sign in again.')
    }
    return reply
  }),
]

/** "Keep me signed in", carried from the sign-in page. */
const keepQuery = (c: Ctx) => (c.query.get('keep') === '1' ? '?keep=1' : '')
