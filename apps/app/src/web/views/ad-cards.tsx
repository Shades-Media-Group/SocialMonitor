import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { BrandIconName } from 'shades-gradient'
import { renderIcon } from 'shades-gradient'
import { locale, t } from '../i18n.ts'
import { Icon, Modal, count, fmt, when } from '../ui.tsx'

/**
 * The Ads dashboard's cards: each ad drawn the way it runs in a feed, its Page on top, its text,
 * its creative at its own shape (a 9:16 video stays tall, a carousel shows every card), then where
 * it leads. A card opens a pop-up with everything the Ad Library shows for it.
 */

export interface AdMedia {
  position: number
  kind: string
  path: string | null
  width: number | null
  height: number | null
  video_url: string | null
  video_hd_url: string | null
  expires_at: string | null
  title: string | null
  body: string | null
  link_url: string | null
  caption: string | null
  cta: string | null
  cta_type: string | null
  link_description: string | null
}
export interface Ad {
  library_id: string
  page_id: string
  page_name: string | null
  active: number
  started_on: string | null
  ended_on: string | null
  platforms: string
  body: string
  title: string | null
  caption: string | null
  link_url: string | null
  cta: string | null
  cta_type: string | null
  format: string | null
  media_kind: string | null
  media_path: string | null
  media_type: string | null
  media_set: string | null
  versions: number | null
  categories: string
  reach: string | null
  spend: string | null
  impressions: string | null
  country: string | null
  page_avatar: string | null
  page_url: string | null
  page_likes: number | null
  page_categories: string
  link_description: string | null
  disclaimer: string | null
  digital_media: number
  countries: string
  first_seen_at: string
  last_seen_at: string
  days: number | null
  media: AdMedia[]
}
export interface Owner {
  page_id: string
  label: string | null
  page_name: string | null
  own: number
  avatar: string | null
}

export const PLATFORM: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  messenger: 'Messenger',
  audience_network: 'Audience Network',
  whatsapp: 'WhatsApp',
  threads: 'Threads',
}
/** The platforms the shared icon set draws; the rest are named in words. */
const MARKS: Record<string, BrandIconName> = {
  facebook: 'facebook',
  instagram: 'instagram',
  whatsapp: 'whatsapp',
}

const dayFmt = new Intl.DateTimeFormat(locale, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})
export const day = (d: string | null) => (d ? dayFmt.format(new Date(`${d}T00:00:00Z`)) : '–')
export const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
export const libraryLink = (id: string) =>
  `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`
export const nameOf = (a: Pick<Owner, 'label' | 'page_name' | 'page_id'>) =>
  a.label || a.page_name || a.page_id
