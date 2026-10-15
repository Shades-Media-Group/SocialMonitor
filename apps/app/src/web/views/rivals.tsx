import { useEffect, useState } from 'preact/hooks'
import type { BrandRow, Network } from '../api.ts'
import { api } from '../api.ts'
import { t } from '../i18n.ts'
import { NETWORK_NAME, Row } from '../ui.tsx'

const NETS: Network[] = ['instagram', 'facebook', 'tiktok']
const PLACEHOLDER: Record<Network, string> = {
  instagram: 'https://www.instagram.com/rival',
  facebook: 'https://www.facebook.com/Rival',
  tiktok: 'https://www.tiktok.com/@rival',
}

/** A rival as the server lists it: a brand of its own, with its public profiles. */
export interface Rival {
  id: number
  name: string
  profiles: { network: Network; handle: string }[]
}

/** The rivals a brand watches, for its Share of voice tab. Fetches again when `version` moves. */
export function useRivals(brandId: number, version = 0) {
  const [rivals, setRivals] = useState<Rival[] | null>(null)
  const load = () =>
    api
      .get<Rival[]>(`/api/brands/${brandId}/competitors`)
      .then(setRivals)
      .catch(() => setRivals([]))
  useEffect(() => void load(), [brandId, version])
  return [rivals, load] as const
}

/**
 * Brand settings: the rivals this brand watches. Each one is read by the same updates as the
 * brand and sorted by the same AI, and shows only on this brand's Share of voice.
 */
export function Rivals({ brand, notify }: { brand: BrandRow; notify: (text: string) => void }) {
  const [rivals, load] = useRivals(brand.id)
  const [name, setName] = useState('')
  const [links, setLinks] = useState<Record<Network, string>>({
    instagram: '',
    facebook: '',
    tiktok: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async (e: Event) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.post(`/api/brands/${brand.id}/competitors`, {
        name,
        links: NETS.map((n) => links[n].trim()).filter(Boolean),
      })
      notify(t('{name} added. The next update reads it.', { name: name.trim() }))
      setName('')
      setLinks({ instagram: '', facebook: '', tiktok: '' })
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (r: Rival) => {
    if (!confirm(t('Remove {name}? Its posts and comments are deleted too.', { name: r.name })))
      return
    await api.del(`/api/brands/${brand.id}/competitors/${r.id}`)
    await load()
  }

  if (!rivals) return null
  return (
    <section class="sm-box">
      <header class="sm-box__head">
        <h2>{t('Rivals')}</h2>
        <span class="sm-box__meta">{t('Read with every update, compared on Share of voice')}</span>
      </header>
      {rivals.map((r) => (
        <Row label={r.name}>
          <span class="sm-inline">
            <span class="sm-quiet">
              {r.profiles.map((p) => `${NETWORK_NAME[p.network]} @${p.handle}`).join(', ')}
            </span>
            <button class="g-btn g-btn--ghost g-btn--sm" type="button" onClick={() => remove(r)}>
              {t('Remove')}
            </button>
          </span>
        </Row>
      ))}
      {rivals.length < 5 ? (
        <form class="sm-form" onSubmit={add}>
          <Row label={t('New rival')}>
            <input
              class="g-input"
              required
              placeholder={t('Name')}
              aria-label={t('Name')}
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
            <button class="g-btn g-btn--sm" type="submit" disabled={busy}>
              {t('Add rival')}
            </button>
          </div>
        </form>
      ) : (
        <p class="sm-quiet">{t('Five rivals at most: remove one to add another.')}</p>
      )}
    </section>
  )
}
