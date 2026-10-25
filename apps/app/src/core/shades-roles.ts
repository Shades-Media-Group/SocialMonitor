import { createHash, timingSafeEqual } from 'node:crypto'
import * as auth from './auth.ts'
import { audit } from './audit.ts'
import type { DB } from './db.ts'

/**
 * The Shades roles API's model: who may use SocialMonitor, as the Shades CRM sees it. Brand
 * memberships stay SocialMonitor's own; the CRM sets one of three levels per Shades account.
 *
 *   none    disabled = 1 (blocked: Shades login says so), or never let in (the waiting screen)
 *   member  disabled = 0, super = 0, and approved = 1 or at least one brand
 *   super   disabled = 0, super = 1
 *
 * Only accounts linked to a Shades subject are listed or changed here; local password accounts
 * are SocialMonitor's alone.
 */
export const LEVELS = [
  { value: 'none', label: 'No access' },
  { value: 'member', label: 'Member' },
  { value: 'super', label: 'Super admin' },
] as const
export type Level = (typeof LEVELS)[number]['value']
export const isLevel = (x: unknown): x is Level => LEVELS.some((l) => l.value === x)

export class RolesError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface Row {
  id: number
  email: string
  name: string
  super: number
  disabled: number
  approved: number
  verified_at: string | null
  last_seen_at: string | null
  pass_hash: string | null
  shades_sub: string | null
}
const COLS =
  'id, email, name, super, disabled, approved, verified_at, last_seen_at, pass_hash, shades_sub'

const bySub = (db: DB, sub: string) =>
  db.prepare(`SELECT ${COLS} FROM users WHERE shades_sub = ?`).get(sub) as Row | undefined
const byEmail = (db: DB, email: string) =>
  db.prepare(`SELECT ${COLS} FROM users WHERE lower(email) = lower(?)`).get(email) as
    Row | undefined
const hasBrands = (db: DB, id: number) =>
  !!db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(id)

export function levelOf(db: DB, u: Row): Level {
  if (u.disabled) return 'none'
  if (u.super) return 'super'
  return u.approved || hasBrands(db, u.id) ? 'member' : 'none'
}

/** An account as the CRM sees it. active: the account can sign in (not blocked). */
const view = (db: DB, u: Row) => ({
  sub: u.shades_sub!,
  email: u.email,
  name: u.name,
  level: levelOf(db, u),
  active: !u.disabled,
  lastSignInAt: u.last_seen_at,
})
export type RolesAccount = ReturnType<typeof view>

export const listRoles = (db: DB) => ({
  levels: LEVELS.map((l) => ({ ...l })),
  accounts: (
    db
      .prepare(`SELECT ${COLS} FROM users WHERE shades_sub IS NOT NULL ORDER BY lower(email)`)
      .all() as unknown as Row[]
  ).map((u) => view(db, u)),
})

// --- The token -------------------------------------------------------------------------------

/** SHADES_ROLES_TOKEN, when it is long enough to count; else the API is off. */
export function rolesToken(env: Record<string, string | undefined> = process.env) {
  const t = env.SHADES_ROLES_TOKEN?.trim()
  return t && t.length >= 32 ? t : null
}

const digest = (s: string) => createHash('sha256').update(s).digest()
/** Whether an Authorization header carries the token: compared as SHA-256 digests, in constant time. */
export function bearerMatches(header: string | undefined, token: string) {
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '')
  if (!m) return false
  return timingSafeEqual(digest(m[1]!.trim()), digest(token))
}

