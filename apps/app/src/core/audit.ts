import type { DB } from './db.ts'
import { now } from './db.ts'

/**
 * The audit log: who did what, when, and from where. Rows are only ever added. SQLite triggers
 * (in db.ts) refuse every UPDATE, and every DELETE of a row younger than RETAIN_DAYS, so not
 * even a bug in the app can rewrite history. Rows older than that leave only through purgeAudit.
 *
 * A row never holds a secret or a comment's text: no passwords, codes, tokens or links, only
 * ids, names, emails and short facts in `detail`.
 */
export const AUDIT_EVENTS = [
  'signin.ok',
  'signin.failed',
  'code.sent',
  'logout.everywhere',
  'password.changed',
  'invite.accepted',
  'person.invited',
  'person.role',
  'person.disabled',
  'person.enabled',
  'person.removed',
  'brand.created',
  'brand.deleted',
  'network.connected',
  'network.disconnected',
  'settings.changed',
  'account.saved',
  'account.deleted',
  'account.revealed',
  'export',
  'import',
  'download',
  'report.sent',
  'security.new_device',
  'security.second_factor_added',
  'security.second_factor_removed',
  'security.failed_signins',
  'security.new_admin',
] as const
export type AuditEvent = (typeof AUDIT_EVENTS)[number]

/** At least a year, as the security plan asks; a leap day never makes it less. */
export const RETAIN_DAYS = 366

export interface AuditInput {
  event: AuditEvent
  /** The signed-in person who did it; null for someone not signed in (a failed sign-in). */
  actor?: number | null
  /** What it was done to: a person's email, a brand's name, a file name. */
  target?: string | null
  /** The brand it concerns, so that brand's admins see it. */
  brandId?: number | null
  ip?: string | null
  ua?: string | null
  /** A few plain facts. Kept under 2 KB. */
  detail?: Record<string, unknown>
}

export interface AuditRow {
  id: number
  at: string
  actor: number | null
  actor_email: string | null
  actor_name: string | null
  event: AuditEvent
  target: string | null
  brand_id: number | null
  brand_name: string | null
  ip: string | null
  ua: string | null
  detail: string
}

export function audit(db: DB, x: AuditInput) {
  let detail = JSON.stringify(x.detail ?? {})
  if (detail.length > 2000) detail = JSON.stringify({ truncated: true })
  db.prepare(
    'INSERT INTO audit (at, actor, event, target, brand_id, ip, ua, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    now(),
    x.actor ?? null,
    x.event,
    x.target?.slice(0, 200) ?? null,
    x.brandId ?? null,
    x.ip?.slice(0, 64) || null,
    x.ua?.slice(0, 300) || null,
    detail,
  )
}

/**
 * One page of the log, newest first. `brands` limits it to those brands' rows (a brand admin);
 * null shows everything (a super admin).
 */
export function listAudit(
  db: DB,
  o: {
    brands: number[] | null
    event?: string
    brandId?: number
    q?: string
    page?: number
    size?: number
  },
) {
  const where: string[] = []
  const args: (string | number)[] = []
  if (o.brands) {
    if (!o.brands.length) return { rows: [] as AuditRow[], total: 0 }
    where.push(`a.brand_id IN (${o.brands.map(() => '?').join(',')})`)
    args.push(...o.brands)
  }
  if (o.event) {
    // "person" matches every person.* event (and an event named just "person"); "person.role" one.
    where.push("(a.event = ? OR a.event LIKE ? || '.%')")
    args.push(o.event, o.event)
  }
  if (o.brandId) {
    where.push('a.brand_id = ?')
    args.push(o.brandId)
  }
  if (o.q?.trim()) {
    const like = `%${o.q.trim().replace(/[%_\\]/g, '\\$&')}%`
    where.push(
      "(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR a.target LIKE ? ESCAPE '\\' OR a.ip LIKE ? ESCAPE '\\')",
    )
    args.push(like, like, like, like)
  }
  const from = `FROM audit a LEFT JOIN users u ON u.id = a.actor LEFT JOIN brands b ON b.id = a.brand_id${
    where.length ? ` WHERE ${where.join(' AND ')}` : ''
  }`
  const size = Math.min(200, Math.max(1, o.size ?? 50))
  const page = Math.max(0, o.page ?? 0)
  const total = (db.prepare(`SELECT count(*) AS n ${from}`).get(...args) as { n: number }).n
  const rows = db
    .prepare(
      `SELECT a.*, u.email AS actor_email, u.name AS actor_name, b.name AS brand_name ${from} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, size, page * size) as unknown as AuditRow[]
  return { rows, total }
}

/** The one way rows leave the log: those older than RETAIN_DAYS. Returns how many went. */
export function purgeAudit(db: DB, days = RETAIN_DAYS) {
  const cutoff = new Date(Date.now() - Math.max(RETAIN_DAYS, days) * 86400_000).toISOString()
  return Number(db.prepare('DELETE FROM audit WHERE at < ?').run(cutoff).changes)
}

/** Failed sign-ins on an account since its last good one. */
export const failedStreak = (db: DB, userId: number) =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM audit WHERE actor = ? AND event = 'signin.failed'
           AND id > coalesce((SELECT max(id) FROM audit WHERE actor = ? AND event = 'signin.ok'), 0)`,
      )
      .get(userId, userId) as { n: number }
  ).n

/** Earlier good sign-ins of an account, to tell a new device or country from a known one. */
export const pastSignIns = (db: DB, userId: number) =>
  db
    .prepare(
      "SELECT ua, json_extract(detail, '$.country') AS country FROM audit WHERE actor = ? AND event = 'signin.ok'",
    )
    .all(userId) as { ua: string | null; country: string | null }[]
