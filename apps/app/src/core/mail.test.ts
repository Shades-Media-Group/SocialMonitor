import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The SMTP transport, caught: these tests read what would be handed to the server, nothing is sent.
const sent = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sent.push(m)
    },
  }),
}))
import {
  accessMail,
  badMail,
  codeMail,
  deviceName,
  digestMail,
  instantMail,
  linkMail,
  securityMail,
  sendMail,
} from './mail.ts'
import type { SecurityKind } from './mail.ts'

const link = 'https://app.example.test/reset/abc.def'

describe('emails in Gradient’s design', () => {
  it('puts the code in the subject, on the pass and in the text twin', () => {
    const m = codeMail('en', '716428')
    expect(m.subject).toBe('716428 is your SocialMonitor sign-in code')
    expect(m.html).toContain('716428')
    expect(m.html).toContain('socialmonitor.shades.md/email/logo.png')
    expect(m.text).toContain('716428')
    expect(m.text).toContain('change your password')
    // Gmail's preview line names the code and says how long it works.
    expect(m.html).toContain('Your SocialMonitor code is 716428 · works for 10 minutes')
  })

  it('sends a password code the same way, with its own words', () => {
    const m = codeMail('en', '402913', 'reset')
    expect(m.subject).toBe('402913 is your SocialMonitor password code')
    expect(m.html).toContain('Your SocialMonitor code is 402913 · works for 10 minutes')
    expect(m.text).toContain('402913')
    expect(m.text).toContain('did not ask to change your password')
    for (const l of ['ro', 'ru', 'fr', 'zh'])
      expect(codeMail(l, '402913', 'reset').subject.startsWith('402913')).toBe(true)
  })

  it('writes an invitation and a reset with a button and the link spelled out', () => {
    for (const kind of ['invite', 'reset', 'forgot'] as const) {
      const m = linkMail('en', kind, link, 'Ana')
      expect(m.html).toContain(`href="${link}"`)
      expect(m.text).toContain(link)
    }
    expect(linkMail('en', 'invite', link, 'Ana').subject).toBe('Ana invited you to SocialMonitor')
    expect(linkMail('en', 'forgot', link).text).toContain('ignore this email')
  })

  it('escapes what people typed', () => {
    const m = accessMail('en', '<b>Ana</b>', 'Tavelo', 'https://app.example.test')
    expect(m.html).not.toContain('<b>Ana</b>')
    expect(m.html).toContain('&lt;b&gt;Ana&lt;/b&gt;')
  })

  it('writes an instant alert grouped by reason, with the comments and the link', () => {
    const c = (text: string) => ({
      author: 'ana',
      text,
      network: 'instagram',
      post_url: 'https://www.instagram.com/p/abc/',
    })
    const m = instantMail(
      'en',
      'Tavelo',
      {
        urgent: [c('My booking vanished')],
        bad: Array.from({ length: 12 }, (_, i) => c(`Late again ${i}`)),
        run: 13,
        watched: [c('Is <b>Tavelo Plus</b> worth it?')],
        terms: ['Tavelo Plus'],
      },
      'https://app.example.test',
    )
    expect(m.subject).toBe('Tavelo: 14 comments need you now')
    expect(m.html).toContain('Urgent')
    expect(m.html).toContain('13 negative comments since the last alert')
    expect(m.html).toContain('Words to watch: Tavelo Plus')
    expect(m.html).toContain('And 2 more in SocialMonitor.')
    expect(m.html).not.toContain('<b>Tavelo Plus</b>')
    expect(m.html).toContain('href="https://app.example.test/"')
    expect(m.text).toContain('My booking vanished')
    expect(m.text).toContain('ana · Instagram · https://www.instagram.com/p/abc/')
    expect(m.text).toContain('https://app.example.test')
    expect(m.text).not.toContain('Late again 11')
  })

  it('writes the weekly and monthly summary with the period’s counts', () => {
    const counts = { total: 120, needs_reply: 7, complaint: 18, question: 25, praise: 40 }
    const w = digestMail('en', 'Tavelo', 'weekly', 7, counts, true, 'https://app.example.test')
    expect(w.subject).toBe('Tavelo: last week in comments')
    expect(w.html).toContain('What people said about Tavelo in the last 7 days.')
    expect(w.text).toContain('120')
    expect(w.text).toContain('Still need an answer')
    expect(w.text).toContain('attached as a PDF')
    expect(w.text).toContain('https://app.example.test')
    const m = digestMail('ro', 'Tavelo', 'monthly', 30, {}, false, 'https://app.example.test')
    expect(m.subject).toBe('Tavelo: comentariile lunii trecute')
    expect(m.text).not.toContain('PDF')
  })

  it('speaks the reader’s language and falls back to English', () => {
    expect(codeMail('ro', '111111').subject).toBe(
      '111111 este codul tău de conectare SocialMonitor',
    )
    expect(codeMail('xx', '111111').subject).toBe('111111 is your SocialMonitor sign-in code')
    expect(badMail('fr', 'Tavelo', 12, 'https://app.example.test').subject).toBe(
      'Tavelo : 12 commentaires négatifs',
    )
  })

  const facts = {
    at: '2026-10-15T20:43:00.000Z',
    ip: '203.0.113.7',
    country: 'MD',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    who: 'Ana Popescu',
    by: 'Ion <b>Rusu</b>',
  }
  const app = 'https://app.example.test'

  it('writes each security alert: what happened, when, from where, and what to do', () => {
    const subjects: Record<SecurityKind, string> = {
      newDevice: 'New sign-in to your SocialMonitor account',
      password: 'Your SocialMonitor password was changed',
      factorAdded: 'A second factor was added to your SocialMonitor account',
      factorRemoved: 'A second factor was removed from your SocialMonitor account',
      failed: 'Five failed sign-ins to your SocialMonitor account',
      newAdmin: 'You are now an admin in SocialMonitor',
      newAdminOthers: 'Ana Popescu is now an admin in SocialMonitor',
    }
    for (const [kind, subject] of Object.entries(subjects) as [SecurityKind, string][]) {
      const m = securityMail('en', kind, facts, app)
      expect(m.subject).toBe(subject)
      expect(m.text).toContain('15 October 2026 at 20:43 UTC')
      expect(m.html).toContain(`href="${app}/"`)
      expect(m.text).toContain(app)
      // What to do if it wasn't them, every time.
      expect(m.text).toMatch(/If (this wasn’t you|you didn’t expect this)/)
    }
    const d = securityMail('en', 'newDevice', facts, app)
    expect(d.text).toContain('203.0.113.7, Moldova')
    expect(d.text).toContain('Chrome · macOS')
    expect(d.text).toContain('change your password now')
    const f = securityMail('en', 'failed', facts, app)
    expect(f.text).toContain('paused for 15 minutes')
    const a = securityMail('en', 'newAdminOthers', { ...facts, brand: 'Tavelo' }, app)
    expect(a.text).toContain('made Ana Popescu an admin of Tavelo')
    expect(a.html).not.toContain('<b>Rusu</b>')
    expect(a.text).toContain('open Activity')
    expect(securityMail('en', 'newAdmin', facts, app).text).toContain('made you a super admin')
    expect(securityMail('en', 'factorAdded', { ...facts, method: 'passkey' }, app).text).toContain(
      'passkey',
    )
  })

  it('writes security alerts in the reader’s language, with unknowns named', () => {
    const m = securityMail('ro', 'password', { at: facts.at }, app)
    expect(m.subject).toBe('Parola ta SocialMonitor a fost schimbată')
    expect(m.text).toContain('Necunoscut')
    expect(m.text).toContain('UTC')
    for (const lang of ['ru', 'fr', 'zh'])
      expect(securityMail(lang, 'newDevice', facts, app).subject).not.toBe(
        securityMail('en', 'newDevice', facts, app).subject,
      )
  })

  it('names the device from a user agent', () => {
    expect(deviceName(facts.ua)).toBe('Chrome · macOS')
    expect(
      deviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1',
      ),
    ).toBe('Safari · iOS')
    expect(deviceName('curl/8.7.1')).toBe('')
  })
})

