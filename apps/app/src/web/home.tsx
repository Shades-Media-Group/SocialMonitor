import { useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import type { BrandRow, Network } from './api.ts'
import { api } from './api.ts'
import { Icon, NetworkMark, Row, ago, fmt } from './ui.tsx'
import { JsonPanel } from './json.tsx'

const NETS: Network[] = ['instagram', 'facebook', 'tiktok']
const PLACEHOLDER: Record<Network, string> = {
  instagram: 'https://www.instagram.com/brand',
  facebook: 'https://www.facebook.com/Brand',
  tiktok: 'https://www.tiktok.com/@brand',
}

/** The brand list: every brand you watch, with what waits for you under it. */
export function Home({ brands, mode, adding, reload, notify }: AppState & { adding: boolean }) {
  if (mode === 'json')
    return (
      <main class="sm-page">
        <JsonPanel
          value={brands.map((b) => ({
            id: b.id,
            name: b.name,
            industry: b.industry,
            need_a_reply: b.counts.needs_reply ?? 0,
            complaints: b.counts.complaint ?? 0,
            comments: b.counts.total ?? 0,
            networks: b.profiles.map((p) => ({
              network: p.network,
              handle: p.handle,
              last_update: p.last_run_at,
              status: p.last_status,
            })),
          }))}
        />
      </main>
    )

  return (
    <main class="sm-page">
      <header class="sm-head">
        <h1>Brands</h1>
        <p class="sm-head__lead">
          Each brand you watch, and what people say under its posts. Open one to read it.
        </p>
      </header>

      {brands.length > 0 && (
        <ul class="sm-brands">
          {brands.map((b) => (
            <BrandLine brand={b} />
          ))}
        </ul>
      )}

      {adding || !brands.length ? (
        <NewBrand reload={reload} notify={notify} />
      ) : (
        <p class="sm-after">
          <a class="g-btn g-btn--sm" href="#/new">
            <Icon name="add" size={16} /> Add a brand
          </a>
        </p>
      )}
    </main>
  )
}

function BrandLine({ brand: b }: { brand: BrandRow }) {
  const waiting = b.counts.needs_reply ?? 0
  const last = b.profiles
    .map((p) => p.last_run_at)
    .filter(Boolean)
    .sort()
    .at(-1)
  const trouble = b.profiles.find((p) => p.last_status === 'error')
  return (
    <li>
      <a class="sm-brandline" href={`#/b/${b.id}/overview`}>
        <span class="sm-brandline__name">
          <strong>{b.name}</strong>
          <span>{b.industry || 'No field of work yet'}</span>
        </span>
        <span class="sm-brandline__nets" aria-label="Networks">
          {NETS.map((n) =>
            b.profiles.some((p) => p.network === n) ? (
              <NetworkMark network={n} size={18} />
            ) : (
              <span class="sm-net-off" />
            ),
          )}
        </span>
        <span class="sm-brandline__fig sm-brandline__fig--main">
          <b class={`g-num${waiting ? ' sm-hot' : ''}`}>{fmt(waiting)}</b>
          <span>to answer</span>
        </span>
        <span class="sm-brandline__fig">
          <b class="g-num">{fmt(b.counts.complaint ?? 0)}</b>
          <span>complaints</span>
        </span>
        <span class="sm-brandline__fig">
          <b class="g-num">{fmt(b.counts.total ?? 0)}</b>
          <span>comments</span>
        </span>
        <span class={`sm-brandline__when${trouble ? ' sm-brandline__when--error' : ''}`}>
          {trouble ? 'Needs you' : `Updated ${ago(last)}`}
        </span>
        <Icon name="chevronRight" size={20} />
      </a>
    </li>
  )
}

function NewBrand({ reload, notify }: Pick<AppState, 'reload' | 'notify'>) {
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState('')
  const [links, setLinks] = useState<Record<Network, string>>({
    instagram: '',
    facebook: '',
    tiktok: '',
  })
  const [error, setError] = useState<string | null>(null)

  const save = async (e: Event) => {
    e.preventDefault()
    setError(null)
    try {
      const b = await api.post<{ id: number }>('/api/brands', {
        name,
        links: NETS.map((n) => links[n].trim()).filter(Boolean),
      })
      if (industry.trim()) await api.patch(`/api/brands/${b.id}`, { industry })
      await reload()
      notify(`${name} added. Press Update to read it.`)
      location.hash = `#/b/${b.id}/overview`
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section class="sm-panel">
      <h2>Add a brand</h2>
      <form class="sm-form" onSubmit={save}>
        <Row label="Name">
          <input
            class="g-input"
            required
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </Row>
        <Row
          label="Field of work"
          hint="Telecom, retail, banking… The AI reads it to sort comments better."
        >
          <input
            class="g-input"
            value={industry}
            onInput={(e) => setIndustry((e.target as HTMLInputElement).value)}
          />
        </Row>
        {NETS.map((n) => (
          <Row label={{ instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' }[n]}>
            <input
              class="g-input"
              type="url"
              placeholder={PLACEHOLDER[n]}
              value={links[n]}
              onInput={(e) => setLinks({ ...links, [n]: (e.target as HTMLInputElement).value })}
            />
          </Row>
        ))}
        {error && <p class="g-error">{error}</p>}
        <div class="sm-form__actions">
          <button class="g-btn g-btn--primary g-btn--sm" type="submit">
            Add brand
          </button>
          <a class="g-btn g-btn--ghost g-btn--sm" href="#/">
            Cancel
          </a>
        </div>
      </form>
    </section>
  )
}
