import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db.ts'
import { createUser } from './auth.ts'
import { listAudit } from './audit.ts'
import { securityEvent, signInFailed, signedIn } from './security-events.ts'

// Without SMTP_HOST, mail is printed to the console: that is what these tests read.
let printed: string[] = []
beforeEach(() => {
  delete process.env.SMTP_HOST
  printed = []
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => void printed.push(String(s)))
})
afterEach(() => vi.restoreAllMocks())
const to = () => printed.map((p) => /To: (\S+)/.exec(p)?.[1]).filter(Boolean)

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36'
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0'

function setup() {
  const db = openDb(':memory:')
  const ana = createUser(db, { email: 'ana@example.com', name: 'Ana', verified: true })
  const boss = createUser(db, { email: 'boss@example.com', super: true, verified: true })
  const other = createUser(db, { email: 'other@example.com', super: true, verified: true })
  return { db, ana, boss, other }
}
const at = (ip = '203.0.113.7', ua = MAC, country: string | null = 'MD') => ({
  ip,
  ua,
  country,
  keep: false,
})

describe('security events', () => {
  it('records the row and emails the person, with the type’s own audit event', async () => {
    const { db, ana } = setup()
    await securityEvent(db, {
      type: 'second_factor_added',
      userId: ana.id,
      ...at(),
      detail: { method: 'passkey' },
    })
    expect(to()).toEqual(['ana@example.com'])
    expect(printed[0]).toContain('A second factor was added')
    const row = listAudit(db, { brands: null }).rows[0]!
    expect(row).toMatchObject({
      event: 'security.second_factor_added',
      actor: ana.id,
      target: 'ana@example.com',
    })
    expect(JSON.parse(row.detail)).toEqual({ method: 'passkey', country: 'MD' })
  })

  it('alerts a sign-in from a new device or country, not the first one or a browser update', async () => {
    const { db, ana } = setup()
    await signedIn(db, { userId: ana.id, ...at() })
    expect(to()).toEqual([])
    await signedIn(db, {
      userId: ana.id,
      ...at('203.0.113.8', MAC.replace('141.0.0.0', '142.0.1.2')),
    })
    expect(to()).toEqual([])
    await signedIn(db, { userId: ana.id, ...at('198.51.100.1', WIN) })
    expect(to()).toEqual(['ana@example.com'])
    expect(printed[0]).toContain('New sign-in')
    printed = []
    await signedIn(db, { userId: ana.id, ...at('198.51.100.1', MAC, 'FR') })
    expect(to()).toEqual(['ana@example.com'])
    // Local sign-ins have no country; that is never "a new country".
    printed = []
    await signedIn(db, { userId: ana.id, ...at('127.0.0.1', MAC, null) })
    expect(to()).toEqual([])
    expect(listAudit(db, { brands: null, event: 'security.new_device' }).total).toBe(2)
  })

  it('alerts five failed sign-ins in a row once, and starts counting again after a good one', async () => {
    const { db, ana } = setup()
    const fail = () =>
      signInFailed(db, { userId: ana.id, email: ana.email, step: 'password', ...at() })
    for (let i = 0; i < 4; i++) await fail()
    expect(to()).toEqual([])
    await fail()
    expect(to()).toEqual(['ana@example.com'])
    expect(printed[0]).toContain('Five failed sign-ins')
    await fail()
    expect(to()).toHaveLength(1)
    await signedIn(db, { userId: ana.id, ...at() })
    for (let i = 0; i < 5; i++) await fail()
    expect(to()).toHaveLength(2)
    // Unknown accounts are logged without anyone to tell.
    await signInFailed(db, { userId: null, email: null, step: 'password', ...at() })
    expect(listAudit(db, { brands: null, event: 'signin.failed' }).total).toBe(12)
  })

  it('tells a new admin and every other super admin', async () => {
    const { db, ana, boss } = setup()
    await securityEvent(db, {
      type: 'new_admin',
      userId: ana.id,
      ...at(),
      detail: { byId: boss.id, by: 'Boss', brandId: 3, brand: 'Tavelo' },
    })
    expect(to().sort()).toEqual(['ana@example.com', 'boss@example.com', 'other@example.com'])
    expect(printed.find((p) => p.includes('To: ana@'))).toContain('You are now an admin')
    expect(printed.find((p) => p.includes('To: other@'))).toContain(
      'Boss made Ana an admin of Tavelo',
    )
    expect(listAudit(db, { brands: [3] }).rows[0]).toMatchObject({
      event: 'security.new_admin',
      actor: boss.id,
    })
  })

  it('never throws when mail fails', async () => {
    const { db, ana } = setup()
    process.env.SMTP_HOST = '127.0.0.1'
    process.env.SMTP_PORT = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      securityEvent(db, { type: 'password_changed', userId: ana.id, ...at() }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    delete process.env.SMTP_PORT
  })
})
