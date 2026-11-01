import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  adsIn,
  adUrl,
  connectionIn,
  country,
  graphqlJson,
  libraryUrl,
  linkExpiry,
  MEDIA_CAP,
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
    expect(political.disclaimer).toBe('Partidului Politic "Mișcarea Alternativă Națională"')
    expect(political.page_avatar_url).toMatch(/^https:\/\/scontent\./)
    expect(connectionIn(roots[0])).toMatchObject({ more: true })
    expect(graphqlJson(`for (;;);${JSON.stringify({ a: 1 })}`)).toEqual([{ a: 1 }])
  })

  it('keeps every creative at its own shape: a 9:16 video, a carousel, versions, a picture', () => {
    // Orange Moldova's Page in Moldova, read logged out on 2026-11-02: four of its ads.
    const ads = graphqlJson(fixture('orange.json')).flatMap(adsIn)
    const by = (id: string) => ads.find((a) => a.library_id === id)!
    expect(ads).toHaveLength(4)

    const video = by('973795511694566')
    expect(video).toMatchObject({
      media_type: 'video',
      media_set: 'single',
      cta: 'See details',
      cta_type: 'SEE_DETAILS',
      versions: 5,
      page_url: 'https://www.facebook.com/Orange.Moldova/',
      page_likes: 31839084,
      page_categories: ['Public Utility'],
      digital_media: false,
      disclaimer: null,
    })
    expect(video.page_avatar_url).toMatch(/^https:\/\/scontent\..*s60x60/)
    expect(video.media).toHaveLength(1)
    expect(video.media[0]).toMatchObject({ position: 0, kind: 'video' })
    expect(video.media[0]!.video_url).toMatch(/^https:\/\/video\..*\.fbcdn\.net\//)
    expect(video.media[0]!.video_hd_url).toMatch(/^https:\/\/video\./)
    // The still the video shows before it plays.
    expect(video.media[0]!.image_url).toMatch(/^https:\/\/scontent\./)
    expect(linkExpiry(video.media[0]!.video_url)).toMatch(/^2026-/)

    const carousel = by('1012324434833410')
    expect(carousel).toMatchObject({ format: 'MULTI_IMAGES', media_type: 'carousel' })
    expect(carousel.media_set).toBe('carousel')
    expect(carousel.media.map((m) => m.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(carousel.media.every((m) => m.kind === 'image' && !!m.original_url)).toBe(true)

    // A dynamic ad's versions: alternatives with their own words, not cards side by side.
    const dco = by('2212694622925696')
    expect(dco).toMatchObject({ format: 'DCO', media_set: 'versions', media_type: 'image' })
    expect(dco.media).toHaveLength(2)
    expect(dco.media[0]).toMatchObject({ cta: 'See Details', cta_type: 'SEE_DETAILS' })
    expect(dco.media[0]!.body).toMatch(/^Doar 140 lei/)
    expect(dco.media[0]!.link_url).toMatch(/^https:\/\/www\.orange\.md\/GigaFibra/)

    const picture = by('2295562687874886')
    expect(picture).toMatchObject({
      active: true,
      media_type: 'image',
      media_set: 'single',
      title: 'My Orange | Orange Moldova',
      link_description: expect.stringMatching(/^Întregul univers My Orange/),
    })
  })

  it('reads a signed link’s expiry, and nothing from links without one', () => {
    expect(linkExpiry('https://video.example.fbcdn.net/v.mp4?oe=6AEDB260&x=1')).toBe(
      new Date(0x6aedb260 * 1000).toISOString(),
    )
    expect(linkExpiry('https://video.example.fbcdn.net/v.mp4')).toBeNull()
    expect(linkExpiry('https://x.example/?oe=zz')).toBeNull()
    expect(linkExpiry(null)).toBeNull()
  })

  it('caps the creatives of one ad and skips cards with nothing to show', () => {
    const card = (i: number) => ({ resized_image_url: `https://scontent.example/${i}.jpg` })
    const [ad] = adsIn({
      ad_archive_id: '1',
      page_id: '2',
      snapshot: {
        display_format: 'CAROUSEL',
        cards: [{ title: 'empty' }, ...Array.from({ length: MEDIA_CAP + 5 }, (_, i) => card(i))],
      },
    })
    expect(ad!.media).toHaveLength(MEDIA_CAP)
    expect(ad!.media[0]!.image_url).toBe('https://scontent.example/0.jpg')
    expect(ad!.media_type).toBe('carousel')
    const [bare] = adsIn({ ad_archive_id: '3', page_id: '2', snapshot: { body: { text: 'Hi' } } })
    expect(bare).toMatchObject({ media: [], media_set: null, media_type: 'text' })
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
