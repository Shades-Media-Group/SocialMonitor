// A fresh, consistent copy of SocialMonitor's database, for backups made by other tools.
//
//   node scripts/export.mjs <outfile>
//
// Writes data/socialmonitor.db to <outfile> with SQLite's VACUUM INTO, which is safe while the
// dashboard is running and writing, then checks the copy (integrity_check and row counts). No
// prompts: it prints one line and exits 0, or prints the problem and exits 1. The data folder is
// SOCIALMONITOR_DATA, else data/ next to this repository. The copy holds the database only; media
// and reports stay in data/. Saved network passwords in it open only with the same
// SOCIALMONITOR_VAULT_KEY. See "Backups" in docs/server.md.
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDb, snapshotDb } from './backup.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2]

try {
  if (!out) throw new Error('Usage: node scripts/export.mjs <outfile>')
  const data = resolve(process.env.SOCIALMONITOR_DATA ?? join(ROOT, 'data'))
  const target = resolve(out)
  mkdirSync(dirname(target), { recursive: true })
  snapshotDb(join(data, 'socialmonitor.db'), target)
  const { integrity, counts } = checkDb(target)
  if (integrity !== 'ok') throw new Error(`The copy is damaged: ${integrity}`)
  const mb = (statSync(target).size / 1024 / 1024).toFixed(1)
  console.log(`Exported ${target} (${mb} MB): ${JSON.stringify(counts)}`)
} catch (e) {
  console.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
}