const list = (json: string | null | undefined) => {
  try {
    const v = JSON.parse(json || '[]') as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
/** Only http(s) links are followed; anything else is shown as words. */
const safe = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : null)

/** Running since a day, or the days it ran. */
export const runLine = (ad: Ad) =>
  ad.active
    ? t('Since {date}', { date: day(ad.started_on) })
    : `${day(ad.started_on)} – ${day(ad.ended_on)}`

/** What a creative's own card says, falling back to the ad's. */
function wordsOf(ad: Ad, m: AdMedia | undefined) {
  const link = safe(m?.link_url) ?? safe(ad.link_url)
  return {
    title: m?.title ?? ad.title,
    body: ad.body || m?.body || '',
    link,
    caption: m?.caption ?? ad.caption ?? (link ? host(link) : null),
    description: m?.link_description ?? ad.link_description,
    cta: m?.cta ?? ad.cta,
  }
}

export function PageFace({ owner, ad, size = 32 }: { owner?: Owner; ad: Ad; size?: number }) {
  const src = ad.page_avatar ?? owner?.avatar
  const name = owner ? nameOf(owner) : (ad.page_name ?? ad.page_id)
  return (
    <span class="sm-adface" style={{ width: size, height: size }} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" /> : <span>{name.slice(0, 1)}</span>}
    </span>
  )
}

export function Platforms({ json }: { json: string }) {
  const all = list(json)
  if (!all.length) return null
  const drawn = all.filter((p) => MARKS[p])
  const rest = all.length - drawn.length
  const names = all.map((p) => PLATFORM[p] ?? p).join(', ')
  return (
    <span class="sm-adplat" role="img" aria-label={names} title={names}>
      {drawn.map((p) => (
        <span dangerouslySetInnerHTML={{ __html: renderIcon(MARKS[p]!, 14) }} />
      ))}
      {rest > 0 && <span class="sm-adplat__more g-num">+{rest}</span>}
    </span>
  )
}

/** A creative's frame keeps its own shape; a missing size falls back to a square. */
const ratio = (m: AdMedia) => (m.width && m.height ? `${m.width} / ${m.height}` : '1 / 1')

/**
 * One creative: a picture, or a video's still with a play button. A video plays from Meta's own
 * link, only when pressed; once the link has expired (or fails), its still stays with a way to
 * watch it in the Ad Library.
 */
function Creative({
  ad,
  m,
  big = false,
  eager = false,
}: {
  ad: Ad
  m: AdMedia
  big?: boolean
  eager?: boolean
}) {
  const [state, setState] = useState<'still' | 'playing' | 'gone'>('still')
  useEffect(() => setState('still'), [ad.library_id, m.position])
  const video = m.kind === 'video'
  const expired = !!m.expires_at && new Date(m.expires_at).getTime() < Date.now()
  const src = big ? (m.video_hd_url ?? m.video_url) : (m.video_url ?? m.video_hd_url)
  const play = (e: Event) => {
    e.stopPropagation()
    setState(!src || expired ? 'gone' : 'playing')
  }
  return (
    <figure class="sm-cr" style={{ '--ar': ratio(m) }}>
      <div class="sm-cr__frame">
        {state === 'playing' && src ? (
          <video
            src={src}
            poster={m.path ?? undefined}
            controls
            autoplay
            muted={!big}
            playsInline
            preload="metadata"
            onError={() => setState('gone')}
            onClick={(e) => e.stopPropagation()}
          />
        ) : m.path ? (
          <img
            src={m.path}
            alt=""
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            width={m.width ?? undefined}
            height={m.height ?? undefined}
          />
        ) : (
          <span class="sm-cr__none">{t('No picture kept')}</span>
        )}
        {video && state === 'still' && (
          <button type="button" class="sm-cr__play" aria-label={t('Play the video')} onClick={play}>
            <Icon name="play" size={big ? 26 : 22} />
          </button>
        )}
      </div>
      {state === 'gone' && (
        <figcaption class="sm-cr__gone">
          {t('This video’s link from Meta has expired.')}{' '}
          <a
            href={libraryLink(ad.library_id)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {t('Watch it in the Ad Library')}
          </a>
        </figcaption>
      )}
    </figure>
  )
}

/**
 * All of an ad's creatives: one alone, or a strip that snaps card by card, with a counter and
 * arrows. Swiping, the arrows and the arrow keys all move it; `at` follows what is in view.
 */
export function Creatives({
  ad,
  at,
  onAt,
  big = false,
}: {
  ad: Ad
  at: number
  onAt: (i: number) => void
  big?: boolean
}) {
  const strip = useRef<HTMLDivElement>(null)
  const media = ad.media
  const n = media.length
  // Moving `at` from outside (a thumbnail, the arrows) scrolls the strip to it.
  useEffect(() => {
    const s = strip.current
    if (!s) return
    const left = at * s.clientWidth
    if (Math.abs(s.scrollLeft - left) > 4) s.scrollTo({ left, behavior: 'smooth' })
  }, [at])
  if (!n) return null
  if (n === 1) return <Creative ad={ad} m={media[0]!} big={big} eager={big} />
  const versions = ad.media_set === 'versions'
  const go = (i: number) => onAt(Math.max(0, Math.min(n - 1, i)))
  const label = versions
    ? t('Version {at} of {n}', { at: at + 1, n })
    : t('Card {at} of {n}', { at: at + 1, n })
  return (
    <div
      class="sm-crs"
      role="group"
      aria-roledescription={versions ? t('versions') : t('carousel')}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault()
          e.stopPropagation()
          go(at + (e.key === 'ArrowRight' ? 1 : -1))
        }
      }}
    >
      <div
        ref={strip}
        class="sm-crs__strip"
        onScroll={(e) => {
          const s = e.currentTarget
          const i = Math.round(s.scrollLeft / Math.max(1, s.clientWidth))
          if (i !== at) onAt(i)
        }}
      >
        {media.map((m, i) => (
          <div class="sm-crs__slide" aria-hidden={i !== at ? 'true' : undefined}>
            <Creative ad={ad} m={m} big={big} eager={big && i === at} />
          </div>
        ))}
      </div>
      <span class="sm-crs__count g-num" aria-hidden="true">
        {at + 1} / {n}
      </span>
      <button
        type="button"
        class="sm-crs__arrow sm-crs__arrow--prev"
        aria-label={versions ? t('Previous version') : t('Previous card')}
        disabled={at === 0}
        onClick={(e) => {
          e.stopPropagation()
          go(at - 1)
        }}
      >
        <Icon name="chevronLeft" size={16} />
      </button>
      <button
        type="button"
        class="sm-crs__arrow sm-crs__arrow--next"
        aria-label={versions ? t('Next version') : t('Next card')}
        disabled={at === n - 1}
        onClick={(e) => {
          e.stopPropagation()
          go(at + 1)
        }}
      >
        <Icon name="chevronRight" size={16} />
      </button>
    </div>
  )
}

