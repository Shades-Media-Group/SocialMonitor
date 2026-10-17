import { useEffect, useRef, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import { ApiError, api } from './api.ts'
import type { Second, SecondOptions } from './auth.tsx'
import { SecondFields, firstSecond, secondBody } from './auth.tsx'
import { NETWORK_NAME, Row, Segmented, Sheet, ago, count, when } from './ui.tsx'
import { JsonPanel } from './json.tsx'
import { Accounts } from './accounts.tsx'
import { TwoStep } from './security.tsx'
import { Backups } from './backups.tsx'
import type { Lang } from './i18n.ts'
import { LANGS, lang, locale, setLang, t } from './i18n.ts'
import { flushPrefs, setPref } from './prefs.ts'

interface Settings {
  gap_hours: number
  keep_days: number
  analyzer: 'auto' | 'claude' | 'api'
  analyzer_status: string
  version: string
}

type Theme = 'light' | 'dark' | 'auto'

export function SettingsSheet({
  open,
  onClose,
  notify,
  reload,
  mode,
  me,
}: AppState & { open: boolean; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme) || 'light',
  )
  const file = useRef<HTMLInputElement>(null)
  const [signed, setSigned] = useState<Record<string, boolean> | null>(null)

  useEffect(() => {
    if (!open) return
    api
      .get<Settings>('/api/settings')
      .then(setS)
      .catch(() => setS(null))
    if (me.super)
      api
        .get<Record<string, boolean>>('/api/browser/status')
        .then(setSigned)
        .catch(() => setSigned(null))
  }, [open])

  const chooseTheme = (t: Theme) => {
    setTheme(t)
    if (t === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
    try {
      localStorage.setItem('sm-theme', t)
    } catch {
      /* private mode */
    }
    setPref('theme', t)
  }

  const save = async (patch: Partial<Settings>) => {
    const next = await api.patch<Settings>('/api/settings', patch)
    setS(next)
  }

  const importFile = async (f: File) => {
    try {
      const data = JSON.parse(await f.text())
      const r = await api.post<{ brands: number; posts: number; comments: number }>(
        '/api/import',
        data,
      )
      notify(
        t('Imported {brands}, {posts} and {comments}.', {
          brands: count(r.brands, 'brand'),
          posts: count(r.posts, 'post'),
          comments: count(r.comments, 'comment'),
        }),
      )
      reload()
    } catch (e) {
      notify(t('Import failed: {error}', { error: (e as Error).message }))
    }
  }

  if (mode === 'json' && s)
    return (
      <Sheet open={open} title={t('Settings')} onClose={onClose}>
        <JsonPanel
          value={{ theme, gap_hours: s.gap_hours, keep_days: s.keep_days, analyzer: s.analyzer }}
          note={t(
            'theme: light, dark or auto. gap_hours: 4 to 48. keep_days: 7 to 3650. analyzer: auto, claude or api.',
          )}
          onSave={async (next) => {
            const x = next as Partial<Settings> & { theme?: Theme }
            if (x.theme && ['light', 'dark', 'auto'].includes(x.theme)) chooseTheme(x.theme)
            const r = await api.patch<Settings>('/api/settings', x)
            setS(r)
            return t('Saved.')
          }}
        />
      </Sheet>
    )

  return (
    <Sheet open={open} title={t('Settings')} onClose={onClose}>
      <Row label={t('Language')}>
        <select
          class="g-select sm-select-sm"
          aria-label={t('Language')}
          value={lang}
          onChange={async (e) => {
            const l = (e.target as HTMLSelectElement).value as Lang
            setPref('lang', l)
            await flushPrefs()
            setLang(l)
          }}
        >
          {LANGS.map(([l, name]) => (
            <option value={l}>{name}</option>
          ))}
        </select>
      </Row>
      <Row label={t('Theme')}>
        <Segmented
          label={t('Theme')}
          value={theme}
          onChange={chooseTheme}
          options={[
            ['light', t('Light')],
            ['dark', t('Dark')],
            ['auto', t('Automatic')],
          ]}
        />
      </Row>
      <Account me={me} notify={notify} />
      <TwoStep open={open} notify={notify} superAdmin={me.super} />
      <Row label={t('Devices')}>
        <Devices open={open} notify={notify} />
      </Row>
      {me.super && s && (
        <>
          <Row label={t('Gap')} hint={t('hours between updates that use a signed-in network')}>
            <input
              class="g-input sm-input-num"
              type="number"
              min={4}
              max={48}
              value={s.gap_hours}
              onChange={(e) => save({ gap_hours: Number((e.target as HTMLInputElement).value) })}
            />
          </Row>
          <Row label={t('Keep')} hint={t('days of comments; older ones are deleted')}>
            <input
              class="g-input sm-input-num"
              type="number"
              min={7}
              max={3650}
              value={s.keep_days}
              onChange={(e) => save({ keep_days: Number((e.target as HTMLInputElement).value) })}
            />
          </Row>
          <Row label={t('AI')} hint={s.analyzer_status}>
            <Segmented
              label={t('AI')}
              value={s.analyzer}
              onChange={(analyzer) => save({ analyzer })}
              options={[
                ['auto', t('Automatic')],
                ['claude', 'Claude Code'],
                ['api', t('API key')],
              ]}
            />
          </Row>
        </>
      )}
      {me.super && (
        <>
          <Row
            label={t('Sign in')}
            hint={`${
              signed && !signed.busy
                ? t('Signed in: {networks}.', {
                    networks:
                      (['tiktok', 'instagram', 'facebook'] as const)
                        .filter((n) => signed[n])
                        .map((n) => NETWORK_NAME[n])
                        .join(', ') || t('none yet'),
                  }) + ' '
                : ''
            }${t("Opens SocialMonitor's own Chrome window. Sign in by hand; the app never sees passwords.")}`}
          >
            <button
              class="g-btn g-btn--sm"
              type="button"
              onClick={() =>
                api
                  .post('/api/browser/sign-in')
                  .then(() => notify(t('Sign in in the window that opened, then close it.')))
                  .catch((e: Error) => notify(e.message))
              }
            >
              {t('Sign in to networks')}
            </button>
          </Row>
          <Row label={t('Saved accounts')}>
            <Accounts notify={notify} />
          </Row>
          <Row label={t('Data')}>
            <div class="sm-inline">
              <a class="g-btn g-btn--sm" href="/api/export" download>
                {t('Export everything')}
              </a>
              <button
                class="g-btn g-btn--ghost g-btn--sm"
                type="button"
                onClick={() => file.current?.click()}
              >
                {t('Import')}
              </button>
              <input
                ref={file}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = (e.target as HTMLInputElement).files?.[0]
                  if (f) importFile(f)
                  ;(e.target as HTMLInputElement).value = ''
                }}
              />
            </div>
          </Row>
          <Backups open={open} />
        </>
      )}
      <p class="sm-credit">
        {t('SocialMonitor {version}. Free and open source. Built by Shades Media Group.', {
          version: s?.version ?? '',
        })}{' '}
        <a
          class="g-link"
          href="https://github.com/Shades-Media-Group/SocialMonitor"
          target="_blank"
          rel="noreferrer"
        >
          {t('Source')}
        </a>
      </p>
    </Sheet>
  )
}

