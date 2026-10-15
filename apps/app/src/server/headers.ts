import { randomBytes } from 'node:crypto'

/**
 * Security headers for every dashboard response. The page itself gets a strict CSP with a fresh
 * nonce per response: only its own scripts and styles run, pictures come from this computer
 * (data/media) or the networks' image servers (a connected TikTok's avatar), and nothing may
 * frame it. Everything else (the API, media, files) gets a CSP that allows nothing at all.
 */

/** The networks' picture servers, for the few pictures shown straight from them. */
const IMAGE_HOSTS = [
  'https://*.tiktokcdn.com',
  'https://*.tiktokcdn-us.com',
  'https://*.tiktokcdn-eu.com',
  'https://*.fbcdn.net',
  'https://*.cdninstagram.com',
]

export const newNonce = () => randomBytes(16).toString('base64')

export const pageCsp = (nonce: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: blob: ${IMAGE_HOSTS.join(' ')}`,
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

/** For everything that is not the page: JSON, media, downloads. */
export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/** Headers every response carries; HSTS only when it went out over HTTPS (the tunnel). */
export function baseHeaders(https: boolean): Record<string, string> {
  return {
    'content-security-policy': API_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()',
    'cross-origin-opener-policy': 'same-origin',
    'x-frame-options': 'DENY',
    ...(https ? { 'strict-transport-security': 'max-age=15552000; includeSubDomains' } : {}),
  }
}

/** The built index.html with the nonce on every script and style tag it holds. */
export const withNonce = (html: string, nonce: string) =>
  html.replace(/<(script|style)\b(?![^>]*\bnonce=)/gi, `<$1 nonce="${nonce}"`)
