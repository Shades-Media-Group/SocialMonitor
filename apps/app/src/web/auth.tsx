import { useEffect, useId, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { ApiError, api } from './api.ts'
import { Icon, Logo, navigate } from './ui.tsx'
import { t } from './i18n.ts'

export interface Me {
  id: number
  email: string
  username: string | null
  name: string
  super: boolean
  memberships: { brand_id: number; role: 'viewer' | 'admin' }[]
  prefs?: Record<string, unknown>
  /** A super admin without a passkey or authenticator yet. */
  needs_second?: boolean
  /** This session came from Shades login. */
  shades?: boolean
}
/** What the password step answers: a ticket, and the second steps besides the emailed code. */
interface Ticket {
  ticket: string
  to: string
  mail: boolean
  second?: SecondOptions
}
/** The second steps a person can use, as the server lists them. */
export interface SecondOptions {
  totp: boolean
  recovery: boolean
  passkey: PublicKeyCredentialRequestOptionsJSON | null
}
export type Second = 'passkey' | 'totp' | 'recovery'
export const firstSecond = (s: SecondOptions): Second =>
  s.passkey ? 'passkey' : s.totp ? 'totp' : 'recovery'
/** What to send for the chosen second step; a passkey asks the browser first. */
export const secondBody = async (s: SecondOptions, mode: Second, value: string) =>
  mode === 'passkey' ? { passkey: await askPasskey(s.passkey!) } : { [mode]: value }

/**
 * The second step inside a password change or reset, when the account has one: the passkey
 * prompt or a code field, and the other ways as quiet buttons. `plain` is Settings' look.
 */
export function SecondFields({
  s,
  mode,
  setMode,
  value,
  setValue,
  plain = false,
}: {
  s: SecondOptions
  mode: Second
  setMode: (m: Second) => void
  value: string
  setValue: (v: string) => void
  plain?: boolean
}) {
  const label = mode === 'totp' ? t('Code from your authenticator app') : t('Recovery code')
  const input = {
    required: true,
    autocomplete: mode === 'totp' ? 'one-time-code' : 'off',
    inputMode: mode === 'totp' ? ('numeric' as const) : undefined,
    value,
    onInput: (e: Event) => setValue((e.target as HTMLInputElement).value),
  }
  const others = (
    [
      ['passkey', t('Use your passkey')],
      ['totp', t('Use your authenticator app')],
      ['recovery', t('Use a recovery code')],
    ] as [Second, string][]
  ).filter(([k]) => k !== mode && (k === 'passkey' ? !!s.passkey : s[k]))
  const switches = others.map(([k, text]) => (
    <button
      class={plain ? 'sm-textbtn' : 'g-btn g-btn--ghost'}
      type="button"
      onClick={() => {
        setMode(k)
        setValue('')
      }}
    >
      {text}
    </button>
  ))
  return (
    <>
      {mode === 'passkey' ? (
        <p class={plain ? 'sm-quiet' : 'g-hint'}>
          {t('Your browser asks for your passkey when you save.')}
        </p>
      ) : plain ? (
        <label class="sm-auth__field">
          <span>{label}</span>
          <input class="g-input" key={mode} ref={focus} {...input} />
        </label>
      ) : (
        <Field key={mode} label={label} inputRef={focus} {...input} />
      )}
      {plain ? others.length > 0 && <div class="sm-inline">{switches}</div> : switches}
    </>
  )
}

/** The browser's passkey prompt; cancelling it reads as a plain sentence, not a DOMException. */
export async function askPasskey(options: PublicKeyCredentialRequestOptionsJSON) {
  try {
    return await startAuthentication({ optionsJSON: options })
  } catch {
    throw new Error(t('The passkey was not used. Try again, or choose another way.'))
  }
}

export interface AuthInfo {
  user: Me | null
  setup: boolean
  local: boolean
  mail: boolean
  /** Shades login is configured, so the sign-in page offers it. */
  shades?: boolean
}

/** Why a Shades login came back to the sign-in page, as the callback names it (?shades=…). */
const SHADES_WHY: Record<string, string> = {
  failed: 'Shades login did not work. Try again.',
  expired: 'Shades login took too long. Try again.',
  unavailable: 'Shades ID cannot be reached right now. Try again in a moment.',
  cancelled: 'Shades login was cancelled.',
  domain: 'Shades login is only for @shades.md accounts.',
  unverified: 'Confirm your email at Shades ID first, then try again.',
  blocked: 'This account is blocked. Ask a super admin.',
  conflict: 'This email belongs to another Shades account here. Ask a super admin.',
  rate: 'Too many tries. Wait 15 minutes and try again.',
}
/** The reason in the address, once: it is taken out so a reload doesn't show it again. */
function shadesReason() {
  const why = new URLSearchParams(location.search).get('shades')
  if (!why) return null
  history.replaceState(null, '', location.pathname + location.hash)
  return t(SHADES_WHY[why] ?? SHADES_WHY.failed!)
}
/** A Shades login waiting for SocialMonitor's own second step: its ticket, from #shades=…. */
function shadesTicket() {
  const m = /^#shades=([\w-]+)$/.exec(location.hash)
  if (m) history.replaceState(null, '', location.pathname + location.search)
  return m?.[1] ?? null
}

/** Signs out; a session from Shades login also signs out at Shades ID, which then comes back here. */
export const signOut = () =>
  api.post<{ logout?: string }>('/api/auth/logout').then((r) => {
    if (r.logout) location.assign(r.logout)
    else dispatchEvent(new Event('sm-signed-out'))
  })

/** A link from an email: /invite/<token> or /reset/<token> (older emails: #/invite/<token>). */
export function linkFromPath() {
  const [, kind, token] = (
    location.hash.startsWith('#/') ? location.hash.slice(1) : location.pathname
  ).split('/')
  return (kind === 'invite' || kind === 'reset') && token ? { kind, token } : null
}

/** The last email or username signed in with on this browser, to fill in next time. */
const LAST = 'sm-last-login'
const lastLogin = () => {
  try {
    return localStorage.getItem(LAST) ?? ''
  } catch {
    return ''
  }
}
const keepLogin = (login: string) => {
  try {
    localStorage.setItem(LAST, login)
  } catch {
    /* private window: nothing to remember */
  }
}

type Input = Record<string, unknown> & {
  label: string
  hint?: string
  inputRef?: (el: HTMLInputElement | null) => void
}

/** Gradient's field with its label inside: the label moves up when the field is used. */
function Field({ label, hint, inputRef, ...input }: Input) {
  const id = useId()
  return (
    <>
      <div class="g-auth-field">
        <input class="g-input" id={id} placeholder=" " ref={inputRef} {...input} />
        <label for={id}>{label}</label>
      </div>
      {hint && <p class="g-hint">{hint}</p>}
    </>
  )
}

/** A password field with a show/hide button inside it and a Caps Lock warning under it. */
function Password({ label, hint, inputRef, ...input }: Input) {
  const id = useId()
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const check = (e: KeyboardEvent) => setCaps(e.getModifierState?.('CapsLock') ?? false)
  return (
    <>
      <div class="g-auth-field">
        <input
          class="g-input"
          id={id}
          placeholder=" "
          ref={inputRef}
          {...input}
          type={shown ? 'text' : 'password'}
          onKeyUp={check}
          onKeyDown={check}
          onBlur={() => setCaps(false)}
        />
        <label for={id}>{label}</label>
        <button
          type="button"
          class="g-icon-btn"
          aria-label={shown ? t('Hide the password') : t('Show the password')}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          <Icon name={shown ? 'visibilityOff' : 'visibility'} size={20} />
        </button>
      </div>
      {caps && <p class="g-hint">{t('Caps Lock is on.')}</p>}
      {hint && <p class="g-hint">{hint}</p>}
    </>
  )
}

/** Focuses a field when it first appears. Stable, so it runs once per mount. */
const focus = (el: HTMLInputElement | null) => el?.focus()

/** The Shades mark, from Gradient's brand files. */
const ShadesMark = () => (
  <svg viewBox="0 0 56 56" aria-hidden="true">
    <rect width="56" height="56" fill="#E40523" />
    <rect x="10" y="13" width="10" height="30" fill="#fff" />
    <rect x="23" y="13" width="10" height="30" fill="#fff" fill-opacity=".75" />
    <rect x="36" y="13" width="10" height="30" fill="#fff" fill-opacity=".5" />
  </svg>
)

type Theme = 'light' | 'dark' | 'auto'

/** The theme as plain words under the form, like every Shades sign-in. */
function ThemeChoice() {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme | undefined) ?? 'auto',
  )
  const choose = (next: Theme) => {
    setTheme(next)
    if (next === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('sm-theme', next)
    } catch {
      /* private window: the choice lasts until the page closes */
    }
  }
  const options: [Theme, string][] = [
    ['light', t('Light')],
    ['dark', t('Dark')],
    ['auto', t('Automatic')],
  ]
  return (
    <div class="g-segmented" role="group" aria-label={t('Theme')}>
      {options.map(([value, label]) => (
        <button type="button" aria-pressed={theme === value} onClick={() => choose(value)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * Gradient's sign-in layout, shared by every Shades product: the brand panel, then one column
 * with the title, the fields and one full-width button, and the theme under it.
 */
function Frame({
  title,
  lead,
  busy = false,
  onSubmit,
  children,
}: {
  title: string
  lead?: ComponentChildren
  busy?: boolean
  onSubmit?: (e: Event) => void
  children: ComponentChildren
}) {
  const Body = onSubmit ? 'form' : 'div'
  return (
    <div class="g-auth">
      <aside class="g-auth-brand">
        <Logo />
        <p class="g-auth-statement">{t('What people say about your brand, sorted.')}</p>
        <p class="g-auth-credit">
          <ShadesMark />
          {t('Free and open source. Built by Shades Media Group.')}
        </p>
      </aside>
      <main class="g-auth-main" aria-busy={busy}>
        <Body key={title} class="g-auth-form" onSubmit={onSubmit}>
          <h1 class="g-auth-title">{title}</h1>
          {lead && <p class="g-hint">{lead}</p>}
          {children}
        </Body>
        <footer class="g-auth-foot">
          <ThemeChoice />
        </footer>
      </main>
    </div>
  )
}

const value = (e: Event) => (e.target as HTMLInputElement).value

/**
 * Everything before the dashboard: the first account, signing in with a password and an
 * emailed code, a forgotten password, and the links people get by email.
 */
export function AuthScreen({ info, onIn }: { info: AuthInfo; onIn: (me: Me) => void }) {
  const link = linkFromPath()
  const [step, setStep] = useState<'signin' | 'code' | 'second' | 'forgot' | 'reset'>('signin')
  const [second, setSecond] = useState<Second>('totp')
  // A password change on an account with two-step sign-in: what it can use, and the answer.
  const [need, setNeed] = useState<SecondOptions | null>(null)
  const [factor, setFactor] = useState('')
  const [f, setF] = useState({
    login: lastLogin(),
    keep: true,
    password: '',
    code: '',
    name: '',
    username: '',
    email: '',
  })
  const [ticket, setTicket] = useState<Ticket | null>(null)
  // Why a Shades login came back, if it did: shown once, and never marks the password wrong.
  const [why] = useState(shadesReason)
  const [error, setError] = useState<string | null>(why)
  const [busy, setBusy] = useState(false)
  const [resent, setResent] = useState(false)
  // The cursor starts where typing begins: the password when the login is remembered.
  const [known] = useState(() => !!f.login)
  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: value(e) })

  // Back from Shades login without Shades ID's second step: SocialMonitor's own comes next.
  useEffect(() => {
    const id = shadesTicket()
    if (!id) return
    setBusy(true)
    api
      .post<Ticket & { login: string; keep: boolean }>('/api/auth/shades/ticket', { ticket: id })
      .then((r) => {
        setTicket(r)
        setF((x) => ({ ...x, login: r.login, keep: r.keep, password: '', code: '' }))
        if (r.second) setSecond(firstSecond(r.second))
        setStep(r.second ? 'second' : 'code')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }, [])

  const go = (fn: () => Promise<void>) => async (e: Event) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      const ask = err instanceof ApiError ? (err.data.second as SecondOptions | undefined) : null
      if (ask) {
        // The first time it is a question, not a mistake: the fields appear with a hint.
        if (!need) setSecond(firstSecond(ask))
        setError(need ? (err as Error).message : null)
        setNeed(ask)
        setFactor('')
      } else setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const err = error && (
    <p class="g-error" role="alert">
      {error}
    </p>
  )
  const submit = (text: string) => (
    <button class="g-btn g-btn--primary" type="submit" disabled={busy}>
      {text}
    </button>
  )
  const withSecond = async () => (need ? secondBody(need, second, factor) : {})
  const secondFields = need && (
    <>
      <p class="g-hint">
        {t('This account has two-step sign-in. Confirm it is you to change the password.')}
      </p>
      <SecondFields
        s={need}
        mode={second}
        setMode={setSecond}
        value={factor}
        setValue={setFactor}
      />
    </>
  )
  const startAgain = () => {
    setNeed(null)
    setStep('signin')
    setResent(false)
    setError(null)
    setF({ ...f, code: '', password: '' })
  }
  /** The account this step belongs to; tap it to start over. */
  const who = (
    <button class="g-auth-who" type="button" onClick={startAgain} title={t('Start again')}>
      <span class="g-avatar g-avatar--sm" aria-hidden="true">
        {f.login.trim().charAt(0).toUpperCase()}
      </span>
      <span>{f.login.trim()}</span>
    </button>
  )

  if (link)
    return (
      <Frame
        title={link.kind === 'invite' ? t('Set up your account') : t('Choose a new password')}
        lead={
          link.kind === 'invite'
            ? t('Pick a password. You will sign in with it and a code we email you.')
            : undefined
        }
        busy={busy}
        onSubmit={go(async () => {
          const r = await api.post<{ email: string; me?: Me }>('/api/auth/accept', {
            token: link.token,
            kind: link.kind,
            password: f.password,
            ...(link.kind === 'invite' ? { name: f.name, username: f.username } : {}),
            ...(await withSecond()),
          })
          // A finished invitation comes back signed in: straight to the dashboard.
          if (r.me) {
            navigate('/')
            onIn(r.me)
            return
          }
          setNeed(null)
          setF({ ...f, login: r.email, password: '' })
          navigate('/')
          setStep('signin')
          setError(null)
        })}
      >
        {link.kind === 'invite' && (
          <>
            <Field
              label={t('Your name')}
              autocomplete="name"
              value={f.name}
              onInput={set('name')}
              inputRef={focus}
            />
            <Field
              label={t('Username')}
              hint={t('Optional. You can sign in with it instead of your email.')}
              autocomplete="username"
              value={f.username}
              onInput={set('username')}
            />
          </>
        )}
        <Password
          label={t('Password')}
          hint={t('At least 10 characters.')}
          required
          minLength={10}
          autocomplete="new-password"
          value={f.password}
          onInput={set('password')}
          inputRef={link.kind === 'invite' ? undefined : focus}
        />
        {secondFields}
        {err}
        {submit(t('Save password'))}
      </Frame>
    )

  if (info.setup)
    return info.local ? (
      <Frame
        title={t('Create the first account')}
        lead={t('It becomes the super admin: it sees every brand and invites everyone else.')}
        busy={busy}
        onSubmit={go(async () => {
          onIn(
            await api.post<Me>('/api/auth/setup', {
              email: f.email,
              name: f.name,
              username: f.username,
              password: f.password,
            }),
          )
        })}
      >
        <Field
          label={t('Your name')}
          required
          autocomplete="name"
          value={f.name}
          onInput={set('name')}
          inputRef={focus}
        />
        <Field
          label={t('Email')}
          type="email"
          required
          autocomplete="email"
          value={f.email}
          onInput={set('email')}
        />
        <Field
          label={t('Username')}
          hint={t('Optional.')}
          autocomplete="username"
          value={f.username}
          onInput={set('username')}
        />
        <Password
          label={t('Password')}
          hint={t('At least 10 characters.')}
          required
          minLength={10}
          autocomplete="new-password"
          value={f.password}
          onInput={set('password')}
        />
        {err}
        {submit(t('Create account'))}
      </Frame>
    ) : (
      <Frame
        title={t('Not set up yet')}
        lead={t(
          'Create the first account on the computer SocialMonitor runs on, then come back here.',
        )}
      >
        {null}
      </Frame>
    )

  if (step === 'second' && ticket?.second) {
    const s = ticket.second
    const others: [Second, string][] = (
      [
        ['passkey', t('Use your passkey')],
        ['totp', t('Use your authenticator app')],
        ['recovery', t('Use a recovery code')],
      ] as [Second, string][]
    ).filter(([k]) => k !== second && s[k])
    return (
      <Frame
        title={
          second === 'passkey'
            ? t('Use your passkey')
            : second === 'totp'
              ? t('Enter the code from your app')
              : t('Enter a recovery code')
        }
        busy={busy}
        onSubmit={go(async () => {
          onIn(
            await api.post<Me>('/api/auth/code', {
              ticket: ticket.ticket,
              [second]: second === 'passkey' ? await askPasskey(s.passkey!) : f.code,
              keep: f.keep,
            }),
          )
        })}
      >
        {who}
        {second === 'passkey' ? (
          <p class="g-hint">{t('Your browser asks for the passkey you added for this account.')}</p>
        ) : second === 'totp' ? (
          <Field
            key="totp"
            label={t('Six-digit code')}
            required
            inputMode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            value={f.code}
            onInput={set('code')}
            inputRef={focus}
          />
        ) : (
          <Field
            key="recovery"
            label={t('Recovery code')}
            hint={t('Each recovery code works once.')}
            required
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            value={f.code}
            onInput={set('code')}
            inputRef={focus}
          />
        )}
        {err}
        {submit(second === 'passkey' ? t('Continue') : t('Verify'))}
        {others.map(([k, text]) => (
          <button
            class="g-btn g-btn--ghost"
            type="button"
            onClick={() => {
              setSecond(k)
              setError(null)
              setF({ ...f, code: '' })
            }}
          >
            {text}
          </button>
        ))}
      </Frame>
    )
  }

  if (step === 'code' && ticket)
    return (
      <Frame
        title={t('Check your email')}
        busy={busy}
        onSubmit={go(async () => {
          onIn(
            await api.post<Me>('/api/auth/code', {
              ticket: ticket.ticket,
              code: f.code,
              keep: f.keep,
            }),
          )
        })}
      >
        {who}
        <p class="g-hint">
          {ticket.mail
            ? t('We sent a six-digit code to {to}. It works for 10 minutes.', { to: ticket.to })
            : t(
                'Email is not set up, so the code was printed in the console of the computer SocialMonitor runs on.',
              )}
        </p>
        <Field
          label={t('Code')}
          required
          inputMode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={f.code}
          onInput={set('code')}
          inputRef={focus}
        />
        {err}
        {resent && !error && (
          <p class="g-hint" role="status">
            {t('A new code is on its way.')}
          </p>
        )}
        {submit(t('Verify'))}
        <button
          class="g-btn g-btn--ghost"
          type="button"
          disabled={busy}
          onClick={go(async () => {
            setTicket(await api.post<Ticket>('/api/auth/resend', { ticket: ticket.ticket }))
            setF({ ...f, code: '' })
            setResent(true)
          })}
        >
          {t('Send a new code')}
        </button>
      </Frame>
    )

  if (step === 'forgot')
    return (
      <Frame
        title={t('Forgot your password')}
        lead={t('Give your email or username. We email you a code to choose a new password.')}
        busy={busy}
        onSubmit={go(async () => {
          const r = await api.post<{ ticket: string; mail: boolean }>('/api/auth/forgot', {
            login: f.login,
          })
          setTicket({ ticket: r.ticket, to: '', mail: r.mail })
          setNeed(null)
          setResent(false)
          setF({ ...f, code: '', password: '' })
          setStep('reset')
        })}
      >
        <Field
          label={t('Email or username')}
          required
          autocomplete="username"
          value={f.login}
          onInput={set('login')}
          inputRef={focus}
        />
        {err}
        {submit(t('Send code'))}
        <button class="g-btn g-btn--ghost" type="button" onClick={startAgain}>
          {t('Back to sign in')}
        </button>
      </Frame>
    )

  if (step === 'reset' && ticket)
    return (
      <Frame
        title={t('Choose a new password')}
        busy={busy}
        onSubmit={go(async () => {
          onIn(
            await api.post<Me>('/api/auth/reset', {
              ticket: ticket.ticket,
              code: f.code,
              password: f.password,
              keep: f.keep,
              ...(await withSecond()),
            }),
          )
        })}
      >
        {who}
        <p class="g-hint">
          {ticket.mail
            ? t('If that account exists, we emailed it a six-digit code. It works for 10 minutes.')
            : t(
                'Email is not set up, so the code was printed in the console of the computer SocialMonitor runs on.',
              )}
        </p>
        <Field
          label={t('Code')}
          required
          inputMode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={f.code}
          onInput={set('code')}
          inputRef={focus}
        />
        <Password
          label={t('New password')}
          hint={t('At least 10 characters.')}
          required
          minLength={10}
          autocomplete="new-password"
          value={f.password}
          onInput={set('password')}
        />
        {secondFields}
        {err}
        {resent && !error && (
          <p class="g-hint" role="status">
            {t('A new code is on its way.')}
          </p>
        )}
        {submit(t('Save password'))}
        <button
          class="g-btn g-btn--ghost"
          type="button"
          disabled={busy}
          onClick={go(async () => {
            const r = await api.post<{ ticket: string; mail: boolean }>('/api/auth/forgot', {
              login: f.login,
            })
            setTicket({ ticket: r.ticket, to: '', mail: r.mail })
            setNeed(null)
            setF({ ...f, code: '' })
            setResent(true)
          })}
        >
          {t('Send a new code')}
        </button>
      </Frame>
    )

  return (
    <Frame
      title={t('Sign in to SocialMonitor')}
      busy={busy}
      onSubmit={go(async () => {
        const r = await api.post<Ticket>('/api/auth/login', {
          login: f.login,
          password: f.password,
        })
        keepLogin(f.login.trim())
        setTicket(r)
        setResent(false)
        setF({ ...f, password: '', code: '' })
        if (r.second) setSecond(r.second.passkey ? 'passkey' : r.second.totp ? 'totp' : 'recovery')
        setStep(r.second ? 'second' : 'code')
      })}
    >
      <Field
        label={t('Email or username')}
        required
        autocomplete="username"
        value={f.login}
        onInput={set('login')}
        inputRef={known ? undefined : focus}
      />
      <Password
        label={t('Password')}
        required
        autocomplete="current-password"
        aria-invalid={error && error !== why ? true : undefined}
        value={f.password}
        onInput={set('password')}
        inputRef={known ? focus : undefined}
      />
      <label class="g-check">
        <input
          type="checkbox"
          checked={f.keep}
          onChange={(e) => setF({ ...f, keep: (e.target as HTMLInputElement).checked })}
        />
        {t('Keep me signed in')}
      </label>
      {err}
      {submit(t('Sign in'))}
      <button class="g-btn g-btn--ghost" type="button" onClick={() => setStep('forgot')}>
        {t('Forgot your password?')}
      </button>
      {/* Gradient's Shades login (auth.css, g-auth-or and g-auth-sso), the same in every product. */}
      {info.shades && (
        <>
          <p class="g-auth-or">{t('or')}</p>
          <a class="g-auth-sso" href={`/api/auth/shades/start${f.keep ? '?keep=1' : ''}`}>
            <ShadesMark />
            {t('Shades login')}
          </a>
        </>
      )}
    </Frame>
  )
}

/**
 * Signed in, but with no brand and no super admin role yet: someone new from Shades login, or
 * someone whose access was taken away. One calm screen until a super admin gives them a role.
 */
export function NoAccess({ me }: { me: Me }) {
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<unknown>) => () => {
    setBusy(true)
    fn().catch(() => setBusy(false))
  }
  // Signing in again picks up a role given since; through Shades ID that takes one click.
  const again = () =>
    me.shades
      ? Promise.resolve(location.assign('/api/auth/shades/start'))
      : api.post('/api/auth/logout').then(() => dispatchEvent(new Event('sm-signed-out')))
  return (
    <Frame title={t('Ask a super admin for access')} busy={busy}>
      <span class="g-auth-who sm-auth-who--still">
        <span class="g-avatar g-avatar--sm" aria-hidden="true">
          {me.email.charAt(0).toUpperCase()}
        </span>
        <span>{me.email}</span>
      </span>
      <p class="g-auth-text">
        {me.shades
          ? t(
              'Your Shades account works, but it has no access to SocialMonitor yet. Ask a super admin to give you a role, then sign in again.',
            )
          : t(
              'Your account works, but it has no access to SocialMonitor yet. Ask a super admin to give you a role, then sign in again.',
            )}
      </p>
      <button class="g-btn g-btn--primary" type="button" disabled={busy} onClick={run(again)}>
        {t('Sign in again')}
      </button>
      <button class="g-btn g-btn--ghost" type="button" disabled={busy} onClick={run(signOut)}>
        {t('Sign out')}
      </button>
    </Frame>
  )
}
