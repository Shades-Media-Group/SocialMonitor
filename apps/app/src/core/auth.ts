import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR, now } from './db.ts'

/**
 * Who may open the dashboard, and what they see. A super admin sees every brand and manages
 * people; everyone else sees only the brands they belong to, as a viewer (read only) or as that
 * brand's admin (edits the brand, its links and its people, rates comments, runs updates).
 * Sessions are signed tokens (HS256) in an HttpOnly cookie; signing in takes the password and
 * then a six-digit code sent by email.
 */
export type Role = 'viewer' | 'admin'
export interface User {
  id: number
  email: string
  username: string | null
  name: string
  super: number
  verified_at: string | null
  disabled: number
  session_version: number
  created_at: string
  last_seen_at: string | null
  lang: string
}
interface UserRow extends User {
  pass_hash: string | null
}
export interface Membership {
  brand_id: number
  role: Role
}

const SESSION_HOURS = 12
/** "Keep me signed in": a session that outlives the browser, for this many days. */
export const KEEP_DAYS = 30
const CODE_MINUTES = 10
const INVITE_HOURS = 72
const RESET_MINUTES = 30
const MAX_TRIES = 5

// --- Passwords ---------------------------------------------------------------------------

export function hashPassword(password: string) {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, 64).toString('base64')}`
}

export function checkPassword(password: string, stored: string | null) {
  const [kind, salt, hash] = (stored ?? '').split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64')
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'base64'), want.length), want)
}

export function validPassword(p: unknown): string {
  const s = String(p ?? '')
  if (s.length < 10) throw new Error('Use a password of at least 10 characters.')
  if (s.length > 200) throw new Error('That password is too long.')
  return s
}

// --- Session tokens ----------------------------------------------------------------------

const KEY_FILE = join(DATA_DIR, 'session.key')
let key: Buffer | null = null
/** SOCIALMONITOR_JWT_SECRET when set (a server's secret store), else a key kept in data/. */
function signingKey() {
  if (key) return key
  const env = process.env.SOCIALMONITOR_JWT_SECRET?.trim()
  if (env) {
    if (env.length < 32) throw new Error('SOCIALMONITOR_JWT_SECRET must be at least 32 characters.')
    return (key = Buffer.from(env))
  }
  if (!existsSync(KEY_FILE)) {
    writeFileSync(KEY_FILE, randomBytes(48).toString('base64'), { mode: 0o600 })
    chmodSync(KEY_FILE, 0o600)
  }
  return (key = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim()))
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (data: string) => createHmac('sha256', signingKey()).update(data).digest()

export function signSession(
  user: Pick<User, 'id' | 'session_version'>,
  seconds = SESSION_HOURS * 3600,
) {
  const iat = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, v: user.session_version, iat, exp: iat + seconds })}`
  return `${body}.${sign(body).toString('base64url')}`
}

/** The signed-in user, or null for a missing, forged, expired or revoked token. */
export function readSession(db: DB, token: string | undefined): User | null {
  const [h, p, s] = (token ?? '').split('.')
  if (!h || !p || !s) return null
  const want = sign(`${h}.${p}`)
  const got = Buffer.from(s, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  try {
    const head = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string }
    if (head.alg !== 'HS256') return null
    const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as {
      sub: number
      v: number
      exp: number
    }
    if (!c.exp || c.exp * 1000 < Date.now()) return null
    const u = getUser(db, c.sub)
    if (!u || u.disabled || !u.verified_at || u.session_version !== c.v) return null
    return u
  } catch {
    return null
  }
}

export const SESSION_COOKIE = 'sm_session'
export function sessionCookie(token: string, secure: boolean, maxAge = SESSION_HOURS * 3600) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}
export function readCookie(header: string | undefined, name = SESSION_COOKIE) {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return undefined
}

// --- People ------------------------------------------------------------------------------

const COLS =
  'id, email, username, name, super, verified_at, disabled, session_version, created_at, last_seen_at, lang'

export const countUsers = (db: DB) =>
  (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n

export const getUser = (db: DB, id: number) =>
  db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id) as User | undefined

/** By email or username, with the password hash, for signing in only. */
export const findLogin = (db: DB, login: string) =>
  db
    .prepare('SELECT * FROM users WHERE email = ? OR username = ?')
    .get(login.trim(), login.trim()) as UserRow | undefined

export const findByEmail = (db: DB, email: string) =>
  db.prepare(`SELECT ${COLS} FROM users WHERE email = ?`).get(email.trim()) as User | undefined

