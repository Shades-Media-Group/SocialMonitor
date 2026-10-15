import { createPublicKey, verify } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Remote access, for running the dashboard behind a Cloudflare Tunnel. The dashboard has no
 * login of its own, so requests that do not come from this computer are accepted only with a
 * valid Cloudflare Access token: Access checks who you are, and this checks Access.
 *
 *   SOCIALMONITOR_PUBLIC_HOST   the tunnel's hostname, e.g. socialmonitor-app.example.com
 *   SOCIALMONITOR_ACCESS_TEAM   the Zero Trust team domain, e.g. myteam.cloudflareaccess.com
 *   SOCIALMONITOR_ACCESS_AUD    the Access application's audience tag
 *   SOCIALMONITOR_TUNNEL_ADDRESSES  only when cloudflared runs on another machine: its addresses
 */
const LOCAL = /^(127\.0\.0\.1|localhost)(:\d+)?$/

export const publicHost = () => process.env.SOCIALMONITOR_PUBLIC_HOST?.trim().toLowerCase() || null

/** True when the request was made on this computer, not through the tunnel. */
export function isLocal(req: IncomingMessage) {
  return LOCAL.test(req.headers.host ?? '') && !req.headers['cf-connecting-ip']
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const one = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.trim() || ''

/**
 * Whether the TCP peer is the tunnel: cloudflared on this computer, or an address named in
 * SOCIALMONITOR_TUNNEL_ADDRESSES (comma separated) when it runs elsewhere. Only then are
 * Cloudflare's headers about the visitor believed.
 */
export function trustedPeer(peer: string | undefined, env = process.env) {
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
  headers: Record<string, string | string[] | undefined>,
  peer: string | undefined,
  env = process.env,
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

let certs: { keys: (JsonWebKey & { kid: string })[]; at: number } | null = null
async function signingKeys(team: string) {
  if (!certs || Date.now() - certs.at > 3600_000) {
    const r = await fetch(`https://${team}/cdn-cgi/access/certs`)
    if (!r.ok) throw new Error('Could not load Cloudflare Access keys.')
    certs = {
      keys: ((await r.json()) as { keys: (JsonWebKey & { kid: string })[] }).keys,
      at: Date.now(),
    }
  }
  return certs.keys
}

const b64 = (s: string) => Buffer.from(s, 'base64url')

/** Checks the Cf-Access-Jwt-Assertion header: RS256 signature, audience, issuer and expiry. */
async function validAccessToken(token: string | undefined) {
  const team = process.env.SOCIALMONITOR_ACCESS_TEAM?.trim()
  const aud = process.env.SOCIALMONITOR_ACCESS_AUD?.trim()
  if (!token || !team || !aud) return false
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) return false
  const header = JSON.parse(b64(h).toString('utf8')) as { kid?: string; alg?: string }
  if (header.alg !== 'RS256') return false
  const jwk = (await signingKeys(team)).find((k) => k.kid === header.kid)
  if (!jwk) return false
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    b64(s),
  )
  if (!ok) return false
  const claims = JSON.parse(b64(p).toString('utf8')) as {
    aud?: string | string[]
    iss?: string
    exp?: number
  }
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  return (
    auds.includes(aud) &&
    claims.iss === `https://${team}` &&
    !!claims.exp &&
    claims.exp * 1000 > Date.now()
  )
}

/** Null when the request may proceed; otherwise why it is refused. */
export async function refuseRemote(req: IncomingMessage): Promise<string | null> {
  if (isLocal(req)) return null
  const host = publicHost()
  if (!host || (req.headers.host ?? '').toLowerCase() !== host)
    return 'This dashboard only answers on this computer.'
  const token = req.headers['cf-access-jwt-assertion']
  return (await validAccessToken(Array.isArray(token) ? token[0] : token).catch(() => false))
    ? null
    : 'Sign in through Cloudflare Access first.'
}