/** The signed-in person: who they are, a new password, and signing out. */
function Account({ me, notify }: Pick<AppState, 'me' | 'notify'>) {
  const blank = { current: '', password: '', code: '' }
  const [pw, setPw] = useState<typeof blank | null>(null)
  const [ticket, setTicket] = useState<{ ticket: string; to: string; mail: boolean } | null>(null)
  const [need, setNeed] = useState<SecondOptions | null>(null)
  const [mode, setMode] = useState<Second>('totp')
  const [factor, setFactor] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => {
    setPw(null)
    setTicket(null)
    setNeed(null)
    setError(null)
  }
  const out = (path: string) => () =>
    api
      .post<{ logout?: string }>(path)
      // A session from Shades login also signs out at Shades ID.
      .then((r) =>
        r.logout ? location.assign(r.logout) : dispatchEvent(new Event('sm-signed-out')),
      )
      .catch((e: Error) => notify(e.message))
  const field = (key: keyof typeof blank, label: string, input: Record<string, unknown>) =>
    pw && (
      <label class="sm-auth__field">
        <span>{label}</span>
        <input
          class="g-input"
          required
          {...input}
          value={pw[key]}
          onInput={(e) => setPw({ ...pw, [key]: (e.target as HTMLInputElement).value })}
        />
      </label>
    )
  return (
    <Row
      label={t('You')}
      hint={me.super ? t('{email}, super admin', { email: me.email }) : me.email}
    >
      <div class="sm-account">
        <b>{me.name || me.username || me.email}</b>
        {pw ? (
          <form
            class="sm-account__pw"
            aria-busy={busy}
            onSubmit={async (e) => {
              e.preventDefault()
              setError(null)
              setBusy(true)
              try {
                await api.post('/api/auth/password', {
                  password: pw.password,
                  ...(ticket ? { ticket: ticket.ticket, code: pw.code } : { current: pw.current }),
                  ...(need ? await secondBody(need, mode, factor) : {}),
                })
                close()
                notify(t('Password changed. Other devices are signed out.'))
              } catch (err) {
                const ask =
                  err instanceof ApiError ? (err.data.second as SecondOptions | undefined) : null
                if (ask) {
                  if (!need) setMode(firstSecond(ask))
                  setError(need ? (err as Error).message : null)
                  setNeed(ask)
                  setFactor('')
                } else setError((err as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {ticket ? (
              <>
                <p class="sm-quiet">
                  {ticket.mail
                    ? t('We sent a six-digit code to {to}. It works for 10 minutes.', {
                        to: ticket.to,
                      })
                    : t(
                        'Email is not set up, so the code was printed in the console of the computer SocialMonitor runs on.',
                      )}
                </p>
                {field('code', t('Code'), {
                  inputMode: 'numeric',
                  autocomplete: 'one-time-code',
                  pattern: '[0-9]{6}',
                  maxLength: 6,
                })}
              </>
            ) : (
              <>
                {field('current', t('Current password'), {
                  type: 'password',
                  autocomplete: 'current-password',
                })}
                <div>
                  <button
                    class="sm-textbtn"
                    type="button"
                    onClick={async () => {
                      setError(null)
                      try {
                        setTicket(await api.post('/api/auth/password/code'))
                      } catch (err) {
                        setError((err as Error).message)
                      }
                    }}
                  >
                    {t("Don't remember it? Send me a code instead")}
                  </button>
                </div>
              </>
            )}
            {field('password', t('New password'), {
              type: 'password',
              minLength: 10,
              autocomplete: 'new-password',
            })}
            {need && (
              <>
                <p class="sm-quiet">
                  {t(
                    'This account has two-step sign-in. Confirm it is you to change the password.',
                  )}
                </p>
                <SecondFields
                  plain
                  s={need}
                  mode={mode}
                  setMode={setMode}
                  value={factor}
                  setValue={setFactor}
                />
              </>
            )}
            {error && (
              <p class="g-error" role="alert">
                {error}
              </p>
            )}
            <div class="sm-inline">
              <button class="g-btn g-btn--sm" type="submit" disabled={busy}>
                {t('Change password')}
              </button>
              <button class="g-btn g-btn--ghost g-btn--sm" type="button" onClick={close}>
                {t('Cancel')}
              </button>
            </div>
          </form>
        ) : (
          <div class="sm-inline">
            <button class="g-btn g-btn--sm" type="button" onClick={out('/api/auth/logout')}>
              {t('Sign out')}
            </button>
            <button class="g-btn g-btn--ghost g-btn--sm" type="button" onClick={() => setPw(blank)}>
              {t('Change password')}
            </button>
          </div>
        )}
      </div>
    </Row>
  )
}

interface Device {
  id: string
  browser: string | null
  os: string | null
  country: string | null
  local: boolean
  created_at: string
  seen_at: string
  current: boolean
}

const regions = (() => {
  try {
    return new Intl.DisplayNames(locale, { type: 'region' })
  } catch {
    return null
  }
})()
/** Where a session was last used: this computer, or the country Cloudflare reported. */
function place(d: Device) {
  if (d.local) return t('This computer')
  if (!d.country || d.country === 'XX' || d.country === 'T1') return null
  try {
    return regions?.of(d.country) ?? d.country
  } catch {
    return d.country
  }
}

/** The browsers this person is signed in on: sign one out, or all of them. */
function Devices({ open, notify }: { open: boolean; notify: (s: string) => void }) {
  const [list, setList] = useState<Device[] | null>(null)
  const load = () =>
    api
      .get<Device[]>('/api/auth/sessions')
      .then(setList)
      .catch(() => setList(null))
  useEffect(() => {
    if (open) load()
  }, [open])
  const end = (d: Device) =>
    api
      .del(`/api/auth/sessions/${d.id}`)
      .then(() => {
        if (d.current) dispatchEvent(new Event('sm-signed-out'))
        else void load()
      })
      .catch((e: Error) => notify(e.message))
  if (!list) return null
  return (
    <div class="sm-accounts">
      <ul class="sm-accounts__list">
        {list.map((d) => {
          const name =
            d.browser && d.os
              ? t('{browser} on {os}', { browser: d.browser, os: d.os })
              : (d.browser ?? d.os ?? t('Unknown browser'))
          const where = place(d)
          return (
            <li>
              <div class="sm-accounts__who">
                <strong>{name}</strong>
                <span class="sm-quiet" title={t('Signed in {when}', { when: when(d.created_at) })}>
                  {[where, d.current ? t('This device') : ago(d.seen_at)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <div class="sm-accounts__do">
                <button
                  class="sm-textbtn"
                  type="button"
                  aria-label={t('Sign out {device}', { device: name })}
                  onClick={() => end(d)}
                >
                  {t('Sign out')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {list.length > 1 && (
        <div>
          <button
            class="sm-textbtn"
            type="button"
            onClick={() =>
              api
                .post('/api/auth/logout-everywhere')
                .then(() => dispatchEvent(new Event('sm-signed-out')))
                .catch((e: Error) => notify(e.message))
            }
          >
            {t('Sign out everywhere')}
          </button>
        </div>
      )}
    </div>
  )
}
