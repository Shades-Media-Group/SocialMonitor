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
 * Sessions live server-side, named by a random id in an HttpOnly cookie; signing in takes the
 * password and then a second step: an emailed code, an authenticator code or a passkey.
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

/**
 * scrypt at N=2^17, r=8, p=1 (128 MB, a few hundred milliseconds) with a 32-byte salt. The
 * parameters live in the hash, "scrypt$17$8$1$salt$hash", so they can rise later; hashes from
 * before ("scrypt$salt$hash", N=2^14) still check and are rehashed at the next sign-in.
 */
const SCRYPT = { logN: 17, r: 8, p: 1 }
const scrypt = (password: string, salt: Buffer, logN: number, r: number, p: number, len: number) =>
  scryptSync(password, salt, len, { N: 2 ** logN, r, p, maxmem: 256 * 1024 * 1024 })

export function hashPassword(password: string) {
  const { logN, r, p } = SCRYPT
  const salt = randomBytes(32)
  const h = scrypt(password, salt, logN, r, p, 32)
  return `scrypt$${logN}$${r}$${p}$${salt.toString('base64')}$${h.toString('base64')}`
}

function parseHash(stored: string | null) {
  const parts = (stored ?? '').split('$')
  if (parts[0] !== 'scrypt') return null
  if (parts.length === 3) return { logN: 14, r: 8, p: 1, salt: parts[1]!, hash: parts[2]! }
  if (parts.length !== 6) return null
  const [logN, r, p] = parts.slice(1, 4).map(Number) as [number, number, number]
  if (!(logN >= 10 && logN <= 20 && r >= 1 && r <= 32 && p >= 1 && p <= 4)) return null
  return { logN, r, p, salt: parts[4]!, hash: parts[5]! }
}

export function checkPassword(password: string, stored: string | null) {
  const h = parseHash(stored)
  if (!h || !h.salt || !h.hash) return false
  const want = Buffer.from(h.hash, 'base64')
  const got = scrypt(password, Buffer.from(h.salt, 'base64'), h.logN, h.r, h.p, want.length)
  return timingSafeEqual(got, want)
}

/** True when a stored hash uses weaker parameters than today's, so it is redone on sign-in. */
export function needsRehash(stored: string | null) {
  const h = parseHash(stored)
  return !h || h.logN < SCRYPT.logN || h.r < SCRYPT.r || Buffer.from(h.salt, 'base64').length < 32
}

/** After a right password: stores it again with today's parameters when the old hash is weaker. */
export function upgradeHash(db: DB, id: number, password: string, stored: string | null) {
  if (needsRehash(stored))
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), id)
}

/**
 * Whether a password is in Have I Been Pwned's list of breached passwords, by k-anonymity: only
 * the first five hex characters of its SHA-1 leave the computer, the matching suffixes come back
 * padded with decoys, and the comparison happens here. Unreachable means "not known breached",
 * with a warning in the log, so an offline install can still set passwords.
 * SOCIALMONITOR_HIBP=off turns the check off.
 */
export async function breached(
  password: string,
  get: typeof fetch = fetch,
  warn: (line: string) => void = console.warn,
) {
  if (process.env.SOCIALMONITOR_HIBP?.trim().toLowerCase() === 'off') return false
  const sha = createHash('sha1').update(password).digest('hex').toUpperCase()
  try {
    const r = await get(`https://api.pwnedpasswords.com/range/${sha.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) throw new Error(`status ${r.status}`)
    for (const line of (await r.text()).split('\n')) {
      const [suffix, n] = line.trim().split(':')
      if (suffix === sha.slice(5) && Number(n) > 0) return true
    }
    return false
  } catch (e) {
    warn(
      `The breached-password check could not reach Have I Been Pwned (${e instanceof Error ? e.message : String(e)}); the password was accepted.`,
    )
    return false
  }
}

/** A new password: long enough, and not in a known breach. */
export async function newPassword(p: unknown, get?: typeof fetch) {
  const s = validPassword(p)
  if (await breached(s, get))
    throw new Error(
      'That password has appeared in a data breach, so attackers try it first. Choose another one.',
    )
  return s
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

/**
 * A short-lived token for the headless browser that renders a PDF as a person: signed (HS256),
 * never stored, at most RENDER_MAX seconds. People's own sign-ins are server-side sessions below.
 */
const RENDER_MAX = 600
export function signSession(user: Pick<User, 'id' | 'session_version'>, seconds = 120) {
  const iat = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, v: user.session_version, iat, exp: iat + Math.min(seconds, RENDER_MAX) })}`
  return `${body}.${sign(body).toString('base64url')}`
}

function readRenderToken(db: DB, token: string): User | null {
  const [h, p, s] = token.split('.')
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
      iat: number
      exp: number
    }
    if (!c.exp || c.exp * 1000 < Date.now() || c.exp - c.iat > RENDER_MAX) return null
    const u = getUser(db, c.sub)
    if (!u || u.disabled || !u.verified_at || u.session_version !== c.v) return null
    return u
  } catch {
    return null
  }
}

// --- Sessions ----------------------------------------------------------------------------

