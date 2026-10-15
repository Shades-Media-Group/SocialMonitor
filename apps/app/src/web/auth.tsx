import { useId, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api } from './api.ts'
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
}
/** What the password step answers: a ticket, and the second steps besides the emailed code. */
interface Ticket {
  ticket: string
  to: string
  mail: boolean
  second?: { totp: boolean; recovery: boolean }
}
type Second = 'totp' | 'recovery'

export interface AuthInfo {
  user: Me | null
  setup: boolean
  local: boolean
  mail: boolean
}

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
  const [step, setStep] = useState<'signin' | 'code' | 'second' | 'forgot' | 'sent'>('signin')
  const [second, setSecond] = useState<Second>('totp')
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resent, setResent] = useState(false)
  // The cursor starts where typing begins: the password when the login is remembered.
  const [known] = useState(() => !!f.login)
  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: value(e) })

  const go = (fn: () => Promise<void>) => async (e: Event) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError((err as Error).message)
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
  const startAgain = () => {
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
          const r = await api.post<{ email: string }>('/api/auth/accept', {
            token: link.token,
            kind: link.kind,
            password: f.password,
            ...(link.kind === 'invite' ? { name: f.name, username: f.username } : {}),
          })
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
        ['totp', t('Use your authenticator app')],
        ['recovery', t('Use a recovery code')],
      ] as [Second, string][]
    ).filter(([k]) => k !== second && s[k])
    return (
      <Frame
        title={second === 'totp' ? t('Enter the code from your app') : t('Enter a recovery code')}
        busy={busy}
        onSubmit={go(async () => {
          onIn(
            await api.post<Me>('/api/auth/code', {
              ticket: ticket.ticket,
              [second]: f.code,
              keep: f.keep,
            }),
          )
        })}
      >
        {who}
        {second === 'totp' ? (
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
        {submit(t('Verify'))}
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
        <button
          class="g-btn g-btn--ghost"
          type="button"
          disabled={busy}
          onClick={go(async () => {
            setTicket(await api.post<Ticket>('/api/auth/resend', { ticket: ticket.ticket }))
            setF({ ...f, code: '' })
            setStep('code')
          })}
        >
          {t('Email me a code instead')}
        </button>
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

  if (step === 'forgot' || step === 'sent')
    return (
      <Frame
        title={t('Forgot your password')}
        lead={
          step === 'sent'
            ? t(
                'If that account exists, a link to choose a new password is on its way. It works for 30 minutes.',
              )
            : t('Give your email or username. We email you a link to choose a new password.')
        }
        busy={busy}
        onSubmit={
          step === 'forgot'
            ? go(async () => {
                await api.post('/api/auth/forgot', { login: f.login })
                setStep('sent')
              })
            : undefined
        }
      >
        {step === 'forgot' && (
          <>
            <Field
              label={t('Email or username')}
              required
              autocomplete="username"
              value={f.login}
              onInput={set('login')}
              inputRef={focus}
            />
            {err}
            {submit(t('Send link'))}
          </>
        )}
        <button class="g-btn g-btn--ghost" type="button" onClick={startAgain}>
          {t('Back to sign in')}
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
        if (r.second) setSecond(r.second.totp ? 'totp' : 'recovery')
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
        aria-invalid={error ? true : undefined}
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
    </Frame>
  )
}
