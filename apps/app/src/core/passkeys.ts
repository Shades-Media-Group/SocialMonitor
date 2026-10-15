import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { DB } from './db.ts'
import { now } from './db.ts'

/**
 * Passkeys (WebAuthn) as the second step of signing in. A passkey belongs to one host name:
 * one made at http://localhost works only there, one made through the tunnel only there.
 * Browsers refuse passkeys on bare IP addresses, so http://127.0.0.1 can't use them.
 */
export interface Passkey {
  id: string
  user_id: number
  name: string
  public_key: string
  counter: number
  transports: string
  rp_id: string
  created_at: string
  last_used_at: string | null
}
export interface RelyingParty {
  rpID: string
  origin: string
}

/** The host passkeys are made for, from the page's origin; null on an IP address. */
export function relyingParty(origin: string | undefined): RelyingParty | null {
  try {
    const u = new URL(String(origin))
    if (/^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[')) return null
    return { rpID: u.hostname, origin: u.origin }
  } catch {
    return null
  }
}

/** Challenges waiting for their answer, five minutes each. */
const challenges = new Map<string, { challenge: string; at: number }>()
// ponytail: in memory; a restart in the middle of adding a passkey means pressing Add again.
const remember = (key: string, challenge: string) => {
  for (const [k, v] of challenges) if (Date.now() - v.at > 5 * 60_000) challenges.delete(k)
  challenges.set(key, { challenge, at: Date.now() })
}
const recall = (key: string) => {
  const c = challenges.get(key)
  return c && Date.now() - c.at <= 5 * 60_000 ? c.challenge : null
}

export const listPasskeys = (db: DB, userId: number) =>
  db
    .prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at')
    .all(userId) as unknown as Passkey[]

export const deletePasskey = (db: DB, userId: number, id: string) =>
  Number(
    db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId).changes,
  ) === 1

const parse = (s: string) => JSON.parse(s) as string[]

export async function registrationOptions(
  db: DB,
  user: { id: number; email: string; name: string },
  rp: RelyingParty,
) {
  const options = await generateRegistrationOptions({
    rpName: 'SocialMonitor',
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(`socialmonitor:${user.id}`),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: listPasskeys(db, user.id)
      .filter((p) => p.rp_id === rp.rpID)
      .map((p) => ({ id: p.id, transports: parse(p.transports) })),
  })
  remember(`reg:${user.id}`, options.challenge)
  return options
}

/** Checks the browser's answer and keeps the new passkey under the given name. */
export async function addPasskey(
  db: DB,
  userId: number,
  rp: RelyingParty,
  response: RegistrationResponseJSON,
  name: string,
) {
  const expectedChallenge = recall(`reg:${userId}`)
  if (!expectedChallenge) throw new Error('Adding the passkey took too long. Try again.')
  const r = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
  }).catch(() => ({ verified: false as const }))
  if (!r.verified) throw new Error('The passkey could not be checked. Try again.')
  challenges.delete(`reg:${userId}`)
  const c = r.registrationInfo.credential
  db.prepare(
    'INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, rp_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    c.id,
    userId,
    name.trim().slice(0, 60) || 'Passkey',
    Buffer.from(c.publicKey).toString('base64url'),
    c.counter,
    JSON.stringify(c.transports ?? []),
    rp.rpID,
    now(),
  )
  return c.id
}

/** Options to sign in with one of this person's passkeys for this host, or null if none. */
export async function authenticationOptions(
  db: DB,
  userId: number,
  rp: RelyingParty | null,
  key: string,
) {
  if (!rp) return null
  const mine = listPasskeys(db, userId).filter((p) => p.rp_id === rp.rpID)
  if (!mine.length) return null
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'preferred',
    allowCredentials: mine.map((p) => ({ id: p.id, transports: parse(p.transports) })),
  })
  remember(`auth:${key}`, options.challenge)
  return options
}

/** Whether the browser's answer proves one of this person's passkeys; the challenge is used up. */
export async function checkPasskey(
  db: DB,
  userId: number,
  rp: RelyingParty | null,
  key: string,
  response: AuthenticationResponseJSON,
) {
  const expectedChallenge = recall(`auth:${key}`)
  if (!rp || !expectedChallenge || typeof response?.id !== 'string') return false
  const p = db
    .prepare('SELECT * FROM passkeys WHERE id = ? AND user_id = ? AND rp_id = ?')
    .get(response.id, userId, rp.rpID) as Passkey | undefined
  if (!p) return false
  const r = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
    credential: {
      id: p.id,
      publicKey: Buffer.from(p.public_key, 'base64url'),
      counter: p.counter,
      transports: parse(p.transports),
    },
  }).catch(() => null)
  if (!r?.verified) return false
  challenges.delete(`auth:${key}`)
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(
    r.authenticationInfo.newCounter,
    now(),
    p.id,
  )
  return true
}
