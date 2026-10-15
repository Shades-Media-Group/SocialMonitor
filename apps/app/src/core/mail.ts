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
 * The six-digit sign-in code, on Gradient's ink pass so mail apps offer to copy it. The subject
 * leads with the code and the preheader says how long it works (gradient/docs/guides/email.md).
 */
export const codeMail = (lang: string, code: string): Mail =>
  build(
    lang,
    mailText(lang, 'codeSubject', { code }),
    mailText(lang, 'codeHeading'),
    undefined,
    [
      ui.code(
        mailText(lang, 'codeLabel'),
        code,
        mailText(lang, 'codeValid'),
        mailText(lang, 'codeStub'),
      ),
    ],
    `${mailText(lang, 'codeLabel')}: ${code} · ${mailText(lang, 'codeValid')}`,
  )

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

/** What a security alert is about. */
export type SecurityKind =
  | 'newDevice'
  | 'password'
  | 'factorAdded'
  | 'factorRemoved'
  | 'failed'
  | 'newAdmin'
  | 'newAdminOthers'

/** The facts a security alert states: when, from where, on what, and for admins who and what. */
export interface SecurityFacts {
  at: string
  ip?: string | null
  country?: string | null
  ua?: string | null
  /** The second factor: "passkey", "authenticator app". */
  method?: string | null
  /** The person it happened to, for the other super admins. */
  who?: string
  /** The admin who did it. */
  by?: string
  /** For a brand admin: which brand; none means super admin. */
  brand?: string | null
}

const LOCALE: Record<string, string> = {
  en: 'en-GB',
  ro: 'ro-RO',
  ru: 'ru-RU',
  fr: 'fr-FR',
  zh: 'zh-CN',
}

/** "Chrome on macOS" from a user agent; empty when it says nothing useful. */
export function deviceName(ua: string | null | undefined) {
  const u = ua ?? ''
  const browser = /Edg\//.test(u)
    ? 'Edge'
    : /OPR\//.test(u)
      ? 'Opera'
      : /Firefox\//.test(u)
        ? 'Firefox'
        : /Chrome\//.test(u)
          ? 'Chrome'
          : /Safari\//.test(u)
            ? 'Safari'
            : ''
  const os = /iPhone|iPad/.test(u)
    ? 'iOS'
    : /Android/.test(u)
      ? 'Android'
      : /Windows/.test(u)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(u)
          ? 'macOS'
          : /Linux/.test(u)
            ? 'Linux'
            : ''
  return [browser, os].filter(Boolean).join(' · ')
}

/**
 * A security alert: what happened, when (in UTC, named), from where and on which device, and
 * what to do if it wasn't the reader. One button, to the dashboard, with the link written out.
 */
export function securityMail(
  lang: string,
  kind: SecurityKind,
  f: SecurityFacts,
  link: string,
): Mail {
  const l = mailLang(lang)
  let when = f.at
  try {
    when = `${new Date(f.at).toLocaleString(LOCALE[l], {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'UTC',
    })} UTC`
  } catch {
    /* keep the ISO time */
  }
  let country = f.country ?? ''
  try {
    if (country)
      country = new Intl.DisplayNames([LOCALE[l]!], { type: 'region' }).of(country) ?? country
  } catch {
    /* keep the code */
  }
  const unknown = mailText(l, 'secUnknown')
  const scope = f.brand ? mailText(l, 'scopeBrand', { brand: f.brand }) : mailText(l, 'scopeSuper')
  const vars = { who: f.who ?? '', by: f.by ?? '', scope }
  const admin = kind === 'newAdmin' || kind === 'newAdminOthers'
  const notYou =
    kind === 'failed'
      ? 'secNotYouFailed'
      : kind === 'newAdminOthers'
        ? 'secNotYouAdmin'
        : 'secNotYou'
  return build(
    l,
    mailText(l, `${kind}Subject`, vars),
    mailText(l, `${kind}Heading`, vars),
    mailText(l, `${kind}Lead`, vars),
    [
      ui.fields([
        { label: mailText(l, 'secWhen'), value: when },
        ...(admin
          ? [{ label: mailText(l, 'secBy'), value: f.by || unknown }]
          : [
              {
                label: mailText(l, 'secWhere'),
                value: [f.ip, country].filter(Boolean).join(', ') || unknown,
              },
              { label: mailText(l, 'secDevice'), value: deviceName(f.ua) || unknown },
            ]),
        ...(f.method ? [{ label: mailText(l, 'secMethod'), value: f.method }] : []),
      ]),
      ui.paragraph(mailText(l, notYou)),
      ui.button(mailText(l, 'open'), link),
      ui.note(`${mailText(l, 'orCopy')} ${link}`),
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
