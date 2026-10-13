import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { Network, Tracker } from '../api.ts'
import { api } from '../api.ts'
import { Icon, NETWORK_NAME, NetworkMark, Row, fmt, navigate } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import { AutoUpdate } from '../auto-update.tsx'
import type { Category } from '../rate.tsx'
import { brandCategories } from '../rate.tsx'
import { t } from '../i18n.ts'

const NETS: Network[] = ['instagram', 'facebook', 'tiktok']
const PLACEHOLDER: Record<Network, string> = {
  instagram: 'https://www.instagram.com/brand',
  facebook: 'https://www.facebook.com/Brand',
  tiktok: 'https://www.tiktok.com/@brand',
}

/**
 * What the brand is, where it posts, and the kinds of positive and negative comments it gets.
 * The field of work and the description also go to the AI, so it sorts with context.
 */
export function About({ brand, mode, reload, notify, me }: BrandView) {
  const edit = brand.my_role === 'admin'
  const linksOf = () =>
    Object.fromEntries(
      NETS.map((n) => [n, brand.profiles.find((p) => p.network === n)?.url ?? '']),
    ) as Record<Network, string>
  const [f, setF] = useState({
    name: brand.name,
    industry: brand.industry ?? '',
    website: brand.website ?? '',
    description: brand.description ?? '',
    notes: brand.notes ?? '',
    reply_target_hours: String(brand.reply_target_hours ?? 24),
  })
  const [links, setLinks] = useState(linksOf)
  const [cats, setCats] = useState<Category[]>(() => brandCategories(brand))
  const [watch, setWatch] = useState<Tracker[]>(() => {
    try {
      return JSON.parse(brand.trackers ?? '[]') as Tracker[]
    } catch {
      return []
    }
  })
  const [templates, setTemplates] = useState<
    Record<string, { name: string; categories: Category[] }>
  >({})
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    api
      .get<typeof templates>('/api/templates')
      .then(setTemplates)
      .catch(() => {})
  }, [])

  const save = async (e?: Event) => {
    e?.preventDefault()
    setError(null)
    try {
      await api.patch(`/api/brands/${brand.id}`, {
        ...f,
        reply_target_hours: Number(f.reply_target_hours) || 24,
        website: f.website || null,
        links: NETS.map((n) => links[n].trim()).filter(Boolean),
      })
      for (const n of NETS)
        if (!links[n].trim() && brand.profiles.some((p) => p.network === n))
          await api.del(`/api/brands/${brand.id}/profiles/${n}`)
      await api.put(`/api/brands/${brand.id}/categories`, { categories: cats })
      setWatch(await api.put<Tracker[]>(`/api/brands/${brand.id}/trackers`, { trackers: watch }))
      await reload()
      notify(t('Saved.'))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (mode === 'json')
    return (
      <JsonPanel
        value={{ ...f, links, categories: cats }}
        note={t(
          'Everything on this page. Categories: key, name, and sentiment positive or negative.',
        )}
        onSave={async (next) => {
          const x = next as typeof f & { links?: Record<Network, string>; categories?: Category[] }
          await api.patch(`/api/brands/${brand.id}`, {
            name: x.name,
            industry: x.industry || null,
            website: x.website || null,
            description: x.description || null,
            notes: x.notes || null,
            reply_target_hours: Number(x.reply_target_hours) || undefined,
            links: NETS.map((n) => (x.links?.[n] ?? '').trim()).filter(Boolean),
          })
          if (x.categories)
            setCats(
              await api.put<Category[]>(`/api/brands/${brand.id}/categories`, {
                categories: x.categories,
              }),
            )
          await reload()
          return t('Saved.')
        }}
      />
    )

  const set = (k: keyof typeof f) => (e: Event) =>
    setF({ ...f, [k]: (e.target as HTMLInputElement).value })
  const kindList = (sentiment: 'positive' | 'negative') => (
    <div class={`sm-kinds sm-kinds--${sentiment}`}>
      <h3>{sentiment === 'negative' ? t('Negative') : t('Positive')}</h3>
      <ul>
        {cats.map((c, i) =>
          c.sentiment !== sentiment ? null : (
            <li>
              <input
                class="g-input"
                value={c.name}
                aria-label={
                  sentiment === 'negative'
                    ? t('negative kind {n}', { n: i + 1 })
                    : t('positive kind {n}', { n: i + 1 })
                }
                onInput={(e) => {
                  const name = (e.target as HTMLInputElement).value
                  setCats(cats.map((x, j) => (j === i ? { ...x, name } : x)))
                }}
              />
              <button
                class="g-icon-btn"
                type="button"
                aria-label={t('Remove {name}', { name: c.name })}
                onClick={() => setCats(cats.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={16} />
              </button>
            </li>
          ),
        )}
      </ul>
      <button
        class="sm-textbtn"
        type="button"
        onClick={() => {
          const n = cats.filter((c) => c.sentiment === sentiment).length + 1
          setCats([
            ...cats,
            {
              key: `${sentiment}-${Date.now().toString(36)}`,
              name:
                sentiment === 'negative'
                  ? t('New negative kind {n}', { n })
                  : t('New positive kind {n}', { n }),
              sentiment,
            },
          ])
        }}
      >
        {t('Add a kind')}
      </button>
    </div>
  )

  return (
    <form class="sm-about" onSubmit={save}>
      {!edit && <p class="sm-quiet">{t('You can read this brand. Its admins can change it.')}</p>}
      <fieldset class="sm-fieldset" disabled={!edit}>
        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{t('The brand')}</h2>
          </header>
          <Row label={t('Name')}>
            <input class="g-input" required value={f.name} onInput={set('name')} />
          </Row>
          <Row
            label={t('Field of work')}
            hint={t(
              "The AI reads it, so a shop's “out of stock again” is understood as a complaint.",
            )}
          >
            <input
              class="g-input"
              value={f.industry}
              placeholder={t('Retail, banking, hospitality…')}
              onInput={set('industry')}
            />
          </Row>
          <Row label={t('Website')}>
            <input
              class="g-input"
              type="url"
              value={f.website}
              placeholder="https://"
              onInput={set('website')}
            />
          </Row>
          <Row
            label={t('Description')}
            hint={t('What it sells and to whom. Two or three sentences are enough.')}
          >
            <textarea
              class="g-input sm-textarea"
              rows={3}
              value={f.description}
              onInput={set('description')}
            />
          </Row>
          <Row
            label={t('Notes')}
            hint={t(
              'Anything else worth keeping: products, campaigns, people to tell. Only you see it.',
            )}
          >
            <textarea class="g-input sm-textarea" rows={3} value={f.notes} onInput={set('notes')} />
          </Row>
          <Row
            label={t('Reply target')}
            hint={t('Hours a comment may wait for an answer. Older ones are marked overdue.')}
          >
            <input
              class="g-input sm-input--short"
              type="number"
              min="1"
              max="720"
              step="1"
              value={f.reply_target_hours}
              onInput={set('reply_target_hours')}
            />
          </Row>
        </section>

        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{t('Networks')}</h2>
          </header>
          {NETS.map((n) => (
            <Row label={NETWORK_NAME[n]}>
              <input
                class="g-input"
                type="url"
                placeholder={PLACEHOLDER[n]}
                value={links[n]}
                onInput={(e) => setLinks({ ...links, [n]: (e.target as HTMLInputElement).value })}
              />
            </Row>
          ))}
          <TikTokConnect brand={brand} edit={edit} notify={notify} />
          <MetaConnect brand={brand} edit={edit} notify={notify} />
          <Row
            label={t('Automatic updates')}
            hint={t('New posts and fresh numbers, read by themselves. More choices in Settings.')}
          >
            <AutoUpdate brand={brand} />
          </Row>
        </section>

        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{t('Words to watch')}</h2>
          </header>
          <p class="sm-quiet">
            {t(
              'Your products, campaigns, other brands or topics. The overview counts how often comments mention each one.',
            )}
          </p>
          <ul class="sm-watch">
            {watch.map((w, i) => (
              <li>
                <input
                  class="g-input"
                  value={w.term}
                  aria-label={t('Word or phrase')}
                  maxLength={60}
                  onInput={(e) =>
                    setWatch(
                      watch.map((x, j) =>
                        j === i ? { ...x, term: (e.target as HTMLInputElement).value } : x,
                      ),
                    )
                  }
                />
                <select
                  class="g-select sm-select-sm"
                  value={w.kind}
                  aria-label={t('What it is')}
                  onChange={(e) =>
                    setWatch(
                      watch.map((x, j) =>
                        j === i
                          ? { ...x, kind: (e.target as HTMLSelectElement).value as Tracker['kind'] }
                          : x,
                      ),
                    )
                  }
                >
                  <option value="product">{t('Product')}</option>
                  <option value="competitor">{t('Other brand')}</option>
                  <option value="topic">{t('Topic')}</option>
                </select>
                <button
                  class="g-icon-btn"
                  type="button"
                  aria-label={t('Remove')}
                  onClick={() => setWatch(watch.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
          {watch.length < 40 && (
            <button
              class="sm-textbtn"
              type="button"
              onClick={() => setWatch([...watch, { term: '', kind: 'product' }])}
            >
              {t('Add a word')}
            </button>
          )}
        </section>

        <section class="sm-box">
          <header class="sm-box__head">
            <h2>{t('Kinds of comments')}</h2>
            {Object.keys(templates).length > 0 && (
              <label class="sm-inline-label">
                <span>{t('Start from')}</span>
                <select
                  class="g-select sm-select-sm"
                  value=""
                  onChange={(e) => {
                    const tpl = templates[(e.target as HTMLSelectElement).value]
                    if (tpl) setCats(tpl.categories)
                  }}
                >
                  <option value="">{t('A template…')}</option>
                  {Object.entries(templates).map(([k, tpl]) => (
                    <option value={k}>{tpl.name}</option>
                  ))}
                </select>
              </label>
            )}
          </header>
          <p class="sm-quiet">
            {t(
              'Comments are rated positive or negative, then given one of these kinds, or neutral when they count neither way, by you or by Claude.',
            )}
          </p>
          <div class="sm-kinds-grid">
            {kindList('negative')}
            {kindList('positive')}
          </div>
        </section>
      </fieldset>
      {error && <p class="g-error">{error}</p>}
      {edit && (
        <div class="sm-savebar">
          <button class="g-btn g-btn--primary" type="submit">
            {t('Save')}
          </button>
          <span class="sm-quiet">
            {t('Changes apply to new sorting and to Claude right away.')}
          </span>
        </div>
      )}

      {me.super && (
        <section class="sm-box sm-danger-zone">
          <header class="sm-box__head">
            <h2>{t('Delete {name}', { name: brand.name })}</h2>
          </header>
          <p class="sm-quiet">
            {t(
              'Its posts, comments, reports and schedules go too. Export first if you may need them.',
            )}
          </p>
          {confirm ? (
            <div class="sm-inline">
              <button
                class="g-btn g-btn--sm sm-danger"
                type="button"
                onClick={async () => {
                  await api.del(`/api/brands/${brand.id}`)
                  await reload()
                  notify(t('{name} and everything kept for it are deleted.', { name: brand.name }))
                  navigate('/')
                }}
              >
                {t('Delete everything')}
              </button>
              <button
                class="g-btn g-btn--ghost g-btn--sm"
                type="button"
                onClick={() => setConfirm(false)}
              >
                {t('Keep it')}
              </button>
            </div>
          ) : (
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => setConfirm(true)}
            >
              {t('Delete brand')}
            </button>
          )}
        </section>
      )}
    </form>
  )
}

interface TikTokAccount {
  username?: string
  display_name?: string
  avatar_url?: string
  follower_count?: number
  video_count?: number
  connected_at: string
}

/**
 * The brand's own TikTok, connected through TikTok's sign-in: exact figures for its videos and
 * its follower count. Comments keep coming from public pages either way.
 */
function TikTokConnect({
  brand,
  edit,
  notify,
}: {
  brand: BrandView['brand']
  edit: boolean
  notify: (text: string) => void
}) {
  const [state, setState] = useState<{ ready: boolean; account: TikTokAccount | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    api
      .get<{ ready: boolean; account: TikTokAccount | null }>(`/api/brands/${brand.id}/tiktok`)
      .then(setState)
      .catch(() => setState(null))
  useEffect(() => {
    void load()
    if (new URLSearchParams(location.search).get('tiktok') === 'connected')
      notify(t('TikTok connected.'))
  }, [brand.id])
  if (!state) return null
  const a = state.account
  return (
    <Row
      label={t('Your TikTok account')}
      hint={t(
        'Connect it with TikTok to get exact figures for its videos and its followers. SocialMonitor only reads; it never posts.',
      )}
    >
      {a ? (
        <span class="sm-connected">
          {a.avatar_url && <img src={a.avatar_url} alt="" />}
          <span>
            <b>{a.display_name ?? a.username}</b>
            <small>
              {a.username ? `@${a.username} · ` : ''}
              {t('{n} followers', { n: fmt(a.follower_count ?? 0) })}
            </small>
          </span>
          {edit && (
            <button
              class="sm-textbtn"
              type="button"
              onClick={async () => {
                await api.del(`/api/brands/${brand.id}/tiktok`)
                await load()
              }}
            >
              {t('Disconnect')}
            </button>
          )}
        </span>
      ) : (
        <span class="sm-connected">
          <button
            class="g-btn"
            type="button"
            disabled={!edit || !state.ready}
            onClick={async () => {
              setError(null)
              try {
                const r = await api.post<{ url: string }>(
                  `/api/brands/${brand.id}/tiktok/connect`,
                  {
                    origin: location.origin,
                  },
                )
                location.href = r.url
              } catch (e) {
                setError((e as Error).message)
              }
            }}
          >
            <NetworkMark network="tiktok" size={14} /> {t('Connect with TikTok')}
          </button>
          {!state.ready && (
            <small class="sm-quiet">
              {t('Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to .env first.')}
            </small>
          )}
          {error && <small class="g-error">{error}</small>}
        </span>
      )}
    </Row>
  )
}

type MetaAccount = { name: string; username: string | null; connected_at: string } | null

/** The brand's own Facebook Page and its Instagram, read through Meta's API once connected. */
function MetaConnect({
  brand,
  edit,
  notify,
}: {
  brand: BrandView['brand']
  edit: boolean
  notify: (text: string) => void
}) {
  const [state, setState] = useState<{
    ready: boolean
    facebook: MetaAccount
    instagram: MetaAccount
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    api
      .get<NonNullable<typeof state>>(`/api/brands/${brand.id}/meta`)
      .then(setState)
      .catch(() => setState(null))
  useEffect(() => {
    void load()
    const back = new URLSearchParams(location.search).get('meta')
    if (back === 'connected') notify(t('Facebook and Instagram connected.'))
    else if (back) setError(back)
  }, [brand.id])
  if (!state) return null
  const fb = state.facebook
  return (
    <Row
      label={t('Your Facebook Page')}
      hint={t(
        'Connect the Page you manage, and the Instagram account linked to it, to read their posts and comments through Meta, with no signed-in browser. SocialMonitor only reads; it never posts.',
      )}
    >
      {fb ? (
        <span class="sm-connected">
          <span>
            <b>{fb.name}</b>
            <small>
              {state.instagram?.username
                ? t('and Instagram @{name}', { name: state.instagram.username })
                : t('No Instagram account is linked to this Page.')}
            </small>
          </span>
          {edit && (
            <button
              class="sm-textbtn"
              type="button"
              onClick={async () => {
                await api.del(`/api/brands/${brand.id}/meta`)
                await load()
              }}
            >
              {t('Disconnect')}
            </button>
          )}
        </span>
      ) : (
        <span class="sm-connected">
          <button
            class="g-btn"
            type="button"
            disabled={!edit || !state.ready}
            onClick={async () => {
              setError(null)
              try {
                const r = await api.post<{ url: string }>(`/api/brands/${brand.id}/meta/connect`, {
                  origin: location.origin,
                })
                location.href = r.url
              } catch (e) {
                setError((e as Error).message)
              }
            }}
          >
            <NetworkMark network="facebook" size={14} /> {t('Connect with Facebook')}
          </button>
          {!state.ready && (
            <small class="sm-quiet">
              {t('Add META_APP_ID and META_APP_SECRET to .env first.')}
            </small>
          )}
          {error && <small class="g-error">{error}</small>}
        </span>
      )}
    </Row>
  )
}
