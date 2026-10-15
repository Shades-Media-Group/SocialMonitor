import { describe, expect, it } from 'vitest'
import { accessMail, badMail, codeMail, digestMail, instantMail, linkMail } from './mail.ts'

const link = 'https://app.example.test/reset/abc.def'

describe('emails in Gradient’s design', () => {
  it('puts the code in the subject, on the pass and in the text twin', () => {
    const m = codeMail('en', '716428')
    expect(m.subject).toBe('716428 is your SocialMonitor sign-in code')
    expect(m.html).toContain('716428')
    expect(m.html).toContain('socialmonitor.shades.md/email/logo.png')
    expect(m.text).toContain('716428')
    expect(m.text).toContain('change your password')
    // Gmail's preview line says how long the code works.
    expect(m.html).toContain('Sign-in code: 716428 · Works for 10 minutes')
  })

  it('sends a password code the same way, with its own words', () => {
    const m = codeMail('en', '402913', 'reset')
    expect(m.subject).toBe('402913 is your SocialMonitor password code')
    expect(m.html).toContain('Password code: 402913 · Works for 10 minutes')
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
})
