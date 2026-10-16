import { useState } from 'preact/hooks'
import type { AppState, BrandView, Tab } from './app.tsx'
import { TABS } from './app.tsx'
import type { BrandRow, Network } from './api.ts'
import { Head, Icon, Menu, NETWORK_NAME, NetworkMark } from './ui.tsx'
import { t } from './i18n.ts'
import { usePref } from './prefs.ts'
import { Overview } from './views/overview.tsx'
import { Comments } from './views/comments.tsx'
import { Posts } from './views/posts.tsx'
import { Reports } from './views/reports.tsx'
import { Schedules } from './views/schedules.tsx'
import { About } from './views/about.tsx'
import { Calendar } from './views/calendar.tsx'
import { Stats } from './views/stats.tsx'
import { BrandSettings } from './views/brand-settings.tsx'
import { Voice } from './views/voice.tsx'
import { Admin } from './views/admin.tsx'

/** One brand: its name and what it is, its own menu, and a network switch that filters every tab. */
export function BrandPage(props: AppState & { brand: BrandRow; tab: Tab }) {
  const { brand, tab } = props
  // Kept with the account: the network per brand, and one period for every brand.
  const [network, setNetwork] = usePref<Network | ''>(`net:${brand.id}`, '')
  const [shared, setShared] = usePref<number>('days', 30)
  // Comments keep their own period, all time unless chosen, so the list never hides old ones.
  const [commentDays, setCommentDays] = usePref<number>('comments.days', 0)
  const [days, setDays] = tab === 'comments' ? [commentDays, setCommentDays] : [shared, setShared]

  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const nets = brand.profiles.map((p) => p.network)
  const view: BrandView = {
    ...props,
    brand,
    network: nets.includes(network as Network) ? network : '',
    days,
    setNetwork,
    setDays,
    viewSlot: slot,
  }
  const exportQuery = new URLSearchParams({
    days: String(days),
    ...(view.network ? { network: view.network } : {}),
  })

  const hasFilters =
    tab === 'overview' ||
    tab === 'posts' ||
    tab === 'stats' ||
    tab === 'voice' ||
    tab === 'comments' ||
    tab === 'calendar'
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
            {(tab === 'overview' ||
              tab === 'posts' ||
              tab === 'stats' ||
              tab === 'voice' ||
              tab === 'comments') && (
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
            {tab === 'comments' && <span class="sm-slot" ref={setSlot} />}
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
        ) : tab === 'stats' ? (
          <Stats {...view} />
        ) : tab === 'voice' ? (
          <Voice {...view} />
        ) : tab === 'reports' ? (
          <Reports {...view} />
        ) : tab === 'calendar' ? (
          <Calendar {...view} />
        ) : tab === 'schedules' ? (
          <Schedules {...view} />
        ) : tab === 'settings' && brand.my_role === 'admin' ? (
          <BrandSettings {...view} />
        ) : tab === 'admin' && props.me.super ? (
          <Admin {...view} />
        ) : (
          <About {...view} />
        )}
      </div>
    </main>
  )
}
