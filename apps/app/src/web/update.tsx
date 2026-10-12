import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import type { Network } from './api.ts'
import { api } from './api.ts'
import { Chips, NetworkMark, Row, Segmented, Sheet, ago, count } from './ui.tsx'
import { usePref } from './prefs.ts'
import { AutoUpdate } from './auto-update.tsx'
import { locale, t } from './i18n.ts'

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
  const [range, setRange] = usePref<'all' | 'due' | 'new'>('update.range', 'all')
  const [limit, setLimit] = usePref('update.limit', 15)
  const [preview, setPreview] = useState<
    {
      brand_id: number
      brand: string
      network: Network
      handle: string
      last_run_at: string | null
      last_status: string | null
      due: number
    }[]
  >([])
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
  useEffect(() => {
    if (!open || !ids.length) return setPreview([])
    api
      .get<typeof preview>(`/api/runs/preview?brands=${ids.join(',')}`)
      .then(setPreview)
      .catch(() => setPreview([]))
  }, [open, ids.join()])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      // 'Latest, again' also refreshes due older posts: run it as 'all' plus the due ones.
      await api.post('/api/runs', { brandIds: ids.map(Number), networks, range, limit })
      onClose()
      notify(t('Update started. Follow it in the corner; you can keep working.'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const due = preview.filter((p) => networks.includes(p.network)).reduce((n, p) => n + p.due, 0)
  const profiles = brands
    .filter((b) => ids.includes(String(b.id)))
    .flatMap((b) => b.profiles.filter((p) => networks.includes(p.network)))

  return (
    <Sheet
      open={open}
      title={t('Update')}
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
            {!profiles.length
              ? t('Choose a brand and a network')
              : range === 'all'
                ? t('Read the latest {posts} from {profiles}', {
                    posts: count(limit, 'post'),
                    profiles: count(profiles.length, 'profile'),
                  })
                : range === 'due' && due
                  ? t('Read new posts and {n} due from {profiles}', {
                      n: due,
                      profiles: count(profiles.length, 'profile'),
                    })
                  : t('Read new posts from {profiles}', {
                      profiles: count(profiles.length, 'profile'),
                    })}
          </button>
        </>
      }
    >
      {brands.length > 1 && (
        <Row label={t('Brands')}>
          <Chips
            label={t('Brands')}
            values={ids}
            onChange={setIds}
            options={brands.map((b) => [String(b.id), b.name])}
          />
        </Row>
      )}
      <Row label={t('Networks')}>
        <Chips
          label={t('Networks')}
          values={networks}
          onChange={setNetworks}
          options={NET_OPTIONS}
        />
      </Row>
      <Row label={t('Posts')}>
        <Segmented
          label={t('Posts')}
          value={range}
          onChange={setRange}
          options={[
            ['all', t('Latest, again')],
            ['due', t('New and due')],
            ['new', t('Only new')],
          ]}
        />
      </Row>
      <p class="sm-quiet sm-update__what">
        {range === 'all'
          ? t(
              'Reads the newest posts again with all their comments, and older posts whose numbers are due. The fullest, and the slowest.',
            )
          : range === 'due'
            ? t(
                'Reads posts not seen before, plus older posts whose likes, shares and views are due for a fresh look.',
              )
            : t('Reads only posts not seen before. The lightest.')}
      </p>
      {gaps
        .filter((g) => ids.includes(String(g.brand_id)) && networks.includes(g.network))
        .map((g) => (
          <p class="sm-quiet sm-gap">
            {t(
              '{network}: comments wait until {time}, so this update refreshes its posts and counts only.',
              {
                network: NET_OPTIONS.find(([n]) => n === g.network)![1],
                time: new Date(g.until).toLocaleTimeString(locale, {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              },
            )}
          </p>
        ))}
      {preview.filter((p) => networks.includes(p.network)).length > 0 && (
        <ul class="sm-update__list">
          {preview
            .filter((p) => networks.includes(p.network))
            .map((p) => (
              <li>
                <NetworkMark network={p.network} size={14} />
                <span class="sm-update__who">
                  <b>{p.brand}</b> @{p.handle}
                </span>
                <span class="sm-quiet">
                  {p.last_status === 'error'
                    ? t('Needs you')
                    : p.last_run_at
                      ? t('Read {when}', { when: ago(p.last_run_at) })
                      : t('Not read yet')}
                </span>
                {range !== 'new' && p.due > 0 && (
                  <span class="sm-update__due">{t('{n} due for fresh numbers', { n: p.due })}</span>
                )}
              </li>
            ))}
        </ul>
      )}
      {brands
        .filter((b) => ids.includes(String(b.id)) && b.my_role === 'admin')
        .map((b) => (
          <Row label={brands.length > 1 ? `${t('Automatic')} · ${b.name}` : t('Automatic')}>
            <AutoUpdate brand={b} />
          </Row>
        ))}
      <Row label={t('At most')} hint={t('new posts per profile, newest first')}>
        <input
          class="g-input sm-input-num"
          type="number"
          min={1}
          max={50}
          value={limit}
          onInput={(e) => setLimit(Number((e.target as HTMLInputElement).value) || 15)}
        />
      </Row>
    </Sheet>
  )
}
