import type { DB } from './db.ts'
import { now } from './db.ts'
import { brandPdf, uiOrigin } from './pdf.ts'
import { sendMail } from './mail.ts'
import { mailLang, mailText } from './mail-text.ts'
import { signSession } from './auth.ts'
import { saveReport } from './saved.ts'
import * as store from './store.ts'

/**
 * The bad-comments report: every negative comment of a brand as a PDF grouped by kind, sent to
 * the brand's own list of addresses on request, or after each update that brought new ones.
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

/** Renders the PDF as the given person would see it, keeps it in the reports history. */
export async function badPdf(
  db: DB,
  brandId: number,
  opts: { days?: number; readSince?: string; network?: string },
  viewer: Viewer,
) {
  const brand = store.getBrand(db, brandId)
  if (!brand) throw new Error('No such brand.')
  const q = new URLSearchParams({ kind: 'bad' })
  if (opts.days) q.set('days', String(opts.days))
  if (opts.readSince) q.set('since', opts.readSince)
  if (opts.network) q.set('network', opts.network)
  const data = await brandPdf(uiOrigin(), brandId, q.toString(), signSession(viewer, 120))
  const filename = `${brand.name.replace(/[^\w-]+/g, '-')}-negative-comments-${now().slice(0, 10)}.pdf`
  saveReport(db, {
    brandId,
    kind: 'pdf',
    filename,
    type: 'application/pdf',
    data,
    params: { kind: 'bad', ...Object.fromEntries(q) },
    userId: viewer.id,
  })
  return { filename, data }
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
  const vars = { brand: brand.name, n: String(n) }
  for (const to of emails)
    await sendMail(
      to,
      mailText(brand.alert_lang, 'badSubject', vars),
      mailText(brand.alert_lang, 'badBody', vars),
      brand.alert_lang,
      [{ filename, content: data }],
    )
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
  const owner = db
    .prepare(
      'SELECT id, session_version FROM users WHERE super = 1 AND disabled = 0 ORDER BY id LIMIT 1',
    )
    .get() as Viewer | undefined
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
