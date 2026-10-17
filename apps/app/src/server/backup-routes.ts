import { mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { snapshotDb } from '../../../../scripts/backup.mjs'
import { audit } from '../core/audit.ts'
import { sessionCookie } from '../core/auth.ts'
import {
  RestoreError,
  checkUpload,
  countRows,
  dbFile,
  endAllSessions,
  listBackups,
  makeBackup,
  receive,
  safetyPath,
  swapInto,
} from '../core/backup.ts'
import { holdRuns, releaseRuns } from '../core/run.ts'
import { closeStaleRuns } from '../core/store.ts'
import type { Route } from './routes.ts'
import { HttpError, by, r } from './routes.ts'

/** One restore at a time. */
let restoring = false

/** The upload's own name, from ?name=, for the audit log only. */
const uploadName = (q: URLSearchParams) =>
  basename(q.get('name') ?? 'upload.db')
    .replace(/[^\w.() -]+/g, '_')
    .slice(0, 120)

/** Settings → Backups, for super admins: download the database, see the copies, restore one. */
export const backupRoutes: Route[] = [
  // A fresh, consistent copy of the database (never the media or reports), streamed and deleted.
  r('GET', '/api/admin/backup', 'super', (c) => {
    const out = makeBackup(c.db)
    audit(c.db, {
      ...by(c),
      event: 'backup.downloaded',
      target: out.name,
      detail: { bytes: out.size },
    })
    return {
      __file: out.path,
      name: out.name,
      type: 'application/octet-stream',
      cleanup: out.dir,
    }
  }),
  // The automatic copies in data/backups: before each release, and before each restore.
  r('GET', '/api/admin/backups', 'super', (c) => listBackups(c.db)),
  {
    ...r('POST', '/api/admin/restore', 'super', async (c) => {
      if (!c.stream) throw new HttpError(400, 'Choose a backup file.')
      if (Number(c.query.get('size') ?? 0) > 1024 ** 3)
        throw new HttpError(413, 'The file is larger than 1 GB.')
      if (restoring) throw new HttpError(409, 'A restore is already under way.')
      restoring = true
      let work: string | null = null
      let held = false
      try {
        const live = dbFile(c.db)
        // Beside the database, on the same disk, and removed whatever happens.
        work = mkdtempSync(join(dirname(live), '.restore-'))
        const upload = join(work, 'upload.db')
        const bytes = await receive(c.stream, upload)
        const pageSize = (c.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
        const ready = checkUpload(upload, work, pageSize)
        held = holdRuns()
        if (!held) throw new HttpError(409, 'An update is running. Restore when it has finished.')
        const name = uploadName(c.query)
        const before = countRows(c.db)
        const safety = safetyPath(c.db)
        // Into the database being replaced first, so its safety copy says why it was made.
        audit(c.db, {
          ...by(c),
          event: 'backup.restore_started',
          target: name,
          detail: { bytes, safety: basename(safety) },
        })
        snapshotDb(live, safety)
        await swapInto(c.db, ready.file)
        closeStaleRuns(c.db)
        endAllSessions(c.db)
        const after = countRows(c.db)
        // And into the restored one, so the trail survives the swap. Its people may differ: the
        // actor is kept only when the same id is the same person there.
        const same = c.db
          .prepare('SELECT 1 FROM users WHERE id = ? AND email = ?')
          .get(c.user.id, c.user.email)
        audit(c.db, {
          ...by(c),
          actor: same ? c.user.id : null,
          event: 'backup.restored',
          target: name,
          detail: { by: c.user.email, bytes, before, after, safety: basename(safety) },
        })
        // Everyone is signed out, this browser too: the dashboard goes to the sign-in screen.
        c.cookies.push(sessionCookie('', c.secure, 0))
        return { ok: true, signin: true, before, after, safety: basename(safety) }
      } catch (e) {
        if (e instanceof RestoreError) throw new HttpError(e.status, e.message)
        throw e
      } finally {
        if (held) releaseRuns()
        if (work) rmSync(work, { recursive: true, force: true })
        restoring = false
      }
    }),
    raw: true,
  },
]
