import { describe, expect, it } from 'vitest'
import { clientOf, trustedPeer } from './access.ts'

const cf = { 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'md' }

describe('the client address', () => {
  it('believes Cloudflare only when the tunnel connects from this computer', () => {
    expect(clientOf(cf, '127.0.0.1', {})).toEqual({ ip: '203.0.113.7', country: 'MD' })
    expect(clientOf(cf, '::1', {})).toEqual({ ip: '203.0.113.7', country: 'MD' })
    expect(clientOf(cf, '::ffff:127.0.0.1', {})).toEqual({ ip: '203.0.113.7', country: 'MD' })
  })

  it('ignores the headers from anyone else and uses the socket address', () => {
    expect(clientOf(cf, '198.51.100.9', {})).toEqual({ ip: '198.51.100.9', country: null })
    expect(clientOf(cf, '::ffff:198.51.100.9', {})).toEqual({ ip: '198.51.100.9', country: null })
    expect(clientOf(cf, undefined, {})).toEqual({ ip: '', country: null })
  })

  it('trusts a tunnel address named in the environment', () => {
    const env = { SOCIALMONITOR_TUNNEL_ADDRESSES: '10.0.0.5, 10.0.0.6' }
    expect(trustedPeer('10.0.0.6', env)).toBe(true)
    expect(trustedPeer('::ffff:10.0.0.5', env)).toBe(true)
    expect(trustedPeer('10.0.0.7', env)).toBe(false)
    expect(clientOf(cf, '10.0.0.5', env).ip).toBe('203.0.113.7')
  })

  it('falls back to the socket when the header is missing or not an address', () => {
    expect(clientOf({}, '127.0.0.1', {})).toEqual({ ip: '127.0.0.1', country: null })
    expect(
      clientOf({ 'cf-connecting-ip': 'evil<script>', 'cf-ipcountry': 'XX' }, '::1', {}),
    ).toEqual({ ip: '::1', country: null })
  })
})
