import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { PostRow } from '../api.ts'
import { api } from '../api.ts'
import { Empty, NETWORK_NAME, NetworkMark, Segmented, count, fmt, when } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'

/** The posts as a contact sheet: the real pictures, newest or most engaging first. */
export function Posts({ brand, network, version, mode, openUpdate }: BrandView) {
  const [rows, setRows] = useState<PostRow[] | null>(null)
  const [sort, setSort] = useState<'new' | 'top'>('new')

  useEffect(() => {
    api
      .get<PostRow[]>(
        `/api/posts?brand=${brand.id}&limit=120&sort=${sort}${network ? `&network=${network}` : ''}`,
      )
      .then(setRows)
      .catch(() => setRows([]))
  }, [brand.id, network, version, sort])

  if (rows === null) return null
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
  if (!rows.length)
    return (
      <Empty title="No posts yet.">
        Read the latest posts and their comments.{' '}
        <button class="sm-textbtn" type="button" onClick={() => openUpdate(brand.id)}>
          Update now
        </button>
      </Empty>
    )

  return (
    <div class="sm-stack">
      <div class="sm-toolbar">
        <Segmented
          label="Order"
          value={sort}
          onChange={setSort}
          options={[
            ['new', 'Newest'],
            ['top', 'Most engaging'],
          ]}
        />
      </div>
      <ul class="sm-sheet-grid">
        {rows.map((p) => (
          <li class="sm-postcard">
            <a
              class="sm-postcard__img"
              href={p.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open on ${NETWORK_NAME[p.network]}`}
            >
              {p.thumb_url ? <img src={p.thumb_url} alt="" loading="lazy" /> : <span />}
              {p.flagged > 0 && <span class="sm-postcard__flag">{p.flagged} to look at</span>}
            </a>
            <div class="sm-postcard__meta">
              <NetworkMark network={p.network} size={13} />
              <span>{when(p.posted_at)}</span>
            </div>
            <p class="sm-postcard__text">{p.description ?? p.caption ?? 'No caption.'}</p>
            <p class="sm-postcard__stats g-num">
              {count(p.likes, 'like')} · {count(p.comments_count, 'comment')}
              {p.views != null && ` · ${fmt(p.views)} views`}
            </p>
            {p.stored_comments > 0 && (
              <a
                class="sm-textbtn"
                href={`#/b/${brand.id}/comments`}
                onClick={() => sessionStorage.setItem('sm-post', String(p.id))}
              >
                {p.comments_count && p.comments_count > p.stored_comments
                  ? `${fmt(p.stored_comments)} of ${fmt(p.comments_count)} comments saved`
                  : `Read ${count(p.stored_comments, 'comment')}`}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
