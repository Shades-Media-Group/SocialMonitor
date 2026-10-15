import type { DB } from './db.ts'
import { now } from './db.ts'
import type { AuditEvent } from './audit.ts'
import { audit, failedStreak, pastSignIns } from './audit.ts'
import { getUser } from './auth.ts'
import type { SecurityKind } from './mail.ts'
import { securityMail, sendMail } from './mail.ts'

/**
 * Security events: each one is written to the audit log and emailed, in Gradient's design, to the
 * person it happened to; a new admin also goes to every other super admin. Mail problems are
 * logged and never stop the request that caused the event.
 */
export type SecurityEventType =
  | 'new_device'
  | 'password_changed'
  | 'second_factor_added'
  | 'second_factor_removed'
  | 'failed_signins'
  | 'new_admin'
  // Logged only, no email: the sign-in steps call these where they happen.
  | 'signed_in'
  | 'session_revoked'
  | 'sessions_ended'
  | 'recovery_code_used'
  | 'recovery_codes_new'

export interface SecurityEventInput {
  type: SecurityEventType
  /** The person it happened to. */
  userId: number
  ip?: string | null
  ua?: string | null
  /** Two letters from Cloudflare's cf-ipcountry, when the request came through Access. */
  country?: string | null
  /**
   * Small plain facts. Understood keys: `method` (the second factor), and for new_admin
   * `byId`/`by` (who granted it) and `brandId`/`brand` (none means super admin).
   */
  detail?: Record<string, unknown>
}

const KIND: Partial<Record<SecurityEventType, SecurityKind>> = {
  new_device: 'newDevice',
  password_changed: 'password',
  second_factor_added: 'factorAdded',
  second_factor_removed: 'factorRemoved',
  failed_signins: 'failed',
  new_admin: 'newAdmin',
}
const EVENT: Record<SecurityEventType, AuditEvent> = {
  new_device: 'security.new_device',
  password_changed: 'password.changed',
  second_factor_added: 'security.second_factor_added',
  second_factor_removed: 'security.second_factor_removed',
  failed_signins: 'security.failed_signins',
  new_admin: 'security.new_admin',
  signed_in: 'signin.ok',
  session_revoked: 'session.revoked',
  sessions_ended: 'logout.everywhere',
  recovery_code_used: 'security.recovery_used',
  recovery_codes_new: 'security.recovery_new',
}

/** Where links in emails point: the tunnel's address when there is one, else this computer. */
export function appUrl(env: Record<string, string | undefined> = process.env) {
  const host = env.SOCIALMONITOR_PUBLIC_HOST?.trim().toLowerCase()
  if (host) return `https://${host}`
  return (
    env.SOCIALMONITOR_UI ?? `http://127.0.0.1:${env.SOCIALMONITOR_API_PORT ?? env.PORT ?? 4400}`
  )
}

const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined)

/** Never throws: a broken alert must not break the sign-in or the request that caused it. */
export async function securityEvent(db: DB, e: SecurityEventInput) {
  try {
    await record(db, e)
  } catch (err) {
    console.warn(
      `A security event (${e.type}) failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function record(db: DB, e: SecurityEventInput) {
  const user = getUser(db, e.userId)
  if (!user) return
  const d = e.detail ?? {}
  const admin = e.type === 'new_admin'
  audit(db, {
    event: EVENT[e.type],
    actor: admin && typeof d.byId === 'number' ? d.byId : e.userId,
    target: user.email,
    brandId: typeof d.brandId === 'number' ? d.brandId : null,
    ip: e.ip,
    ua: e.ua,
    detail: { ...d, ...(e.country ? { country: e.country } : {}) },
  })
  const facts = {
    at: now(),
    ip: e.ip,
    country: e.country,
    ua: e.ua,
    method: str(d.method),
    by: str(d.by),
    brand: str(d.brand) ?? null,
    who: user.name || user.email,
  }
  const kind = KIND[e.type]
  if (!kind) return // logged only
  const link = appUrl()
  const mails: [string, string, SecurityKind][] = []
  // Someone invited a moment ago has no account to protect yet; their invitation says enough.
  if (user.verified_at && !user.disabled) mails.push([user.email, user.lang, kind])
  if (admin) {
    const supers = db
      .prepare('SELECT email, lang FROM users WHERE super = 1 AND disabled = 0 AND id != ?')
      .all(user.id) as { email: string; lang: string }[]
    for (const s of supers) mails.push([s.email, s.lang, 'newAdminOthers'])
  }
  await Promise.all(
    mails.map(([to, lang, kind]) =>
      sendMail(to, securityMail(lang, kind, facts, link)).catch((err: unknown) =>
        console.warn(
          `A security alert to ${to} was not sent: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ),
    ),
  )
}

/** The device a user agent names, without version numbers, so updates don't count as new. */
const deviceKey = (ua: string | null | undefined) =>
  (ua ?? '')
    .replace(/[\d._]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A good sign-in: logged, and alerted when the account has signed in before but never from this
 * device or this country.
 */
export async function signedIn(
  db: DB,
  x: {
    userId: number
    ip: string
    ua: string
    country: string | null
    keep: boolean
    /** How the second step was passed: code, totp, passkey, recovery. */
    method?: string
    newDevice?: boolean
  },
) {
  const user = getUser(db, x.userId)
  if (!user) return
  const past = pastSignIns(db, x.userId)
  const fresh =
    past.length > 0 &&
    (!past.some((p) => deviceKey(p.ua) === deviceKey(x.ua)) ||
      (!!x.country && !past.some((p) => p.country === x.country)))
  audit(db, {
    event: 'signin.ok',
    actor: x.userId,
    target: user.email,
    ip: x.ip,
    ua: x.ua,
    detail: { country: x.country, keep: x.keep, method: x.method ?? 'code' },
  })
  if (fresh)
    await securityEvent(db, {
      type: 'new_device',
      userId: x.userId,
      ip: x.ip,
      ua: x.ua,
      country: x.country,
    })
}

/** A failed sign-in: logged, and the fifth in a row on an account is alerted once. */
export async function signInFailed(
  db: DB,
  x: {
    userId: number | null
    email: string | null
    step: string
    ip: string
    ua: string
    country: string | null
  },
) {
  audit(db, {
    event: 'signin.failed',
    actor: x.userId,
    target: x.email,
    ip: x.ip,
    ua: x.ua,
    detail: { step: x.step, ...(x.country ? { country: x.country } : {}) },
  })
  if (x.userId && failedStreak(db, x.userId) === 5)
    await securityEvent(db, {
      type: 'failed_signins',
      userId: x.userId,
      ip: x.ip,
      ua: x.ua,
      country: x.country,
    })
}
