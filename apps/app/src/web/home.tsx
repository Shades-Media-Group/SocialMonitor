import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import type { Network } from './api.ts'
import { api } from './api.ts'
import { Head, Icon, NetworkMark, Row, ago, fmt, short } from './ui.tsx'
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
    <main class="sm-page">
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
                <dl class="sm-kpis sm-kpis--row">
                  {(
                    [
                      ['blue', 'grid', t('Brands'), fmt(brands.length)],
                      ['violet', 'chat', t('Comments'), fmt(sum('comments'))],
                      ['orange', 'schedule', t('Waiting for an answer'), fmt(waitingAll)],
                      [
                        'green',
                        'star',
                        t('Average reputation'),
                        avgRep == null ? '–' : `${avgRep}`,
                      ],
                      ['pink', 'visibility', t('Reach'), short(sum('reach'))],
                      ['ink', 'image', t('Posts'), fmt(sum('posts'))],
                    ] as const
                  ).map(([tn, icon, label, value]) => (
                    <div class={`sm-kpi sm-tone--${tn}`}>
                      <dt>
                        <span class="sm-kpi__icon">
                          <Icon name={icon} size={16} />
                        </span>
                        {label}
                      </dt>
                      <dd class="sm-kpi__value">
                        <span class="g-num">{value}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
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
                      <h2>{t('Comments per brand')}</h2>
                      <span class="sm-box__meta">{t('Last 30 days')}</span>
                    </header>
                    <ul class="sm-bars">
                      {cmp.map((c, i) => (
                        <li>
                          <span class="sm-bars__name">{c.name}</span>
                          <span class="sm-bars__track">
                            <span
                              class={`sm-bars__fill sm-c-${tone(i)}`}
                              style={{ width: `${Math.max(2, (c.comments / maxC) * 100)}%` }}
                            />
                          </span>
                          <b class="g-num">{fmt(c.comments)}</b>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              </>
            )
          })()}
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
                  {brands.map((b) => {
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
