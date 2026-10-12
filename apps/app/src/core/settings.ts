import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { DB } from './db.ts'
import { getSetting, setSetting } from './store.ts'

export interface Settings {
  /** Hours between updates that use a signed-in network. Never below 4. */
  gap_hours: number
  /** Days comments are kept; older ones are deleted after each update. */
  keep_days: number
  /** Which AI sorts comments: Claude Code, an API key, or whichever is there. */
  analyzer: 'auto' | 'claude' | 'api'
}

const DEFAULTS: Settings = { gap_hours: 4, keep_days: 365, analyzer: 'auto' }
const VERSION = (
  JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

export function hasClaudeCode() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export function getSettings(db: DB): Settings {
  const raw = getSetting(db, 'settings')
  return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) }
}

export function readSettings(db: DB) {
  const s = getSettings(db)
  const claude = hasClaudeCode()
  const key = !!process.env.ANTHROPIC_API_KEY
  const using =
    s.analyzer === 'api'
      ? key
        ? 'API key'
        : null
      : s.analyzer === 'claude'
        ? claude
          ? 'Claude Code'
          : null
        : claude
          ? 'Claude Code'
          : key
            ? 'API key'
            : null
  return {
    ...s,
    version: VERSION,
    analyzer_status: using
      ? `Comments are sorted with ${using}.`
      : 'Nothing to sort with yet: install Claude Code, or set ANTHROPIC_API_KEY in .env.',
  }
}

export function writeSettings(db: DB, patch: unknown) {
  const p = (patch ?? {}) as Partial<Settings>
  const next = { ...getSettings(db) }
  if (p.gap_hours != null) next.gap_hours = Math.min(48, Math.max(4, Number(p.gap_hours) || 4))
  if (p.keep_days != null) next.keep_days = Math.min(3650, Math.max(7, Number(p.keep_days) || 365))
  if (p.analyzer && ['auto', 'claude', 'api'].includes(p.analyzer)) next.analyzer = p.analyzer
  setSetting(db, 'settings', JSON.stringify(next))
  return readSettings(db)
}
