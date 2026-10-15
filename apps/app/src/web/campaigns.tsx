import { useEffect, useState } from 'preact/hooks'
import type { Campaign } from '../core/campaigns.ts'
import type { BrandRow, CommentRow, PostRow } from './api.ts'
import { api } from './api.ts'
import { Chips, Menu, NetworkMark, Row, Sheet, fmt, short, when } from './ui.tsx'
import { CommentList } from './views/comments.tsx'
import type { Growth } from './growth.tsx'
import { GrowthLists } from './growth.tsx'
import { locale, t } from './i18n.ts'

/** A campaign as the dashboard lists it, with how many posts it holds. */
export type CampaignRow = Campaign & { posts: number }
/** One of a brand's campaigns as seen from a post: in or out, and who said so. */
interface PostCampaign {
  id: number
  name: string
  set_by: 'rule' | 'ai' | 'you' | null
  member: 0 | 1
}

/** The brand's campaigns, fetched again when `version` changes. */
export function useCampaigns(brandId: number, version = 0) {
  const [rows, setRows] = useState<CampaignRow[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    api
      .get<CampaignRow[]>(`/api/brands/${brandId}/campaigns`)
      .then(setRows)
      .catch(() => setRows([]))
  }, [brandId, version, tick])
  return [rows, () => setTick((x) => x + 1)] as const
}

const day = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
/** "1 Jun 2026 – 31 Aug 2026", "From 1 Jun 2026", or '' without dates. */
export const dates = (c: Pick<Campaign, 'starts_on' | 'ends_on'>) =>
  c.starts_on && c.ends_on
    ? `${day(c.starts_on)} – ${day(c.ends_on)}`
    : c.starts_on
      ? t('From {date}', { date: day(c.starts_on) })
      : c.ends_on
        ? t('Until {date}', { date: day(c.ends_on) })
        : ''
const hints = (c: Campaign) =>
  [
    (JSON.parse(c.hashtags || '[]') as string[]).map((h) => `#${h}`).join(' '),
    (JSON.parse(c.keywords || '[]') as string[]).join(', '),
  ]
    .filter(Boolean)
    .join(' · ')

const BY: Record<string, string> = {
  rule: 'By its hashtags or keywords',
  ai: 'Chosen by Claude',
  you: 'Set by hand',
}

/**
 * A post's campaigns in the post viewer: brand admins switch each one on or off; everyone else
 * reads which ones it is in. Nothing shows when the brand has no campaigns.
 */
export function PostCampaigns({ post, brands }: { post: PostRow; brands: BrandRow[] }) {
  const [rows, setRows] = useState<PostCampaign[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setRows(null)
    api
      .get<PostCampaign[]>(`/api/posts/${post.id}/campaigns`)
      .then(setRows)
      .catch(() => setRows([]))
  }, [post.id])
  if (!rows?.length) return null
  const admin = brands.find((b) => b.id === post.brand_id)?.my_role === 'admin'
  const on = rows.filter((r) => r.member).map((r) => String(r.id))
  if (!admin)
    return on.length ? (
      <p class="sm-postcamps">
        <span class="sm-postcamps__label">{t('Campaigns')}</span>
        {rows
          .filter((r) => r.member)
          .map((r) => r.name)
          .join(', ')}
      </p>
    ) : null
  const set = (next: string[]) => {
    const changed = rows.find((r) => next.includes(String(r.id)) !== !!r.member)
    if (!changed) return
    setError(null)
    api
      .put<PostCampaign[]>(`/api/posts/${post.id}/campaigns`, {
        campaign_id: changed.id,
        member: !changed.member,
      })
      .then(setRows)
      .catch((e: Error) => setError(e.message))
  }
  return (
    <div class="sm-postcamps">
      <span class="sm-postcamps__label">{t('Campaigns')}</span>
      <Chips
        label={t('Campaigns')}
        values={on}
        options={rows.map((r) => [String(r.id), r.name])}
        onChange={set}
      />
      {rows.some((r) => r.member && r.set_by && r.set_by !== 'you') && (
        <small class="sm-quiet">
          {rows
            .filter((r) => r.member && r.set_by && r.set_by !== 'you')
            .map((r) => `${r.name}: ${t(BY[r.set_by!]!).toLowerCase()}`)
            .join('; ')}
        </small>
      )}
      {error && <p class="g-error">{error}</p>}
    </div>
  )
}

