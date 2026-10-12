import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { PostRow } from '../api.ts'
import { api } from '../api.ts'
import {
  Empty,
  NETWORK_NAME,
  NetworkMark,
  Scroller,
  Segmented,
  count,
  fmt,
  short,
  when,
} from '../ui.tsx'
import type { Network } from '../api.ts'
import { JsonPanel } from '../json.tsx'
import { locale, t } from '../i18n.ts'
import { usePref } from '../prefs.ts'
import { MoodStrip, PostCard, PostDrawer } from '../social.tsx'

const KIND: Record<string, string> = {
  video: 'Video',
  reel: 'Reel',
  photo: 'Photo',
  post: 'Post',
}

interface Group {
  key: string
  network?: Network
  name: string
  posts: number
  likes: number
  comments: number
  views: number | null
  /** Likes, comments and shares per view, when views are known. */
  rate: number | null
}

/** Sums posts into groups; a post can sit in several (one per hashtag). */
function groups(rows: PostRow[], keys: (p: PostRow) => string[], name: (k: string) => string) {
  const m = new Map<string, PostRow[]>()
  for (const p of rows) for (const k of keys(p)) m.set(k, [...(m.get(k) ?? []), p])
  return [...m].map(([key, ps]): Group => {
    const sum = (f: (p: PostRow) => number | null) => ps.reduce((n, p) => n + (f(p) ?? 0), 0)
    const seen = ps.filter((p) => p.views)
    const acts = seen.reduce(
      (n, p) => n + (p.likes ?? 0) + (p.comments_count ?? 0) + (p.shares ?? 0),
      0,
    )
    const views = sum((p) => (seen.includes(p) ? p.views : 0))
    return {
      key,
      network: ps[0]!.network,
      name: name(key),
      posts: ps.length,
      likes: Math.round(sum((p) => p.likes) / ps.length),
      comments: Math.round(sum((p) => p.comments_count) / ps.length),
      views: seen.length ? Math.round(sum((p) => p.views) / ps.length) : null,
      rate: views ? acts / views : null,
    }
  })
}

const TAG = /#[\p{L}\p{N}_]+/gu

/**
 * What works: averages per post for each format and each hashtag, so the next post can copy
 * what did best. Engagement is likes, comments and shares per view.
 */
