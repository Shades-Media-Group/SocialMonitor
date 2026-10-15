import { createPublicKey, verify } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Remote access, for running the dashboard behind a Cloudflare Tunnel with Cloudflare Access in
 * front. Access checks who you are, and this checks Access: every request that came through the
 * tunnel must carry a valid Access token, or it is refused. Requests made on this computer pass.
 *
 *   SOCIALMONITOR_PUBLIC_HOST   the tunnel's hostname, e.g. socialmonitor-app.example.com
 *   CF_ACCESS_TEAM              the Zero Trust team, e.g. myteam (or myteam.cloudflareaccess.com)
 *   CF_ACCESS_AUD               the Access application's audience tag
 *
 * SOCIALMONITOR_ACCESS_TEAM and SOCIALMONITOR_ACCESS_AUD, the older names, still work.
 */
type Env = Record<string, string | undefined>
type Headers = Record<string, string | string[] | undefined>

export const publicHost = (env: Env = process.env) =>
  env.SOCIALMONITOR_PUBLIC_HOST?.trim().toLowerCase() || null

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const one = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.trim() || ''

/** The team's domain and the audience tag, or null when Access is not set up. */
export function accessConfig(env: Env = process.env) {
  const team = (env.CF_ACCESS_TEAM ?? env.SOCIALMONITOR_ACCESS_TEAM)?.trim().toLowerCase()
  const aud = (env.CF_ACCESS_AUD ?? env.SOCIALMONITOR_ACCESS_AUD)?.trim()
  if (!team || !aud) return null
  return { team: team.includes('.') ? team : `${team}.cloudflareaccess.com`, aud }
}

/** Signs that a request came through Cloudflare rather than from this computer. */
export const tunneled = (headers: Headers, peer: string | undefined, env: Env = process.env) =>
  !LOOPBACK.has(peer ?? '') ||
  !!headers['cf-connecting-ip'] ||
  !!headers['cf-ray'] ||
  !!headers['cf-access-jwt-assertion'] ||
  (!!publicHost(env) && one(headers.host).toLowerCase() === publicHost(env))

// --- Access tokens -----------------------------------------------------------------------

type Jwk = JsonWebKey & { kid: string }
const jwks = new Map<string, { keys: Jwk[]; at: number }>()

/** The team's signing keys, kept an hour; fetched again for an unknown key, at most once a minute. */
async function signingKey(team: string, kid: string, fetcher: typeof fetch) {
  const load = async () => {
    const r = await fetcher(`https://${team}/cdn-cgi/access/certs`)
    if (!r.ok) throw new Error('Could not load Cloudflare Access keys.')
    const keys = ((await r.json()) as { keys?: Jwk[] }).keys ?? []
    jwks.set(team, { keys, at: Date.now() })
    return keys
  }
  const cached = jwks.get(team)
  let keys = cached && Date.now() - cached.at < 3600_000 ? cached.keys : await load()
  if (!keys.some((k) => k.kid === kid) && Date.now() - (jwks.get(team)?.at ?? 0) > 60_000)
    keys = await load()
  return keys.find((k) => k.kid === kid)
}

const b64 = (s: string) => Buffer.from(s, 'base64url')
const SKEW = 30 // seconds of clock difference allowed on exp and nbf

/** Checks a Cf-Access-Jwt-Assertion: RS256 signature by the team's key, audience, issuer, exp and nbf. */
export async function validAccessToken(
  token: string | undefined,
  config: { team: string; aud: string } | null,
  fetcher: typeof fetch = fetch,
) {
  if (!token || !config) return false
  try {
    const [h, p, s] = token.split('.')
    if (!h || !p || !s) return false
    const header = JSON.parse(b64(h).toString('utf8')) as { kid?: string; alg?: string }
    if (header.alg !== 'RS256' || !header.kid) return false
    const jwk = await signingKey(config.team, header.kid, fetcher)
    if (!jwk) return false
    const key = createPublicKey({ key: jwk, format: 'jwk' })
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64(s))) return false
    const c = JSON.parse(b64(p).toString('utf8')) as {
      aud?: string | string[]
      iss?: string
      exp?: number
      nbf?: number
    }
    const t = Date.now() / 1000
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud]
    return (
      auds.includes(config.aud) &&
      c.iss === `https://${config.team}` &&
      typeof c.exp === 'number' &&
      c.exp + SKEW > t &&
      (c.nbf === undefined || c.nbf - SKEW <= t)
    )
  } catch {
    return false
  }
}

// --- The gate ------------------------------------------------------------------------------

export type Gate =
  | { ok: false; status: number; error: string }
  /** `local`: made on this computer. `access`: came through the tunnel with a valid Access token. */
  | { ok: true; local: boolean; access: boolean }

let warned = false

/**
 * Decides whether a request may go on, before any routing. A request from this computer with
 * no tunnel signs passes as local. Anything that came
 * through the tunnel passes only on the public hostname with a valid Access token; without
 * Access configured, it is refused (fail closed) and the log says why once.
 */
export async function gate(
  req: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } },
  _port: number,
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
): Promise<Gate> {
  const host = one(req.headers.host).toLowerCase()
  if (!tunneled(req.headers, req.socket.remoteAddress, env))
    return { ok: true, local: true, access: false }
  const config = accessConfig(env)
  if (!config) {
    if (!warned) {
      warned = true
      console.warn(
        'A request came through the tunnel, but Cloudflare Access is not set up: set CF_ACCESS_TEAM and CF_ACCESS_AUD. Tunnel requests are refused until then.',
      )
    }
    return { ok: false, status: 403, error: 'Remote access is not set up on this computer.' }
  }
  if (host !== publicHost(env))
    return { ok: false, status: 403, error: 'This dashboard only answers on this computer.' }
  return (await validAccessToken(one(req.headers['cf-access-jwt-assertion']), config, fetcher))
    ? { ok: true, local: false, access: true }
    : { ok: false, status: 403, error: 'Sign in through Cloudflare Access first.' }
}

/**
 * Whether the TCP peer is the tunnel: cloudflared on this computer, or an address named in
 * SOCIALMONITOR_TUNNEL_ADDRESSES (comma separated) when it runs elsewhere. Only then are
 * Cloudflare's headers about the visitor believed.
 */
export function trustedPeer(peer: string | undefined, env: Env = process.env) {
  const p = peer ?? ''
  if (LOOPBACK.has(p)) return true
  return (env.SOCIALMONITOR_TUNNEL_ADDRESSES ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .includes(p.replace(/^::ffff:/, ''))
}

/**
 * Who is asking, and from which country when Cloudflare says. cf-connecting-ip and cf-ipcountry
 * count only from a trusted peer; anyone else gets the socket's own address and no country.
 */
export function clientOf(
  headers: Headers,
  peer: string | undefined,
  env: Env = process.env,
): { ip: string; country: string | null } {
  const sock = (peer ?? '').replace(/^::ffff:/, '')
  if (!trustedPeer(peer, env)) return { ip: sock, country: null }
  const ip = one(headers['cf-connecting-ip'])
  const country = one(headers['cf-ipcountry']).toUpperCase()
  return {
    ip: /^[0-9a-f.:]{2,45}$/i.test(ip) ? ip : sock,
    country: /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null,
  }
}
