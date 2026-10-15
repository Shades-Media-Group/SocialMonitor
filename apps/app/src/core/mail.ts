import { createTransport } from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { blocks, renderEmail, SHADES } from 'shades-gradient/email'
import type { Block, EmailBrand } from 'shades-gradient/email'
import { mailLang, mailText } from './mail-text.ts'

/**
 * Email for sign-in codes, invitations and password resets, over any SMTP server. The same
 * keys work for every Shades project that sends mail:
 *
 *   SMTP_HOST   e.g. smtp.gmail.com
 *   SMTP_PORT   465 (TLS) or 587 (STARTTLS)
 *   SMTP_USER   the account that signs in, e.g. you@yourdomain.com
 *   SMTP_PASS   its app password (never your normal password)
 *   SMTP_FROM   the sender people see, e.g. "SocialMonitor <no-reply@yourdomain.com>"
 *
 * Without SMTP_HOST, nothing is sent: the message is printed in the server's own console, so
 * the person at that computer can still finish setting up.
 */
let transport: Transporter | null = null

export const mailReady = () => !!process.env.SMTP_HOST?.trim()

/** A message ready to send: Gradient's HTML and its plain-text twin. */
export interface Mail {
  subject: string
  html: string
  text: string
}

const SITE = 'https://socialmonitor.shades.md'

/** SocialMonitor in Gradient's email design: its own lockup and mark, the family's colours. */
const BRAND: EmailBrand = {
  ...SHADES,
  name: 'SocialMonitor',
  logo: { src: `${SITE}/email/logo.png`, width: 168, height: 28 },
  logoDark: `${SITE}/email/logo-dark.png`,
  mark: `${SITE}/email/mark.png`,
  home: SITE,
  // The footer line: replaced by the credit in the reader's language.
  address: '',
  accent: '#E0000A',
}

const ui = blocks(BRAND)

function build(
  lang: string,
  subject: string,
  heading: string,
  lead: string | undefined,
  body: Block[],
  preheader = lead ?? heading,
): Mail {
  const l = mailLang(lang)
  const m = renderEmail({
    lang: l,
    subject,
    preheader,
    heading,
    lead,
    blocks: body,
    brand: { ...BRAND, address: mailText(l, 'credit') },
  })
  return { subject: m.subject, html: m.html, text: m.text }
}

/** A button, then the same link written out for clients that block buttons. */
const action = (lang: string, label: string, link: string, note: string) => [
  ui.button(label, link),
  ui.note(note),
  ui.note(`${mailText(lang, 'orCopy')} ${link}`),
]

/**
 * A six-digit code, on Gradient's ink pass so mail apps offer to copy it: for signing in, or for
 * choosing a new password (`reset`). The subject leads with the code and the preheader says how
 * long it works (gradient/docs/guides/email.md).
 */
export function codeMail(lang: string, code: string, kind: 'signin' | 'reset' = 'signin'): Mail {
  const k = kind === 'reset'
  const label = mailText(lang, k ? 'resetCodeLabel' : 'codeLabel')
  return build(
    lang,
    mailText(lang, k ? 'resetCodeSubject' : 'codeSubject', { code }),
    mailText(lang, k ? 'resetCodeHeading' : 'codeHeading'),
    undefined,
    [
      ui.code(
        label,
        code,
        mailText(lang, 'codeValid'),
        mailText(lang, k ? 'resetCodeStub' : 'codeStub'),
      ),
    ],
    `${label}: ${code} · ${mailText(lang, 'codeValid')}`,
  )
}

/** An invitation to choose a first password, or a reset; `forgot` when the person asked for it. */
export function linkMail(
  lang: string,
  kind: 'invite' | 'reset' | 'forgot',
  link: string,
  from = '',
): Mail {
  if (kind === 'invite')
    return build(
      lang,
      mailText(lang, 'inviteSubject', { from }),
      mailText(lang, 'inviteHeading'),
      mailText(lang, 'inviteLead', { from }),
      action(lang, mailText(lang, 'inviteButton'), link, mailText(lang, 'inviteNote')),
    )
  return build(
    lang,
    mailText(lang, 'resetSubject'),
    mailText(lang, 'resetHeading'),
    undefined,
    action(
      lang,
      mailText(lang, 'resetButton'),
      link,
      mailText(lang, kind === 'forgot' ? 'forgotNote' : 'resetNote'),
    ),
  )
}

/** New brands someone may now open. */
export const accessMail = (lang: string, from: string, brands: string, link: string): Mail =>
  build(
    lang,
    mailText(lang, 'accessSubject'),
    mailText(lang, 'accessHeading'),
    mailText(lang, 'accessLead', { from, brands }),
    [ui.button(mailText(lang, 'open'), link)],
  )

