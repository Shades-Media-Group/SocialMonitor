import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import { api } from './api.ts'
import { Empty, Head, count } from './ui.tsx'
import { locale, t } from './i18n.ts'
import { JsonPanel } from './json.tsx'

interface Row {
  id: number
  at: string
  actor: number | null
  actor_email: string | null
  actor_name: string | null
  event: string
  target: string | null
  brand_id: number | null
  brand_name: string | null
  ip: string | null
  ua: string | null
  detail: string
}

const EVENT: Record<string, string> = {
  'signin.ok': t('Signed in'),
  'signin.failed': t('Sign-in failed'),
  'code.sent': t('Sign-in code sent'),
  'logout.everywhere': t('Signed out everywhere'),
  'password.changed': t('Password changed'),
  'invite.accepted': t('Invitation accepted'),
  'person.invited': t('Person invited'),
  'person.role': t('Access changed'),
  'person.disabled': t('Person blocked'),
  'person.enabled': t('Person unblocked'),
  'person.removed': t('Person removed'),
  'person.joined': t('Joined with Shades login'),
  'brand.created': t('Brand added'),
  'brand.deleted': t('Brand deleted'),
  'network.connected': t('Network connected'),
  'network.disconnected': t('Network disconnected'),
  'settings.changed': t('Settings changed'),
  'account.saved': t('Saved account changed'),
  'account.deleted': t('Saved account deleted'),
  'account.revealed': t('Saved password shown'),
  export: t('Exported'),
  import: t('Imported'),
  download: t('Downloaded'),
  'report.sent': t('Report emailed'),
  'security.new_device': t('Sign-in from a new device'),
  'security.second_factor_added': t('Second factor added'),
  'security.second_factor_removed': t('Second factor removed'),
  'security.failed_signins': t('Five failed sign-ins'),
  'security.new_admin': t('New admin'),
  'backup.downloaded': t('Backup downloaded'),
  'backup.restore_started': t('Restore started'),
  'backup.restored': t('Backup restored'),
}

const KINDS: [string, string][] = [
  ['', t('Every event')],
  ['signin', t('Sign-ins')],
  ['password', t('Passwords')],
  ['person', t('People')],
  ['brand', t('Brands')],
  ['network', t('Network connections')],
  ['settings', t('Settings')],
  ['account', t('Saved accounts')],
  ['export', t('Exports')],
  ['download', t('Downloads')],
  ['backup', t('Backups')],
  ['security', t('Security alerts')],
]

const SIZE = 50
const at = (iso: string) =>
  new Date(iso).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
let regions: Intl.DisplayNames | null = null
const country = (code: unknown) => {
  if (typeof code !== 'string' || !code) return ''
  try {
    regions ??= new Intl.DisplayNames([locale], { type: 'region' })
    return regions.of(code) ?? code
  } catch {
    return code
  }
}
/** The detail as plain facts, without the country (shown under From). */
const facts = (detail: string) => {
  try {
    const d = JSON.parse(detail) as Record<string, unknown>
    return Object.entries(d)
      .filter(
        ([k, v]) =>
          k !== 'country' && k !== 'brand' && v !== null && v !== '' && typeof v !== 'object',
      )
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(' · ')
  } catch {
    return ''
  }
}

/**
 * The activity log: sign-ins, people and access, brands, connections, settings and every file
 * taken away, newest first. Super admins see everything; a brand's admins see their brands.
 */
