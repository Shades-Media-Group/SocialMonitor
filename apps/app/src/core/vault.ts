import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DB } from './db.ts'
import { DATA_DIR } from './db.ts'
import { getSetting, setSetting } from './store.ts'

/**
 * Account details kept for the user's own reference: usernames, passwords and notes for the
 * networks. The app never logs in with them. They are encrypted with AES-256-GCM. Passwords
 * never appear in exports, reports, JSON views, the MCP server or anything sent to an AI.
 *
 * The key lives in the operating system's secret store, never beside the database:
 *   SOCIALMONITOR_VAULT_KEY (64 hex characters) from the service's environment, first;
 *   else the macOS Keychain; else on Windows a blob protected by DPAPI for the current user,
 *   in %LOCALAPPDATA%\SocialMonitor. Only when none of these works does it fall back to
 *   data/vault.key, readable only by the user, with a warning in the log and in Settings.
 * A data/vault.key from an older version is moved into the secret store the first time it is
 * read, then deleted, so saved accounts stay readable.
 */
export interface Account {
  id: string
  network: string
  username: string
  password: string
  note: string
}
export type AccountView = Omit<Account, 'password'> & { has_password: boolean }

/** Where the key is kept: the environment, the Keychain, Windows DPAPI, or a plain file. */
export type KeySource = 'env' | 'keychain' | 'dpapi' | 'file'

const SERVICE = 'SocialMonitor'
const KEY_FILE = join(DATA_DIR, 'vault.key')
const HEX = /^[0-9a-f]{64}$/i

/** A secret store: read the key (null when there is none yet) and write it. */
export interface Store {
  source: KeySource
  read(): string | null
  write(hex: string): void
}

const keychain: Store = {
  source: 'keychain',
  read() {
    try {
      return execFileSync(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', 'vault', '-w'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim()
    } catch {
      return null
    }
  },
  write(hex) {
    execFileSync('security', [
      'add-generic-password',
      '-s',
      SERVICE,
      '-a',
      'vault',
      '-w',
      hex,
      '-U',
    ])
  },
}

/** DPAPI through PowerShell: the key passes on stdin and stdout, never on a command line. */
const ps = (script: string, input: string) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim()
const DPAPI_FILE = join(
  process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'),
  SERVICE,
  'vault.key.dpapi',
)
const dpapi: Store = {
  source: 'dpapi',
  read() {
    if (!existsSync(DPAPI_FILE)) return null
    return ps(
      '$s = ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); ' +
        '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
      readFileSync(DPAPI_FILE, 'utf8'),
    )
  },
  write(hex) {
    // ConvertFrom-SecureString without -Key protects to the current Windows user.
    const blob = ps(
      'ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()) -AsPlainText -Force | ConvertFrom-SecureString',
      hex,
    )
    mkdirSync(dirname(DPAPI_FILE), { recursive: true })
    writeFileSync(DPAPI_FILE, blob, { mode: 0o600 })
  },
}

/** The secret store this computer offers, if any. */
const osStore = (platform = process.platform): Store | null =>
  platform === 'darwin' ? keychain : platform === 'win32' ? dpapi : null

/**
 * Finds or makes the key in `store`, moving an old data/vault.key into it. Returns null when the
 * store can't be used, so the caller falls back to the file. With `existing` (accounts are
 * already saved), it never makes a new key: that would lock them away for good.
 */
export function keyFromStore(store: Store, file = KEY_FILE, existing = false): Buffer | null {
  try {
    const have = store.read()
    if (have && HEX.test(have)) return Buffer.from(have, 'hex')
    const old = existsSync(file) ? readFileSync(file, 'utf8').trim() : null
    if (existing && !(old && HEX.test(old))) return null
    const hex = old && HEX.test(old) ? old : randomBytes(32).toString('hex')
    store.write(hex)
    // Only once the store gives the same key back is the plain copy removed.
    if (store.read() !== hex) return null
    if (old) unlinkSync(file)
    return Buffer.from(hex, 'hex')
  } catch {
    return null
  }
}

let cached: { key: Buffer; source: KeySource } | null = null

/** `existing`: accounts are already saved, so the key must be found, never made anew. */
function key(existing: boolean): Buffer {
  if (cached) return cached.key
  // A server can supply the key from its own secret store (systemd credentials, a Windows
  // service's environment, a password manager's CLI), so it never sits beside the database.
  const fromEnv = process.env.SOCIALMONITOR_VAULT_KEY?.trim()
  if (fromEnv) {
    if (!HEX.test(fromEnv)) throw new Error('SOCIALMONITOR_VAULT_KEY must be 64 hex characters.')
    return (cached = { key: Buffer.from(fromEnv, 'hex'), source: 'env' }).key
  }
  const store = osStore()
  const fromStore = store && keyFromStore(store, KEY_FILE, existing)
  if (store && fromStore) return (cached = { key: fromStore, source: store.source }).key
  if (existing && !existsSync(KEY_FILE))
    throw new Error(
      'The key for the saved accounts was not found in this computer’s secret store. Accounts saved on another computer must be entered again.',
    )
  console.warn(
    `WARNING: the key for saved accounts is kept in ${KEY_FILE}, next to the database. ` +
      'Anyone who copies data/ can read the saved passwords. Set SOCIALMONITOR_VAULT_KEY in the ' +
      "service's environment (see docs/server.md).",
  )
  if (!existsSync(KEY_FILE)) {
    writeFileSync(KEY_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
    chmodSync(KEY_FILE, 0o600)
  }
  return (cached = {
    key: Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex'),
    source: 'file',
  }).key
}

/**
 * Where the key is (or will be) kept, without making one: 'file' means it sits beside the
 * database, which Settings warns super admins about.
 */
export function vaultKeySource(): KeySource {
  if (cached) return cached.source
  if (process.env.SOCIALMONITOR_VAULT_KEY?.trim()) return 'env'
  if (process.platform === 'darwin') return 'keychain'
  if (process.platform === 'win32')
    return existsSync(KEY_FILE) && !existsSync(DPAPI_FILE) ? 'file' : 'dpapi'
  return 'file'
}

function load(db: DB): Account[] {
  const raw = getSetting(db, 'vault')
  if (!raw) return []
  const buf = Buffer.from(raw, 'base64')
  const d = createDecipheriv('aes-256-gcm', key(true), buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'),
  ) as Account[]
}

function save(db: DB, list: Account[]) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(!!getSetting(db, 'vault')), iv)
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