/** Where the ad leads: its caption, headline and description, with its button's words. */
function LinkBar({ ad, m }: { ad: Ad; m: AdMedia | undefined }) {
  const w = wordsOf(ad, m)
  if (!w.link && !w.title && !w.cta) return null
  const inner = (
    <>
      <span class="sm-adlink__text">
        {w.caption && <span class="sm-adlink__host">{host(w.caption)}</span>}
        {w.title && <b>{w.title}</b>}
        {w.description && <span class="sm-adlink__desc">{w.description}</span>}
      </span>
      {w.cta && <span class="sm-adlink__cta">{w.cta}</span>}
    </>
  )
  return w.link ? (
    <a
      class="sm-adlink"
      href={w.link}
      target="_blank"
      rel="noreferrer"
      title={w.link}
      onClick={(e) => e.stopPropagation()}
    >
      {inner}
    </a>
  ) : (
    <div class="sm-adlink">{inner}</div>
  )
}

/** One ad as a card. A click anywhere but its own controls opens the pop-up. */
export function AdCard({
  ad,
  owner,
  onOpen,
}: {
  ad: Ad
  owner?: Owner
  onOpen: (id: string) => void
}) {
  const [at, setAt] = useState(0)
  const m = ad.media[at]
  const words = wordsOf(ad, m)
  const name = owner ? nameOf(owner) : (ad.page_name ?? ad.page_id)
  return (
    <article
      class="sm-adcard"
      onClick={(e) => {
        if ((e.target as Element).closest('a, button, video, input, select')) return
        onOpen(ad.library_id)
      }}
    >
      <header class="sm-adcard__head">
        <PageFace owner={owner} ad={ad} />
        <span class="sm-adcard__who">
          <b>{name}</b>
          <span>
            <span class={ad.active ? 'sm-adstate is-on' : 'sm-adstate'}>
              {ad.active ? t('Running') : t('Stopped')}
            </span>
            <span class="g-num"> · {runLine(ad)}</span>
          </span>
        </span>
        <Platforms json={ad.platforms} />
      </header>
      {words.body ? (
        <p class="sm-adcard__body">{words.body}</p>
      ) : !words.title ? (
        <p class="sm-adcard__body is-quiet">{t('No text.')}</p>
      ) : null}
      <Creatives ad={ad} at={at} onAt={setAt} />
      <LinkBar ad={ad} m={m} />
      <footer class="sm-adcard__foot">
        <span class="g-num">
          {ad.versions && ad.versions > 1
            ? t('{n} ads use this creative', { n: fmt(ad.versions) })
            : t('Library ID {id}', { id: ad.library_id })}
        </span>
        <button type="button" class="sm-adcard__open" onClick={() => onOpen(ad.library_id)}>
          {t('Ad details')}
          <Icon name="chevronRight" size={14} />
        </button>
      </footer>
    </article>
  )
}

/**
 * Cards in columns of their natural heights: each card spans as many 4px grid rows as it is tall,
 * so a tall video and a wide picture sit side by side without gaps, and the order stays the
 * reading and tabbing order.
 */
