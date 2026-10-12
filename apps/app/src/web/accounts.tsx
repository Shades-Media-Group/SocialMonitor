import { useEffect, useState } from 'preact/hooks'
import { api } from './api.ts'
import { Icon } from './ui.tsx'
import { t } from './i18n.ts'

interface Account {
  id: string
  network: string
  username: string
  note: string
  has_password: boolean
}

const NETWORKS = ['TikTok', 'Instagram', 'Facebook', 'Other']

/**
 * Saved accounts, kept encrypted for reference. SocialMonitor never logs in with them; signing
 * in stays a person's job in its own Chrome window. Reveal and Copy work only on this computer.
 */
export function Accounts({ notify }: { notify: (s: string) => void }) {
  const [list, setList] = useState<Account[]>([])
  const [local, setLocal] = useState(true)
  const [edit, setEdit] = useState<(Partial<Account> & { password?: string }) | null>(null)
  const [shown, setShown] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    api
      .get<Account[]>('/api/accounts')
      .then(setList)
      .catch(() => setList([]))
  useEffect(() => {
    load()
    api
      .get<{ local: boolean }>('/api/remote')
      .then((r) => setLocal(r.local))
      .catch(() => {})
  }, [])

  const save = async (e: Event) => {
    e.preventDefault()
    setError(null)
    try {
      await api.post('/api/accounts', edit)
      setEdit(null)
      notify(t('Account saved, encrypted.'))
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const reveal = async (a: Account) => {
    if (shown[a.id]) return setShown(({ [a.id]: _, ...rest }) => rest)
    try {
      const { password } = await api.post<{ password: string }>(`/api/accounts/${a.id}/reveal`)
      setShown({ ...shown, [a.id]: password })
      setTimeout(() => setShown(({ [a.id]: _, ...rest }) => rest), 20000)
    } catch (err) {
      notify((err as Error).message)
    }
  }

  return (
    <div class="sm-accounts">
      {list.length > 0 && (
        <ul class="sm-accounts__list">
          {list.map((a) => (
            <li>
              <div class="sm-accounts__who">
                <strong>{a.network}</strong>
                <span>{a.username}</span>
                {a.note && <span class="sm-quiet">{a.note}</span>}
                {shown[a.id] !== undefined && (
                  <code class="sm-accounts__pw">{shown[a.id] || t('(no password)')}</code>
                )}
              </div>
              <div class="sm-accounts__do">
                {a.has_password && local && (
                  <button class="sm-textbtn" type="button" onClick={() => reveal(a)}>
                    {shown[a.id] !== undefined ? t('Hide') : t('Reveal')}
                  </button>
                )}
                <button
                  class="sm-textbtn"
                  type="button"
                  onClick={() => setEdit({ ...a, password: '' })}
                >
                  {t('Edit')}
                </button>
                <button
                  class="g-icon-btn"
                  type="button"
                  aria-label={t('Delete {network} {username}', {
                    network: a.network === 'Other' ? t('Other') : a.network,
                    username: a.username,
                  })}
                  onClick={async () => {
                    await api.del(`/api/accounts/${a.id}`)
                    load()
                  }}
                >
                  <Icon name="delete" size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {edit ? (
        <form class="sm-accounts__form" onSubmit={save}>
          <select
            class="g-select"
            aria-label={t('Network')}
            value={edit.network ?? 'TikTok'}
            onChange={(e) => setEdit({ ...edit, network: (e.target as HTMLSelectElement).value })}
          >
            {NETWORKS.map((n) => (
              <option value={n}>{n === 'Other' ? t('Other') : n}</option>
            ))}
          </select>
          <input
            class="g-input"
            placeholder={t('Username or email')}
            autocomplete="off"
            value={edit.username ?? ''}
            onInput={(e) => setEdit({ ...edit, username: (e.target as HTMLInputElement).value })}
          />
          <input
            class="g-input"
            type="password"
            placeholder={edit.id ? t('New password (empty keeps the old one)') : t('Password')}
            autocomplete="new-password"
            value={edit.password ?? ''}
            onInput={(e) => setEdit({ ...edit, password: (e.target as HTMLInputElement).value })}
          />
          <input
            class="g-input"
            placeholder={t('Note, e.g. spare account for reading')}
            value={edit.note ?? ''}
            onInput={(e) => setEdit({ ...edit, note: (e.target as HTMLInputElement).value })}
          />
          {error && <p class="g-error">{error}</p>}
          <div class="sm-inline">
            <button class="g-btn g-btn--primary g-btn--sm" type="submit">
              {t('Save account')}
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => setEdit(null)}
            >
              {t('Cancel')}
            </button>
          </div>
        </form>
      ) : (
        <button
          class="g-btn g-btn--sm"
          type="button"
          onClick={() => setEdit({ network: 'TikTok' })}
        >
          {t('Add an account')}
        </button>
      )}
      <p class="sm-quiet">
        {t(
          'Encrypted on this computer, with the key in its Keychain. SocialMonitor never signs in with them, and they never appear in exports, reports, JSON or anything sent to Claude.',
        )}
        {!local && ` ${t('Passwords can be revealed only on the computer SocialMonitor runs on.')}`}
      </p>
    </div>
  )
}