/**
 * Each sign-in is a row in `sessions`, named in the cookie by a random 256-bit id; the table
 * keeps only its SHA-256, so a copy of the database can't be used to sign in. A session ends
 * after IDLE hours without use (KEEP_DAYS with "Keep me signed in") and at most ABSOLUTE_DAYS
 * after it began, whichever comes first. Bumping users.session_version ends them all.
 */
export interface Session {
  id: string
  user_id: number
  version: number
  keep: number
  created_at: string
  seen_at: string
  expires_at: string
  ua: string
  ip: string
  country: string | null
  rotate: number
  confirmed_at: string | null
}
const IDLE_HOURS = SESSION_HOURS
const ABSOLUTE_DAYS = 30
/** How often last-seen is written, so a busy dashboard doesn't write on every request. */
const SEEN_EVERY = 60_000

export interface Client {
  ua: string
  ip: string
  country: string | null
}

const sessionId = (token: string) => hash(`session:${token}`)

export function createSession(
  db: DB,
  user: Pick<User, 'id' | 'session_version'>,
  keep: boolean,
  client: Client,
) {
  const token = randomBytes(32).toString('base64url')
  const at = now()
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(at)
  db.prepare(
    `INSERT INTO sessions (id, user_id, version, keep, created_at, seen_at, expires_at, ua, ip, country)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId(token),
    user.id,
    user.session_version,
    keep ? 1 : 0,
    at,
    at,
    new Date(Date.now() + ABSOLUTE_DAYS * 86400_000).toISOString(),
    client.ua.slice(0, 400),
    client.ip.slice(0, 64),
    client.country,
  )
  return { token, id: sessionId(token), maxAge: keep ? ABSOLUTE_DAYS * 86400 : undefined }
}

/** Seconds a session's cookie should live: until its absolute end with keep, else the browser's. */
export const cookieAge = (s: Pick<Session, 'keep' | 'expires_at'>) =>
  s.keep ? Math.max(0, Math.floor((Date.parse(s.expires_at) - Date.now()) / 1000)) : undefined

export const getSession = (db: DB, id: string) =>
  db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined

/**
 * The signed-in person for a cookie, or null for a missing, unknown, idle, expired or revoked
 * session. A render token (see signSession) comes back with session null.
 */
export function readSession(
  db: DB,
  token: string | undefined,
  client?: Client,
): { user: User; session: Session | null } | null {
  if (!token) return null
  if (token.includes('.')) {
    const user = readRenderToken(db, token)
    return user ? { user, session: null } : null
  }
  const s = getSession(db, sessionId(token))
  if (!s) return null
  const t = Date.now()
  const idle = (s.keep ? KEEP_DAYS * 24 : IDLE_HOURS) * 3600_000
  const user = getUser(db, s.user_id)
  if (
    t - Date.parse(s.seen_at) > idle ||
    t > Date.parse(s.expires_at) ||
    !user ||
    user.disabled ||
    !user.verified_at ||
    user.session_version !== s.version
  ) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id)
    return null
  }
  if (t - Date.parse(s.seen_at) > SEEN_EVERY) {
    s.seen_at = now()
    db.prepare(
      'UPDATE sessions SET seen_at = ?, ip = coalesce(?, ip), country = coalesce(?, country) WHERE id = ?',
    ).run(s.seen_at, client?.ip.slice(0, 64) ?? null, client?.country ?? null, s.id)
  }
  return { user, session: s }
}

/** A new id for the same session (after a change of role); the old id stops working. */
export function rotateSession(db: DB, s: Session) {
  const token = randomBytes(32).toString('base64url')
  db.prepare('UPDATE sessions SET id = ?, rotate = 0 WHERE id = ?').run(sessionId(token), s.id)
  return { token, id: sessionId(token) }
}

/** Every session of this person gets a new id on its next request. */
export const rotateSessions = (db: DB, userId: number) =>
  db.prepare('UPDATE sessions SET rotate = 1 WHERE user_id = ?').run(userId)

export const deleteSession = (db: DB, id: string) =>
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)

/** A person's sessions, newest use first. */
export const listSessions = (db: DB, userId: number) =>
  db
    .prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY seen_at DESC')
    .all(userId, now()) as unknown as Session[]

/** Whether this person already has a session from the same browser, to tell a new device. */
export const knownDevice = (db: DB, userId: number, ua: string) =>
  !!db.prepare('SELECT 1 FROM sessions WHERE user_id = ? AND ua = ?').get(userId, ua.slice(0, 400))

/** Browser and system from a user agent, for the devices list. */
export function device(ua: string) {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null
  return { browser, os }
}

/**
 * The cookie: `__Host-sm_session` over HTTPS (the tunnel), which browsers bind to this exact
 * host with Secure and Path=/; plain `sm_session` on http://127.0.0.1, where Secure can't be
 * set. Without maxAge it lasts until the browser closes.
 */
export const SESSION_COOKIE = 'sm_session'
export const cookieName = (secure: boolean) =>
  secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE
export function sessionCookie(token: string, secure: boolean, maxAge?: number) {
  return `${cookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Strict${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}${secure ? '; Secure' : ''}`
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
  if (s.includes('@'))
    throw new Error('A username is not an email. Leave it empty to sign in with your email.')
  if (!/^[a-z0-9._-]{3,32}$/i.test(s))
    throw new Error('A username is 3 to 32 letters, digits, dots, dashes or underscores.')
  return s
}
/** Whether another account already signs in with this username (case does not matter). */
export const usernameTaken = (db: DB, username: string, userId: number) =>
  !!db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(username, userId)

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
  if (x.super !== undefined) {
    db.prepare('UPDATE users SET super = ? WHERE id = ?').run(x.super ? 1 : 0, id)
    rotateSessions(db, id)
  }
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

/** Ends every session of a person: their sessions go and older render tokens stop working. */
export function endSessions(db: DB, id: number) {
  db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
}

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
  rotateSessions(db, userId)
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

/**
 * Issues a code (six digits, ten minutes) or a link secret; the database keeps only its hash.
 * Sign-in tickets are always codes; a reset is a code when asked for (newer requests) or a link.
 */
export function issue(db: DB, userId: number, purpose: Purpose, asCode = purpose === 'code') {
  db.prepare('DELETE FROM tokens WHERE (user_id = ? AND purpose = ?) OR expires_at < ?').run(
    userId,
    purpose,
    now(),
  )
  const id = randomBytes(16).toString('base64url')
  const secret = asCode
    ? String(randomInt(0, 1_000_000)).padStart(6, '0')
    : randomBytes(24).toString('base64url')
  const minutes = asCode ? CODE_MINUTES : purpose === 'reset' ? RESET_MINUTES : INVITE_HOURS * 60
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

/** Whether a secret is the one a token was issued with. */
const matches = (id: string, secret: string, t: TokenRow) =>
  timingSafeEqual(Buffer.from(hash(`${id}:${String(secret).trim()}`)), Buffer.from(t.secret_hash))

/** Uses up a one-time secret and returns its user; wrong guesses count toward a limit. */
export const consume = (db: DB, id: string, secret: string, purpose: Purpose, keep = false) =>
  spend(db, id, purpose, (t) => matches(id, secret, t), keep)

/**
 * A password code (the emailed six digits for a reset). Every failure reads the same, whether
 * the code is wrong, expired or was never sent, so it can't tell which accounts exist. With
 * keep, a right code stays usable for the second step that must follow.
 */
export function checkResetCode(db: DB, id: string, code: string, keep = false) {
  try {
    return spend(db, id, 'reset', (t) => matches(id, code, t), keep)
  } catch {
    throw new Error('That code is not right, or it has expired.')
  }
}

/** Counts one wrong try against a token, as a wrong code would. */
export function failToken(db: DB, id: string) {
  const t = db.prepare('SELECT tries FROM tokens WHERE id = ?').get(id) as
    { tries: number } | undefined
  if (!t) return
  if (t.tries + 1 >= MAX_TRIES) db.prepare('DELETE FROM tokens WHERE id = ?').run(id)
  else db.prepare('UPDATE tokens SET tries = tries + 1 WHERE id = ?').run(id)
}
export const dropToken = (db: DB, id: string) =>
  db.prepare('DELETE FROM tokens WHERE id = ?').run(id)

/** The account a reset code was sent to, to count wrong codes against it. */
export const resetOwner = (db: DB, id: string) =>
  db
    .prepare(
      "SELECT u.id, u.email FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.purpose = 'reset'",
    )
    .get(String(id)) as { id: number; email: string } | undefined

type Purpose = 'code' | 'invite' | 'reset'
interface TokenRow {
  user_id: number
  secret_hash: string
  tries: number
  expires_at: string
}
/**
 * A one-time token passes `check` (a code, or the sign-in ticket with an authenticator code,
 * passkey or recovery code): it is used up and its user returned. A failed check counts toward
 * MAX_TRIES, after which the token is gone. With keep, a passing token stays for one more step.
 */
export function spend(
  db: DB,
  id: string,
  purpose: Purpose,
  check: (t: TokenRow) => boolean,
  keep = false,
) {
  const t = db
    .prepare('SELECT * FROM tokens WHERE id = ? AND purpose = ?')
    .get(String(id), purpose) as TokenRow | undefined
  const expired =
    purpose === 'code'
      ? 'That code has expired. Sign in again.'
      : 'This link has expired. Ask for a new one.'
  if (!t || t.expires_at < now()) throw new Error(expired)
  if (!check(t)) {
    failToken(db, id)
    throw new Error(purpose === 'code' ? 'That code is not right.' : 'This link is not valid.')
  }
  if (!keep) db.prepare('DELETE FROM tokens WHERE id = ?').run(id)
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

/** The account a sign-in ticket belongs to, to count wrong codes against it. */
export const ticketOwner = (db: DB, ticket: string) =>
  db
    .prepare(
      "SELECT u.id, u.email FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.purpose = 'code'",
    )
    .get(String(ticket)) as { id: number; email: string } | undefined

/** Marks the password as just entered again in this session, for changes to signing in. */
export const confirmSession = (db: DB, id: string) =>
  db.prepare('UPDATE sessions SET confirmed_at = ? WHERE id = ?').run(now(), id)
