import { useEffect, useState } from 'preact/hooks'
import { encode } from 'uqr'
import { ApiError, api } from './api.ts'
import { Row } from './ui.tsx'
import { t } from './i18n.ts'

interface Security {
  totp: boolean
  recovery: number
}

/** The otpauth link as a QR code, drawn here: nothing about the secret leaves the page. */
function Qr({ text }: { text: string }) {
  const { data, size } = encode(text, { ecc: 'M', border: 2 })
  const d = data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ''))).join('')
  return (
    <svg
      class="sm-qr"
      viewBox={`0 0 ${size} ${size}`}
      shape-rendering="crispEdges"
      role="img"
      aria-label={t('QR code for your authenticator app')}
    >
      <rect width={size} height={size} fill="white" />
      <path d={d} fill="black" />
    </svg>
  )
}

/** Recovery codes, shown once, with ways to keep them. */
function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n')
  return (
    <div class="sm-security__codes">
      <p class="sm-quiet">
        {t('Keep these somewhere safe. Each works once, and they are shown only now.')}
      </p>
      <ol class="sm-security__list">
        {codes.map((c) => (
          <li>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div class="sm-inline">
        <button
          class="g-btn g-btn--sm"
          type="button"
          onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}
        >
          {t('Copy')}
        </button>
        <a
          class="g-btn g-btn--ghost g-btn--sm"
          download="socialmonitor-recovery-codes.txt"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text + '\n')}`}
        >
          {t('Download')}
        </a>
        <button class="g-btn g-btn--ghost g-btn--sm" type="button" onClick={onDone}>
          {t('I saved them')}
        </button>
      </div>
    </div>
  )
}

/**
 * Two-step sign-in in Settings: the authenticator app and recovery codes. Changes ask for the
 * password again when it was entered more than 15 minutes ago.
 */
export function TwoStep({ open, notify }: { open: boolean; notify: (s: string) => void }) {
  const [sec, setSec] = useState<Security | null>(null)
  const [setup, setSetup] = useState<{ secret: string; uri: string; code: string } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [confirm, setConfirm] = useState<{ retry: () => Promise<void>; password: string } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    api
      .get<Security>('/api/auth/security')
      .then(setSec)
      .catch(() => setSec(null))
  useEffect(() => {
    if (open) load()
    else {
      setSetup(null)
      setCodes(null)
      setConfirm(null)
    }
  }, [open])

  /** Runs a change; if the server wants the password first, asks for it and runs it again. */
  const guarded = (fn: () => Promise<void>) => async () => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      if (e instanceof ApiError && e.data.confirm) setConfirm({ retry: fn, password: '' })
      else setError((e as Error).message)
    }
  }

  if (!sec) return null
  if (confirm)
    return (
      <Row label={t('Password')} hint={t('Enter your password again to change how you sign in.')}>
        <form
          class="sm-account__pw"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              await api.post('/api/auth/confirm', { password: confirm.password })
              const retry = confirm.retry
              setConfirm(null)
              await guarded(retry)()
            } catch (err) {
              setError((err as Error).message)
            }
          }}
        >
          <label class="sm-auth__field">
            <span>{t('Current password')}</span>
            <input
              class="g-input"
              type="password"
              required
              autocomplete="current-password"
              ref={(el) => el?.focus()}
              value={confirm.password}
              onInput={(e) =>
                setConfirm({ ...confirm, password: (e.target as HTMLInputElement).value })
              }
            />
          </label>
          {error && (
            <p class="g-error" role="alert">
              {error}
            </p>
          )}
          <div class="sm-inline">
            <button class="g-btn g-btn--sm" type="submit">
              {t('Continue')}
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => {
                setConfirm(null)
                setError(null)
              }}
            >
              {t('Cancel')}
            </button>
          </div>
        </form>
      </Row>
    )

  const err = error && (
    <p class="g-error" role="alert">
      {error}
    </p>
  )
  const protectedBy = sec.totp
  return (
    <>
      <Row
        label={t('Authenticator app')}
        hint={
          sec.totp
            ? t('On. Sign in with a code from the app instead of email.')
            : t('Codes from an authenticator app on your phone or computer.')
        }
      >
        {setup ? (
          <form
            class="sm-security__setup"
            onSubmit={(e) => {
              e.preventDefault()
              void guarded(async () => {
                const r = await api.post<{ recovery: string[] | null }>('/api/auth/totp', {
                  code: setup.code,
                })
                setSetup(null)
                if (r.recovery) setCodes(r.recovery)
                notify(t('Authenticator app turned on.'))
                await load()
              })()
            }}
          >
            <Qr text={setup.uri} />
            <p class="sm-quiet">
              {t('Scan this with the app, or enter this key by hand:')}{' '}
              <code class="sm-security__key">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            </p>
            <label class="sm-auth__field">
              <span>{t('Code from the app')}</span>
              <input
                class="g-input"
                required
                inputMode="numeric"
                autocomplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                value={setup.code}
                onInput={(e) => setSetup({ ...setup, code: (e.target as HTMLInputElement).value })}
              />
            </label>
            {err}
            <div class="sm-inline">
              <button class="g-btn g-btn--sm" type="submit">
                {t('Turn on')}
              </button>
              <button
                class="g-btn g-btn--ghost g-btn--sm"
                type="button"
                onClick={() => setSetup(null)}
              >
                {t('Cancel')}
              </button>
            </div>
          </form>
        ) : (
          <div class="sm-inline">
            {sec.totp ? (
              <button
                class="sm-textbtn"
                type="button"
                onClick={guarded(async () => {
                  await api.del('/api/auth/totp')
                  notify(t('Authenticator app turned off.'))
                  await load()
                })}
              >
                {t('Turn off')}
              </button>
            ) : (
              <button
                class="g-btn g-btn--sm"
                type="button"
                onClick={guarded(async () => {
                  const r = await api.post<{ secret: string; uri: string }>('/api/auth/totp/start')
                  setSetup({ ...r, code: '' })
                })}
              >
                {t('Set up')}
              </button>
            )}
            {!setup && err}
          </div>
        )}
      </Row>
      {(protectedBy || codes) && (
        <Row
          label={t('Recovery codes')}
          hint={
            codes
              ? undefined
              : t('{n} of 10 left, for when you have neither your passkey nor your app.', {
                  n: sec.recovery,
                })
          }
        >
          {codes ? (
            <Codes codes={codes} onDone={() => setCodes(null)} />
          ) : (
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={guarded(async () => {
                const r = await api.post<{ codes: string[] }>('/api/auth/recovery')
                setCodes(r.codes)
                await load()
              })}
            >
              {t('Make new codes')}
            </button>
          )}
        </Row>
      )}
    </>
  )
}
