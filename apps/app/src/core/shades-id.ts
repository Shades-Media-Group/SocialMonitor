import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'
import type { DB } from './db.ts'
import { now } from './db.ts'

/**
 * Shades login: signing in with the company's Shades ID (an OpenID Connect provider), for
 * @shades.md accounts. Authorization code with PKCE (S256), state and nonce; the ID token is
 * checked here with node:crypto (RS256, ES256 or EdDSA) against the issuer's published keys.
 *
 *   SHADES_ID_ISSUER          https://id.shades.md
 *   SHADES_ID_CLIENT_ID       socialmonitor
 *   SHADES_ID_CLIENT_SECRET   from Shades ID, kept in .env only
 *
 * With any of them empty, or without SOCIALMONITOR_PUBLIC_HOST (the redirect URI is built from
 * it, never from a request), Shades login does not exist: no link, and its routes answer 404.
 * Nothing here logs a code, a token or the secret.
 */
type Env = Record<string, string | undefined>

export interface ShadesConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Where Shades ID sends the browser after signing out there. */
  afterLogout: string
}

export function shadesConfig(env: Env = process.env): ShadesConfig | null {
  const issuer = env.SHADES_ID_ISSUER?.trim().replace(/\/+$/, '')
  const clientId = env.SHADES_ID_CLIENT_ID?.trim()
  const clientSecret = env.SHADES_ID_CLIENT_SECRET?.trim()
  const host = env.SOCIALMONITOR_PUBLIC_HOST?.trim().toLowerCase()
  if (!issuer || !clientId || !clientSecret || !host) return null
  try {
    if (new URL(issuer).protocol !== 'https:') return null
  } catch {
    return null
  }
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri: `https://${host}/api/auth/shades/callback`,
    afterLogout: `https://${host}/`,
  }
}

/** Why a Shades login was refused: each code has its own sentence on the sign-in screen. */
export type ShadesFailure =
  | 'failed'
  | 'expired'
  | 'unavailable'
  | 'cancelled'
  | 'domain'
  | 'unverified'
  | 'blocked'
  | 'conflict'
  | 'rate'

export class ShadesError extends Error {
  code: ShadesFailure
  /** The account it was about, once the ID token proved it. */
  email: string | null
  constructor(code: ShadesFailure, reason: string, email: string | null = null) {
    super(reason)
    this.code = code
    this.email = email
  }
}

// --- Discovery and keys --------------------------------------------------------------------

export interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint?: string
  token_endpoint_auth_methods_supported?: string[]
  code_challenge_methods_supported?: string[]
}

const TIMEOUT = 5000
const HOUR = 3600_000
const discoveries = new Map<string, { doc: Discovery; at: number }>()
type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string }
const keySets = new Map<string, { keys: Jwk[]; at: number }>()

/** Forgets cached discovery documents and keys (tests, or after the issuer rotates everything). */
export function resetShadesCache() {
  discoveries.clear()
  keySets.clear()
  pending.clear()
  handoffs.clear()
}