export function validEmail(e: unknown) {
  const s = String(e ?? '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 200)
    throw new Error('Give a valid email.')
  return s
}
export function validUsername(u: unknown) {
  const s = String(u ?? '').trim()
  if (!s) return null
  if (!/^[a-z0-9._-]{3,32}$/i.test(s))
    throw new Error('A username is 3 to 32 letters, digits, dots, dashes or underscores.')
  return s
}

export function createUser(
  db: DB,
  input: {
    email: string
    name?: string
    username?: string | null
    password?: string
    super?: boolean
    verified?: boolean
  },
) {
  const r = db
    .prepare(
      'INSERT INTO users (email, name, username, pass_hash, super, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      validEmail(input.email),
      String(input.name ?? '')
        .trim()
        .slice(0, 100),
      validUsername(input.username),
      input.password ? hashPassword(validPassword(input.password)) : null,
      input.super ? 1 : 0,
      input.verified ? now() : null,
      now(),
    )
  return getUser(db, Number(r.lastInsertRowid))!
}

export function updateUser(
  db: DB,
  id: number,
  x: {
    name?: string
    username?: string | null
    super?: boolean
    disabled?: boolean
    password?: string
  },
) {
  if (x.name !== undefined)
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(
      String(x.name).trim().slice(0, 100),
      id,
    )
  if (x.username !== undefined)
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(validUsername(x.username), id)
  if (x.super !== undefined)
    db.prepare('UPDATE users SET super = ? WHERE id = ?').run(x.super ? 1 : 0, id)
  if (x.disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(x.disabled ? 1 : 0, id)
    if (x.disabled) endSessions(db, id)
  }
  if (x.password !== undefined) {
    db.prepare(
      'UPDATE users SET pass_hash = ?, verified_at = coalesce(verified_at, ?) WHERE id = ?',
    ).run(hashPassword(validPassword(x.password)), now(), id)
    endSessions(db, id)
  }
}

export const endSessions = (db: DB, id: number) =>
  db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(id)

export const deleteUser = (db: DB, id: number) =>
  db.prepare('DELETE FROM users WHERE id = ?').run(id)

/** A person's view choices: merged into what is kept, at most 16 KB, plain values only. */
export function savePrefs(db: DB, id: number, patch: unknown) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('Preferences are an object.')
  const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(id) as
    { prefs: string } | undefined
  const next = { ...(JSON.parse(row?.prefs ?? '{}') as object), ...(patch as object) }
  const text = JSON.stringify(next)
  if (text.length > 16_384) throw new Error('Too many preferences.')
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(text, id)
  return next
}
export const readPrefs = (db: DB, id: number) =>
  JSON.parse(
    (db.prepare('SELECT prefs FROM users WHERE id = ?').get(id) as { prefs: string } | undefined)
      ?.prefs ?? '{}',
  ) as Record<string, unknown>

export const setLang = (db: DB, id: number, lang: string) =>
  db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, id)

/**
 * The super admin from .env, so a fresh install can skip the setup screen. Creates the account
 * only when SOCIALMONITOR_ADMIN_EMAIL and SOCIALMONITOR_ADMIN_PASSWORD are set and no one has that
 * email yet; an existing account is never changed. Bad values are logged, never thrown, and the
 * password is never logged.
 */