/** X-Acting-User: the CRM person asking, an email. */
export function actingUser(header: unknown) {
  const s = String(Array.isArray(header) ? header[0] : (header ?? '')).trim()
  if (!s || s.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null
  return s.toLowerCase()
}

// --- Changes ---------------------------------------------------------------------------------

export interface Who {
  /** The acting CRM person's email. */
  by: string
  ip: string
  ua: string
}

const activeSupers = (db: DB) =>
  (
    db.prepare('SELECT count(*) AS n FROM users WHERE super = 1 AND disabled = 0').get() as {
      n: number
    }
  ).n

const notSelf = (who: Who, ...emails: (string | undefined)[]) => {
  if (emails.some((e) => e && e.toLowerCase() === who.by))
    throw new RolesError(403, 'Nobody changes their own level.')
}

/** The acting person's own account here, if they have one, as the audit row's actor. */
const actorId = (db: DB, who: Who) => byEmail(db, who.by)?.id ?? null

function record(
  db: DB,
  who: Who,
  event: 'person.role' | 'person.removed',
  u: Pick<Row, 'email' | 'shades_sub'>,
  detail: Record<string, unknown>,
) {
  audit(db, {
    event,
    actor: actorId(db, who),
    target: u.email,
    ip: who.ip,
    ua: who.ua,
    detail: { via: 'shades-roles', by: who.by, sub: u.shades_sub, ...detail },
  })
}

/** Puts a level on an account; signs the person out when they lose access or lose super. */
function apply(db: DB, u: Row, level: Level) {
  const before = levelOf(db, u)
  if (before === 'super' && level !== 'super' && activeSupers(db) <= 1)
    throw new RolesError(409, 'That would leave no super admin.')
  const set = (sql: string, ...args: (string | number)[]) =>
    db.prepare(`UPDATE users SET ${sql} WHERE id = ?`).run(...args, u.id)
  if (level === 'none') set('disabled = 1, super = 0, approved = 0')
  else if (level === 'member') set('disabled = 0, super = 0, approved = 1')
  else set('disabled = 0, super = 1, approved = 1')
  if (level === 'none' || (u.super && level !== 'super')) auth.endSessions(db, u.id)
  else if (before !== level) auth.rotateSessions(db, u.id)
  return before
}

const cleanName = (x: unknown) =>
  x === undefined || x === null ? undefined : String(x).trim().slice(0, 100)

/**
 * PUT /accounts/:sub. The account linked to sub gets the level (and the email and name when
 * given); else an account here with that email and no subject is linked; else one is made in
 * advance, with no password, for Shades login only.
 */
export function putAccount(db: DB, who: Who, sub: string, body: unknown) {
  const x = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (!isLevel(x.level)) throw new RolesError(400, 'level is one of none, member, super.')
  const level = x.level
  const name = cleanName(x.name)
  let email: string | undefined
  if (x.email !== undefined && x.email !== null && x.email !== '') {
    try {
      email = auth.validEmail(x.email).toLowerCase()
    } catch {
      throw new RolesError(400, 'Give a valid email.')
    }
  }
  if (!sub || sub.length > 200) throw new RolesError(400, 'Give a Shades subject.')

  return run(db, () => put(db, who, sub, level, email, name))
}

/** One change at a time, all or nothing. */
function run<T>(db: DB, f: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = f()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function put(
  db: DB,
  who: Who,
  sub: string,
  level: Level,
  email: string | undefined,
  name: string | undefined,
) {
  const linked = bySub(db, sub)
  if (linked) {
    notSelf(who, linked.email, email)
    if (email && email !== linked.email.toLowerCase()) {
      const other = byEmail(db, email)
      if (other && other.id !== linked.id)
        throw new RolesError(409, 'Another account here has that email.')
    }
    const from = apply(db, linked, level)
    if (email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, linked.id)
    if (name !== undefined)
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, linked.id)
    const u = bySub(db, sub)!
    record(db, who, 'person.role', u, { action: 'change', from, to: level })
    return view(db, u)
  }
  if (!email) throw new RolesError(400, 'Give a valid email.')
  notSelf(who, email)
  const match = byEmail(db, email)
  if (match) {
    if (match.shades_sub)
      throw new RolesError(409, 'That email is linked to another Shades account.')
    db.prepare('UPDATE users SET shades_sub = ? WHERE id = ?').run(sub, match.id)
    const from = apply(db, { ...match, shades_sub: sub }, level)
    if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, match.id)
    const u = bySub(db, sub)!
    record(db, who, 'person.role', u, { action: 'link', from, to: level })
    return view(db, u)
  }
  const made = auth.createUser(db, { email, name: name ?? '' })
  db.prepare('UPDATE users SET shades_sub = ? WHERE id = ?').run(sub, made.id)
  apply(db, bySub(db, sub)!, level)
  const u = bySub(db, sub)!
  record(db, who, 'person.role', u, { action: 'create', from: null, to: level })
  return view(db, u)
}

/** Whether an account was only ever set up in advance: never used, nothing points at it. */
function untouched(db: DB, u: Row) {
  if (u.last_seen_at || u.verified_at || u.pass_hash) return false
  const any = (sql: string) => !!db.prepare(sql).get(u.id)
  return !(
    any('SELECT 1 FROM memberships WHERE user_id = ?') ||
    any('SELECT 1 FROM sessions WHERE user_id = ?') ||
    any('SELECT 1 FROM passkeys WHERE user_id = ?') ||
    any('SELECT 1 FROM audit WHERE actor = ?') ||
    any('SELECT 1 FROM comments WHERE done_by = ?') ||
    any('SELECT 1 FROM saved_reports WHERE created_by = ?')
  )
}

/**
 * DELETE /accounts/:sub: no access, history kept. An account only set up in advance, never
 * signed in and with nothing pointing at it, is removed instead.
 */
export function deleteAccount(db: DB, who: Who, sub: string) {
  return run(db, () => {
    const u = bySub(db, sub)
    if (!u) throw new RolesError(404, 'No account with that Shades subject.')
    notSelf(who, u.email)
    const from = levelOf(db, u)
    if (untouched(db, u)) {
      if (from === 'super' && activeSupers(db) <= 1)
        throw new RolesError(409, 'That would leave no super admin.')
      auth.deleteUser(db, u.id)
      record(db, who, 'person.removed', u, { action: 'delete', from, to: null })
      return 'deleted' as const
    }
    apply(db, u, 'none')
    record(db, who, 'person.role', u, { action: 'revoke', from, to: 'none' })
    return 'revoked' as const
  })
}
