import { useEffect, useState } from 'preact/hooks'
import type { IconName } from 'shades-gradient'
import type { AppState } from './app.tsx'
import type { CommentRow, Network, PostRow } from './api.ts'
import { api } from './api.ts'
import { Head, Icon, NetworkMark, Row, Scroller, ago, count, fmt, short, when } from './ui.tsx'
import { usePref } from './prefs.ts'
import { MoodStrip, PostDrawer } from './social.tsx'
import { CommentList } from './views/comments.tsx'
import { Donut } from './charts.tsx'
import { t } from './i18n.ts'
import { JsonPanel } from './json.tsx'

const NETS: Network[] = ['instagram', 'facebook', 'tiktok']
const PLACEHOLDER: Record<Network, string> = {
  instagram: 'https://www.instagram.com/brand',
  facebook: 'https://www.facebook.com/Brand',
  tiktok: 'https://www.tiktok.com/@brand',
}

interface Compare {
  id: number
  name: string
  comments: number
  reach: number
  posts: number
  complaint_share: number | null
  praise_share: number | null
  reputation: number | null
  share_of_voice: number | null
  response_rate: number | null
}
const share = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`)

/** What the tiles at the top switch the page to. */
type Tab = 'brands' | 'comments' | 'waiting' | 'reputation' | 'reach' | 'posts'

/** Every brand's rows of one kind, merged newest first; works for any role, brand by brand. */
function useAcross<T extends { posted_at: string | null }>(
  path: string | null,
  brandIds: number[],
): T[] | null {
  const [rows, setRows] = useState<T[] | null>(null)
  useEffect(() => {
    if (!path) return
    setRows(null)
    Promise.all(
      brandIds.map((id) => api.get<T[]>(`${path}${path.includes('?') ? '&' : '?'}brand=${id}`)),
    )
      .then((all) =>
        setRows(all.flat().sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''))),
      )
      .catch(() => setRows([]))
  }, [path, brandIds.join()])
  return rows
}

/** Every brand you can see, side by side for the last 30 days. */
export function Home({
  brands,
  mode,
  adding,
  reload,
  notify,
  actions,
  me,
}: AppState & { adding: boolean }) {
  const [cmp, setCmp] = useState<Compare[]>([])
  useEffect(() => {
    api
      .get<Compare[]>('/api/compare?days=30')
      .then(setCmp)
      .catch(() => setCmp([]))
  }, [brands])
  const row = (id: number) => cmp.find((c) => c.id === id)
  const [tab, setTab] = usePref<Tab>('home.tab', 'brands')
  const [tick, setTick] = useState(0)
  const [openPost, setOpenPost] = useState<PostRow | null>(null)
  const ids = brands.map((b) => b.id)
  const comments = useAcross<CommentRow>(
    tab === 'comments'
      ? `/api/comments?threads=1&limit=60&t=${tick}`
      : tab === 'waiting'
        ? `/api/comments?threads=1&reply=1&limit=200&t=${tick}`
        : null,
    ids,
  )
  const posts = useAcross<PostRow>(tab === 'posts' ? '/api/posts?limit=100' : null, ids)
  // The brands table and the bars follow the chosen figure.
  const metric = (id: number) => {
    const c = row(id)
    return tab === 'reputation' ? (c?.reputation ?? -1) : tab === 'reach' ? (c?.reach ?? 0) : 0
  }
  const sorted =
    tab === 'reputation' || tab === 'reach'
      ? [...brands].sort((a, b) => metric(b.id) - metric(a.id))
      : brands

  if (mode === 'json')
    return (
      <main class="sm-page">
        <Head title={t('All brands')} actions={actions} />
        <JsonPanel
          value={brands.map((b) => ({
            id: b.id,
            name: b.name,
            industry: b.industry,
            waiting_for_answer: b.counts.needs_reply ?? 0,
            last_30_days: row(b.id) ?? null,
            networks: b.profiles.map((p) => ({
              network: p.network,
              handle: p.handle,
              last_update: p.last_run_at,
              status: p.last_status,
            })),
          }))}
        />
      </main>
    )

  return (
    <main class="sm-page sm-ga">
      <Head
        title={adding ? t('Add a brand') : t('All brands')}
        sub={adding ? undefined : t('Last 30 days')}
        actions={actions}
      />
      {adding || !brands.length ? (
        me.super ? (
          <NewBrand reload={reload} notify={notify} />
        ) : (
          <div class="sm-empty sm-empty--page">
            <p class="sm-empty__title">{t('No brands for you yet.')}</p>
            <p class="sm-empty__body">{t('Ask an admin to give you access to a brand.')}</p>
          </div>
        )
      ) : (
        <>
          {(() => {
            const sum = (k: 'comments' | 'reach' | 'posts') =>
              cmp.reduce((n, c) => n + (c[k] ?? 0), 0)
            const waitingAll = brands.reduce((n, b) => n + (b.counts.needs_reply ?? 0), 0)
            const reps = cmp.filter((c) => c.reputation != null)
            const avgRep = reps.length
              ? Math.round(reps.reduce((n, c) => n + c.reputation!, 0) / reps.length)
              : null
            const tone = (i: number) => `b${i % 6}`
            const maxC = Math.max(1, ...cmp.map((c) => c.comments))
            return (
              <>
                <div class="sm-ga__cards sm-hometabs" role="tablist" aria-label={t('Show')}>
                  {(
                    [
                      ['brands', 'grid', t('Brands'), fmt(brands.length)],
                      ['comments', 'chat', t('Comments'), fmt(sum('comments'))],
                      ['waiting', 'schedule', t('Waiting for an answer'), fmt(waitingAll)],
                      [
                        'reputation',
                        'star',
                        t('Average reputation'),
                        avgRep == null ? '–' : `${avgRep}`,
                      ],
                      ['reach', 'visibility', t('Reach'), short(sum('reach'))],
                      ['posts', 'image', t('Posts'), fmt(sum('posts'))],
                    ] as [Tab, IconName, string, string][]
                  ).map(([k, icon, label, value]) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === k}
                      class="sm-ga__card"
                      onClick={() => setTab(k)}
                    >
                      <span class="sm-ga__label">
                        <Icon name={icon} size={14} /> {label}
                      </span>
                      <span
                        class={`sm-ga__value g-num${k === 'waiting' && waitingAll ? ' sm-hot' : ''}`}
                      >
                        {value}
                      </span>
                    </button>
                  ))}
                </div>
                {(tab === 'brands' || tab === 'reputation' || tab === 'reach') && (
                  <div class="sm-layout sm-home-charts">
                    <section class="sm-box sm-span-4">
                      <header class="sm-box__head">
                        <h2>{t('Share of voice')}</h2>
                        <span class="sm-box__meta">{t('Last 30 days')}</span>
                      </header>
                      <Donut
                        parts={cmp.map((c, i) => ({ key: tone(i), name: c.name, n: c.comments }))}
                        total={fmt(sum('comments'))}
                        caption={t('comments')}
                      />
                    </section>
                    <section class="sm-box sm-span-8">
                      <header class="sm-box__head">
                        <h2>
                          {tab === 'reputation'
                            ? t('Reputation per brand')
                            : tab === 'reach'
                              ? t('Reach per brand')
                              : t('Comments per brand')}
                        </h2>
                        <span class="sm-box__meta">{t('Last 30 days')}</span>
                      </header>
                      <ul class="sm-bars">
                        {(tab === 'brands'
                          ? cmp
                          : [...cmp].sort((a, b) =>
                              tab === 'reach'
                                ? b.reach - a.reach
                                : (b.reputation ?? -1) - (a.reputation ?? -1),
                            )
                        ).map((c, i) => {
                          const v =
                            tab === 'reputation'
                              ? (c.reputation ?? 0)
                              : tab === 'reach'
                                ? c.reach
                                : c.comments
                          const max =
                            tab === 'reputation'
                              ? 100
                              : tab === 'reach'
                                ? Math.max(1, ...cmp.map((x) => x.reach))
                                : maxC
                          return (
                            <li>
                              <span class="sm-bars__name">{c.name}</span>
                              <span class="sm-bars__track">
                                <span
                                  class={`sm-bars__fill sm-c-${tone(cmp.indexOf(c) >= 0 ? cmp.indexOf(c) : i)}`}
                                  style={{ width: `${Math.max(2, (v / max) * 100)}%` }}
                                />
                              </span>
                              <b class="g-num">
                                {tab === 'reputation'
                                  ? (c.reputation ?? '–')
                                  : tab === 'reach'
                                    ? short(v)
                                    : fmt(v)}
                              </b>
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  </div>
                )}
              </>
            )
          })()}
          {(tab === 'comments' || tab === 'waiting') &&
            (comments === null ? null : comments.length ? (
              <Scroller
                head={
                  <header class="sm-box__head">
                    <h2>{tab === 'waiting' ? t('Waiting for an answer') : t('Newest comments')}</h2>
                    <span class="sm-box__meta">{count(comments.length, 'comment')}</span>
                  </header>
                }
              >
                <CommentList
                  comments={comments}
                  brands={brands}
                  showPost
                  onChange={() => setTick((x) => x + 1)}
                />
              </Scroller>
            ) : (
              <p class="sm-quiet">
                {tab === 'waiting'
                  ? t('Nothing waits for an answer.')
                  : t('Comments appear here after the first update.')}
              </p>
            ))}
          {tab === 'posts' && posts && (
            <section class="sm-box sm-box--table">
              <header class="sm-box__head">
                <h2>{count(posts.length, 'post')}</h2>
              </header>
              <div class="sm-scroll">
                <table class="sm-dtable sm-dtable--rows">
                  <thead>
                    <tr>
                      <th>{t('Post')}</th>
                      <th>{t('Brand')}</th>
                      <th>{t('Published')}</th>
                      <th class="sm-num">{t('Likes')}</th>
                      <th class="sm-num">{t('Comments')}</th>
                      <th class="sm-num">{t('Shares')}</th>
                      <th class="sm-num">{t('Views')}</th>
                      <th>{t('What people say')}</th>
                      <th class="sm-num">{t('To answer')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posts.map((p) => (
                      <tr class="sm-ctable__row" onClick={() => setOpenPost(p)}>
                        <td>
                          <span class="sm-postcell">
                            {p.thumb_url ? (
                              <img src={p.thumb_url} alt="" loading="lazy" />
                            ) : (
                              <span class="sm-postcell__blank" />
                            )}
                            <NetworkMark network={p.network} size={13} />
                            <span class="sm-postcell__text">
                              {p.description ?? p.caption ?? t('No caption.')}
                            </span>
                          </span>
                        </td>
                        <td class="sm-nowrap">{brands.find((b) => b.id === p.brand_id)?.name}</td>
                        <td class="sm-nowrap">{when(p.posted_at)}</td>
                        <td class="sm-num g-num">{fmt(p.likes)}</td>
                        <td class="sm-num g-num">{fmt(p.comments_count)}</td>
                        <td class="sm-num g-num">{fmt(p.shares)}</td>
                        <td class="sm-num g-num">{fmt(p.views)}</td>
                        <td class="sm-ga__mood">
                          <MoodStrip p={p} />
                        </td>
                        <td class={`sm-num g-num${p.waiting ? ' sm-hot' : ''}`}>
                          {p.waiting || '–'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <PostDrawer post={openPost} brands={brands} onClose={() => setOpenPost(null)} />
          {(tab === 'brands' || tab === 'reputation' || tab === 'reach') && (
            <section class="sm-box">
              <div class="sm-scroll">
                <table class="sm-dtable sm-dtable--rows sm-brandtable">
                  <thead>
                    <tr>
                      <th>{t('Brand')}</th>
                      <th>{t('Networks')}</th>
                      <th class="sm-num">{t('To answer')}</th>
                      <th class="sm-num">{t('Comments')}</th>
                      <th class="sm-num">{t('Complaints')}</th>
                      <th class="sm-num">{t('Praise')}</th>
                      <th class="sm-num">{t('Reputation')}</th>
                      <th class="sm-num">{t('Answered')}</th>
                      <th class="sm-num">{t('Share of voice')}</th>
                      <th class="sm-num">{t('Updated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((b) => {
                      const c = row(b.id)
                      const waiting = b.counts.needs_reply ?? 0
                      const last = b.profiles
                        .map((p) => p.last_run_at)
                        .filter(Boolean)
                        .sort()
                        .at(-1)
                      const trouble = b.profiles.some((p) => p.last_status === 'error')
                      return (
                        <tr onClick={() => (location.hash = `#/b/${b.id}/overview`)}>
                          <td>
                            <a class="sm-brandcell" href={`#/b/${b.id}/overview`}>
                              <span class="sm-nav__initial" aria-hidden="true">
                                {b.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span>
                                <b>{b.name}</b>
                                {b.industry && <span class="sm-brandcell__sub">{b.industry}</span>}
                              </span>
                            </a>
                          </td>
                          <td>
                            <span class="sm-netrow">
                              {NETS.filter((n) => b.profiles.some((p) => p.network === n)).map(
                                (n) => (
                                  <NetworkMark network={n} size={15} />
                                ),
                              )}
                            </span>
                          </td>
                          <td class={`sm-num g-num${waiting ? ' sm-hot' : ''}`}>{fmt(waiting)}</td>
                          <td class="sm-num g-num">{fmt(c?.comments)}</td>
                          <td class="sm-num g-num">{share(c?.complaint_share)}</td>
                          <td class="sm-num g-num">{share(c?.praise_share)}</td>
                          <td class="sm-num g-num">{c?.reputation ?? '–'}</td>
                          <td class="sm-num g-num">{share(c?.response_rate)}</td>
                          <td class="sm-num g-num">{share(c?.share_of_voice)}</td>
                          <td class="sm-num">
                            {trouble ? (
                              <span class="sm-status sm-status--error">{t('Needs you')}</span>
                            ) : (
                              ago(last)
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  )
}

function NewBrand({ reload, notify }: Pick<AppState, 'reload' | 'notify'>) {
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState('')
  const [links, setLinks] = useState<Record<Network, string>>({
    instagram: '',
    facebook: '',
    tiktok: '',
  })
  const [error, setError] = useState<string | null>(null)

  const save = async (e: Event) => {
    e.preventDefault()
    setError(null)
    try {
      const b = await api.post<{ id: number }>('/api/brands', {
        name,
        links: NETS.map((n) => links[n].trim()).filter(Boolean),
      })
      if (industry.trim()) await api.patch(`/api/brands/${b.id}`, { industry })
      await reload()
      notify(t('{name} added. Press Update to read it.', { name }))
      location.hash = `#/b/${b.id}/overview`
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section class="sm-panel">
      <form class="sm-form" onSubmit={save}>
        <Row label={t('Name')}>
          <input
            class="g-input"
            required
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </Row>
        <Row
          label={t('Field of work')}
          hint={t('Retail, banking, hospitality… The AI reads it to sort comments better.')}
        >
          <input
            class="g-input"
            value={industry}
            onInput={(e) => setIndustry((e.target as HTMLInputElement).value)}
          />
        </Row>
        {NETS.map((n) => (
          <Row label={{ instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' }[n]}>
            <input
              class="g-input"
              type="url"
              placeholder={PLACEHOLDER[n]}
              value={links[n]}
              onInput={(e) => setLinks({ ...links, [n]: (e.target as HTMLInputElement).value })}
            />
          </Row>
        ))}
        {error && <p class="g-error">{error}</p>}
        <div class="sm-form__actions">
          <button class="g-btn g-btn--primary g-btn--sm" type="submit">
            {t('Add brand')}
          </button>
          <a class="g-btn g-btn--ghost g-btn--sm" href="#/">
            {t('Cancel')}
          </a>
        </div>
      </form>
    </section>
  )
}
