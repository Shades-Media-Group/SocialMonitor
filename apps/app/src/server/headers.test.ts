import { describe, expect, it } from 'vitest'
import { API_CSP, baseHeaders, newNonce, pageCsp, withNonce } from './headers.ts'

const INDEX = `<!doctype html>
<html><head>
<script>try { document.documentElement.dataset.theme = 'dark' } catch {}</script>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-abc.css">
</head><body><div id="root"></div></body></html>`

describe('security headers', () => {
  it('puts the nonce on every script and style tag, once', () => {
    const html = withNonce(INDEX + '<style>a{}</style>', 'n0nce')
    expect(html.match(/<script nonce="n0nce"/g)).toHaveLength(2)
    expect(html).toContain('<style nonce="n0nce">')
    expect(withNonce(html, 'other')).toBe(html)
    expect(html).toContain('<link rel="stylesheet"')
  })

  it('makes a new nonce for every page', () => {
    const a = newNonce()
    expect(a).not.toBe(newNonce())
    expect(Buffer.from(a, 'base64')).toHaveLength(16)
  })

  it('lets the page run only its own scripts, and nothing frame it', () => {
    const csp = pageCsp('n0nce')
    expect(csp).toContain("script-src 'self' 'nonce-n0nce'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    for (const d of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "img-src 'self' data: blob:",
    ])
      expect(csp).toContain(d)
    expect(API_CSP).toContain("default-src 'none'")
  })

  it('sends HSTS only over HTTPS', () => {
    expect(baseHeaders(false)['strict-transport-security']).toBeUndefined()
    expect(baseHeaders(true)['strict-transport-security']).toBe(
      'max-age=15552000; includeSubDomains',
    )
    expect(baseHeaders(false)).toMatchObject({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    expect(baseHeaders(false)['permissions-policy']).toContain('camera=()')
  })
})
