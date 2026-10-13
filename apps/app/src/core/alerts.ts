import type { DB } from './db.ts'
import { now } from './db.ts'
import { brandPdf, uiOrigin } from './pdf.ts'
import { badMail, digestMail, instantMail, sendMail } from './mail.ts'
import type { AlertItem, InstantPick } from './mail.ts'
import type { Comment, Digest, Tracker } from './types.ts'
import { RUN } from './types.ts'
import { mailLang } from './mail-text.ts'
import { signSession } from './auth.ts'
import { saveReport } from './saved.ts'
import * as store from './store.ts'

/**
 * Emails to a brand's own list of addresses. The bad-comments report: every negative comment as
 * a PDF grouped by kind, on request or after each update that brought new ones. Instant alerts:
 * the comments that need someone now, after an update. The summary: weekly or monthly.
 */

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

/** Keeps up to 20 valid, distinct addresses. */
export function setAlerts(db: DB, brandId: number, emails: unknown, auto: unknown, lang: string) {
  const list = [
    ...new Set(
      (Array.isArray(emails) ? emails : [])
        .map((e) => String(e).trim().toLowerCase())
        .filter((e) => EMAIL.test(e)),
    ),
  ].slice(0, 20)
  db.prepare('UPDATE brands SET alert_emails = ?, alert_auto = ?, alert_lang = ? WHERE id = ?').run(
    JSON.stringify(list),
    auto ? 1 : 0,
    mailLang(lang),
    brandId,
  )
  return { emails: list, auto: !!auto }
}

/** Negative comments from customers, optionally only those read since a time. */
export function badCount(db: DB, brandId: number, readSince?: string) {
  return store.listComments(db, { brandId, bad: true, others: true, readSince, limit: 100000 })
    .length
}

type Viewer = { id: number; session_version: number }

/** The first super admin, who sees every brand: emails sent by themselves render as them. */
const firstOwner = (db: DB) =>
  db
    .prepare(
      'SELECT id, session_version FROM users WHERE super = 1 AND disabled = 0 ORDER BY id LIMIT 1',
    )
    .get() as Viewer | undefined

/** Renders a brand's print page as the given person would see it, keeps it in the reports history. */
async function savedPdf(db: DB, brandId: number, q: URLSearchParams, viewer: Viewer, name: string) {
  const brand = store.getBrand(db, brandId)
  if (!brand) throw new Error('No such brand.')
  const data = await brandPdf(uiOrigin(), brandId, q.toString(), signSession(viewer, 120))
  const filename = `${brand.name.replace(/[^\w-]+/g, '-')}-${name}-${now().slice(0, 10)}.pdf`
  saveReport(db, {
    brandId,
    kind: 'pdf',
    filename,
    type: 'application/pdf',
    data,
    params: Object.fromEntries(q),
    userId: viewer.id,
  })
  return { filename, data }
}

/** The negative comments as a PDF, grouped by kind. */
export function badPdf(
  db: DB,
  brandId: number,
  opts: { days?: number; readSince?: string; network?: string },
  viewer: Viewer,
) {
  const q = new URLSearchParams({ kind: 'bad' })
  if (opts.days) q.set('days', String(opts.days))
  if (opts.readSince) q.set('since', opts.readSince)
  if (opts.network) q.set('network', opts.network)
  return savedPdf(db, brandId, q, viewer, 'negative-comments')
}

/** Sends the report to the brand's list. Returns how many addresses it went to. */
export async function sendBad(
  db: DB,
  brandId: number,
  opts: { days?: number; readSince?: string },
  viewer: Viewer,
) {
  const brand = store.getBrand(db, brandId)
  if (!brand) throw new Error('No such brand.')
  const emails = JSON.parse(brand.alert_emails || '[]') as string[]
  if (!emails.length) throw new Error('Add at least one address first.')
  const n = opts.readSince
    ? badCount(db, brandId, opts.readSince)
    : store.listComments(db, {
        brandId,
        bad: true,
        others: true,
        from: opts.days ? new Date(Date.now() - opts.days * 86400_000).toISOString() : undefined,
        limit: 100000,
      }).length
  const { filename, data } = await badPdf(db, brandId, opts, viewer)
  const mail = badMail(brand.alert_lang, brand.name, n, uiOrigin())
  for (const to of emails) await sendMail(to, mail, [{ filename, content: data }])
  db.prepare('UPDATE brands SET alert_sent_at = ? WHERE id = ?').run(now(), brandId)
  return emails.length
}