async function getJson(url: string, fetcher: typeof fetch, what: string) {
  let r: Response
  try {
    r = await fetcher(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch {
    throw new ShadesError('unavailable', `${what} could not be reached`)
  }
  if (!r.ok) throw new ShadesError('unavailable', `${what} answered ${r.status}`)
  try {
    return (await r.json()) as unknown
  } catch {
    throw new ShadesError('unavailable', `${what} is not JSON`)
  }
}

/** Every endpoint must be HTTPS on the issuer's own origin, so the browser and the code go nowhere else. */
const onIssuer = (cfg: ShadesConfig, url: unknown) => {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.origin === new URL(cfg.issuer).origin
  } catch {
    return false
  }
}

/**
 * The issuer's discovery document, kept an hour. Refused when it names another issuer, when an
 * endpoint is on another origin, or when it says it can't do S256.
 */
export async function discover(cfg: ShadesConfig, fetcher: typeof fetch = fetch) {
  const cached = discoveries.get(cfg.issuer)
  if (cached && Date.now() - cached.at < HOUR) return cached.doc
  const doc = (await getJson(
    `${cfg.issuer}/.well-known/openid-configuration`,
    fetcher,
    'Discovery',
  )) as Partial<Discovery> | null
  if (!doc || typeof doc !== 'object') throw new ShadesError('unavailable', 'Discovery is empty')
  if (String(doc.issuer ?? '').replace(/\/+$/, '') !== cfg.issuer)
    throw new ShadesError('unavailable', 'Discovery names another issuer')
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
    if (!onIssuer(cfg, doc[k]))
      throw new ShadesError('unavailable', `Discovery ${k} is not on the issuer`)
  if (doc.end_session_endpoint !== undefined && !onIssuer(cfg, doc.end_session_endpoint))
    throw new ShadesError('unavailable', 'Discovery end_session_endpoint is not on the issuer')
  const pkce = doc.code_challenge_methods_supported
  if (Array.isArray(pkce) && !pkce.includes('S256'))
    throw new ShadesError('unavailable', 'Discovery does not offer S256')
  discoveries.set(cfg.issuer, { doc: doc as Discovery, at: Date.now() })
  return doc as Discovery
}

/** The issuer's keys, kept an hour; fetched again for an unknown key id, at most once a minute. */
async function signingKeys(doc: Discovery, kid: string | undefined, fetcher: typeof fetch) {
  const load = async () => {
    const set = (await getJson(doc.jwks_uri, fetcher, 'The key set')) as { keys?: unknown }
    const keys = Array.isArray(set?.keys) ? (set.keys as Jwk[]) : []
    keySets.set(doc.jwks_uri, { keys, at: Date.now() })
    return keys
  }
  const cached = keySets.get(doc.jwks_uri)
  let keys = cached && Date.now() - cached.at < HOUR ? cached.keys : await load()
  const known = (ks: Jwk[]) => !kid || ks.some((k) => k.kid === kid)
  if (!known(keys) && Date.now() - (keySets.get(doc.jwks_uri)?.at ?? 0) > 60_000)
    keys = await load()
  return keys
}

// --- The ID token --------------------------------------------------------------------------

/** What each accepted algorithm needs from the key, and how node:crypto checks it. */
const ALGS = {
  RS256: { kty: 'RSA', crv: undefined, digest: 'sha256', p1363: false },
  ES256: { kty: 'EC', crv: 'P-256', digest: 'sha256', p1363: true },
  EdDSA: { kty: 'OKP', crv: 'Ed25519', digest: null, p1363: false },
} as const
type Alg = keyof typeof ALGS

export interface IdClaims {
  iss: string
  sub: string
  aud: string | string[]
  azp?: string
  exp: number
  iat: number
  nbf?: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  amr?: string[]
  acr?: string
}

const SKEW = 60 // seconds of clock difference allowed
/** An ID token is made at the token exchange; one older than this was not made for this sign-in. */
const MAX_AGE = 600
const b64 = (s: string) => Buffer.from(s, 'base64url')
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * Checks an ID token: the signature by one of the issuer's keys (RS256, ES256 or EdDSA; never
 * none or HMAC), the issuer, the audience (and azp), exp, iat and nbf with a minute of skew, and
 * the nonce of this sign-in. The email checks come after, in checkAccount.
 */