function WhatWorks({ rows }: { rows: PostRow[] }) {
  const formats = groups(
    rows,
    (p) => [`${p.network}:${p.kind}`],
    (k) =>
      `${NETWORK_NAME[k.split(':')[0] as Network]} · ${t(KIND[k.split(':')[1]!] ?? k.split(':')[1]!)}`,
  ).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))
  const tags = groups(
    rows,
    (p) => [...new Set((p.caption ?? '').toLowerCase().match(TAG) ?? [])],
    (k) => k,
  )
    .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.posts - a.posts)
    .slice(0, 40)
  const table = (list: Group[], head: string, mark: boolean) => {
    const max = Math.max(0.0001, ...list.map((g) => g.rate ?? 0))
    return (
      <table class="sm-dtable">
        <thead>
          <tr>
            <th>{head}</th>
            <th class="sm-num">{t('Posts')}</th>
            <th class="sm-num">{t('Likes')}</th>
            <th class="sm-num">{t('Comments')}</th>
            <th class="sm-num">{t('Views')}</th>
            <th>{t('Engagement')}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((g) => (
            <tr>
              <td>
                <span class="sm-net-name">
                  {mark && g.network && <NetworkMark network={g.network} size={13} />}
                  {g.name}
                </span>
              </td>
              <td class="sm-num g-num">{fmt(g.posts)}</td>
              <td class="sm-num g-num">{short(g.likes)}</td>
              <td class="sm-num g-num">{short(g.comments)}</td>
              <td class="sm-num g-num">{short(g.views)}</td>
              <td class="sm-works__rate">
                <span class="sm-bars__track">
                  <span
                    class="sm-bars__fill sm-c-praise"
                    style={{ width: `${((g.rate ?? 0) / max) * 100}%` }}
                  />
                </span>
                <b class="g-num">{g.rate == null ? '–' : `${(g.rate * 100).toFixed(1)}%`}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  // Engagement by the weekday a post went out, to pick the next posting day.
  const DAYS = Array.from({ length: 7 }, (_, d) =>
    new Date(Date.UTC(2024, 0, 1 + d)).toLocaleDateString(locale, {
      weekday: 'long',
      timeZone: 'UTC',
    }),
  )
  const byDay = groups(
    rows.filter((p) => p.posted_at),
    (p) => [String((new Date(p.posted_at!).getDay() + 6) % 7)],
    (k) => DAYS[Number(k)]!,
  ).sort((a, b) => Number(a.key) - Number(b.key))
  const maxDay = Math.max(0.0001, ...byDay.map((g) => g.rate ?? 0))
  return (
    <div class="sm-layout sm-layout--top sm-works">
      <div class="sm-stack sm-span-6">
        <section class="sm-box sm-box--table">
          <header class="sm-box__head">
            <h2>{t('What works: formats')}</h2>
            <span class="sm-box__meta">{t('Averages per post')}</span>
          </header>
          <div class="sm-scroll">{table(formats, t('Format'), false)}</div>
        </section>
        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{t('Best days to post')}</h2>
            <span class="sm-box__meta">{t('Engagement by the day a post went out')}</span>
          </header>
          <ul class="sm-bars">
            {byDay.map((g) => (
              <li>
                <span class="sm-bars__name">
                  {g.name}
                  <small>{count(g.posts, 'post')}</small>
                </span>
                <span class="sm-bars__track">
                  <span
                    class="sm-bars__fill sm-c-praise"
                    style={{ width: `${((g.rate ?? 0) / maxDay) * 100}%` }}
                  />
                </span>
                <b class="g-num">{g.rate == null ? '–' : `${(g.rate * 100).toFixed(1)}%`}</b>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <Scroller
        fit="column"
        class="sm-span-6 sm-box--table"
        head={
          <header class="sm-box__head">
            <h2>{t('What works: hashtags')}</h2>
            <span class="sm-box__meta">{t('Averages per post')}</span>
          </header>
        }
      >
        {tags.length ? (
          table(tags, t('Hashtag'), false)
        ) : (
          <p class="sm-quiet">{t('No hashtags in these captions.')}</p>
        )}
      </Scroller>
    </div>
  )
}

/** The posts: a table to compare them, or a contact sheet of the real pictures. */
export function Posts({ brand, network, version, mode, openUpdate, days, brands }: BrandView) {
  const [all, setAll] = useState<PostRow[] | null>(null)
  const [sort, setSort] = usePref<'new' | 'top'>('posts.sort', 'new')
  const [look, setLook] = usePref<'table' | 'grid'>('posts.look.v2', 'table')
  const [cols, setCols] = usePref<'2' | '3' | '4' | '5' | '6'>('posts.cols', '4')
  const [openPost, setOpenPost] = useState<PostRow | null>(null)

  useEffect(() => {
    api
      .get<PostRow[]>(
        `/api/posts?brand=${brand.id}&limit=300&sort=${sort}${network ? `&network=${network}` : ''}`,
      )
      .then(setAll)
      .catch(() => setAll([]))
  }, [brand.id, network, version, sort])

  if (all === null) return null
  const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : ''
  const rows = since ? all.filter((p) => (p.posted_at ?? '') >= since) : all
  if (mode === 'json')
    return (
      <JsonPanel
        value={rows.map((p) => ({
          id: p.id,
          network: p.network,
          posted_at: p.posted_at,
          kind: p.kind,
          about: p.description,
          caption: p.caption,
          likes: p.likes,
          comments: p.comments_count,
          comments_kept: p.stored_comments,
          to_look_at: p.flagged,
          views: p.views,
          shares: p.shares,
          url: p.url,
        }))}
      />
    )
  if (!all.length)
    return (
      <Empty title={t('No posts yet.')}>
        {t('Read the latest posts and their comments.')}{' '}
        <button class="sm-textbtn" type="button" onClick={() => openUpdate(brand.id)}>
          {t('Update now')}
        </button>
      </Empty>
    )

  return (
    <div class="sm-stack">
      <div class="sm-toolbar">
        <Segmented
          label={t('Order')}
          value={sort}
          onChange={setSort}
          options={[
            ['new', t('Newest')],
            ['top', t('Most engaging')],
          ]}
        />
        <span class="sm-toolbar__end">
          {look === 'grid' && (
            <Segmented
              label={t('Per row')}
              value={cols}
              onChange={setCols}
              options={(['2', '3', '4', '5', '6'] as const).map((n) => [
                n,
                t('{n} per row', { n }),
              ])}
            />
          )}
          <Segmented
            label={t('Layout')}
            value={look}
            onChange={setLook}
            options={[
              ['table', t('Table')],
              ['grid', t('Pictures')],
            ]}
          />
        </span>
      </div>
      {rows.length > 1 && <WhatWorks rows={rows} />}
      {!rows.length ? (
        <Empty title={t('No posts in this period.')}>{t('Choose a longer period above.')}</Empty>
      ) : look === 'table' ? (
        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{count(rows.length, 'post')}</h2>
          </header>
          <div class="sm-scroll">
            <table class="sm-dtable sm-dtable--rows">
              <thead>
                <tr>
                  <th>{t('Post')}</th>
                  <th>{t('Published')}</th>
                  <th class="sm-num">{t('Likes')}</th>
                  <th class="sm-num">{t('Comments')}</th>
                  <th class="sm-num">{t('Shares')}</th>
                  <th class="sm-num">{t('Views')}</th>
                  <th class="sm-num">{t('To look at')}</th>
                  <th>{t('What people say')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr class="sm-ctable__row" onClick={() => setOpenPost(p)}>
                    <td>
                      <a class="sm-postcell" href={p.url} target="_blank" rel="noreferrer">
                        {p.thumb_url ? (
                          <img src={p.thumb_url} alt="" loading="lazy" />
                        ) : (
                          <span class="sm-postcell__blank" />
                        )}
                        <NetworkMark network={p.network} size={14} />
                        <span class="sm-postcell__text">
                          {p.description ?? p.caption ?? t('No caption.')}
                        </span>
                      </a>
                    </td>
                    <td class="sm-nowrap">{when(p.posted_at)}</td>
                    <td class="sm-num g-num">{fmt(p.likes)}</td>
                    <td class="sm-num g-num">{fmt(p.comments_count)}</td>
                    <td class="sm-num g-num">{fmt(p.shares)}</td>
                    <td class="sm-num g-num">{fmt(p.views)}</td>
                    <td class={`sm-num g-num${p.flagged ? ' sm-hot' : ''}`}>{fmt(p.flagged)}</td>
                    <td>
                      <MoodStrip p={p} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <>
          <h2 class="sm-section">{count(rows.length, 'post')}</h2>
          <div class={`sm-wall sm-wall--${cols}`} style={{ '--cols': cols }}>
            {rows.map((p) => (
              <PostCard p={p} onOpen={setOpenPost} />
            ))}
          </div>
        </>
      )}
      <PostDrawer post={openPost} brands={brands} onClose={() => setOpenPost(null)} />
    </div>
  )
}
