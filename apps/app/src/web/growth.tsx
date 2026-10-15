import type { Network } from './api.ts'
import { NetworkMark, fmt } from './ui.tsx'
import { t } from './i18n.ts'

/** A post that grew in the period: what it gained between two readings, and the figure now. */
export interface Grown {
  post_id: number
  gained: number
  now: number
  network: Network
  url: string
  thumb_url: string | null
  about: string
}
export interface Growth {
  interactions: Grown[]
  views: Grown[]
  /** Posts read only once in the period, so with no growth to show. */
  thin: number
}

/** How many posts each list shows; the server returns at most this many. */
export const GROWTH_LIMIT = 8

function List({ title, rows }: { title: string; rows: Grown[] }) {
  return (
    <div class="sm-grow__list">
      <h3>{title}</h3>
      {rows.length ? (
        <table class="sm-dtable">
          <thead>
            <tr>
              <th>{t('Post')}</th>
              <th class="sm-num">{t('Gained')}</th>
              <th class="sm-num">{t('Now')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  <a class="sm-postcell" href={r.url} target="_blank" rel="noreferrer">
                    {r.thumb_url ? (
                      <img src={r.thumb_url} alt="" loading="lazy" />
                    ) : (
                      <span class="sm-postcell__blank" />
                    )}
                    <NetworkMark network={r.network} size={12} />
                    <span class="sm-postcell__text">{r.about || t('No caption.')}</span>
                  </a>
                </td>
                <td class="sm-num g-num sm-grow__gain">+{fmt(r.gained)}</td>
                <td class="sm-num g-num">{fmt(r.now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="sm-quiet">{t('No post grew in this period.')}</p>
      )}
    </div>
  )
}

/**
 * The posts that grew most in the period, by interactions and by views, side by side. When
 * history is thin it says so in one line instead of guessing.
 */
export function GrowthLists({ g }: { g: Growth }) {
  const short = g.interactions.length < GROWTH_LIMIT || g.views.length < GROWTH_LIMIT
  if (!g.interactions.length && !g.views.length)
    return (
      <p class="sm-quiet sm-grow__note">
        {t('No post grew between two readings in this period; history builds up with each update.')}
      </p>
    )
  return (
    <>
      <div class="sm-grow">
        <List title={t('By likes, comments and shares')} rows={g.interactions} />
        <List title={t('By views')} rows={g.views} />
      </div>
      {g.thin > 0 && short && (
        <p class="sm-quiet sm-grow__note">
          {t(
            'Posts read only once in this period are left out; history builds up with each update.',
          )}
        </p>
      )}
    </>
  )
}
