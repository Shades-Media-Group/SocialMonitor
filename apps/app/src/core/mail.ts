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
): Mail {
  const l = mailLang(lang)
  const m = renderEmail({
    lang: l,
    subject,
    preheader: lead ?? heading,
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

/** The six-digit sign-in code, on Gradient's ink pass so mail apps offer to copy it. */
export const codeMail = (lang: string, code: string): Mail =>
  build(lang, mailText(lang, 'codeSubject', { code }), mailText(lang, 'codeHeading'), undefined, [
    ui.code(
      mailText(lang, 'codeLabel'),
      code,
      mailText(lang, 'codeValid'),
      mailText(lang, 'codeStub'),
    ),
  ])

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
