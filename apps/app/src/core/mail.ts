import { createTransport } from 'nodemailer'
import type { Transporter } from 'nodemailer'

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

export async function sendMail(to: string, subject: string, text: string) {
  if (!mailReady()) {
    console.log(`\n[mail not set up] To: ${to}\nSubject: ${subject}\n\n${text}\n`)
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
    text: `${text}\n\nSocialMonitor. Free and open source. Built by Shades Media Group.`,
  })
}