export async function verifyIdToken(
  token: string,
  doc: Discovery,
  cfg: ShadesConfig,
  nonce: string,
  fetcher: typeof fetch = fetch,
  at = Date.now(),
): Promise<IdClaims> {
  const fail = (reason: string) => new ShadesError('failed', reason)
  const parts = token.split('.')
  if (parts.length !== 3) throw fail('the ID token is not a JWS')
  const [h, p, s] = parts as [string, string, string]
  let header: { alg?: string; kid?: string; crit?: unknown }
  let c: IdClaims
  try {
    header = JSON.parse(b64(h).toString('utf8')) as typeof header
    c = JSON.parse(b64(p).toString('utf8')) as IdClaims
  } catch {
    throw fail('the ID token is not JSON')
  }
  if (!header || !c || typeof c !== 'object') throw fail('the ID token is empty')
  if (header.crit !== undefined) throw fail('the ID token has critical headers')
  const alg = header.alg as Alg
  const spec = Object.hasOwn(ALGS, String(header.alg)) ? ALGS[alg] : null
  if (!spec) throw fail(`the ID token algorithm ${String(header.alg)} is not accepted`)
  const keys = (await signingKeys(doc, header.kid, fetcher)).filter(
    (k) =>
      k.kty === spec.kty &&
      (spec.crv === undefined || k.crv === spec.crv) &&
      (!k.alg || k.alg === alg) &&
      (!k.use || k.use === 'sig') &&
      (!header.kid || k.kid === header.kid),
  )
  if (!keys.length) throw fail('no key of the issuer matches the ID token')
  const data = Buffer.from(`${h}.${p}`)
  const sig = b64(s)
  const good = keys.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' })
      return verify(spec.digest, data, spec.p1363 ? { key, dsaEncoding: 'ieee-p1363' } : key, sig)
    } catch {
      return false
    }
  })
  if (!good) throw fail('the ID token signature is wrong')
  const t = at / 1000
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud]
  if (c.iss !== doc.issuer) throw fail('the ID token names another issuer')
  if (!auds.includes(cfg.clientId)) throw fail('the ID token is for another client')
  if ((auds.length > 1 || c.azp !== undefined) && c.azp !== cfg.clientId)
    throw fail('the ID token azp is not this client')
  if (typeof c.exp !== 'number' || c.exp + SKEW <= t) throw fail('the ID token has expired')
  if (typeof c.iat !== 'number' || c.iat - SKEW > t || t - c.iat > MAX_AGE + SKEW)
    throw fail('the ID token iat is out of range')
  if (c.nbf !== undefined && (typeof c.nbf !== 'number' || c.nbf - SKEW > t))
    throw fail('the ID token is not valid yet')
  if (typeof c.nonce !== 'string' || !same(c.nonce, nonce))
    throw fail('the ID token nonce is wrong')
  if (typeof c.sub !== 'string' || !c.sub) throw fail('the ID token has no subject')
  return c
}

/** A @shades.md address, exactly: one @, then that domain and nothing after it. */
export const shadesEmail = (email: unknown) =>
  typeof email === 'string' && /^[^\s@]+@shades\.md$/i.test(email.trim())

/**
 * Whether Shades ID did its own second step for this sign-in. Shades ID always sends amr with
 * "mfa" (plus "pwd", "otp" or "hwk") and acr "urn:shades:id:mfa"; only "mfa" in amr counts.
 * Without it, SocialMonitor asks for its own second step, as after a password.
 */
export const provesSecondStep = (c: Pick<IdClaims, 'amr' | 'acr'>) =>
  Array.isArray(c.amr) && c.amr.includes('mfa')

// --- One sign-in at a time -------------------------------------------------------------------

/** A Shades login on its way: kept here, named in the browser by its state, ten minutes, used once. */
interface Pending {
  nonce: string
  verifier: string
  keep: boolean
  at: number
}
const pending = new Map<string, Pending>()
export const STATE_MINUTES = 10
const MAX_PENDING = 1000
export const STATE_COOKIE = '__Host-sm_shades'

/** The state cookie: HTTPS only, this host only, sent back on Shades ID's redirect (Lax). */
export const stateCookie = (state: string, maxAge = STATE_MINUTES * 60) =>
  `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`

const prune = () => {
  const cutoff = Date.now() - STATE_MINUTES * 60_000
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k)
  // A flood of starts can't grow memory without bound: the oldest go first.
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
}