/** The negative comments report; the PDF itself is attached by the caller. */
export const badMail = (lang: string, brand: string, n: number, link: string): Mail => {
  const vars = { brand, n: String(n) }
  return build(
    lang,
    mailText(lang, 'badSubject', vars),
    mailText(lang, 'badHeading', vars),
    mailText(lang, 'badLead', vars),
    [ui.button(mailText(lang, 'open'), link)],
  )
}

/** A comment as an alert shows it. */
export interface AlertItem {
  author: string
  text: string
  network: string
  post_url: string
}

/** What an instant alert holds: comments grouped by why they need someone now. */
export interface InstantPick<T extends AlertItem = AlertItem> {
  urgent: T[]
  /** Negative comments of a run not already listed as urgent; `run` counts the whole run. */
  bad: T[]
  run: number
  /** Comments naming a word to watch, not already listed above, and which words they named. */
  watched: T[]
  terms: string[]
}

const NETWORK: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
}
const SHOWN = 10

/** Comments that need someone now: urgent ones, a run of complaints, words to watch. */
export function instantMail(lang: string, brand: string, pick: InstantPick, link: string): Mail {
  const n = pick.urgent.length + pick.bad.length + pick.watched.length
  const vars = { brand, n: String(n) }
  const group = (title: string, items: AlertItem[]) =>
    items.length
      ? [
          ui.heading(title),
          ...items.slice(0, SHOWN).flatMap((c) => {
            const t = c.text.replace(/\s+/g, ' ').trim()
            return [
              ui.paragraph(`“${t.length > 300 ? t.slice(0, 299) + '…' : t}”`),
              ui.note(`${c.author} · ${NETWORK[c.network] ?? c.network} · ${c.post_url}`),
            ]
          }),
          ...(items.length > SHOWN
            ? [ui.note(mailText(lang, 'instantMore', { n: String(items.length - SHOWN) }))]
            : []),
        ]
      : []
  return build(
    lang,
    mailText(lang, 'instantSubject', vars),
    mailText(lang, 'instantHeading', vars),
    mailText(lang, 'instantLead', vars),
    [
      ...group(mailText(lang, 'instantUrgent'), pick.urgent),
      ...group(mailText(lang, 'instantRun', { n: String(pick.run) }), pick.bad),
      ...group(mailText(lang, 'instantWatched', { terms: pick.terms.join(', ') }), pick.watched),
      ui.button(mailText(lang, 'open'), link),
      ui.note(`${mailText(lang, 'orCopy')} ${link}`),
    ],
  )
}

/** The weekly or monthly summary: the period's counts; the report PDF is attached by the caller. */
export function digestMail(
  lang: string,
  brand: string,
  kind: 'weekly' | 'monthly',
  days: number,
  counts: Record<string, number>,
  pdf: boolean,
  link: string,
): Mail {
  const week = kind === 'weekly'
  const num = (k: string) => String(counts[k] ?? 0)
  return build(
    lang,
    mailText(lang, week ? 'digestWeekSubject' : 'digestMonthSubject', { brand }),
    mailText(lang, week ? 'digestWeekHeading' : 'digestMonthHeading'),
    mailText(lang, 'digestLead', { brand, days: String(days) }),
    [
      ui.fields([
        { label: mailText(lang, 'digestNew'), value: num('total') },
        { label: mailText(lang, 'digestReply'), value: num('needs_reply') },
        { label: mailText(lang, 'digestComplaints'), value: num('complaint') },
        { label: mailText(lang, 'digestQuestions'), value: num('question') },
        { label: mailText(lang, 'digestPraise'), value: num('praise') },
      ]),
      ...(pdf ? [ui.note(mailText(lang, 'digestPdf'))] : []),
      ui.button(mailText(lang, 'open'), link),
      ui.note(`${mailText(lang, 'orCopy')} ${link}`),
    ],
  )
}

export async function sendMail(
  to: string,
  mail: Mail,
  attachments: { filename: string; content: Buffer }[] = [],
) {
  const { subject, html, text } = mail
  if (!mailReady()) {
    const files = attachments.map((a) => `\n[attached] ${a.filename}`).join('')
    console.log(`\n[mail not set up] To: ${to}\nSubject: ${subject}\n\n${text}${files}\n`)
    return
  }
  const port = Number(process.env.SMTP_PORT ?? 465)
  transport ??= createTransport({
    host: process.env.SMTP_HOST!.trim(),
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: process.env.SMTP_USER?.trim(), pass: process.env.SMTP_PASS?.replace(/\s/g, '') },
  })
  await transport.sendMail({
    from: process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim(),
    to,
    subject,
    text,
    html,
    attachments,
  })
}
