import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../apps/app/src/core/db.ts'
import {
  backupArgs,
  checkDb,
  findFile,
  forgetArgs,
  missingSettings,
  pruneEnv,
  restoreArgs,
  snapshotDb,
} from './backup.mjs'

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-backup-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('database snapshot', () => {
  it('copies a live WAL database consistently, without the open transaction', () => {
    const dir = temp()
    const live = openDb(join(dir, 'socialmonitor.db'))
    live.prepare('INSERT INTO brands (name) VALUES (?)').run('Tavelo')
    live.exec('BEGIN')
    live.prepare('INSERT INTO brands (name) VALUES (?)').run('Uncommitted')

    const copy = join(dir, 'snap', 'socialmonitor.db')
    snapshotDb(join(dir, 'socialmonitor.db'), copy)
    live.exec('COMMIT')
    live.close()

    const { integrity, counts } = checkDb(copy)
    expect(integrity).toBe('ok')
    expect(counts.brands).toBe(1)
    expect(counts.comments).toBe(0)
  })

  it('refuses a missing database instead of backing up nothing', () => {
    const dir = temp()
    expect(() => snapshotDb(join(dir, 'none.db'), join(dir, 'out.db'))).toThrow(/No database/)
  })
})

describe('restic arguments and settings', () => {
  it('builds the backup, forget and restore commands', () => {
    expect(backupArgs(['/d/a', '/d/b'])).toEqual([
      'backup',
      '--tag',
      'socialmonitor',
      '/d/a',
      '/d/b',
    ])
    expect(forgetArgs()).toEqual([
      'forget',
      '--tag',
      'socialmonitor',
      '--group-by',
      'host,tags',
      '--keep-daily',
      '30',
      '--keep-monthly',
      '12',
      '--prune',
    ])
    expect(restoreArgs('/tmp/x')).toEqual([
      'restore',
      'latest',
      '--tag',
      'socialmonitor',
      '--target',
      '/tmp/x',
    ])
  })

  it('names every missing setting, and accepts a password file', () => {
    expect(missingSettings({})).toEqual([
      'RESTIC_REPOSITORY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'RESTIC_PASSWORD or RESTIC_PASSWORD_FILE',
    ])
    expect(
      missingSettings({
        RESTIC_REPOSITORY: 's3:https://x.r2.cloudflarestorage.com/b',
        RESTIC_PASSWORD_FILE: '/secret',
        AWS_ACCESS_KEY_ID: 'id',
        AWS_SECRET_ACCESS_KEY: 'key',
      }),
    ).toEqual([])
  })

  it('forgets only with a separate prune credential, which replaces the nightly one', () => {
    const nightly = { AWS_ACCESS_KEY_ID: 'night', AWS_SECRET_ACCESS_KEY: 'night-key' }
    expect(pruneEnv(nightly)).toBeNull()
    expect(pruneEnv({ ...nightly, RESTIC_PRUNE_AWS_ACCESS_KEY_ID: 'p' })).toBeNull()
    const env = pruneEnv({
      ...nightly,
      RESTIC_PRUNE_AWS_ACCESS_KEY_ID: 'admin',
      RESTIC_PRUNE_AWS_SECRET_ACCESS_KEY: 'admin-key',
    })
    expect(env?.AWS_ACCESS_KEY_ID).toBe('admin')
    expect(env?.AWS_SECRET_ACCESS_KEY).toBe('admin-key')
  })

  it('finds the restored database under the original absolute path', () => {
    const dir = temp()
    mkdirSync(join(dir, 'Users', 'x', 'data', 'backup-snapshot'), { recursive: true })
    writeFileSync(join(dir, 'Users', 'x', 'data', 'backup-snapshot', 'socialmonitor.db'), '')
    expect(findFile(dir, 'socialmonitor.db')).toBe(
      join(dir, 'Users', 'x', 'data', 'backup-snapshot', 'socialmonitor.db'),
    )
    expect(findFile(dir, 'other.db')).toBeNull()
  })
})

const hasRestic = !spawnSync('restic', ['version']).error

describe.skipIf(!hasRestic)('with restic installed', () => {
  it('backs up to a local repository and passes the restore test', () => {
    const dir = temp()
    const data = join(dir, 'data')
    const db = openDb(join(data, 'socialmonitor.db'))
    db.prepare('INSERT INTO brands (name) VALUES (?)').run('Tavelo')
    db.close()
    mkdirSync(join(data, 'reports'), { recursive: true })
    writeFileSync(join(data, 'reports', 'week.html'), '<p>report</p>')
    mkdirSync(join(data, 'browser'), { recursive: true })
    writeFileSync(join(data, 'browser', 'Cookies'), 'not backed up')

    const env = {
      ...process.env,
      SOCIALMONITOR_DATA: data,
      RESTIC_REPOSITORY: join(dir, 'repo'),
      RESTIC_PASSWORD: 'testtesttest',
      RESTIC_PASSWORD_FILE: '',
      AWS_ACCESS_KEY_ID: 'unused',
      AWS_SECRET_ACCESS_KEY: 'unused',
      RESTIC_PRUNE_AWS_ACCESS_KEY_ID: '',
      RESTIC_PRUNE_AWS_SECRET_ACCESS_KEY: '',
    }
    expect(spawnSync('restic', ['init'], { env }).status).toBe(0)
    const script = join(import.meta.dirname, 'backup.mjs')
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { env })

    expect(run().status).toBe(0)
    expect(existsSync(join(data, 'backup-snapshot'))).toBe(false)
    expect(run('--test-restore').status).toBe(0)

    const status = JSON.parse(readFileSync(join(data, 'backup-status.json'), 'utf8'))
    expect(status.backup.ok).toBe(true)
    expect(status.restoreTest.counts.brands).toBe(1)
    const ls = spawnSync('restic', ['ls', 'latest'], { env, encoding: 'utf8' }).stdout
    expect(ls).toContain('week.html')
    expect(ls).not.toContain('Cookies')
  }, 60_000)
})