/** The address to send the browser to, and the state for its cookie. */
export async function startLogin(cfg: ShadesConfig, keep: boolean, fetcher: typeof fetch = fetch) {
  const doc = await discover(cfg, fetcher)
  prune()
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  pending.set(state, { nonce, verifier, keep, at: Date.now() })
  const url = new URL(doc.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString()
  return { url: url.toString(), state }
}

/** Takes the sign-in a state belongs to, once; the cookie must name the same state. */
export function takePending(state: string, cookie: string | undefined) {
  const p = state ? pending.get(state) : undefined
  if (state) pending.delete(state)
  // No cookie: it lasted ten minutes, so the sign-in took too long (or began somewhere else).
  if (!cookie) throw new ShadesError('expired', 'the state cookie is gone')
  if (!state || !same(state, cookie)) throw new ShadesError('failed', 'the state is wrong')
  if (!p || Date.now() - p.at > STATE_MINUTES * 60_000)
    throw new ShadesError('expired', 'the sign-in took too long')
  return p
}

/**
 * Trades the code for tokens at the token endpoint, with the client secret in the Authorization
 * header (client_secret_basic), or in the body when discovery offers only client_secret_post.
 */
export async function exchangeCode(
  cfg: ShadesConfig,
  doc: Discovery,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
) {
  const methods = doc.token_endpoint_auth_methods_supported
  const post =
    Array.isArray(methods) &&
    !methods.includes('client_secret_basic') &&
    methods.includes('client_secret_post')
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  })
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (post) {
    form.set('client_id', cfg.clientId)
    form.set('client_secret', cfg.clientSecret)
  } else {
    // RFC 6749 2.3.1: each part form-encoded before the base64.
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+')
    headers.authorization = `Basic ${Buffer.from(`${enc(cfg.clientId)}:${enc(cfg.clientSecret)}`).toString('base64')}`
  }
  let r: Response
  try {
    r = await fetcher(doc.token_endpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch {
    throw new ShadesError('unavailable', 'the token endpoint could not be reached')
  }
  // The body may hold tokens or the issuer's words about the code: never logged, only the status.
  if (!r.ok) throw new ShadesError('failed', `the token endpoint answered ${r.status}`)
  const out = (await r.json().catch(() => null)) as { id_token?: unknown } | null
  if (typeof out?.id_token !== 'string') throw new ShadesError('failed', 'no ID token came back')
  return out.id_token
}

// --- The account -----------------------------------------------------------------------------

interface Linked {
  id: number
  email: string
  disabled: number
  verified_at: string | null
  shades_sub: string | null
}
const byEmail = (db: DB, email: string) =>
  db
    .prepare(
      'SELECT id, email, disabled, verified_at, shades_sub FROM users WHERE lower(email) = lower(?)',
    )
    .get(email.trim()) as Linked | undefined
const bySub = (db: DB, sub: string) =>
  db
    .prepare('SELECT id, email, disabled, verified_at, shades_sub FROM users WHERE shades_sub = ?')
    .get(sub) as Linked | undefined

/**
 * The person an ID token names: first by its subject (linked at their first Shades login), then
 * by email for that first link. Someone new gets an account with no password, no brands and no
 * super admin role: signed in, and waiting for a super admin to give them access. An email already
 * linked to another Shades subject is refused, and so is a blocked account.
 */
export function checkAccount(
  db: DB,
  c: IdClaims,
  create: (input: { email: string; name: string }) => { id: number },
) {
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : ''
  if (!shadesEmail(email))
    throw new ShadesError('domain', 'the email is not @shades.md', email || null)
  if (c.email_verified !== true)
    throw new ShadesError('unverified', 'the email is not verified', email)
  let user = bySub(db, c.sub)
  let created = false
  if (!user) {
    const match = byEmail(db, email)
    if (match?.shades_sub && match.shades_sub !== c.sub)
      throw new ShadesError('conflict', 'the email is linked to another Shades account', email)
    if (match) user = match
    else {
      const name = String(c.name ?? c.preferred_username ?? '').trim()
      user = {
        ...create({ email, name }),
        email,
        disabled: 0,
        verified_at: now(),
        shades_sub: null,
      }
      created = true
    }
    db.prepare('UPDATE users SET shades_sub = ? WHERE id = ?').run(c.sub, user.id)
  }
  if (user.disabled) throw new ShadesError('blocked', 'the account is blocked', user.email)
  // Shades ID proved the address, as an emailed code or link would: an open invitation is done.
  if (!user.verified_at)
    db.prepare('UPDATE users SET verified_at = ? WHERE id = ? AND verified_at IS NULL').run(
      now(),
      user.id,
    )
  return { userId: user.id, created }
}

// --- Sessions and signing out -----------------------------------------------------------------

/** Keeps the ID token with the session, server-side, for signing out at Shades ID later. */
export const keepIdToken = (db: DB, sessionId: string, idToken: string) =>
  db.prepare('UPDATE sessions SET shades_id_token = ? WHERE id = ?').run(idToken, sessionId)

/** Whether a session came from Shades ID, and whether Shades ID did the second step. */
export function shadesSession(db: DB, sessionId: string | undefined) {
  if (!sessionId) return null
  const row = db
    .prepare('SELECT shades_id_token AS t FROM sessions WHERE id = ?')
    .get(sessionId) as { t: string | null } | undefined
  if (!row?.t) return null
  try {
    const c = JSON.parse(b64(row.t.split('.')[1] ?? '').toString('utf8')) as IdClaims
    return { idToken: row.t, mfa: provesSecondStep(c) }
  } catch {
    return { idToken: row.t, mfa: false }
  }
}

/** Shades ID's sign-out address for a session that came from it, or null (none, or unreachable). */
export async function logoutUrl(
  cfg: ShadesConfig | null,
  idToken: string,
  fetcher: typeof fetch = fetch,
) {
  if (!cfg) return null
  try {
    const doc = await discover(cfg, fetcher)
    if (!doc.end_session_endpoint) return null
    const url = new URL(doc.end_session_endpoint)
    url.search = new URLSearchParams({
      id_token_hint: idToken,
      post_logout_redirect_uri: cfg.afterLogout,
      client_id: cfg.clientId,
    }).toString()
    return url.toString()
  } catch {
    return null
  }
}

/**
 * A Shades login without Shades ID's second step waits for SocialMonitor's own: the sign-in
 * ticket's answer (what /api/auth/login would have said) is kept here for the page to pick up,
 * and the ID token until the ticket is used. Ten minutes, once.
 */
interface Handoff {
  reply: Record<string, unknown> | null
  idToken: string
  at: number
}
const handoffs = new Map<string, Handoff>()
const fresh = (h: Handoff | undefined) =>
  h && Date.now() - h.at < STATE_MINUTES * 60_000 ? h : undefined

export function holdTicket(ticket: string, reply: Record<string, unknown>, idToken: string) {
  for (const [k, v] of handoffs) if (!fresh(v)) handoffs.delete(k)
  while (handoffs.size >= MAX_PENDING) handoffs.delete(handoffs.keys().next().value!)
  handoffs.set(ticket, { reply, idToken, at: Date.now() })
}
/** The ticket's answer for the page, once. */
export function ticketReply(ticket: string) {
  const h = fresh(handoffs.get(ticket))
  if (!h?.reply) return null
  const reply = h.reply
  h.reply = null
  return reply
}
/** After the second step: the session gets the ID token the ticket was waiting with. */
export function ticketUsed(db: DB, ticket: string, sessionId: string | undefined) {
  const h = fresh(handoffs.get(ticket))
  handoffs.delete(ticket)
  if (h && sessionId) keepIdToken(db, sessionId, h.idToken)
}
/** A new code for the same sign-in has a new ticket; the ID token moves with it. */
export function ticketMoved(from: string, to: string) {
  const h = fresh(handoffs.get(from))
  handoffs.delete(from)
  if (h) handoffs.set(to, { ...h, reply: null })
}
