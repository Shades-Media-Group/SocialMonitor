import { useEffect, useState } from 'preact/hooks'
import type { Network } from './api.ts'
import { api } from './api.ts'
import {
  NETWORK_NAME,
  NetworkMark,
  Scroller,
  Segmented,
  ago,
  count,
  navigate,
  short,
  when,
} from './ui.tsx'
import { Sparkline } from './charts.tsx'
import { t } from './i18n.ts'
import { usePref } from './prefs.ts'
import './fans-ideas.css'

interface Person {
  author: string
  n: number
  positive: number
  negative: number
  last: string
  avatar: string | null
  url: string | null
  networks: Network[]
  followers: number | null
  weeks: number[]
}

/** Opens the Comments tab with only this person's comments. */
export function showPerson(brandId: number, author: string) {
  sessionStorage.setItem('sm-author', author)
  navigate(`/b/${brandId}/comments`)
}

/**
 * The people who keep coming back: fans (mostly praise) and critics (mostly complaints), with
 * how far they reach where a network shows it. A name opens their comments.
 */
export function FansAndCritics({
  brandId,
  network,
  days,
  version,
}: {
  brandId: number
  network: Network | ''
  days: number
  version: number
}) {
  const [data, setData] = useState<{ fans: Person[]; critics: Person[] } | null>(null)
  const [side, setSide] = usePref<'fans' | 'critics'>('overview.people', 'fans')
  useEffect(() => {
    api
      .get<{ fans: Person[]; critics: Person[] }>(
        `/api/brands/${brandId}/people?days=${days}${network ? `&network=${network}` : ''}`,
      )
      .then(setData)
      .catch(() => setData(null))
  }, [brandId, network, days, version])
  const list = data?.[side] ?? []
  const pct = (part: number, p: Person) => Math.round((part / p.n) * 100)
  return (
    <Scroller
      fit="column"
      class="sm-span-4 sm-fans"
      head={
        <header class="sm-box__head">
          <h2>{t('Fans and critics')}</h2>
          <Segmented
            label={t('Show')}
            value={side}
            onChange={setSide}
            options={[
              ['fans', t('Fans')],
              ['critics', t('Critics')],
            ]}
          />
        </header>
      }
    >
      {list.length ? (
        <table class="sm-dtable">
          <tbody>
            {list.map((p) => (
              <tr>
                <td>
                  <span class="sm-fan">
                    {p.avatar ? (
                      <a
                        href={p.url ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={t('{name} on the network', { name: p.author })}
                      >
                        <img class="sm-fan__face" src={p.avatar} alt="" loading="lazy" />
                      </a>
                    ) : (
                      <span class="sm-fan__face sm-fan__face--none">
                        <NetworkMark network={p.networks[0]!} size={12} />
                      </span>
                    )}
                    <span class="sm-fan__text">
                      <a
                        class="sm-fan__name"
                        href={`/b/${brandId}/comments`}
                        title={t('Show their comments')}
                        onClick={(e) => {
                          e.preventDefault()
                          showPerson(brandId, p.author)
                        }}
                      >
                        {p.author}
                      </a>
                      <small>
                        {count(p.n, 'comment')} ·{' '}
                        <span class="g-num">
                          {side === 'fans'
                            ? t('{n}% positive', { n: pct(p.positive, p) })
                            : t('{n}% negative', { n: pct(p.negative, p) })}
                        </span>
                        {(side === 'fans' ? p.negative : p.positive) > 0 && (
                          <>
                            {', '}
                            <span class="g-num">
                              {side === 'fans'
                                ? t('{n}% negative', { n: pct(p.negative, p) })
                                : t('{n}% positive', { n: pct(p.positive, p) })}
                            </span>
                          </>
                        )}
                      </small>
                      <small>
                        {p.followers == null ? (
                          t('Followers unknown')
                        ) : (
                          <span class="g-num">{t('{n} followers', { n: short(p.followers) })}</span>
                        )}{' '}
                        · {p.networks.map((n) => NETWORK_NAME[n]).join(', ')}
                      </small>
                    </span>
                  </span>
                </td>
                <td class="sm-num sm-fan__trend">
                  <span title={t('Comments per week')}>
                    <Sparkline values={p.weeks} tone={side === 'fans' ? 'green' : 'red'} />
                  </span>
                  <small title={when(p.last)}>{ago(p.last)}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="sm-quiet">
          {side === 'fans'
            ? t('People who praise the brand twice or more show here.')
            : t('People who complain twice or more show here.')}
        </p>
      )}
    </Scroller>
  )
}