export function seedAdmin(
  db: DB,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.log,
) {
  const email = env.SOCIALMONITOR_ADMIN_EMAIL?.trim()
  const password = env.SOCIALMONITOR_ADMIN_PASSWORD
  if (!email || !password || findByEmail(db, email)) return
  try {
    const user = createUser(db, {
      email,
      username: env.SOCIALMONITOR_ADMIN_USERNAME || null,
      name: env.SOCIALMONITOR_ADMIN_NAME,
      password,
      super: true,
      verified: true,
    })
    log(`Created the super admin ${user.email} from .env.`)
  } catch (e) {
    log(`The super admin in .env was not created: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export const touch = (db: DB, id: number) =>
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), id)

export const memberships = (db: DB, userId: number) =>
  db
    .prepare('SELECT brand_id, role FROM memberships WHERE user_id = ?')
    .all(userId) as unknown as Membership[]

export function setMembership(db: DB, userId: number, brandId: number, role: Role | null) {
  if (role === null)
    db.prepare('DELETE FROM memberships WHERE user_id = ? AND brand_id = ?').run(userId, brandId)
  else
    db.prepare(
      'INSERT INTO memberships (user_id, brand_id, role) VALUES (?, ?, ?) ON CONFLICT (user_id, brand_id) DO UPDATE SET role = excluded.role',
    ).run(userId, brandId, role)
}

/** What a user may do with one brand: 'admin' for super admins and the brand's admins. */
export function roleFor(db: DB, user: User, brandId: number): Role | null {
  if (user.super) return 'admin'
  // A rival belongs to the brand that watches it: that brand's people see and edit it.
  const owner = (
    db.prepare('SELECT competitor_of FROM brands WHERE id = ?').get(brandId) as
      { competitor_of: number | null } | undefined
  )?.competitor_of
  const m = db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND brand_id = ?')
    .get(user.id, owner ?? brandId) as { role: Role } | undefined
  return m?.role ?? null
}

/** The brands a user may see; null means all of them. */
export const visibleBrands = (db: DB, user: User): number[] | null =>
  user.super ? null : memberships(db, user.id).map((m) => m.brand_id)

/** Super admins, and everyone in a brand this user administers, with those memberships. */
export function listPeople(db: DB, viewer: User) {
  const all = db
    .prepare(`SELECT ${COLS} FROM users ORDER BY name, email`)
    .all() as unknown as User[]
  const mine = viewer.super
    ? null
    : memberships(db, viewer.id)
        .filter((m) => m.role === 'admin')
        .map((m) => m.brand_id)
  return all
    .map((u) => {
      const ms = memberships(db, u.id)
      return { ...u, memberships: mine ? ms.filter((m) => mine.includes(m.brand_id)) : ms }
    })
    .filter((u) => !mine || u.memberships.length > 0)
}

// --- One-time secrets --------------------------------------------------------------------

const hash = (s: string) => createHash('sha256').update(s).digest('hex')

/** Issues a code (six digits) or a link secret; the database keeps only its hash. */
export function issue(db: DB, userId: number, purpose: 'code' | 'invite' | 'reset') {
  db.prepare('DELETE FROM tokens WHERE (user_id = ? AND purpose = ?) OR expires_at < ?').run(
    userId,
    purpose,
    now(),
  )
  const id = randomBytes(16).toString('base64url')
  const secret =
    purpose === 'code'
      ? String(randomInt(0, 1_000_000)).padStart(6, '0')
      : randomBytes(24).toString('base64url')
  const minutes =
    purpose === 'code' ? CODE_MINUTES : purpose === 'reset' ? RESET_MINUTES : INVITE_HOURS * 60
  db.prepare(
    'INSERT INTO tokens (id, user_id, purpose, secret_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    id,
    userId,
    purpose,
    hash(`${id}:${secret}`),
    new Date(Date.now() + minutes * 60_000).toISOString(),
  )
  return { id, secret }
}

/** Uses up a one-time secret and returns its user; wrong guesses count toward a limit. */
export function consume(db: DB, id: string, secret: string, purpose: 'code' | 'invite' | 'reset') {
  const t = db
    .prepare('SELECT * FROM tokens WHERE id = ? AND purpose = ?')
    .get(String(id), purpose) as
    { user_id: number; secret_hash: string; tries: number; expires_at: string } | undefined
  const expired =
    purpose === 'code'
      ? 'That code has expired. Sign in again.'
      : 'This link has expired. Ask for a new one.'
  if (!t || t.expires_at < now()) throw new Error(expired)
  const ok = timingSafeEqual(
    Buffer.from(hash(`${id}:${String(secret).trim()}`)),
    Buffer.from(t.secret_hash),
  )
  if (!ok) {
    if (t.tries + 1 >= MAX_TRIES) db.prepare('DELETE FROM tokens WHERE id = ?').run(id)
    else db.prepare('UPDATE tokens SET tries = tries + 1 WHERE id = ?').run(id)
    throw new Error(purpose === 'code' ? 'That code is not right.' : 'This link is not valid.')
  }
  db.prepare('DELETE FROM tokens WHERE id = ?').run(id)
  return t.user_id
}

/**
 * Limits per key over fifteen minutes: wrong passwords and wrong codes per account
 * ("login:<email>"), per address ("ip:<address>"), and reset emails ("forgot:<login>").
 */
const failures = new Map<string, number[]>()
// ponytail: in-memory, so a restart forgets; move to a table if the server is restarted often under attack.
export function checkRate(key: string, limit = 5) {
  const k = key.trim().toLowerCase()
  const recent = (failures.get(k) ?? []).filter((t) => Date.now() - t < 15 * 60_000)
  failures.set(k, recent)
  if (recent.length >= limit) throw new Error('Too many tries. Wait 15 minutes and try again.')
}
export const noteFailure = (key: string) => {
  const k = key.trim().toLowerCase()
  failures.set(k, [...(failures.get(k) ?? []), Date.now()])
}

/** Checked when the account doesn't exist, so a reply takes as long either way. */
const DUMMY = hashPassword('not a real password, only for timing')
export const checkAnyPassword = (password: string, stored: string | null | undefined) =>
  checkPassword(password, stored ?? DUMMY) && !!stored

/** The account a sign-in code belongs to, to count wrong codes against it. */
export const ticketOwner = (db: DB, ticket: string) =>
  (
    db
      .prepare(
        "SELECT u.email FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.purpose = 'code'",
      )
      .get(String(ticket)) as { email: string } | undefined
  )?.email