// Gmail's "Copy code" card: the bare code leads the subject, the plain text opens with the
// preheader that names it, the digits sit on the code pass, and the mail comes from SMTP_FROM.
describe('code emails for Gmail’s copy card', () => {
  const env = { ...process.env }
  beforeAll(() => {
    Object.assign(process.env, {
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '465',
      SMTP_USER: 'account@shades.md',
      SMTP_PASS: 'not-a-real-password',
      SMTP_FROM: 'SocialMonitor <no-reply@shades.md>',
    })
  })
  afterAll(() => {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'])
      if (env[k] === undefined) delete process.env[k]
      else process.env[k] = env[k]
  })

  const kinds = [
    { kind: 'signin', label: 'Sign-in code' },
    { kind: 'reset', label: 'Password code' },
  ] as const
  const first = (text: string) => text.split('\n')[0]

  for (const { kind, label } of kinds)
    it(`builds the ${kind} code for the card and sends it from SMTP_FROM`, async () => {
      const m = codeMail('en', '716428', kind)
      expect(m.subject.startsWith('716428 ')).toBe(true)
      expect(first(m.text)).toBe('Your SocialMonitor code is 716428 · works for 10 minutes')
      // Gradient's ink pass, with the label next to the digits as plain text.
      expect(m.html).toContain('g-e-pass-ink')
      expect(m.text).toContain(`${label}: 716428`)

      sent.length = 0
      await sendMail('ana@example.test', m)
      expect(sent).toHaveLength(1)
      const out = sent[0]!
      expect(out.from).toBe('SocialMonitor <no-reply@shades.md>')
      expect(out.subject).toBe(m.subject)
      expect(first(String(out.text))).toBe(first(m.text))
      // Nothing may move the sender away from SMTP_FROM.
      for (const k of ['sender', 'envelope', 'replyTo']) expect(out).not.toHaveProperty(k)
    })

  it('says the real lifetime, and keeps the code first in every language', () => {
    expect(first(codeMail('en', '402913', 'reset', 30).text)).toBe(
      'Your SocialMonitor code is 402913 · works for 30 minutes',
    )
    const want: Record<string, string> = {
      ro: 'Codul tău SocialMonitor este 402913 · valabil 10 minute',
      ru: 'Ваш код SocialMonitor: 402913 · действует 10 минут',
      fr: 'Votre code SocialMonitor est 402913 · valable 10 minutes',
      zh: '你的 SocialMonitor 验证码是 402913 · 10分钟内有效',
    }
    for (const [lang, line] of Object.entries(want))
      for (const kind of ['signin', 'reset'] as const) {
        const m = codeMail(lang, '402913', kind)
        expect(m.subject.startsWith('402913 ')).toBe(true)
        expect(first(m.text)).toBe(line)
        expect(m.html).toContain('g-e-pass-ink')
      }
  })
})
