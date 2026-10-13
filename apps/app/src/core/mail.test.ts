import { describe, expect, it } from 'vitest'
import { accessMail, badMail, codeMail, linkMail } from './mail.ts'

const link = 'https://app.example.test/#/reset/abc.def'

describe('emails in Gradient’s design', () => {
  it('puts the code in the subject, on the pass and in the text twin', () => {
    const m = codeMail('en', '716428')
    expect(m.subject).toBe('Your SocialMonitor code: 716428')
    expect(m.html).toContain('716428')
    expect(m.html).toContain('socialmonitor.shades.md/email/logo.png')
    expect(m.text).toContain('716428')
    expect(m.text).toContain('change your password')
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

  it('speaks the reader’s language and falls back to English', () => {
    expect(codeMail('ro', '111111').subject).toBe('Codul tău SocialMonitor: 111111')
    expect(codeMail('xx', '111111').subject).toBe('Your SocialMonitor code: 111111')
    expect(badMail('fr', 'Tavelo', 12, 'https://app.example.test').subject).toBe(
      'Tavelo : 12 commentaires négatifs',
    )
  })
})
