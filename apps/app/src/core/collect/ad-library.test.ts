import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  adsIn,
  adUrl,
  connectionIn,
  country,
  graphqlJson,
  libraryUrl,
  pageIdFrom,
  scriptJson,
  wallIn,
} from './ad-library.ts'

// Real logged-out answers of the Ad Library (2026-11-01): Moldtelecom's Page in Moldova, cut to
// two results, and a page of a keyword search the Library loaded while scrolling.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ad-library/${name}`, import.meta.url), 'utf8')

describe('Page IDs from what people paste', () => {
  it('takes the number, Ad Library links and Page links that carry it', () => {
    expect(pageIdFrom('493563500503276')).toBe('493563500503276')
    expect(pageIdFrom(' 493563500503276 ')).toBe('493563500503276')
    expect(
      pageIdFrom(
        'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=MD&view_all_page_id=493563500503276&media_type=all',
      ),
    ).toBe('493563500503276')
    expect(pageIdFrom('https://www.facebook.com/profile.php?id=100095494695995')).toBe(
      '100095494695995',
    )
    expect(pageIdFrom('facebook.com/people/Earlyone-Moldova/100095494695995/')).toBe(
      '100095494695995',
    )
    expect(pageIdFrom('https://m.facebook.com/43398889886')).toBe('43398889886')
  })

  it('refuses names, other sites and short numbers', () => {
    expect(pageIdFrom('https://www.facebook.com/MoldtelecomSA/')).toBeNull()
    expect(pageIdFrom('https://example.com/?view_all_page_id=493563500503276')).toBeNull()
    expect(pageIdFrom('1234')).toBeNull()
    expect(pageIdFrom('')).toBeNull()
  })

  it('knows countries and builds the public links', () => {
    expect(country('md')).toBe('MD')
    expect(country('ALL')).toBe('ALL')
    expect(country('Moldova')).toBeNull()
    expect(libraryUrl('493563500503276', 'MD')).toBe(
      'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=MD&view_all_page_id=493563500503276&media_type=all',
    )
    expect(adUrl('1632030062058284')).toBe(
      'https://www.facebook.com/ads/library/?id=1632030062058284',
    )
  })
})

describe('reading the page', () => {
  it('finds the ads in the HTML the page arrives with', () => {
    const roots = scriptJson(fixture('page.html'))
    expect(roots).toHaveLength(1)
    const ads = roots.flatMap(adsIn)
    expect(ads).toHaveLength(2)
    const [a] = ads
    expect(a).toMatchObject({
      library_id: '1029883862846673',
      page_id: '493563500503276',
      page_name: 'Moldtelecom',
      active: false,
      started_on: '2026-07-13',
      ended_on: '2026-07-19',
      platforms: ['facebook', 'instagram', 'audience_network', 'messenger', 'whatsapp', 'threads'],
      format: 'DCO',
      link_url: 'https://mtc.md/xiaomitv',
      media_kind: 'image',
      versions: 1,
      categories: [],
      reach: null,
      spend: null,
    })
    // A dynamic ad's text is a placeholder; its first version's text stands in.
    expect(a!.body).toMatch(/^⚽ Compact, smart/)
    expect(a!.title).toBeNull()
    expect(a!.media_url).toMatch(/^https:\/\/scontent\./)
    expect(connectionIn(roots[0])).toEqual({ count: 4, more: false })
  })

  it('reads the pages that load while scrolling, with public reach and spend where shown', () => {
    const roots = graphqlJson(fixture('pagination.json'))
    expect(roots).toHaveLength(2)
    const ads = roots.flatMap(adsIn)
    expect(ads).toHaveLength(2)
    const political = ads.find((a) => a.reach)!
    expect(political.reach).toBe('10K - 50K')
    expect(political.spend).toBe('<€100')
    expect(political.impressions).toBe('4K - 5K')
    expect(political.categories).toEqual(['POLITICAL'])
    expect(connectionIn(roots[0])).toMatchObject({ more: true })
    expect(graphqlJson(`for (;;);${JSON.stringify({ a: 1 })}`)).toEqual([{ a: 1 }])
  })

  it('tells a login wall or a captcha from the Library’s own Log in link', () => {
    expect(wallIn('https://www.facebook.com/ads/library/?id=1', fixture('page.html'))).toBeNull()
    expect(wallIn('https://www.facebook.com/login/?next=%2Fads%2Flibrary', '')).toBe('login')
    expect(wallIn('https://www.facebook.com/checkpoint/1501092823525282/', '')).toBe('login')
    expect(
      wallIn('https://www.facebook.com/ads/library/', '<form id="login_form" action="/login">'),
    ).toBe('login')
    expect(
      wallIn(
        'https://www.facebook.com/ads/library/',
        '{"xfb_ad_library_is_captcha_required":true,"ad_library_main":{}}',
      ),
    ).toBe('captcha')
  })
})
