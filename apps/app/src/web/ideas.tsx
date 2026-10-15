import { useEffect, useState } from 'preact/hooks'
import type { BrandRow, PostRow } from './api.ts'
import { api } from './api.ts'
import { ago, count, fmt, when } from './ui.tsx'
import { locale, t } from './i18n.ts'
import { localHour, rankSlots } from '../core/timing.ts'
import './fans-ideas.css'

const hourName = (h: number) =>
  new Date(2024, 0, 1, h).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
const dayName = (d: number) =>
  new Date(2024, 0, 7 + d).toLocaleDateString(locale, { weekday: 'long' })

/**
 * The hours posts did best, in the reader's own time. Shown only with enough posts: an hour
 * needs three posts to count, and the ranking needs twelve posts in all.
 */
export function BestHours({ rows }: { rows: PostRow[] }) {
  const r = rankSlots(rows, localHour)
  const top = r.slots.slice(0, 5)
  const max = Math.max(0.0001, ...top.map((s) => s.score))
  return (
    <section class="sm-box">
      <header class="sm-box__head">
        <h2>{t('Best hours to post')}</h2>
        <span class="sm-box__meta">
          {r.metric === 'rate'
            ? t('Engagement by the hour a post went out, your time')
            : t('Interactions per post by the hour it went out, your time')}
        </span>
      </header>
      {r.enough ? (
        <>
          <ul class="sm-bars">
            {top.map((s) => (
              <li>
                <span class="sm-bars__name">
                  {hourName(s.key)}
                  <small>{count(s.posts, 'post')}</small>
                </span>
                <span class="sm-bars__track">
                  <span
                    class="sm-bars__fill sm-c-praise"
                    style={{ width: `${(s.score / max) * 100}%` }}
                  />
                </span>
                <b class="g-num">
                  {r.metric === 'rate'
                    ? `${(s.score * 100).toFixed(1)}%`
                    : fmt(Math.round(s.score))}
                </b>
              </li>
            ))}
          </ul>
          <p class="sm-quiet">
            {t('From {n}. Hours with fewer than {min} posts are left out.', {
              n: count(r.total, 'post'),
              min: r.min,
            })}
          </p>
        </>
      ) : (
        <p class="sm-quiet">
          {t(
            'Too few posts to tell yet: this needs 12 posts, with {min} or more in at least two hours. There are {n} here.',
            { n: count(r.total, 'post'), min: r.min },
          )}
        </p>
      )}
    </section>
  )
}

interface Idea {
  topic: string
  format: string
  day: number
  hour: number
  why: string
}

/**
 * Ideas for the next post: Claude reads the best and worst posts and what commenters ask for,
 * and suggests a few. Made only when an admin asks; the latest set is kept.
 */
export function PostIdeas({ brand, notify }: { brand: BrandRow; notify: (text: string) => void }) {
  const [data, setData] = useState<{ ideas: Idea[]; created_at: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const admin = brand.my_role === 'admin'
  useEffect(() => {
    api
      .get<{ ideas: Idea[]; created_at: string | null }>(`/api/brands/${brand.id}/ideas`)
      .then(setData)
      .catch(() => setData(null))
  }, [brand.id])
  const suggest = async () => {
    setBusy(true)
    setError('')
    try {
      setData(await api.post(`/api/brands/${brand.id}/ideas`))
      notify(t('New ideas are ready.'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!data) return null
  return (
    <section class="sm-box sm-ideas" aria-busy={busy}>
      <header class="sm-box__head">
        <h2>{t('Ideas for the next post')}</h2>
        <span class="sm-ideas__actions">
          {data.created_at && (
            <span class="sm-box__meta" title={when(data.created_at)}>
              {t('Suggested {when}', { when: ago(data.created_at) })}
            </span>
          )}
          {admin && (
            <button class="g-btn g-btn--sm" type="button" disabled={busy} onClick={suggest}>
              {busy
                ? t('Asking Claude…')
                : data.ideas.length
                  ? t('Suggest new ideas')
                  : t('Suggest ideas')}
            </button>
          )}
        </span>
      </header>
      {data.ideas.length ? (
        <ul class="sm-ideas__list">
          {data.ideas.map((i) => (
            <li>
              <p class="sm-ideas__topic">{i.topic}</p>
              <p class="sm-ideas__plan">
                {i.format} · {dayName(i.day)}, {hourName(i.hour)}
              </p>
              <p class="sm-ideas__why">{i.why}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p class="sm-quiet">
          {admin
            ? t(
                'Claude reads the posts that did best and worst and what people ask for in comments, then suggests what to post next.',
              )
            : t('A brand admin can ask Claude for ideas here.')}
        </p>
      )}
      {error && <p class="sm-quiet sm-hot">{error}</p>}
      {data.ideas.length > 0 && (
        <p class="sm-quiet">
          {t('Days and hours are in the time of the computer SocialMonitor runs on.')}
        </p>
      )}
    </section>
  )
}
