import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { createUser } from './auth.ts'
import * as tf from './two-factor.ts'

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors (SHA-1, 8 digits)', () => {
    const key = Buffer.from('12345678901234567890')
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ]
    for (const [time, code] of vectors) expect(tf.totp(key, tf.stepAt(time * 1000), 8)).toBe(code)
    expect(tf.fromBase32(tf.base32(key)).toString()).toBe('12345678901234567890')
    expect(tf.base32(key)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  })

  it('allows one step of drift and refuses a code used before', () => {
    const secret = tf.newTotpSecret()
    const at = Date.parse('2026-10-01T08:00:00Z')
    const code = (ms: number) => tf.totp(tf.fromBase32(secret), tf.stepAt(ms))
    expect(tf.matchTotp(secret, code(at - 30_000), -1, at)).toBe(tf.stepAt(at) - 1)
    expect(tf.matchTotp(secret, code(at + 30_000), -1, at)).toBe(tf.stepAt(at) + 1)
    expect(tf.matchTotp(secret, code(at - 90_000), -1, at)).toBeNull()
    expect(tf.matchTotp(secret, code(at), tf.stepAt(at), at)).toBeNull()
    expect(tf.matchTotp(secret, 'abcdef', -1, at)).toBeNull()
  })

  it('turns on with a right first code, and each code signs in once', () => {
    const db = openDb(':memory:')
    const u = createUser(db, { email: 't@example.com' })
    const secret = tf.newTotpSecret()
    const now = () => tf.totp(tf.fromBase32(secret), tf.stepAt())
    expect(tf.enableTotp(db, u.id, secret, 'abcdef')).toBe(false)
    expect(tf.hasSecondFactor(db, u.id)).toBe(false)
    expect(tf.enableTotp(db, u.id, secret, now())).toBe(true)
    expect(tf.hasSecondFactor(db, u.id)).toBe(true)
    // The setup code can't be used again to sign in.
    expect(tf.checkTotp(db, u.id, now())).toBe(false)
    tf.disableTotp(db, u.id)
    expect(tf.factors(db, u.id).totp).toBe(false)
    expect(tf.otpauthUri(secret, 'a b@example.com')).toBe(
      `otpauth://totp/SocialMonitor%3Aa%20b%40example.com?secret=${secret}&issuer=SocialMonitor&algorithm=SHA1&digits=6&period=30`,
    )
  })
})

describe('recovery codes', () => {
  it('makes ten, stores only hashes, and each works once', () => {
    const db = openDb(':memory:')
    const u = createUser(db, { email: 'r@example.com' })
    const codes = tf.newRecoveryCodes(db, u.id)
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    const stored = db.prepare('SELECT code_hash FROM recovery_codes').all() as {
      code_hash: string
    }[]
    expect(stored.some((r) => codes.some((c) => r.code_hash.includes(c.replace(/-/g, ''))))).toBe(
      false,
    )
    expect(tf.useRecoveryCode(db, u.id, codes[0]!.toUpperCase().replace(/-/g, ' '))).toBe(true)
    expect(tf.useRecoveryCode(db, u.id, codes[0]!)).toBe(false)
    expect(tf.recoveryLeft(db, u.id)).toBe(9)
    const other = createUser(db, { email: 'o@example.com' })
    expect(tf.useRecoveryCode(db, other.id, codes[1]!)).toBe(false)
    // New codes replace the old ones.
    tf.newRecoveryCodes(db, u.id)
    expect(tf.useRecoveryCode(db, u.id, codes[1]!)).toBe(false)
    expect(tf.recoveryLeft(db, u.id)).toBe(10)
  })
})
