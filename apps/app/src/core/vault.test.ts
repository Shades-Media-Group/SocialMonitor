import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import type { Store } from './vault.ts'
import { keyFromStore, listAccounts, revealPassword, saveAccount, vaultKeySource } from './vault.ts'

const OLD = 'ab'.repeat(32)
/** A secret store in memory; `broken` makes writes fail like a locked keychain. */
function memory(start: string | null = null, broken = false): Store & { value: string | null } {
  const s = {
    source: 'keychain' as const,
    value: start,
    read: () => s.value,
    write: (hex: string) => {
      if (broken) throw new Error('locked')
      s.value = hex
    },
  }
  return s
}
const oldFile = (content = OLD) => {
  const f = join(mkdtempSync(join(tmpdir(), 'sm-vault-')), 'vault.key')
  writeFileSync(f, content)
  return f
}

describe('the vault key', () => {
  it('moves an old data/vault.key into the secret store, then deletes it', () => {
    const store = memory()
    const file = oldFile()
    expect(keyFromStore(store, file, true)?.toString('hex')).toBe(OLD)
    expect(store.value).toBe(OLD)
    expect(existsSync(file)).toBe(false)
  })

  it('uses the key already in the store and leaves files alone', () => {
    const file = oldFile()
    expect(keyFromStore(memory('cd'.repeat(32)), file)?.toString('hex')).toBe('cd'.repeat(32))
    expect(readFileSync(file, 'utf8')).toBe(OLD)
  })

  it('makes a new key only when no accounts are saved yet', () => {
    const missing = join(tmpdir(), 'sm-vault-none', 'vault.key')
    expect(keyFromStore(memory(), missing, true)).toBeNull()
    const store = memory()
    expect(keyFromStore(store, missing, false)).toHaveLength(32)
    expect(store.value).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps the old file when the store can not hold the key', () => {
    const file = oldFile()
    expect(keyFromStore(memory(null, true), file, true)).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe(OLD)
  })

  it('encrypts saved accounts with the key from the environment', () => {
    process.env.SOCIALMONITOR_VAULT_KEY = 'ef'.repeat(32)
    const db = openDb(':memory:')
    const a = saveAccount(db, { network: 'tiktok', username: 'tavelo', password: 's3cret' })
    expect(listAccounts(db)).toEqual([{ ...a, has_password: true }])
    expect(revealPassword(db, a.id)).toBe('s3cret')
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'vault'").get() as {
      value: string
    }
    expect(raw.value).not.toContain('s3cret')
    expect(vaultKeySource()).toBe('env')
  })
})
