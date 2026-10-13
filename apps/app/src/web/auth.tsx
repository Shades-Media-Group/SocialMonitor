import { useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { api } from './api.ts'
import { Icon, Logo } from './ui.tsx'
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
export interface AuthInfo {
  user: Me | null
  setup: boolean
  local: boolean
  mail: boolean
}

/** A link from an email: #/invite/<token> or #/reset/<token>. */
export function linkFromHash() {
  const [, kind, token] = location.hash.split('/')
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

/** A password field with a show/hide button and a Caps Lock warning. */
function Password({
  label,
  inputRef,
  ...input
}: { label: string; inputRef?: (el: HTMLInputElement | null) => void } & Record<string, unknown>) {
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const check = (e: KeyboardEvent) => setCaps(e.getModifierState?.('CapsLock') ?? false)
  return (
    <label class="sm-auth__field">
      <span>{label}</span>
      <span class="sm-auth__pass">
        <input
          class="g-input"
          ref={inputRef}
          {...input}
          type={shown ? 'text' : 'password'}
          onKeyUp={check}
          onKeyDown={check}
          onBlur={() => setCaps(false)}
        />
        <button
          type="button"
          class="sm-auth__eye"
          aria-label={shown ? t('Hide the password') : t('Show the password')}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
        >
          <Icon name={shown ? 'visibilityOff' : 'visibility'} size={18} />
        </button>
      </span>
      {caps && <small role="status">{t('Caps Lock is on.')}</small>}
    </label>
  )
}

/** Focuses a field when it first appears. Stable, so it runs once per mount. */
const focus = (el: HTMLInputElement | null) => el?.focus()

function Field({
  label,
  hint,
  inputRef,
  ...input
}: { label: string; hint?: string; inputRef?: (el: HTMLInputElement | null) => void } & Record<
  string,
  unknown
>) {
  return (
    <label class="sm-auth__field">
      <span>{label}</span>
      <input class="g-input" ref={inputRef} {...input} />
      {hint && <small>{hint}</small>}
    </label>
  )
}

function Frame({
  title,
  lead,
  children,
}: {
  title: string
  lead?: ComponentChildren
  children: ComponentChildren
}) {
  return (
    <main class="sm-auth">
      <Logo />
      <h1>{title}</h1>
      {lead && <p class="sm-auth__lead">{lead}</p>}
      {children}
      <p class="sm-auth__foot">
        {t('SocialMonitor. Free and open source. Built by Shades Media Group.')}
      </p>
    </main>
  )
}

const value = (e: Event) => (e.target as HTMLInputElement).value

/**
 * Everything before the dashboard: the first account, signing in with a password and an
 * emailed code, a forgotten password, and the links people get by email.
 */
export function AuthScreen({ info, onIn }: { info: AuthInfo; onIn: (me: Me) => void }) {
  const link = linkFromHash()
  const [step, setStep] = useState<'signin' | 'code' | 'forgot' | 'sent'>('signin')
  const [f, setF] = useState({
    login: lastLogin(),
    keep: false,
    password: '',
    code: '',
    name: '',
    username: '',
    email: '',
  })
  const [ticket, setTicket] = useState<{ ticket: string; to: string; mail: boolean } | null>(null)
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

  if (link)
    return (
      <Frame
        title={link.kind === 'invite' ? t('Set up your account') : t('Choose a new password')}
        lead={
          link.kind === 'invite'
            ? t('Pick a password. You will sign in with it and a code we email you.')
            : undefined
        }
      >
        <form
          key="link"
          class="sm-auth__form"
          onSubmit={go(async () => {
            const r = await api.post<{ email: string }>('/api/auth/accept', {
              token: link.token,
              kind: link.kind,
              password: f.password,
              ...(link.kind === 'invite' ? { name: f.name, username: f.username } : {}),
            })
            setF({ ...f, login: r.email, password: '' })
            location.hash = '#/'
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
          <Field
            label={t('Password')}
            hint={t('At least 10 characters.')}
            type="password"
            required
            minLength={10}
            autocomplete="new-password"
            value={f.password}
            onInput={set('password')}
          />
          {err}
          {submit(t('Save password'))}
        </form>
      </Frame>
    )

  if (info.setup)
    return info.local ? (
      <Frame
        title={t('Create the first account')}
        lead={t('It becomes the super admin: it sees every brand and invites everyone else.')}
      >
        <form
          key="setup"
          class="sm-auth__form"
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
          <Field
            label={t('Password')}
            hint={t('At least 10 characters.')}
            type="password"
            required
            minLength={10}
            autocomplete="new-password"
            value={f.password}
            onInput={set('password')}
          />
          {err}
          {submit(t('Create account'))}
        </form>
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

  if (step === 'code' && ticket)
    return (
      <Frame
        title={t('Check your email')}
        lead={
          ticket.mail
            ? t('We sent a six-digit code to {to}. It works for 10 minutes.', { to: ticket.to })
            : t(
                'Email is not set up, so the code was printed in the console of the computer SocialMonitor runs on.',
              )
        }
      >
        <form
          key="code"
          class="sm-auth__form"
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
            <p class="sm-auth__note" role="status">
              {t('A new code is on its way.')}
            </p>
          )}
          <div class="sm-auth__row">
            {submit(t('Verify'))}
            <button
              class="g-btn g-btn--ghost"
              type="button"
              disabled={busy}
              onClick={go(async () => {
                setTicket(
                  await api.post<{ ticket: string; to: string; mail: boolean }>(
                    '/api/auth/resend',
                    { ticket: ticket.ticket },
                  ),
                )
                setF({ ...f, code: '' })
                setResent(true)
              })}
            >
              {t('Send a new code')}
            </button>
          </div>
          <button
            class="sm-textbtn"
            type="button"
            onClick={() => {
              setStep('signin')
              setResent(false)
              setF({ ...f, code: '' })
            }}
          >
            {t('Start again')}
          </button>
        </form>
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
      >
        {step === 'forgot' && (
          <form
            key="forgot"
            class="sm-auth__form"
            onSubmit={go(async () => {
              await api.post('/api/auth/forgot', { login: f.login })
              setStep('sent')
            })}
          >
            <Field
              label={t('Email or username')}
              required
              autocomplete="username"
              value={f.login}
              onInput={set('login')}
            />
            {err}
            {submit(t('Send link'))}
          </form>
        )}
        <button class="sm-textbtn" type="button" onClick={() => setStep('signin')}>
          {t('Back to sign in')}
        </button>
      </Frame>
    )

  return (
    <Frame title={t('Sign in to SocialMonitor')}>
      <form
        key="signin"
        class="sm-auth__form"
        onSubmit={go(async () => {
          const r = await api.post<{ ticket: string; to: string; mail: boolean }>(
            '/api/auth/login',
            {
              login: f.login,
              password: f.password,
            },
          )
          keepLogin(f.login.trim())
          setTicket(r)
          setResent(false)
          setF({ ...f, password: '', code: '' })
          setStep('code')
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
          value={f.password}
          onInput={set('password')}
          inputRef={known ? focus : undefined}
        />
        <label class="sm-auth__check">
          <input
            type="checkbox"
            checked={f.keep}
            onChange={(e) => setF({ ...f, keep: (e.target as HTMLInputElement).checked })}
          />
          {t('Keep me signed in')}
        </label>
        {err}
        {submit(t('Sign in'))}
        <button class="sm-textbtn" type="button" onClick={() => setStep('forgot')}>
          {t('Forgot your password?')}
        </button>
      </form>
    </Frame>
  )
}
