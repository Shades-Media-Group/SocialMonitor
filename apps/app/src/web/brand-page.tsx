import { useEffect, useState } from 'preact/hooks'
import type { AppState, BrandView, Tab } from './app.tsx'
import { TABS } from './app.tsx'
import type { BrandRow, Network } from './api.ts'
import { Head, Icon, Menu, NETWORK_NAME, NetworkMark } from './ui.tsx'
import { t } from './i18n.ts'
import { Overview } from './views/overview.tsx'
import { Comments } from './views/comments.tsx'
import { Posts } from './views/posts.tsx'
import { Reports } from './views/reports.tsx'
import { Schedules } from './views/schedules.tsx'
import { About } from './views/about.tsx'

/** One brand: its name and what it is, its own menu, and a network switch that filters every tab. */
export function BrandPage(props: AppState & { brand: BrandRow; tab: Tab }) {
  const { brand, tab } = props
  const [network, setNetwork] = useState<Network | ''>(() => {
    try {
      return (sessionStorage.getItem(`sm-net-${brand.id}`) as Network | '') ?? ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(`sm-net-${brand.id}`, network)
    } catch {
      /* private mode */
    }
  }, [network, brand.id])

  const [days, setDays] = useState<number>(() => {
    try {
      return Number(sessionStorage.getItem('sm-days') ?? 30)
    } catch {
      return 30
    }
  })
  useEffect(() => {
    try {
      sessionStorage.setItem('sm-days', String(days))
    } catch {
      /* private mode */
    }
  }, [days])

  const nets = brand.profiles.map((p) => p.network)
  const view: BrandView = {
    ...props,
    brand,
    network: nets.includes(network as Network) ? network : '',
    days,
  }
  const exportQuery = new URLSearchParams({
    days: String(days),
    ...(view.network ? { network: view.network } : {}),
  })

  const hasFilters = tab === 'overview' || tab === 'posts' || tab === 'comments'
  const TAB_NAME = Object.fromEntries(TABS) as Record<Tab, string>

  return (
    <main class="sm-page">
      <Head
        title={brand.name}
        sub={tab === 'overview' ? brand.industry || undefined : t(TAB_NAME[tab])}
        actions={props.actions}
      >
        {hasFilters && (
          <>
            {nets.length > 1 && (
              <div class="g-segmented sm-seg" role="radiogroup" aria-label={t('Network')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={view.network === ''}
                  onClick={() => setNetwork('')}
                >
                  {t('All networks')}
                </button>
                {(['instagram', 'facebook', 'tiktok'] as const)
                  .filter((n) => nets.includes(n))
                  .map((n) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={view.network === n}
                      onClick={() => setNetwork(n)}
                    >
                      <NetworkMark network={n} size={14} />
                      <span>{NETWORK_NAME[n]}</span>
                    </button>
                  ))}
              </div>
            )}
            {(tab === 'overview' || tab === 'posts') && (
              <select
                class="g-select sm-select-sm"
                aria-label={t('Period')}
                value={days}
                onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}
              >
                <option value={7}>{t('Last 7 days')}</option>
                <option value={30}>{t('Last 30 days')}</option>
                <option value={90}>{t('Last 90 days')}</option>
                <option value={365}>{t('Last 12 months')}</option>
                <option value={0}>{t('All time')}</option>
              </select>
            )}
            <span class="sm-pagehead__spacer" />
            <Menu
              label={t('Export')}
              items={[
                {
                  label: t('PDF report'),
                  onSelect: () =>
                    (location.href = `/api/brands/${brand.id}/report.pdf?${exportQuery}`),
                },
                {
                  label: t('Excel workbook'),
                  onSelect: () =>
                    (location.href = `/api/brands/${brand.id}/export.xlsx?${exportQuery}`),
                },
                {
                  label: t('Comments as CSV'),
                  onSelect: () =>
                    (location.href = `/api/comments.csv?brand=${brand.id}${view.network ? `&network=${view.network}` : ''}`),
                },
              ]}
            >
              <Icon name="download" size={14} /> {t('Export')} <Icon name="chevronDown" size={14} />
            </Menu>
          </>
        )}
      </Head>

      <div class="sm-body">
        {tab === 'overview' ? (
          <Overview {...view} />
        ) : tab === 'comments' ? (
          <Comments {...view} />
        ) : tab === 'posts' ? (
          <Posts {...view} />
        ) : tab === 'reports' ? (
          <Reports {...view} />
        ) : tab === 'schedules' ? (
          <Schedules {...view} />
        ) : (
          <About {...view} />
        )}
      </div>
    </main>
  )
}