export function Masonry({ children }: { children: ComponentChildren[] }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const grid = box.current
    if (!grid) return
    const fit = (cell: HTMLElement) => {
      const card = cell.firstElementChild as HTMLElement | null
      if (!card) return
      const gap = parseFloat(getComputedStyle(grid).getPropertyValue('--gap')) || 16
      cell.style.gridRowEnd = `span ${Math.ceil((card.getBoundingClientRect().height + gap) / 4)}`
    }
    const watch = new ResizeObserver((entries) => {
      for (const e of entries) fit((e.target as HTMLElement).parentElement!)
    })
    for (const cell of grid.children) {
      fit(cell as HTMLElement)
      if (cell.firstElementChild) watch.observe(cell.firstElementChild)
    }
    return () => watch.disconnect()
  })
  return (
    <div ref={box} class="sm-masonry">
      {children.map((c) => (
        <div class="sm-masonry__cell">{c}</div>
      ))}
    </div>
  )
}

/**
 * Everything kept about one ad: its creatives large, its full text, where it leads, every field
 * the Ad Library shows, its cards' own words, and the way to the next and previous ad.
 */
export function AdDialog({
  ad,
  owner,
  onClose,
  onStep,
  prev,
  next,
}: {
  ad: Ad
  owner?: Owner
  onClose: () => void
  /** Moves to the ad before (-1) or after (1), where there is one. */
  onStep: (d: -1 | 1) => void
  prev: boolean
  next: boolean
}) {
  const [at, setAt] = useState(0)
  useEffect(() => setAt(0), [ad.library_id])
  const m = ad.media[at]
  const w = wordsOf(ad, m)
  const name = owner ? nameOf(owner) : (ad.page_name ?? ad.page_id)
  const platforms = list(ad.platforms).map((p) => PLATFORM[p] ?? p)
  const countries = list(ad.countries)
  const categories = list(ad.categories)
  const pageCats = list(ad.page_categories)
  const own = ad.media.filter((x) => x.title || x.body || x.link_url)
  const versions = ad.media_set === 'versions'
  const kind =
    ad.media_type === 'carousel'
      ? t('Carousel of {n}', { n: ad.media.length })
      : ad.media_type === 'video'
        ? t('Video')
        : ad.media_type === 'text'
          ? t('Text only')
          : t('Picture')
  // Every field kept, in the Ad Library's order; a field Meta did not show is left out.
  const rows = (
    [
      [t('Library ID'), <span class="g-num">{ad.library_id}</span>],
      [t('Status'), ad.active ? t('Running') : t('Stopped')],
      [t('Started'), <span class="g-num">{day(ad.started_on)}</span>],
      !ad.active && [t('Ended'), <span class="g-num">{day(ad.ended_on)}</span>],
      !!ad.days && [ad.active ? t('Running for') : t('Ran for'), count(ad.days, 'day')],
      [t('Platforms'), platforms.join(', ') || '–'],
      [t('Creative'), versions ? `${kind} · ${t('{n} versions', { n: ad.media.length })}` : kind],
      !!ad.versions && ad.versions > 1 && [t('Ads using it'), fmt(ad.versions)],
      !!w.cta && [t('Call to action'), w.cta],
      !!w.link && [
        t('Link'),
        <a href={w.link} target="_blank" rel="noreferrer" class="sm-addl__url">
          {w.link}
        </a>,
      ],
      categories.length > 0 && [t('Category'), categories.join(', ')],
      !!ad.disclaimer && [t('Paid for by'), ad.disclaimer],
      !!ad.reach && [t('Reach'), ad.reach],
      !!ad.impressions && [t('Impressions'), ad.impressions],
      !!ad.spend && [t('Spent'), ad.spend],
      countries.length > 0 && [t('Countries'), countries.join(', ')],
      !!ad.digital_media && [t('Made or changed digitally'), t('Labelled by Meta')],
      [t('Searched in'), ad.country === 'ALL' ? t('All countries') : (ad.country ?? '–')],
      [
        t('Kept since'),
        <span class="g-num">
          {when(ad.first_seen_at)}
          {ad.last_seen_at !== ad.first_seen_at &&
            ` · ${t('last seen {when}', { when: when(ad.last_seen_at) })}`}
        </span>,
      ],
    ] as ([string, ComponentChildren] | false)[]
  ).filter((r): r is [string, ComponentChildren] => !!r)
  return (
    <Modal title={w.title ?? t('Ad {id}', { id: ad.library_id })} onClose={onClose} wide>
      <div
        class={ad.media.length ? 'sm-addlg' : 'sm-addlg sm-addlg--text'}
        onKeyDown={(e) => {
          const tag = (e.target as Element).tagName
          if (tag === 'INPUT' || tag === 'VIDEO') return
          if (e.key === 'ArrowRight' && next) onStep(1)
          if (e.key === 'ArrowLeft' && prev) onStep(-1)
        }}
      >
        {ad.media.length > 0 && (
          <div class="sm-addlg__stage">
            <Creatives ad={ad} at={at} onAt={setAt} big />
            {ad.media.length > 1 && (
              <div
                class="sm-addlg__thumbs"
                role="group"
                aria-label={versions ? t('Versions') : t('Cards')}
              >
                {ad.media.map((x, i) => (
                  <button
                    type="button"
                    aria-pressed={i === at}
                    aria-label={
                      versions
                        ? t('Version {at} of {n}', { at: i + 1, n: ad.media.length })
                        : t('Card {at} of {n}', { at: i + 1, n: ad.media.length })
                    }
                    style={{ '--ar': ratio(x) }}
                    onClick={() => setAt(i)}
                  >
                    {x.path ? <img src={x.path} alt="" loading="lazy" /> : <span />}
                    {x.kind === 'video' && <Icon name="play" size={12} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div class="sm-addlg__side">
          <header class="sm-addlg__head">
            <PageFace owner={owner} ad={ad} size={36} />
            <span class="sm-adcard__who">
              {safe(ad.page_url) ? (
                <a href={safe(ad.page_url)!} target="_blank" rel="noreferrer">
                  <b>{name}</b>
                </a>
              ) : (
                <b>{name}</b>
              )}
              <span>
                <span class={ad.active ? 'sm-adstate is-on' : 'sm-adstate'}>
                  {ad.active ? t('Running') : t('Stopped')}
                </span>
                <span class="g-num"> · {runLine(ad)}</span>
              </span>
            </span>
            <span class="sm-addlg__steps">
              <button
                type="button"
                class="g-icon-btn"
                aria-label={t('Previous ad')}
                disabled={!prev}
                onClick={() => onStep(-1)}
              >
                <Icon name="chevronLeft" />
              </button>
              <button
                type="button"
                class="g-icon-btn"
                aria-label={t('Next ad')}
                disabled={!next}
                onClick={() => onStep(1)}
              >
                <Icon name="chevronRight" />
              </button>
            </span>
          </header>
          <div class="sm-addlg__scroll">
            <h2 class="sm-addlg__title">{w.title ?? t('Ad {id}', { id: ad.library_id })}</h2>
            {w.body ? <p class="sm-addlg__body">{w.body}</p> : null}
            <LinkBar ad={ad} m={m} />
            <h3 class="sm-addlg__sub">{t('Details')}</h3>
            <dl class="sm-addl">
              {rows.map(([k, v]) => (
                <>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </>
              ))}
            </dl>
            {own.length > 1 && (
              <>
                <h3 class="sm-addlg__sub">{versions ? t('Versions') : t('Cards')}</h3>
                <ol class="sm-adcards-list">
                  {own.map((x) => (
                    <li>
                      <button
                        type="button"
                        aria-current={x.position === at ? 'true' : undefined}
                        onClick={() => setAt(x.position)}
                      >
                        <span class="sm-adcards-list__n g-num">{x.position + 1}</span>
                        <span>
                          {x.title && <b>{x.title}</b>}
                          {x.body && x.body !== ad.body && <span>{x.body}</span>}
                          {safe(x.link_url) && (
                            <span class="sm-adcards-list__url">{host(x.link_url!)}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {(ad.page_likes != null || pageCats.length > 0) && (
              <>
                <h3 class="sm-addlg__sub">{t('About the Page')}</h3>
                <dl class="sm-addl">
                  {ad.page_likes != null && (
                    <>
                      <dt>{t('Page likes')}</dt>
                      <dd class="g-num">{fmt(ad.page_likes)}</dd>
                    </>
                  )}
                  {pageCats.length > 0 && (
                    <>
                      <dt>{t('Page category')}</dt>
                      <dd>{pageCats.join(', ')}</dd>
                    </>
                  )}
                  <dt>{t('Page ID')}</dt>
                  <dd class="g-num">{ad.page_id}</dd>
                </dl>
              </>
            )}
          </div>
          <footer class="sm-addlg__foot">
            <a
              class="g-btn g-btn--sm"
              href={libraryLink(ad.library_id)}
              target="_blank"
              rel="noreferrer"
            >
              {t('Open in the Ad Library')}
              <Icon name="external" size={14} />
            </a>
          </footer>
        </div>
      </div>
    </Modal>
  )
}