/**
 * A post's campaigns in the Posts table: their names, and for admins a menu to add the post to
 * a campaign or take it out. Clicks stay in the cell, so the row does not open the viewer.
 */
export function CampaignCell({
  post,
  campaigns,
  admin,
  onChange,
}: {
  post: PostRow
  campaigns: CampaignRow[]
  admin: boolean
  onChange: () => void
}) {
  const ids = JSON.parse(post.campaign_ids || '[]') as number[]
  const names = campaigns.filter((c) => ids.includes(c.id)).map((c) => c.name)
  const put = (c: CampaignRow, member: boolean) =>
    void api.put(`/api/posts/${post.id}/campaigns`, { campaign_id: c.id, member }).then(onChange)
  return (
    <td class="sm-campcell" onClick={(e) => e.stopPropagation()}>
      <span class="sm-campcell__names">{names.join(', ') || '–'}</span>
      {admin && campaigns.length > 0 && (
        <Menu
          label={t('Campaigns')}
          items={campaigns.map((c) =>
            ids.includes(c.id)
              ? { label: t('Take out of {name}', { name: c.name }), onSelect: () => put(c, false) }
              : { label: t('Add to {name}', { name: c.name }), onSelect: () => put(c, true) },
          )}
        />
      )}
    </td>
  )
}

type Draft = {
  name: string
  starts_on: string
  ends_on: string
  hashtags: string
  keywords: string
  about: string
}
const blank: Draft = { name: '', starts_on: '', ends_on: '', hashtags: '', keywords: '', about: '' }
const draftOf = (c: Campaign): Draft => ({
  name: c.name,
  starts_on: c.starts_on ?? '',
  ends_on: c.ends_on ?? '',
  hashtags: (JSON.parse(c.hashtags || '[]') as string[]).map((h) => `#${h}`).join(' '),
  keywords: (JSON.parse(c.keywords || '[]') as string[]).join(', '),
  about: c.about ?? '',
})

/**
 * The brand's campaigns in its Settings: whether posts join them by themselves, the list, and
 * a sheet to add or change one. Brand admins only, like the rest of the tab.
 */