/**
 * After an update: each brand that asked for it gets the report of the negative comments that
 * update brought in, if there were any. Rendered as the first super admin, who sees every brand.
 */
export async function autoSendBad(
  db: DB,
  brandIds: number[],
  readSince: string,
  log: (line: string) => void,
) {
  const owner = firstOwner(db)
  if (!owner) return
  for (const brandId of new Set(brandIds)) {
    const brand = store.getBrand(db, brandId)
    if (!brand?.alert_auto || brand.alert_emails === '[]') continue
    const n = badCount(db, brandId, readSince)
    if (!n) continue
    try {
      const sent = await sendBad(db, brandId, { readSince }, owner)
      log(`Sent ${n} new negative comments of ${brand.name} to ${sent} addresses.`)
    } catch (e) {
      log(`Could not send the negative comments of ${brand.name}: ${(e as Error).message}`)
    }
  }
}

type Candidate = AlertItem &
  Pick<Comment, 'id' | 'label' | 'sentiment' | 'urgency' | 'needs_reply' | 'reply_status'>

/**
 * Which of the comments no alert has carried yet go out now, by trigger: urgent ones that wait
 * for an answer, a run of negative ones, and ones naming a word to watch (ignoring case, as on
 * the Stats tab). A comment is listed once, under the first reason that holds.
 */
export function pickInstant<T extends Candidate>(
  rows: T[],
  on: { urgent: boolean; bad: boolean; watched: boolean },
  trackers: Tracker[],
): InstantPick<T> {
  const urgent = on.urgent
    ? rows.filter((c) => c.urgency === 2 && c.needs_reply === 1 && c.reply_status === 'open')
    : []
  const negative = rows.filter((c) => c.sentiment === 'negative' || c.label === 'complaint')
  const run = on.bad && negative.length >= RUN ? negative.length : 0
  const seen = new Set<T>(urgent)
  const bad = run ? negative.filter((c) => !seen.has(c)) : []
  for (const c of bad) seen.add(c)
  const terms = on.watched ? trackers.map((t) => t.term) : []
  const named = (c: T) => terms.filter((t) => c.text.toLowerCase().includes(t.toLowerCase()))
  const watched = rows.filter((c) => !seen.has(c) && named(c).length)
  return { urgent, bad, run, watched, terms: [...new Set(watched.flatMap(named))] }
}

/** Turns instant-alert triggers and the summary email on or off for a brand. */
export function setNotify(
  db: DB,
  brandId: number,
  x: { urgent?: unknown; bad?: unknown; watched?: unknown; digest?: unknown },
) {
  const brand = store.getBrand(db, brandId)
  if (!brand) throw new Error('No such brand.')
  const at = now()
  for (const k of ['urgent', 'bad', 'watched'] as const) {
    if (x[k] === undefined) continue
    const on = x[k] ? 1 : 0
    // Switched on: comments count from now, so what was read before never floods the first alert.
    if (on && !brand[`instant_${k}`])
      db.prepare('UPDATE brands SET instant_since = ? WHERE id = ?').run(at, brandId)
    db.prepare(`UPDATE brands SET instant_${k} = ? WHERE id = ?`).run(on, brandId)
  }
  if (x.digest !== undefined && x.digest !== brand.digest) {
    if (!(['off', 'weekly', 'monthly'] as unknown[]).includes(x.digest))
      throw new Error('Choose off, weekly or monthly.')
    // Counted as sent now: the first summary goes at the next Monday or 1st, not straight away.
    db.prepare('UPDATE brands SET digest = ?, digest_sent_at = ? WHERE id = ?').run(
      x.digest as Digest,
      at,
      brandId,
    )
  }
  return store.getBrand(db, brandId)!
}