export function Activity({ brands, me, mode, actions }: AppState) {
  const [kind, setKind] = useState('')
  const [brand, setBrand] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<{ rows: Row[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mine = me.super
    ? brands
    : brands.filter((b) => me.memberships.some((m) => m.brand_id === b.id && m.role === 'admin'))

  useEffect(() => setPage(0), [kind, brand, q])
  useEffect(() => {
    const qs = new URLSearchParams({ page: String(page), size: String(SIZE) })
    if (kind) qs.set('event', kind)
    if (brand) qs.set('brand', brand)
    if (q.trim()) qs.set('q', q.trim())
    let live = true
    const timer = setTimeout(
      () =>
        api
          .get<{ rows: Row[]; total: number }>(`/api/audit?${qs}`)
          .then((d) => live && (setData(d), setError(null)))
          .catch((e: Error) => live && setError(e.message)),
      q ? 250 : 0,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [kind, brand, q, page])

  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const from = total ? page * SIZE + 1 : 0
  const to = Math.min(total, (page + 1) * SIZE)

  return (
    <main class="sm-page">
      <Head
        title={t('Activity')}
        sub={
          me.super
            ? t('Who did what, when and from where. Kept for at least a year.')
            : t('Who did what in the brands you manage. Kept for at least a year.')
        }
        actions={actions}
      />
      <div class="sm-toolbar">
        <select
          class="g-select sm-select-sm"
          value={kind}
          aria-label={t('Event')}
          onChange={(e) => setKind((e.target as HTMLSelectElement).value)}
        >
          {KINDS.map(([k, label]) => (
            <option value={k}>{label}</option>
          ))}
        </select>
        {mine.length > 1 && (
          <select
            class="g-select sm-select-sm"
            value={brand}
            aria-label={t('Brand')}
            onChange={(e) => setBrand((e.target as HTMLSelectElement).value)}
          >
            <option value="">{t('All brands')}</option>
            {mine.map((b) => (
              <option value={String(b.id)}>{b.name}</option>
            ))}
          </select>
        )}
        <input
          class="g-input sm-search"
          type="search"
          placeholder={t('Search people, addresses and files')}
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
      </div>

      {error && <p class="g-error">{error}</p>}
      {mode === 'json' ? (
        <JsonPanel value={rows} />
      ) : data && !rows.length ? (
        <Empty title={t('Nothing here yet')}>
          {t('Sign-ins, changes to people and brands, and downloads show up here as they happen.')}
        </Empty>
      ) : (
        data && (
          <section class="sm-box sm-box--table">
            <header class="sm-box__head">
              <h2>{t('Events')}</h2>
              <span class="sm-box__meta">{count(total, 'event')}</span>
            </header>
            <div class="sm-scroll">
              <table class="sm-dtable sm-dtable--rows">
                <thead>
                  <tr>
                    <th>{t('When')}</th>
                    <th>{t('Who')}</th>
                    <th>{t('What')}</th>
                    <th>{t('Target')}</th>
                    <th>{t('Brand')}</th>
                    <th>{t('From')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const detail = JSON.parse(r.detail || '{}') as Record<string, unknown>
                    const more = facts(r.detail)
                    return (
                      <tr>
                        <td class="sm-nowrap g-num">{at(r.at)}</td>
                        <td>
                          {r.actor_email ? (
                            <span title={r.actor_email}>{r.actor_name || r.actor_email}</span>
                          ) : (
                            <span class="sm-quiet">
                              {r.actor ? t('Removed person') : t('Not signed in')}
                            </span>
                          )}
                        </td>
                        <td>
                          {EVENT[r.event] ?? r.event}
                          {more && <small class="sm-quiet sm-block">{more}</small>}
                        </td>
                        <td class="sm-nowrap">{r.target ?? '–'}</td>
                        <td>{r.brand_name ?? (r.brand_id ? `#${r.brand_id}` : '–')}</td>
                        <td class="sm-nowrap" title={r.ua ?? undefined}>
                          {r.ip ?? '–'}
                          {detail.country ? (
                            <small class="sm-quiet sm-block">{country(detail.country)}</small>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {total > SIZE && (
              <footer class="sm-pager">
                <span class="sm-quiet g-num">
                  {t('{from}–{to} of {total}', { from, to, total })}
                </span>
                <button
                  class="g-btn g-btn--ghost g-btn--sm"
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  {t('Newer')}
                </button>
                <button
                  class="g-btn g-btn--ghost g-btn--sm"
                  type="button"
                  disabled={to >= total}
                  onClick={() => setPage(page + 1)}
                >
                  {t('Older')}
                </button>
              </footer>
            )}
          </section>
        )
      )}
    </main>
  )
}
