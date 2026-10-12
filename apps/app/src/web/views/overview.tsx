import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { CommentRow, PostRow, Profile } from '../api.ts'
import { api } from '../api.ts'
import { NETWORK_NAME, NetworkMark, ago, fmt } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import { MoodBar } from '../labels.tsx'
import { brandCategories } from '../rate.tsx'
import { CommentList } from './comments.tsx'

interface Summary {
  profiles: Profile[]
  counts: Record<string, number>
  week: Record<string, number>
  sentiment: { sentiment: 'positive' | 'negative'; category: string | null; n: number }[]
  posts: number
  brand_replies: number
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0)

/**
 * The brand at a glance. It opens on one sentence that says what needs doing, built from the
 * brand's own numbers, then the comments to answer, the mood, the problems people name, the
 * latest posts and the state of each network.
 */
export function Overview(v: BrandView) {
  const { brand, network, version, mode, openUpdate, brands } = v
  const [s, setS] = useState<Summary | null>(null)
  const [reply, setReply] = useState<CommentRow[]>([])
  const [posts, setPosts] = useState<PostRow[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const n = network ? `&network=${network}` : ''
    api
      .get<Summary>(`/api/brands/${brand.id}/summary${network ? `?network=${network}` : ''}`)
      .then(setS)
      .catch(() => setS(null))
    api
      .get<CommentRow[]>(`/api/comments?brand=${brand.id}&reply=1&limit=5${n}`)
      .then(setReply)
      .catch(() => setReply([]))
    api
      .get<PostRow[]>(`/api/posts?brand=${brand.id}&limit=6${n}`)
      .then(setPosts)
      .catch(() => setPosts([]))
  }, [brand.id, network, version, tick])

  if (!s) return null
  const c = s.counts
  const total = c.total ?? 0
  const sorted = total - (c.unsorted ?? 0)
  const waiting = c.needs_reply ?? 0
  const cats = brandCategories(brand)
  const negatives = s.sentiment.filter((x) => x.sentiment === 'negative')
  const positives = s.sentiment.filter((x) => x.sentiment === 'positive')
  const rated = s.sentiment.reduce((n, x) => n + x.n, 0)
  const name = (key: string | null) => cats.find((k) => k.key === key)?.name ?? 'No kind given'

  if (mode === 'json')
    return (
      <JsonPanel
        value={{
          brand: brand.name,
          network: network || 'all',
          comments: c,
          last_7_days: s.week,
          rated: Object.fromEntries(
            s.sentiment.map((x) => [`${x.sentiment}:${x.category ?? 'none'}`, x.n]),
          ),
          brand_replies: s.brand_replies,
          posts: s.posts,
          answer_first: reply.map((r) => ({
            id: r.id,
            author: r.author,
            text: r.text,
            label: r.label,
            reason: r.reason,
          })),
          networks: s.profiles.map((p) => ({
            network: p.network,
            handle: p.handle,
            last_update: p.last_run_at,
            status: p.last_status,
            error: p.last_error,
          })),
        }}
      />
    )

  const tally = (list: typeof negatives) => (
    <ul class="sm-tally">
      {list.map((x) => (
        <li>
          <span>{name(x.category)}</span>
          <span class="sm-tally__track">
            <span
              class="sm-tally__bar"
              style={{ width: `${Math.max(4, pct(x.n, list[0]!.n))}%` }}
            />
          </span>
          <b class="g-num">{x.n}</b>
        </li>
      ))}
    </ul>
  )

  return (
    <div class="sm-overview">
      <section class="sm-statement" aria-label="Today">
        {total === 0 ? (
          <p>
            Nothing read yet{network ? ` on ${NETWORK_NAME[network]}` : ''}.{' '}
            <button class="sm-statement__act" type="button" onClick={() => openUpdate(brand.id)}>
              Read the latest posts
            </button>
          </p>
        ) : (
          <p>
            <b class={waiting ? 'sm-hot' : undefined}>{fmt(waiting)}</b>{' '}
            {waiting === 1 ? 'comment waits' : 'comments wait'} for an answer.{' '}
            {sorted > 0 ? (
              <>
                {c.complaint ? (
                  <>
                    Complaints are <b>{pct(c.complaint, sorted)}%</b> of what people said
                  </>
                ) : (
                  <>No complaints in what people said</>
                )}
                {s.week.total ? (
                  <>
                    , and <b>{fmt(s.week.total)}</b> new comments came in this week.
                  </>
                ) : (
                  '.'
                )}
              </>
            ) : (
              <>
                <b>{fmt(total)}</b> comments are kept, waiting for the AI to sort them.
              </>
            )}
          </p>
        )}
      </section>

      <div class="sm-split2">
        <section>
          <div class="sm-section-head">
            <h2>Answer first</h2>
            <a class="g-link" href={`#/b/${brand.id}/comments`}>
              Every comment
            </a>
          </div>
          {reply.length ? (
            <CommentList comments={reply} brands={brands} onChange={() => setTick((t) => t + 1)} />
          ) : (
            <p class="sm-quiet sm-pad">
              {sorted
                ? 'Nothing waits for an answer.'
                : 'Once comments are sorted, the ones to answer come here first.'}
            </p>
          )}
        </section>

        <aside class="sm-side">
          <section>
            <h2>What people say</h2>
            {sorted ? (
              <MoodBar counts={c} />
            ) : (
              <p class="sm-quiet">The mood shows once comments are sorted.</p>
            )}
          </section>

          <section>
            <h2>Problems people name</h2>
            {negatives.length ? (
              tally(negatives)
            ) : (
              <p class="sm-quiet">
                Mark comments negative, or ask Claude to, and their kinds add up here.
              </p>
            )}
          </section>

          {positives.length > 0 && (
            <section class="sm-positive">
              <h2>What people like</h2>
              {tally(positives)}
            </section>
          )}

          {(rated > 0 || s.brand_replies > 0) && (
            <p class="sm-quiet">
              {rated > 0 && `${rated} of ${fmt(total)} comments rated. `}
              {s.brand_replies > 0 &&
                `${brand.name} answered ${s.brand_replies} ${s.brand_replies === 1 ? 'time' : 'times'} from its own account.`}
            </p>
          )}
        </aside>
      </div>

      {posts.length > 0 && (
        <section>
          <div class="sm-section-head">
            <h2>Latest posts</h2>
            <a class="g-link" href={`#/b/${brand.id}/posts`}>
              All {fmt(s.posts)} posts
            </a>
          </div>
          <ul class="sm-strip">
            {posts.map((p) => (
              <li>
                <a href={p.url} target="_blank" rel="noreferrer" class="sm-strip__item">
                  {p.thumb_url ? (
                    <img src={p.thumb_url} alt="" loading="lazy" />
                  ) : (
                    <span class="sm-strip__blank" />
                  )}
                  <span class="sm-strip__meta">
                    <NetworkMark network={p.network} size={13} />
                    <span class="g-num">
                      {fmt(p.likes)} likes · {fmt(p.comments_count)} comments
                    </span>
                  </span>
                  <span class="sm-strip__text">{p.description ?? p.caption}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div class="sm-section-head">
          <h2>Networks</h2>
          <a class="g-link" href={`#/b/${brand.id}/about`}>
            Edit links
          </a>
        </div>
        <table class="g-table sm-table">
          <thead>
            <tr>
              <th>Network</th>
              <th>Profile</th>
              <th>Last update</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {s.profiles.map((p) => (
              <tr>
                <td>
                  <span class="sm-net-name">
                    <NetworkMark network={p.network} /> {NETWORK_NAME[p.network]}
                  </span>
                </td>
                <td>
                  <a class="g-link" href={p.url} target="_blank" rel="noreferrer">
                    @{p.handle}
                  </a>
                </td>
                <td title={p.last_run_at ?? undefined}>{ago(p.last_run_at)}</td>
                <td>
                  {p.last_status === 'error' ? (
                    <span class="sm-status sm-status--error" title={p.last_error ?? undefined}>
                      Needs you
                    </span>
                  ) : p.last_status === 'ok' ? (
                    <span class="sm-status sm-status--ok">Up to date</span>
                  ) : (
                    <span class="sm-status">Not read yet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.profiles
          .filter((p) => p.last_status === 'error')
          .map((p) => (
            <p class="sm-note">
              {NETWORK_NAME[p.network]}: {p.last_error}
            </p>
          ))}
      </section>
    </div>
  )
}
