import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { DB } from './db.ts'
import { now } from './db.ts'

/**
 * The second step of signing in, besides the emailed code: an authenticator app (TOTP, RFC 6238)
 * and ten single-use recovery codes. Passkeys live in passkeys.ts.
 */

// --- TOTP ---------------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32(buf: Buffer) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
export function fromBase32(s: string) {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s.toUpperCase().replace(/[\s=-]/g, '')) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('Not base32.')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

const STEP = 30
/** The code for one 30-second step (RFC 4226's HOTP over the step number). */
export function totp(secret: Buffer, step: number, digits = 6) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const at = mac[mac.length - 1]! & 15
  const n = mac.readUInt32BE(at) & 0x7fffffff
  return String(n % 10 ** digits).padStart(digits, '0')
}
export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP)

export const newTotpSecret = () => base32(randomBytes(20))

export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`SocialMonitor:${account}`)}?secret=${secret}&issuer=SocialMonitor&algorithm=SHA1&digits=6&period=${STEP}`

/**
 * The step a code matches, allowing one step of clock drift either way, or null. A step at or
 * before `after` is refused, so a code works once.
 */
export function matchTotp(secret: string, code: string, after = -1, ms = Date.now()) {
  const c = String(code).replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return null
  const key = fromBase32(secret)
  const at = stepAt(ms)
  for (const step of [at - 1, at, at + 1]) {
    if (step <= after) continue
    if (timingSafeEqual(Buffer.from(totp(key, step)), Buffer.from(c))) return step
  }
  return null
}

/** Checks a person's authenticator code and uses it up. */
export function checkTotp(db: DB, userId: number, code: string) {
  const row = db.prepare('SELECT totp_secret, totp_step FROM users WHERE id = ?').get(userId) as
    { totp_secret: string | null; totp_step: number | null } | undefined
  if (!row?.totp_secret) return false
  const step = matchTotp(row.totp_secret, code, row.totp_step ?? -1)
  if (step === null) return false
  db.prepare('UPDATE users SET totp_step = ? WHERE id = ?').run(step, userId)
  return true
}

/** Turns the authenticator on once a first code from it matches. */
export function enableTotp(db: DB, userId: number, secret: string, code: string) {
  const step = matchTotp(secret, code)
  if (step === null) return false
  db.prepare('UPDATE users SET totp_secret = ?, totp_step = ? WHERE id = ?').run(
    secret,
    step,
    userId,
  )
  return true
}

export const disableTotp = (db: DB, userId: number) =>
  db.prepare('UPDATE users SET totp_secret = NULL, totp_step = NULL WHERE id = ?').run(userId)

// --- Recovery codes -----------------------------------------------------------------------

/** No 0/o, 1/l/i: easy to read off paper. 12 characters of 31 is about 59 bits each. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const RECOVERY_COUNT = 10
const codeHash = (userId: number, code: string) =>
  createHash('sha256')
    .update(`recovery:${userId}:${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`)
    .digest('hex')

/** Ten new codes, replacing any before; shown once, kept only as hashes. */
export function newRecoveryCodes(db: DB, userId: number) {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => {
    const s = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
  })
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId)
  const add = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)')
  for (const c of codes) add.run(userId, codeHash(userId, c))
  return codes
}

/** Uses up one recovery code; true when it was one of theirs and unused. */
export const useRecoveryCode = (db: DB, userId: number, code: string) =>
  Number(
    db
      .prepare(
        'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
      )
      .run(now(), userId, codeHash(userId, String(code))).changes,
  ) === 1

export const recoveryLeft = (db: DB, userId: number) =>
  (
    db
      .prepare('SELECT count(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
      .get(userId) as { n: number }
  ).n

export const dropRecoveryCodes = (db: DB, userId: number) =>
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId)

// --- What a person has --------------------------------------------------------------------

export function factors(db: DB, userId: number) {
  const totpOn = !!(
    db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId) as
      { totp_secret: string | null } | undefined
  )?.totp_secret
  const passkeys = (
    db.prepare('SELECT count(*) AS n FROM passkeys WHERE user_id = ?').get(userId) as { n: number }
  ).n
  return { totp: totpOn, passkeys, recovery: recoveryLeft(db, userId) }
}

/** An authenticator or a passkey: the account is protected by more than email. */
export const hasSecondFactor = (db: DB, userId: number) => {
  const f = factors(db, userId)
  return f.totp || f.passkeys > 0
}
