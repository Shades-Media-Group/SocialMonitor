import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../apps/app/src/core/db.ts'

const script = join(import.meta.dirname, 'export.mjs')
const dirs: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sm-export-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const run = (args: string[], data: string) =>
  spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, SOCIALMONITOR_DATA: data },
    encoding: 'utf8',
  })

describe('scripts/export.mjs', () => {
  it('writes a checked copy of the database to the path given, and exits 0', () => {
    const data = temp()
    openDb(join(data, 'socialmonitor.db')).close()
    const out = join(temp(), 'nested', 'copy.db')
    const r = run([out], data)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^Exported .*copy\.db/)
    expect(existsSync(out)).toBe(true)
  })

  it('exits 1 with a reason when the path or the database is missing', () => {
    const data = temp()
    expect(run([], data).status).toBe(1)
    const r = run([join(temp(), 'copy.db')], data)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Export failed: No database/)
  })
})
