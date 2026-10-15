import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { createUser } from './auth.ts'
import * as pk from './passkeys.ts'
import { hasSecondFactor } from './two-factor.ts'

/** Just enough CBOR for an authenticator: maps, integers, byte and text strings. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255])
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)])
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  const entries = v instanceof Map ? [...v] : Object.entries(v as object)
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)]),
  ])
}

/** A software authenticator with one P-256 key, answering like a browser would. */
function authenticator(rp: pk.RelyingParty) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const id = randomBytes(16)
  const rpHash = createHash('sha256').update(rp.rpID).digest()
  let count = 0
  const client = (type: string, challenge: string, origin = rp.origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  const u32 = (n: number) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])
  return {
    id: id.toString('base64url'),
    register(challenge: string) {
      const cose = new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ])
      const authData = Buffer.concat([
        rpHash,
        Buffer.from([0x45]), // user present, verified, credential data included
        u32(count),
        Buffer.alloc(16),
        Buffer.from([0, id.length]),
        id,
        cbor(cose),
      ])
      return {
        id: id.toString('base64url'),
        rawId: id.toString('base64url'),
        type: 'public-key' as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: client('webauthn.create', challenge).toString('base64url'),
          attestationObject: cbor({ fmt: 'none', attStmt: {}, authData }).toString('base64url'),
          transports: ['internal' as const],
        },
      }
    },
    answer(challenge: string, origin?: string) {
      count += 1
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), u32(count)])
      const data = client('webauthn.get', challenge, origin)
      const signature = sign(
        'sha256',
        Buffer.concat([authData, createHash('sha256').update(data).digest()]),
        privateKey,
      )
      return {
        id: id.toString('base64url'),
        rawId: id.toString('base64url'),
        type: 'public-key' as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: data.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      }
    },
  }
}

describe('passkeys', () => {
  const rp = pk.relyingParty('http://localhost:4400')!

  it('work on host names only, never on bare IP addresses', () => {
    expect(rp).toEqual({ rpID: 'localhost', origin: 'http://localhost:4400' })
    expect(pk.relyingParty('http://127.0.0.1:4400')).toBeNull()
    expect(pk.relyingParty('https://sm.example.com')?.rpID).toBe('sm.example.com')
    expect(pk.relyingParty(undefined)).toBeNull()
  })

  it('register, then sign in once per challenge, only for their own person and host', async () => {
    const db = openDb(':memory:')
    const u = createUser(db, { email: 'p@example.com', name: 'P' })
    const other = createUser(db, { email: 'q@example.com' })
    const key = authenticator(rp)

    expect(await pk.authenticationOptions(db, u.id, rp, 't1')).toBeNull()
    const reg = await pk.registrationOptions(db, u, rp)
    expect(reg.rp.id).toBe('localhost')
    await pk.addPasskey(db, u.id, rp, key.register(reg.challenge), 'Laptop')
    expect(pk.listPasskeys(db, u.id)).toMatchObject([
      { id: key.id, name: 'Laptop', rp_id: 'localhost' },
    ])
    expect(hasSecondFactor(db, u.id)).toBe(true)
    // The same registration can't be replayed: its challenge is used up.
    await expect(
      pk.addPasskey(db, u.id, rp, key.register(reg.challenge), 'Again'),
    ).rejects.toThrow()

    const opts = (await pk.authenticationOptions(db, u.id, rp, 't1'))!
    expect(opts.allowCredentials?.map((c) => c.id)).toEqual([key.id])
    // Wrong origin, wrong person, wrong host: refused, and the challenge survives for a retry.
    expect(
      await pk.checkPasskey(db, u.id, rp, 't1', key.answer(opts.challenge, 'http://evil.test')),
    ).toBe(false)
    expect(await pk.checkPasskey(db, other.id, rp, 't1', key.answer(opts.challenge))).toBe(false)
    const tunnel = pk.relyingParty('https://sm.example.com')
    expect(await pk.checkPasskey(db, u.id, tunnel, 't1', key.answer(opts.challenge))).toBe(false)
    expect(await pk.checkPasskey(db, u.id, rp, 't1', key.answer(opts.challenge))).toBe(true)
    expect(pk.listPasskeys(db, u.id)[0]!.last_used_at).not.toBeNull()
    // Used once: the same challenge doesn't sign in again.
    expect(await pk.checkPasskey(db, u.id, rp, 't1', key.answer(opts.challenge))).toBe(false)

    expect(pk.deletePasskey(db, other.id, key.id)).toBe(false)
    expect(pk.deletePasskey(db, u.id, key.id)).toBe(true)
    expect(hasSecondFactor(db, u.id)).toBe(false)
  })
})
