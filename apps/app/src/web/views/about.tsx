import { useEffect, useState } from 'preact/hooks'
import type { BrandView } from '../app.tsx'
import type { Network } from '../api.ts'
import { api } from '../api.ts'
import { Icon, NETWORK_NAME, Row } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'
import type { Category } from '../rate.tsx'
import { brandCategories } from '../rate.tsx'

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
export function About({ brand, mode, reload, notify }: BrandView) {
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
  })
  const [links, setLinks] = useState(linksOf)
  const [cats, setCats] = useState<Category[]>(() => brandCategories(brand))
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
        website: f.website || null,
        links: NETS.map((n) => links[n].trim()).filter(Boolean),
      })
      for (const n of NETS)
        if (!links[n].trim() && brand.profiles.some((p) => p.network === n))
          await api.del(`/api/brands/${brand.id}/profiles/${n}`)
      await api.put(`/api/brands/${brand.id}/categories`, { categories: cats })
      await reload()
      notify('Saved.')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (mode === 'json')
    return (
      <JsonPanel
        value={{ ...f, links, categories: cats }}
        note="Everything on this page. Categories: key, name, and sentiment positive or negative."
        onSave={async (next) => {
          const x = next as typeof f & { links?: Record<Network, string>; categories?: Category[] }
          await api.patch(`/api/brands/${brand.id}`, {
            name: x.name,
            industry: x.industry || null,
            website: x.website || null,
            description: x.description || null,
            notes: x.notes || null,
            links: NETS.map((n) => (x.links?.[n] ?? '').trim()).filter(Boolean),
          })
          if (x.categories)
            setCats(
              await api.put<Category[]>(`/api/brands/${brand.id}/categories`, {
                categories: x.categories,
              }),
            )
          await reload()
          return 'Saved.'
        }}
      />
    )

  const set = (k: keyof typeof f) => (e: Event) =>
    setF({ ...f, [k]: (e.target as HTMLInputElement).value })
  const kindList = (sentiment: 'positive' | 'negative') => (
    <div class={`sm-kinds sm-kinds--${sentiment}`}>
      <h3>{sentiment === 'negative' ? 'Negative' : 'Positive'}</h3>
      <ul>
        {cats.map((c, i) =>
          c.sentiment !== sentiment ? null : (
            <li>
              <input
                class="g-input"
                value={c.name}
                aria-label={`${sentiment} kind ${i + 1}`}
                onInput={(e) => {
                  const name = (e.target as HTMLInputElement).value
                  setCats(cats.map((x, j) => (j === i ? { ...x, name } : x)))
                }}
              />
              <button
                class="g-icon-btn"
                type="button"
                aria-label={`Remove ${c.name}`}
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
              name: `New ${sentiment} kind ${n}`,
              sentiment,
            },
          ])
        }}
      >
        Add a kind
      </button>
    </div>
  )

  return (
    <form class="sm-about" onSubmit={save}>
      <section>
        <h2>The brand</h2>
        <Row label="Name">
          <input class="g-input" required value={f.name} onInput={set('name')} />
        </Row>
        <Row
          label="Field of work"
          hint="The AI reads it, so a shop's “out of stock again” is understood as a complaint."
        >
          <input
            class="g-input"
            value={f.industry}
            placeholder="Retail, banking, hospitality…"
            onInput={set('industry')}
          />
        </Row>
        <Row label="Website">
          <input
            class="g-input"
            type="url"
            value={f.website}
            placeholder="https://"
            onInput={set('website')}
          />
        </Row>
        <Row
          label="Description"
          hint="What it sells and to whom. Two or three sentences are enough."
        >
          <textarea
            class="g-input sm-textarea"
            rows={3}
            value={f.description}
            onInput={set('description')}
          />
        </Row>
        <Row
          label="Notes"
          hint="Anything else worth keeping: products, campaigns, people to tell. Only you see it."
        >
          <textarea class="g-input sm-textarea" rows={3} value={f.notes} onInput={set('notes')} />
        </Row>
      </section>

      <section>
        <h2>Networks</h2>
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
      </section>

      <section>
        <div class="sm-section-head">
          <h2>Kinds of comments</h2>
          {Object.keys(templates).length > 0 && (
            <label class="sm-inline-label">
              <span>Start from</span>
              <select
                class="g-select sm-select-sm"
                value=""
                onChange={(e) => {
                  const t = templates[(e.target as HTMLSelectElement).value]
                  if (t) setCats(t.categories)
                }}
              >
                <option value="">A template…</option>
                {Object.entries(templates).map(([k, t]) => (
                  <option value={k}>{t.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p class="sm-quiet">
          Comments are rated positive or negative, then given one of these kinds, by you or by
          Claude.
        </p>
        <div class="sm-kinds-grid">
          {kindList('negative')}
          {kindList('positive')}
        </div>
      </section>

      {error && <p class="g-error">{error}</p>}
      <div class="sm-savebar">
        <button class="g-btn g-btn--primary" type="submit">
          Save
        </button>
        <span class="sm-quiet">Changes apply to new sorting and to Claude right away.</span>
      </div>

      <section class="sm-danger-zone">
        <h2>Delete {brand.name}</h2>
        <p class="sm-quiet">
          Its posts, comments, reports and schedules go too. Export first if you may need them.
        </p>
        {confirm ? (
          <div class="sm-inline">
            <button
              class="g-btn g-btn--sm sm-danger"
              type="button"
              onClick={async () => {
                await api.del(`/api/brands/${brand.id}`)
                await reload()
                notify(`${brand.name} and everything kept for it are deleted.`)
                location.hash = '#/'
              }}
            >
              Delete everything
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => setConfirm(false)}
            >
              Keep it
            </button>
          </div>
        ) : (
          <button
            class="g-btn g-btn--ghost g-btn--sm"
            type="button"
            onClick={() => setConfirm(true)}
          >
            Delete brand
          </button>
        )}
      </section>
    </form>
  )
}
