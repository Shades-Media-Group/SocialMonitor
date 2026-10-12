import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import type { Network } from './api.ts'
import { api } from './api.ts'
import { Chips, Row, Segmented, Sheet } from './ui.tsx'

const NET_OPTIONS: [Network, string][] = [
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['tiktok', 'TikTok'],
]

/** The manual update: choose brands, networks, and new posts or the latest again. */
export function UpdateSheet({
  open,
  onClose,
  brands,
  brandId,
  notify,
}: AppState & { open: boolean; onClose: () => void; brandId?: number }) {
  const [ids, setIds] = useState<string[]>([])
  const [networks, setNetworks] = useState<Network[]>(['instagram', 'facebook', 'tiktok'])
  const [range, setRange] = useState<'new' | 'all'>('new')
  const [limit, setLimit] = useState(5)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [gaps, setGaps] = useState<{ brand_id: number; network: Network; until: string }[]>([])

  useEffect(() => {
    if (open) {
      api
        .get<typeof gaps>('/api/gaps')
        .then(setGaps)
        .catch(() => setGaps([]))
      setIds(brandId ? [String(brandId)] : brands.map((b) => String(b.id)))
      setError(null)
    }
  }, [open, brandId])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/runs', { brandIds: ids.map(Number), networks, range, limit })
      onClose()
      notify('Update started. It reads slowly on purpose, like a person would.')
      if (ids.length === 1) location.hash = `#/b/${ids[0]}/reports`
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const profiles = brands
    .filter((b) => ids.includes(String(b.id)))
    .flatMap((b) => b.profiles.filter((p) => networks.includes(p.network)))

  return (
    <Sheet
      open={open}
      title="Update"
      onClose={onClose}
      footer={
        <>
          {error && <p class="g-error">{error}</p>}
          <button
            class="g-btn g-btn--primary g-btn--block"
            type="button"
            disabled={busy || !profiles.length}
            onClick={start}
          >
            {profiles.length
              ? `Read ${range === 'new' ? 'new posts' : `the latest ${limit} posts`} from ${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'}`
              : 'Choose a brand and a network'}
          </button>
        </>
      }
    >
      {brands.length > 1 && (
        <Row label="Brands">
          <Chips
            label="Brands"
            values={ids}
            onChange={setIds}
            options={brands.map((b) => [String(b.id), b.name])}
          />
        </Row>
      )}
      <Row label="Networks">
        <Chips label="Networks" values={networks} onChange={setNetworks} options={NET_OPTIONS} />
      </Row>
      <Row label="Posts">
        <Segmented
          label="Posts"
          value={range}
          onChange={setRange}
          options={[
            ['new', 'New since last update'],
            ['all', 'Latest, again'],
          ]}
        />
      </Row>
      {gaps
        .filter((g) => ids.includes(String(g.brand_id)) && networks.includes(g.network))
        .map((g) => (
          <p class="sm-quiet sm-gap">
            {NET_OPTIONS.find(([n]) => n === g.network)![1]}: comments wait until{' '}
            {new Date(g.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })},
            so this update refreshes its posts and counts only.
          </p>
        ))}
      <Row label="At most" hint="posts per profile, newest first">
        <input
          class="g-input sm-input-num"
          type="number"
          min={1}
          max={50}
          value={limit}
          onInput={(e) => setLimit(Number((e.target as HTMLInputElement).value) || 5)}
        />
      </Row>
    </Sheet>
  )
}