/** After an update: one email per brand with the comments that need someone now, if any. */
export async function instantAlerts(db: DB, brandIds: number[], log: (line: string) => void) {
  for (const brandId of new Set(brandIds)) {
    const brand = store.getBrand(db, brandId)
    if (!brand?.instant_since || brand.alert_emails === '[]') continue
    const on = {
      urgent: !!brand.instant_urgent,
      bad: !!brand.instant_bad,
      watched: !!brand.instant_watched,
    }
    if (!on.urgent && !on.bad && !on.watched) continue
    const rows = store
      .listComments(db, { brandId, readSince: brand.instant_since, others: true, limit: 100000 })
      .filter((c) => !c.alerted_at)
    const pick = pickInstant(rows, on, JSON.parse(brand.trackers || '[]') as Tracker[])
    const ids = [...pick.urgent, ...pick.bad, ...pick.watched].map((c) => c.id)
    if (!ids.length) continue
    // Marked before sending: a comment never goes out twice, even if sending stops halfway.
    db.prepare(
      'UPDATE comments SET alerted_at = ? WHERE id IN (SELECT value FROM json_each(?))',
    ).run(now(), JSON.stringify(ids))
    try {
      const emails = JSON.parse(brand.alert_emails) as string[]
      const mail = instantMail(brand.alert_lang, brand.name, pick, uiOrigin())
      for (const to of emails) await sendMail(to, mail)
      log(`Sent an alert of ${ids.length} comments of ${brand.name} to ${emails.length} addresses.`)
    } catch (e) {
      log(`Could not send the alert of ${brand.name}: ${(e as Error).message}`)
    }
  }
}

/** The latest summary time at or before `at`, local time: Monday 08:00, or the 1st at 08:00. */
export function digestSlot(kind: 'weekly' | 'monthly', at: Date) {
  const d = new Date(at)
  d.setHours(8, 0, 0, 0)
  if (kind === 'weekly') {
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    if (d > at) d.setDate(d.getDate() - 7)
  } else {
    d.setDate(1)
    if (d > at) d.setMonth(d.getMonth() - 1)
  }
  return d
}

/** Whether a brand's summary is due: its latest time has come and none went out since. */
export const digestDue = (kind: Digest, sentAt: string | null, at: Date) =>
  kind !== 'off' && (!sentAt || new Date(sentAt) < digestSlot(kind, at))

let digesting = false

/** Checked by the scheduler every minute: sends each brand's due summary, once. */
export async function sendDigests(db: DB, at = new Date(), log = console.log) {
  if (digesting) return
  digesting = true
  try {
    for (const brand of store.listBrands(db)) {
      if (brand.digest === 'off' || brand.alert_emails === '[]') continue
      if (!digestDue(brand.digest, brand.digest_sent_at, at)) continue
      // Marked first, so a restart or a slow PDF never sends the same summary twice.
      db.prepare('UPDATE brands SET digest_sent_at = ? WHERE id = ?').run(
        at.toISOString(),
        brand.id,
      )
      const slot = digestSlot(brand.digest, at)
      const days =
        brand.digest === 'weekly' ? 7 : new Date(slot.getFullYear(), slot.getMonth(), 0).getDate()
      const counts = store.labelCounts(
        db,
        brand.id,
        new Date(slot.getTime() - days * 86400_000).toISOString(),
      )
      // The brand report as a PDF when a browser can render it; otherwise the summary goes alone.
      const files: { filename: string; content: Buffer }[] = []
      const owner = firstOwner(db)
      try {
        if (owner) {
          const q = new URLSearchParams({ days: String(days) })
          const { filename, data } = await savedPdf(db, brand.id, q, owner, 'report')
          files.push({ filename, content: Buffer.from(data) })
        }
      } catch (e) {
        log(`Summary of ${brand.name}: no PDF (${(e as Error).message}).`)
      }
      try {
        const emails = JSON.parse(brand.alert_emails) as string[]
        const mail = digestMail(
          brand.alert_lang,
          brand.name,
          brand.digest,
          days,
          counts,
          files.length > 0,
          uiOrigin(),
        )
        for (const to of emails) await sendMail(to, mail, files)
        log(`Sent the ${brand.digest} summary of ${brand.name} to ${emails.length} addresses.`)
      } catch (e) {
        log(`Could not send the summary of ${brand.name}: ${(e as Error).message}`)
      }
    }
  } finally {
    digesting = false
  }
}
