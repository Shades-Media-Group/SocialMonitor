import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessConfig, allowedHosts, clientOf, gate, validAccessToken } from './access.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

function jwt(claims: Record<string, unknown>, kid = 'k1', key = privateKey, alg = 'RS256') {
  const body = `${b64({ alg, kid, typ: 'JWT' })}.${b64(claims)}`
  const sig = createSign('RSA-SHA256').update(body).sign(key).toString('base64url')
  return `${body}.${sig}`
}
/** A fetch that serves the given keys as the team's JWKS and counts calls. */
function certs(...keys: [string, typeof publicKey][]) {
  const f = vi.fn(async () =>
    Response.json({ keys: keys.map(([kid, k]) => ({ ...k.export({ format: 'jwk' }), kid })) }),
  )
  return f as unknown as typeof fetch & typeof f
}

const now = () => Math.floor(Date.now() / 1000)
const good = (team: string) => ({
  aud: ['aud-tag'],
  iss: `https://${team}`,
  exp: now() + 600,
  nbf: now() - 5,
})

afterEach(() => vi.useRealTimers())

describe('Cloudflare Access tokens', () => {
  it('accepts a token signed by the team, for this app, still valid', async () => {
    const team = 't1.cloudflareaccess.com'
    const config = { team, aud: 'aud-tag' }
    const f = certs(['k1', publicKey])
    expect(await validAccessToken(jwt(good(team)), config, f)).toBe(true)
    expect(f).toHaveBeenCalledWith(`https://${team}/cdn-cgi/access/certs`)
    // The keys are cached: a second token fetches nothing.
    expect(await validAccessToken(jwt(good(team)), config, f)).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('refuses wrong audience, issuer, expiry, nbf, algorithm and signer', async () => {
    const team = 't2.cloudflareaccess.com'
    const config = { team, aud: 'aud-tag' }
    const f = certs(['k1', publicKey])
    const bad = [
      jwt({ ...good(team), aud: 'someone-else' }),
      jwt({ ...good(team), iss: 'https://evil.cloudflareaccess.com' }),
      jwt({ ...good(team), exp: now() - 120 }),
      jwt({ ...good(team), exp: undefined }),
      jwt({ ...good(team), nbf: now() + 600 }),
      jwt(good(team), 'k1', privateKey, 'HS256'),
      jwt(good(team), 'k1', other.privateKey),
      jwt(good(team)).slice(0, -3) + 'abc',
      'not.a.token',
      '',
    ]
    for (const t of bad) expect(await validAccessToken(t, config, f)).toBe(false)
    expect(await validAccessToken(jwt(good(team)), null, f)).toBe(false)
  })

  it('fetches the keys again for an unknown key id, at most once a minute', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-15T10:00:00Z'), toFake: ['Date'] })
    const team = 't3.cloudflareaccess.com'
    const config = { team, aud: 'aud-tag' }
    const old = certs(['k1', publicKey])
    expect(await validAccessToken(jwt(good(team)), config, old)).toBe(true)
    // Cloudflare rotated to k2; a token signed with it arrives a few minutes later.
    vi.setSystemTime(Date.parse('2026-10-15T10:05:00Z'))
    const rotated = certs(['k1', publicKey], ['k2', other.publicKey])
    const t2 = jwt(good(team), 'k2', other.privateKey)
    expect(await validAccessToken(t2, config, rotated)).toBe(true)
    expect(rotated).toHaveBeenCalledTimes(1)
    // Made-up key ids can't make it fetch on every request.
    expect(await validAccessToken(jwt(good(team), 'k9'), config, rotated)).toBe(false)
    expect(rotated).toHaveBeenCalledTimes(1)
  })

  it('reads the team and audience from either name', () => {
    expect(accessConfig({ CF_ACCESS_TEAM: 'acme', CF_ACCESS_AUD: 'x' })).toEqual({
      team: 'acme.cloudflareaccess.com',
      aud: 'x',
    })
    expect(
      accessConfig({
        SOCIALMONITOR_ACCESS_TEAM: 'acme.cloudflareaccess.com',
        SOCIALMONITOR_ACCESS_AUD: 'y',
      }),
    ).toEqual({ team: 'acme.cloudflareaccess.com', aud: 'y' })
    expect(accessConfig({ CF_ACCESS_TEAM: 'acme' })).toBeNull()
  })
})

describe('the request gate', () => {
  const team = 'gate.cloudflareaccess.com'
  const env = {
    SOCIALMONITOR_PUBLIC_HOST: 'app.example.test',
    CF_ACCESS_TEAM: team,
    CF_ACCESS_AUD: 'aud-tag',
  }
  const req = (headers: Record<string, string>, peer = '127.0.0.1') => ({
    headers,
    socket: { remoteAddress: peer },
  })
  const f = certs(['k1', publicKey])

  it('answers only to its own names', async () => {
    expect([...allowedHosts(4400, { SOCIALMONITOR_UI: 'http://127.0.0.1:4400' })]).toEqual([
      '127.0.0.1:4400',
      'localhost:4400',
    ])
    expect(allowedHosts(4401, { ...env, SOCIALMONITOR_UI: 'http://127.0.0.1:4400' })).toEqual(
      new Set([
        '127.0.0.1:4401',
        'localhost:4401',
        '127.0.0.1:4400',
        'localhost:4400',
        'app.example.test',
      ]),
    )
    for (const host of ['evil.example', '127.0.0.1:9999', '', 'app.example.test.evil.example'])
      expect(await gate(req({ host }), 4400, env, f)).toMatchObject({ ok: false, status: 421 })
  })

  it('lets requests made on this computer through as local', async () => {
    for (const host of ['127.0.0.1:4400', 'localhost:4400'])
      expect(await gate(req({ host }), 4400, env, f)).toEqual({
        ok: true,
        local: true,
        access: false,
      })
    expect(await gate(req({ host: 'localhost:4400' }, '::1'), 4400, {}, f)).toMatchObject({
      ok: true,
      local: true,
    })
  })

  it('needs a valid Access token for anything that came through the tunnel', async () => {
    const token = jwt(good(team))
    const tunnel = { host: 'app.example.test', 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'abc' }
    expect(await gate(req(tunnel), 4400, env, f)).toMatchObject({ ok: false, status: 403 })
    expect(await gate(req({ ...tunnel, 'cf-access-jwt-assertion': token }), 4400, env, f)).toEqual({
      ok: true,
      local: false,
      access: true,
      tunnel: true,
    })
    // Tunnel signs on a local address: refused, even with a token.
    for (const sign of [{ 'cf-connecting-ip': '1.2.3.4' }, { 'cf-ray': 'abc' }] as Record<
      string,
      string
    >[])
      expect(
        await gate(
          req({ host: '127.0.0.1:4400', 'cf-access-jwt-assertion': token, ...sign }),
          4400,
          env,
          f,
        ),
      ).toMatchObject({ ok: false, status: 403 })
    // The public host without any Cloudflare header is still a tunnel request.
    expect(await gate(req({ host: 'app.example.test' }), 4400, env, f)).toMatchObject({ ok: false })
    // A peer other than this computer never counts as local.
    expect(await gate(req({ host: '127.0.0.1:4400' }, '10.0.0.5'), 4400, env, f)).toMatchObject({
      ok: false,
    })
  })

  it('without Access, lets the tunnel through to the sign-in, on the public host only', async () => {
    const bare = { SOCIALMONITOR_PUBLIC_HOST: 'app.example.test' }
    const r = req({ host: 'app.example.test', 'cf-ray': 'abc', 'cf-connecting-ip': '203.0.113.7' })
    expect(await gate(r, 4400, bare, f)).toEqual({
      ok: true,
      local: false,
      access: false,
      tunnel: true,
    })
    // Tunnel signs on a local name: still refused. A foreign name: 421.
    expect(await gate(req({ host: '127.0.0.1:4400', 'cf-ray': 'abc' }), 4400, bare, f)).toMatchObject(
      { ok: false, status: 403 },
    )
    expect(await gate(req({ host: 'evil.example', 'cf-ray': 'abc' }), 4400, bare, f)).toMatchObject({
      ok: false,
      status: 421,
    })
    // No public host set: nothing through the tunnel at all.
    expect(await gate(req({ host: '127.0.0.1:4400', 'cf-ray': 'abc' }), 4400, {}, f)).toMatchObject({
      ok: false,
      status: 403,
    })
  })
})

describe('the client address', () => {
  const cf = { 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'md' }

  it('believes Cloudflare only through the tunnel', () => {
    expect(clientOf(cf, '127.0.0.1', true)).toEqual({ ip: '203.0.113.7', country: 'MD' })
    expect(clientOf(cf, '127.0.0.1', false)).toEqual({ ip: '127.0.0.1', country: null })
    expect(clientOf(cf, '::ffff:127.0.0.1', false)).toEqual({ ip: '127.0.0.1', country: null })
    expect(clientOf(cf, undefined, false)).toEqual({ ip: '', country: null })
  })

  it('falls back to the socket when the header is missing or not an address', () => {
    expect(clientOf({}, '::1', true)).toEqual({ ip: '::1', country: null })
    expect(clientOf({ 'cf-connecting-ip': 'evil<x>', 'cf-ipcountry': 'XX' }, '::1', true)).toEqual({
      ip: '::1',
      country: null,
    })
  })
})
