import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { PostRow } from '../api.ts'
import { api } from '../api.ts'
import { Empty, NetworkMark, Segmented, count, fmt, when } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import { t } from '../i18n.ts'
import { usePref } from '../prefs.ts'
import { MoodStrip, PostCard, PostDrawer } from '../social.tsx'

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
        <div class={`sm-wall sm-wall--${cols}`} style={{ '--cols': cols }}>
          {rows.map((p) => (
            <PostCard p={p} onOpen={setOpenPost} />
          ))}
        </div>
      )}
      <PostDrawer post={openPost} brands={brands} onClose={() => setOpenPost(null)} />
    </div>
  )
}
