import { useState } from 'preact/hooks'
import type { AppState } from '../app.tsx'
import type { BrandRow, Network } from '../api.ts'
import { api } from '../api.ts'
import { NETWORK_NAME, Row, ago } from '../ui.tsx'
import { JsonPanel } from '../json.tsx'

const NETS: Network[] = ['instagram', 'facebook', 'tiktok']
const PLACEHOLDER: Record<Network, string> = {
  instagram: 'https://www.instagram.com/brand',
  facebook: 'https://www.facebook.com/Brand',
  tiktok: 'https://www.tiktok.com/@brand',
}

function BrandForm({
  brand,
  done,
  notify,
}: {
  brand?: BrandRow
  done: () => void
  notify: (s: string) => void
}) {
  const [name, setName] = useState(brand?.name ?? '')
  const [links, setLinks] = useState<Record<Network, string>>(() => {
    const out = { instagram: '', facebook: '', tiktok: '' }
    for (const p of brand?.profiles ?? []) out[p.network] = p.url
    return out
  })
  const [error, setError] = useState<string | null>(null)

  const save = async (e: Event) => {
    e.preventDefault()
    setError(null)
    try {
      const list = NETS.map((n) => links[n].trim()).filter(Boolean)
      if (brand) {
        await api.patch(`/api/brands/${brand.id}`, { name, links: list })
        for (const n of NETS)
          if (!links[n].trim() && brand.profiles.some((p) => p.network === n))
            await api.del(`/api/brands/${brand.id}/profiles/${n}`)
      } else await api.post('/api/brands', { name, links: list })
      notify(brand ? 'Saved.' : `${name} added.`)
      done()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form class="sm-form" onSubmit={save}>
      <Row label="Name">
        <input
          class="g-input"
          required
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </Row>
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
      {error && <p class="g-error">{error}</p>}
      <div class="sm-form__actions">
        <button class="g-btn g-btn--primary g-btn--sm" type="submit">
          {brand ? 'Save' : 'Add brand'}
        </button>
        <button class="g-btn g-btn--ghost g-btn--sm" type="button" onClick={done}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export function Brands({ brands, reload, notify, mode }: AppState) {
  const [editing, setEditing] = useState<number | 'new' | null>(brands.length ? null : 'new')
  const [confirm, setConfirm] = useState<number | null>(null)
  const done = () => {
    setEditing(null)
    reload()
  }

  if (mode === 'json') {
    const value = brands.map((b) => ({
      id: b.id,
      name: b.name,
      website: b.website,
      links: Object.fromEntries(
        NETS.map((n) => [n, b.profiles.find((p) => p.network === n)?.url ?? '']),
      ),
    }))
    const save = async (next: unknown) => {
      if (!Array.isArray(next)) throw new Error('Expected a list of brands.')
      let added = 0
      let saved = 0
      for (const x of next as typeof value) {
        if (!x?.name?.trim()) throw new Error('Every brand needs a name.')
        const links = NETS.map((n) => (x.links?.[n] ?? '').trim()).filter(Boolean)
        const old = brands.find((b) => b.id === x.id)
        if (!old) {
          await api.post('/api/brands', { name: x.name, links, website: x.website ?? null })
          added++
          continue
        }
        await api.patch(`/api/brands/${old.id}`, {
          name: x.name,
          links,
          website: x.website ?? null,
        })
        for (const n of NETS)
          if (
            x.links &&
            n in x.links &&
            !x.links[n]?.trim() &&
            old.profiles.some((p) => p.network === n)
          )
            await api.del(`/api/brands/${old.id}/profiles/${n}`)
        saved++
      }
      reload()
      notify('Brands saved.')
      return `Saved ${saved}, added ${added}. A brand left out of the list is kept: delete it in Visual.`
    }
    return (
      <JsonPanel
        value={value}
        onSave={save}
        note="Edit names and links, or add a brand without an id. Leaving a brand out does not delete it."
      />
    )
  }

  return (
    <div class="sm-stack">
      <ul class="sm-list">
        {brands.map((b) =>
          editing === b.id ? (
            <li class="sm-brand-row">
              <BrandForm brand={b} done={done} notify={notify} />
            </li>
          ) : (
            <li class="sm-brand-row">
              <div class="sm-brand-row__main">
                <h2>{b.name}</h2>
                <p class="sm-quiet">
                  {b.profiles.length
                    ? b.profiles.map((p) => `${NETWORK_NAME[p.network]} @${p.handle}`).join(' · ')
                    : 'No links yet.'}
                </p>
                <p class="sm-quiet">
                  {b.counts.total ?? 0} comments kept · last update{' '}
                  {ago(
                    b.profiles
                      .map((p) => p.last_run_at)
                      .filter(Boolean)
                      .sort()
                      .at(-1),
                  )}
                </p>
              </div>
              <div class="sm-brand-row__actions">
                <button
                  class="g-btn g-btn--ghost g-btn--sm"
                  type="button"
                  onClick={() => setEditing(b.id)}
                >
                  Edit
                </button>
                {confirm === b.id ? (
                  <button
                    class="g-btn g-btn--sm sm-danger"
                    type="button"
                    onClick={async () => {
                      await api.del(`/api/brands/${b.id}`)
                      setConfirm(null)
                      notify(`${b.name} and all its posts and comments are deleted.`)
                      reload()
                    }}
                  >
                    Delete everything
                  </button>
                ) : (
                  <button
                    class="g-btn g-btn--ghost g-btn--sm"
                    type="button"
                    onClick={() => setConfirm(b.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ),
        )}
        {editing === 'new' && (
          <li class="sm-brand-row">
            <BrandForm done={done} notify={notify} />
          </li>
        )}
      </ul>
      {editing !== 'new' && (
        <div>
          <button class="g-btn g-btn--sm" type="button" onClick={() => setEditing('new')}>
            Add a brand
          </button>
        </div>
      )}
    </div>
  )
}
