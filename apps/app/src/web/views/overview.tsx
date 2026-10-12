import { useEffect, useState } from 'preact/hooks'
import type { AppState } from '../app.tsx'
import type { CommentRow } from '../api.ts'
import { api } from '../api.ts'
import { Empty, NETWORK_NAME, NetworkMark, ago, fmt } from '../ui.tsx'
import { CommentList } from './comments.tsx'

export function Overview({ brands, brandId, go, openUpdate, running, reload }: AppState) {
  const scope = brandId ? brands.filter((b) => b.id === brandId) : brands
  const [reply, setReply] = useState<CommentRow[]>([])
  useEffect(() => {
    api
      .get<CommentRow[]>(`/api/comments?reply=1&limit=6${brandId ? `&brand=${brandId}` : ''}`)
      .then(setReply)
      .catch(() => setReply([]))
  }, [brandId, running, brands])

  if (!brands.length)
    return (
      <Empty title="Add the first brand to watch.">
        Paste its Instagram, Facebook and TikTok links in Brands; SocialMonitor keeps every post and
        comment from there.{' '}
        <a class="g-link" href="#brands">
          Add a brand
        </a>
      </Empty>
    )

  const sum = (k: string) => scope.reduce((n, b) => n + (b.counts[k] ?? 0), 0)
  const total = sum('total')
  const sorted = total - sum('unsorted')
  const share = (k: string) => (sorted ? Math.round((sum(k) / sorted) * 100) : null)

  return (
    <div class="sm-stack">
      <section class="sm-figures" aria-label="This brand at a glance">
        <div>
          <span class="sm-figure g-num">{fmt(sum('needs_reply'))}</span>
          <span class="sm-figure__label">need a reply</span>
        </div>
        <div>
          <span class="sm-figure g-num">{fmt(sum('complaint'))}</span>
          <span class="sm-figure__label">complaints</span>
        </div>
        <div>
          <span class="sm-figure g-num">
            {share('praise') == null ? '–' : `${share('praise')}%`}
          </span>
          <span class="sm-figure__label">of sorted comments are praise</span>
        </div>
        <div>
          <span class="sm-figure g-num">{fmt(total)}</span>
          <span class="sm-figure__label">comments kept</span>
        </div>
      </section>

      <section>
        <div class="sm-section-head">
          <h2>Need a reply</h2>
          {reply.length > 0 && (
            <a class="g-link" href="#comments">
              All comments
            </a>
          )}
        </div>
        {reply.length ? (
          <CommentList comments={reply} brands={brands} onChange={() => reload()} />
        ) : total ? (
          <p class="sm-quiet">Nothing waiting for an answer.</p>
        ) : (
          <Empty title="No comments yet.">
            Press Update to read the newest posts and their comments.{' '}
            <button class="g-link sm-linkbtn" type="button" onClick={openUpdate}>
              Update now
            </button>
          </Empty>
        )}
      </section>

      <section>
        <div class="sm-section-head">
          <h2>Networks</h2>
          <button class="g-link sm-linkbtn" type="button" onClick={() => go('brands')}>
            Edit links
          </button>
        </div>
        <table class="g-table sm-table">
          <thead>
            <tr>
              {!brandId && <th>Brand</th>}
              <th>Network</th>
              <th>Profile</th>
              <th>Last update</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {scope.flatMap((b) =>
              b.profiles.map((p) => (
                <tr>
                  {!brandId && <td>{b.name}</td>}
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
              )),
            )}
          </tbody>
        </table>
        {scope.flatMap((b) => b.profiles).find((p) => p.last_status === 'error') && (
          <p class="sm-note">
            {scope.flatMap((b) => b.profiles).find((p) => p.last_status === 'error')!.last_error}
          </p>
        )}
      </section>
    </div>
  )
}
