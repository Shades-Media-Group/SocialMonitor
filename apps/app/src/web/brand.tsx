import { useEffect, useState } from 'preact/hooks'
import type { AppState, BrandView, Tab } from './app.tsx'
import { TABS } from './app.tsx'
import type { BrandRow, Network } from './api.ts'
import { NetworkMark } from './ui.tsx'
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

  const nets = brand.profiles.map((p) => p.network)
  const view: BrandView = {
    ...props,
    brand,
    network: nets.includes(network as Network) ? network : '',
  }

  return (
    <main class="sm-page">
      <header class="sm-head">
        <h1>{brand.name}</h1>
        <div class="sm-head__lead">
          {brand.industry && <p class="sm-head__industry">{brand.industry}</p>}
          {brand.description ? (
            <p>{brand.description}</p>
          ) : (
            <p class="sm-quiet">
              No description yet. <a href={`#/b/${brand.id}/about`}>Describe the brand</a> so the AI
              knows what it sells.
            </p>
          )}
        </div>
      </header>

      <nav class="sm-bar" aria-label={`${brand.name} sections`}>
        <div class="sm-bar__tabs">
          {TABS.map(([t, text]) => (
            <a href={`#/b/${brand.id}/${t}`} aria-current={t === tab ? 'page' : undefined}>
              {text}
            </a>
          ))}
        </div>
        {tab !== 'about' && tab !== 'schedules' && nets.length > 1 && (
          <div class="sm-netswitch" role="radiogroup" aria-label="Network">
            <button
              type="button"
              role="radio"
              aria-checked={view.network === ''}
              onClick={() => setNetwork('')}
            >
              All
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
                  <NetworkMark network={n} size={15} />
                  <span>
                    {{ instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' }[n]}
                  </span>
                </button>
              ))}
          </div>
        )}
      </nav>

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