export function CampaignSettings({
  brand,
  reload,
  notify,
}: {
  brand: BrandRow
  reload: () => Promise<void>
  notify: (text: string) => void
}) {
  const [rows, refresh] = useCampaigns(brand.id)
  const [editing, setEditing] = useState<{ id?: number; d: Draft } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setAuto = async (value: boolean) => {
    await api.patch(`/api/brands/${brand.id}`, { campaign_auto: value })
    await reload()
    refresh()
    notify(
      value ? t('Posts join campaigns by themselves.') : t('Posts join campaigns by hand only.'),
    )
  }
  const save = async () => {
    if (!editing) return
    setBusy(true)
    setError(null)
    try {
      if (editing.id) await api.put(`/api/campaigns/${editing.id}`, editing.d)
      else await api.post(`/api/brands/${brand.id}/campaigns`, editing.d)
      setEditing(null)
      refresh()
      notify(t('Saved.'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = (c: CampaignRow) =>
    confirm(t('Delete {name}? Its posts stay; only the campaign goes.', { name: c.name })) &&
    api
      .del(`/api/campaigns/${c.id}`)
      .then(refresh)
      .catch((e: Error) => notify(e.message))
  const field = (k: keyof Draft) => (e: Event) =>
    setEditing((x) => x && { ...x, d: { ...x.d, [k]: (e.target as HTMLInputElement).value } })

  return (
    <section class="sm-box">
      <header class="sm-box__head">
        <h2>{t('Campaigns')}</h2>
        <button
          class="g-btn g-btn--sm"
          type="button"
          onClick={() => {
            setError(null)
            setEditing({ d: blank })
          }}
        >
          {t('New campaign')}
        </button>
      </header>
      <Row
        label={t('Assign posts automatically')}
        hint={
          brand.campaign_auto
            ? brand.ai_sort
              ? t(
                  "By the campaign's hashtags or keywords within its dates; then Claude places the posts they do not.",
                )
              : t(
                  "By the campaign's hashtags or keywords within its dates. The AI is off for this brand.",
                )
            : t('Off: posts join campaigns only when someone adds them.')
        }
      >
        <label class="g-check">
          <input
            class="g-switch"
            type="checkbox"
            checked={!!brand.campaign_auto}
            onChange={(e) => void setAuto((e.target as HTMLInputElement).checked)}
          />
          {brand.campaign_auto ? t('On') : t('Off')}
        </label>
      </Row>
      {rows === null ? null : rows.length ? (
        <div class="sm-scroll">
          <table class="sm-dtable">
            <thead>
              <tr>
                <th>{t('Campaign')}</th>
                <th>{t('Dates')}</th>
                <th>{t('Hashtags and keywords')}</th>
                <th class="sm-num">{t('Posts')}</th>
                <th class="sm-num">
                  <span class="sm-sr">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr>
                  <td>{c.name}</td>
                  <td class="sm-nowrap">{dates(c) || t('Any time')}</td>
                  <td>{hints(c) || '–'}</td>
                  <td class="sm-num g-num">{fmt(c.posts)}</td>
                  <td class="sm-num">
                    <Menu
                      label={t('Actions')}
                      items={[
                        {
                          label: t('Edit'),
                          onSelect: () => {
                            setError(null)
                            setEditing({ id: c.id, d: draftOf(c) })
                          },
                        },
                        { label: t('Delete'), danger: true, onSelect: () => void remove(c) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="sm-quiet">
          {t(
            'No campaigns yet. Add one to see its posts, what people said under them and how they grew, in one report.',
          )}
        </p>
      )}

      <Sheet
        open={!!editing}
        title={editing?.id ? t('Edit campaign') : t('New campaign')}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button class="g-btn g-btn--primary" type="button" disabled={busy} onClick={save}>
              {t('Save')}
            </button>
            <button class="g-btn g-btn--ghost" type="button" onClick={() => setEditing(null)}>
              {t('Cancel')}
            </button>
          </>
        }
      >
        {editing && (
          <>
            <Row label={t('Name')}>
              <input class="g-input" required value={editing.d.name} onInput={field('name')} />
            </Row>
            <Row
              label={t('Starts')}
              hint={t('Optional. Posts outside the dates never join by themselves.')}
            >
              <input
                class="g-input"
                type="date"
                value={editing.d.starts_on}
                onInput={field('starts_on')}
              />
            </Row>
            <Row label={t('Ends')}>
              <input
                class="g-input"
                type="date"
                value={editing.d.ends_on}
                onInput={field('ends_on')}
              />
            </Row>
            <Row label={t('Hashtags')} hint={t('A post with any of them in its caption joins.')}>
              <input
                class="g-input"
                value={editing.d.hashtags}
                placeholder="#summer5g #fibra"
                onInput={field('hashtags')}
              />
            </Row>
            <Row label={t('Keywords')} hint={t('Separated by commas; whole words, any case.')}>
              <input class="g-input" value={editing.d.keywords} onInput={field('keywords')} />
            </Row>
            <Row
              label={t('Description')}
              hint={t('What the campaign is about, for Claude to place posts.')}
            >
              <textarea
                class="g-input sm-textarea"
                rows={3}
                value={editing.d.about}
                onInput={field('about')}
              />
            </Row>
            {error && <p class="g-error">{error}</p>}
          </>
        )}
      </Sheet>
    </section>
  )
}

/** What /api/campaigns/:id/report returns. */
export interface CampaignReportData {
  campaign: Campaign
  labels: Record<string, number>
  reputation: number | null
  responses: { comments: number; answered: number; rate: number | null }
  sentiment: { sentiment: string; category: string | null; n: number }[]
  engagement: { posts: number; likes: number; comments: number; shares: number; views: number }
  posts: PostRow[]
  complaints: CommentRow[]
  questions: CommentRow[]
  growth: Growth
}

/**
 * A campaign's report: its figures, what people said under its posts, the complaints and
 * questions people agreed with most, how its posts grew, and the posts. The same pieces on the
 * dashboard and on paper (`print`), in their own frames.
 */
export function CampaignReport({
  r,
  brand,
  print = false,
}: {
  r: CampaignReportData
  brand: BrandRow
  print?: boolean
}) {
  const L = r.labels
  const sorted = (L.total ?? 0) - (L.unsorted ?? 0)
  const pct = (k: string) => (sorted ? `${Math.round(((L[k] ?? 0) / sorted) * 100)}%` : '–')
  const e = r.engagement
  const split = (
    [
      ['complaint', t('Complaints')],
      ['question', t('Questions')],
      ['suggestion', t('Suggestions')],
      ['praise', t('Praise')],
    ] as const
  ).map(([k, name]) => ({ k: k as string, name, n: L[k] ?? 0 }))
  split.push({
    k: 'other',
    name: t('Other'),
    n: Math.max(0, sorted - split.reduce((s, x) => s + x.n, 0)),
  })
  const max = Math.max(1, ...split.map((x) => x.n))
  const mood = ['positive', 'negative', 'neutral'].map((s) => ({
    s,
    n: r.sentiment.filter((x) => x.sentiment === s).reduce((a, x) => a + x.n, 0),
  }))
  const figures: [string, string][] = [
    [t('Posts'), fmt(e.posts)],
    [t('Comments'), fmt(L.total ?? 0)],
    [t('Complaints'), pct('complaint')],
    [t('Questions'), fmt(L.question ?? 0)],
    [t('Praise'), pct('praise')],
    [t('Interactions'), short(e.likes + e.comments + e.shares)],
    [t('Views'), short(e.views)],
    [t('Answered'), r.responses.rate == null ? '–' : `${Math.round(r.responses.rate * 100)}%`],
  ]
  const block = print ? 'sm-pr__block' : 'sm-box'
  const head = (title: string, meta?: string) =>
    print ? (
      <h2>{title}</h2>
    ) : (
      <header class="sm-box__head">
        <h2>{title}</h2>
        {meta && <span class="sm-box__meta">{meta}</span>}
      </header>
    )

  return (
    <>
      {print ? (
        <section class="sm-pr__figs sm-pr__figs--8">
          {figures.map(([k, v]) => (
            <div class="sm-pr__fig">
              <span class="sm-pr__label">{k}</span>
              <b class="g-num">{v}</b>
            </div>
          ))}
        </section>
      ) : (
        <div class="sm-ga__cards sm-camp__figs">
          {figures.map(([k, v]) => (
            <div class="sm-ga__card sm-ga__card--static">
              <span class="sm-ga__label">{k}</span>
              <span class="sm-ga__value g-num">{v}</span>
            </div>
          ))}
        </div>
      )}

      <section class={block}>
        {head(t('What people say'), t('{n} comments sorted', { n: fmt(sorted) }))}
        <ul class="sm-bars">
          {split.map((x) => (
            <li>
              <span class="sm-bars__name">{x.name}</span>
              <span class="sm-bars__track">
                <span
                  class={`sm-bars__fill sm-c-${x.k}`}
                  style={{ width: `${(x.n / max) * 100}%` }}
                />
              </span>
              <b class="g-num">{x.n}</b>
            </li>
          ))}
        </ul>
        <p class="sm-quiet sm-camp__mood">
          {t('Rated positive {p}, negative {n}, neutral {u}.', {
            p: fmt(mood[0]!.n),
            n: fmt(mood[1]!.n),
            u: fmt(mood[2]!.n),
          })}
        </p>
      </section>
      <section class={`${block}${print ? '' : ' sm-box--table'}`}>
        {head(
          t('Posts that grew most'),
          r.campaign.starts_on
            ? t('Since {date}', { date: day(r.campaign.starts_on) })
            : t('All time'),
        )}
        <GrowthLists g={r.growth} />
      </section>

      {(
        [
          [t('Top complaints'), r.complaints, t('No complaints under these posts.')],
          [t('Top questions'), r.questions, t('No questions under these posts.')],
        ] as const
      ).map(([title, list, none]) => (
        <section class={`${block}${print ? ' sm-pr__comments' : ''}`}>
          {head(title)}
          {list.length ? (
            <CommentList comments={list} brands={[brand]} />
          ) : (
            <p class="sm-quiet">{none}</p>
          )}
        </section>
      ))}

      <section class={`${block}${print ? '' : ' sm-box--table'}`}>
        {head(t('Posts in the campaign'), fmt(r.posts.length))}
        {r.posts.length ? (
          <div class="sm-scroll">
            <table class="sm-dtable">
              <thead>
                <tr>
                  <th>{t('Post')}</th>
                  <th>{t('Published')}</th>
                  <th class="sm-num">{t('Likes')}</th>
                  <th class="sm-num">{t('Comments')}</th>
                  <th class="sm-num">{t('Shares')}</th>
                  <th class="sm-num">{t('Views')}</th>
                </tr>
              </thead>
              <tbody>
                {r.posts.map((p) => (
                  <tr>
                    <td>
                      <a class="sm-postcell" href={p.url} target="_blank" rel="noreferrer">
                        {p.thumb_url ? (
                          <img src={p.thumb_url} alt="" loading="lazy" />
                        ) : (
                          <span class="sm-postcell__blank" />
                        )}
                        <NetworkMark network={p.network} size={12} />
                        <span class="sm-postcell__text">
                          {p.description ?? p.caption ?? t('No caption.')}
                        </span>
                      </a>
                    </td>
                    <td class="sm-nowrap">{when(p.posted_at)}</td>
                    <td class="sm-num g-num">{fmt(p.likes)}</td>
                    <td class="sm-num g-num">{fmt(p.comments_count)}</td>
                    <td class="sm-num g-num">{fmt(p.shares)}</td>
                    <td class="sm-num g-num">{fmt(p.views)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="sm-quiet">{t('No posts in this campaign yet.')}</p>
        )}
      </section>
    </>
  )
}

/**
 * The Reports tab's campaign report: pick one of the brand's campaigns, read its report, and
 * download it as a PDF with the brand's own look.
 */
export function CampaignBox({ brand, version }: { brand: BrandRow; version: number }) {
  const [rows] = useCampaigns(brand.id, version)
  const [pick, setPick] = useState<number | null>(null)
  const [r, setR] = useState<CampaignReportData | null>(null)
  const chosen = rows?.find((c) => c.id === pick) ?? rows?.[0] ?? null
  useEffect(() => {
    if (!chosen) return setR(null)
    api
      .get<CampaignReportData>(`/api/campaigns/${chosen.id}/report`)
      .then(setR)
      .catch(() => setR(null))
  }, [chosen?.id, version])
  if (!rows?.length || !chosen) return null
  return (
    <div class="sm-stack sm-camp">
      <div class="sm-camp__bar">
        <h2 class="sm-sec__title">{t('Campaign report')}</h2>
        <select
          class="g-select sm-select-sm"
          aria-label={t('Campaign')}
          value={String(chosen.id)}
          onChange={(e) => setPick(Number((e.target as HTMLSelectElement).value))}
        >
          {rows.map((c) => (
            <option value={String(c.id)}>{c.name}</option>
          ))}
        </select>
        {dates(chosen) && <span class="sm-quiet">{dates(chosen)}</span>}
        <a
          class="g-btn g-btn--sm"
          href={`/api/brands/${brand.id}/report.pdf?campaign=${chosen.id}`}
          download
        >
          {t('Download PDF')}
        </a>
      </div>
      {r && r.campaign.id === chosen.id && <CampaignReport r={r} brand={brand} />}
    </div>
  )
}
