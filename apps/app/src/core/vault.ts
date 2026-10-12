import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR } from './db.ts'
import { getSetting, setSetting } from './store.ts'

/**
 * Account details kept for the user's own reference: usernames, passwords and notes for the
 * networks. The app never logs in with them. They are encrypted with AES-256-GCM; the key lives
 * in the macOS Keychain (or, elsewhere, in data/vault.key readable only by the user). Passwords
 * never appear in exports, reports, JSON views, the MCP server or anything sent to an AI.
 */
export interface Account {
  id: string
  network: string
  username: string
  password: string
  note: string
}
export type AccountView = Omit<Account, 'password'> & { has_password: boolean }

const SERVICE = 'SocialMonitor'
const KEY_FILE = join(DATA_DIR, 'vault.key')

function key(): Buffer {
  if (process.platform === 'darwin') {
    try {
      return Buffer.from(
        execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', 'vault', '-w'], {
          encoding: 'utf8',
        }).trim(),
        'hex',
      )
    } catch {
      const k = randomBytes(32)
      execFileSync('security', [
        'add-generic-password',
        '-s',
        SERVICE,
        '-a',
        'vault',
        '-w',
        k.toString('hex'),
        '-U',
      ])
      return k
    }
  }
  if (!existsSync(KEY_FILE)) {
    writeFileSync(KEY_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
    chmodSync(KEY_FILE, 0o600)
  }
  return Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex')
}

function load(db: DB): Account[] {
  const raw = getSetting(db, 'vault')
  if (!raw) return []
  const buf = Buffer.from(raw, 'base64')
  const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'),
  ) as Account[]
}

function save(db: DB, list: Account[]) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([c.update(JSON.stringify(list), 'utf8'), c.final()])
  setSetting(db, 'vault', Buffer.concat([iv, c.getAuthTag(), body]).toString('base64'))
}

const view = ({ password, ...a }: Account): AccountView => ({ ...a, has_password: !!password })

export const listAccounts = (db: DB) => load(db).map(view)

/** Adds or updates an account. An empty password on update keeps the stored one. */
export function saveAccount(db: DB, input: Partial<Account>): AccountView {
  const list = load(db)
  const network = String(input.network ?? '')
    .trim()
    .slice(0, 40)
  const username = String(input.username ?? '')
    .trim()
    .slice(0, 200)
  if (!network || !username) throw new Error('An account needs a network and a username.')
  const old = input.id ? list.find((a) => a.id === input.id) : undefined
  const next: Account = {
    id: old?.id ?? randomUUID(),
    network,
    username,
    password: input.password ? String(input.password).slice(0, 500) : (old?.password ?? ''),
    note: String(input.note ?? old?.note ?? '').slice(0, 500),
  }
  save(db, old ? list.map((a) => (a.id === old.id ? next : a)) : [...list, next])
  return view(next)
}

export function deleteAccount(db: DB, id: string) {
  save(
    db,
    load(db).filter((a) => a.id !== id),
  )
}

/** The stored password, for the person at this computer only (the server refuses it remotely). */
export function revealPassword(db: DB, id: string) {
  const a = load(db).find((x) => x.id === id)
  if (!a) throw new Error('No such account.')
  return a.password
}
