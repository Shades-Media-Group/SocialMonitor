import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db.ts'
import { addBrand } from './store.ts'
import { META_SCOPES, authorizeUrl, connection, finishSignIn } from './meta-api.ts'

const ORIGIN = 'http://127.0.0.1:4400'

beforeEach(() => {
  process.env.META_APP_ID = 'fixture-app'
  process.env.META_APP_SECRET = 'fixture-secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.META_APP_ID
  delete process.env.META_APP_SECRET
  delete process.env.META_LOGIN_CONFIG_ID
})

const params = (url: string) => new URL(url).searchParams

describe('the Facebook sign-in address', () => {
  it('asks for the scopes when no login configuration is set', () => {
    const q = params(authorizeUrl(1, ORIGIN))
    expect(q.get('scope')).toBe(META_SCOPES.join(','))
    expect(q.has('config_id')).toBe(false)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('client_id')).toBe('fixture-app')
  })

  it('sends the Facebook Login for Business configuration instead of the scopes', () => {
    process.env.META_LOGIN_CONFIG_ID = ' 123456789012345 '
    const url = authorizeUrl(1, ORIGIN)
    expect(url.startsWith('https://www.facebook.com/v23.0/dialog/oauth?')).toBe(true)
    const q = params(url)
    expect(q.get('config_id')).toBe('123456789012345')
    expect(q.has('scope')).toBe(false)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('client_id')).toBe('fixture-app')
    expect(q.get('redirect_uri')).toBe('https://socialmonitor.shades.md/connect/meta/')
    expect(q.get('state')).toMatch(/^[\w-]+\.[\w-]+$/)
  })

  it('ignores a blank configuration', () => {
    process.env.META_LOGIN_CONFIG_ID = '   '
    const q = params(authorizeUrl(1, ORIGIN))
    expect(q.has('config_id')).toBe(false)
    expect(q.get('scope')).toBe(META_SCOPES.join(','))
  })
})

describe('finishing the sign-in', () => {
  it('connects a Page with no Instagram when Meta refuses the Instagram field', async () => {
    process.env.META_LOGIN_CONFIG_ID = '123456789012345'
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Demo', ['https://www.facebook.com/DemoPage'])
    const state = params(authorizeUrl(brand.id, ORIGIN)).get('state')!
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(url)
        if (u.pathname.endsWith('/oauth/access_token'))
          return new Response(JSON.stringify({ access_token: 'fixture-person-token' }))
        const fields = u.searchParams.get('fields') ?? ''
        asked.push(fields)
        if (fields.includes('instagram_business_account'))
          return new Response(
            JSON.stringify({
              error: { message: '(#100) Tried accessing nonexisting field', code: 100 },
            }),
            { status: 400 },
          )
        return new Response(
          JSON.stringify({
            data: [
              {
                id: '100000000000009',
                name: 'Demo Page',
                username: 'demopage',
                link: 'https://www.facebook.com/DemoPage',
                access_token: 'fixture-page-token',
              },
            ],
          }),
        )
      }),
    )
    const r = await finishSignIn(db, 'fixture-code', state)
    expect(r).toEqual({ brandId: brand.id, page: 'Demo Page', instagram: null, error: null })
    expect(asked).toHaveLength(2)
    expect(asked[1]).not.toContain('instagram')
    const c = connection(db, brand.id)
    expect(c.facebook?.name).toBe('Demo Page')
    expect(c.instagram).toBeNull()
  })
})
