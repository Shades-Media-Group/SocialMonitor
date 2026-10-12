import { useEffect, useState } from 'preact/hooks'
import type { AppState } from '../app.tsx'
import type { PostRow } from '../api.ts'
import { api } from '../api.ts'
import { Empty, NETWORK_NAME, NetworkMark, fmt, when } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'

export function Posts({ brandId, running, openUpdate, mode }: AppState) {
  const [rows, setRows] = useState<PostRow[] | null>(null)
  useEffect(() => {
    api
      .get<PostRow[]>(`/api/posts?limit=100${brandId ? `&brand=${brandId}` : ''}`)
      .then(setRows)
      .catch(() => setRows([]))
  }, [brandId, running])

  if (rows === null) return null
  if (mode === 'json')
    return (
      <JsonPanel
        value={rows.map((p) => ({
          id: p.id,
          network: p.network,
          handle: p.handle,
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
        Press Update to read the newest posts.{' '}
        <button class="g-link sm-linkbtn" type="button" onClick={openUpdate}>
          Update now
        </button>
      </Empty>
    )
  return (
    <ul class="sm-list">
      {rows.map((p) => (
        <li class="sm-post">
          {p.thumb_url ? (
            <img class="sm-post__thumb" src={p.thumb_url} alt="" loading="lazy" />
          ) : (
            <span class="sm-post__thumb" />
          )}
          <div class="sm-post__body">
            <div class="sm-comment__meta">
              <NetworkMark network={p.network} />
              <span class="sm-comment__author">@{p.handle}</span>
              <span>{when(p.posted_at)}</span>
            </div>
            {p.description && <p class="sm-post__desc">{p.description}</p>}
            <p class="sm-post__caption">{p.caption || 'No caption.'}</p>
            <p class="sm-post__stats g-num">
              {fmt(p.likes)} likes · {fmt(p.comments_count)} comments
              {p.views != null && ` · ${fmt(p.views)} views`}
              {p.shares != null && ` · ${fmt(p.shares)} shares`}
              {p.flagged > 0 && <span class="sm-flag"> · {p.flagged} to look at</span>}
            </p>
            <p class="sm-post__links">
              {p.stored_comments > 0 && (
                <a
                  class="g-link"
                  href="#comments"
                  onClick={() => sessionStorage.setItem('sm-post', String(p.id))}
                >
                  {fmt(p.stored_comments)} comments kept
                </a>
              )}
              <a class="g-link" href={p.url} target="_blank" rel="noreferrer">
                Open on {NETWORK_NAME[p.network]}
              </a>
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
