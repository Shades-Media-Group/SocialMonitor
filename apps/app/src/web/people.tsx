import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import type { Me } from './auth.tsx'
import { api } from './api.ts'
import type { IconName } from 'shades-gradient'
import { Head, Icon, Menu, Sheet, ago, count } from './ui.tsx'
import { usePref } from './prefs.ts'
import { t } from './i18n.ts'
import { JsonPanel } from './json.tsx'

type Role = 'viewer' | 'admin'
interface Person {
  id: number
  email: string
  username: string | null
  name: string
  super: number
  verified_at: string | null
  disabled: number
  last_seen_at: string | null
  memberships: { brand_id: number; role: Role }[]
}

const ROLE_TEXT: Record<Role | '', string> = {
  '': t('No access'),
  viewer: t('Viewer'),
  admin: t('Admin'),
}

/**
 * Who can open the dashboard. Super admins see everyone and every brand; a brand's admins see
 * and invite the people of their own brands. Viewers read; admins edit the brand, rate comments
 * and run updates.
 */
type Who = 'all' | 'supers' | 'admins' | 'invited'

export function People({ brands, me, notify, mode, actions }: AppState & { me: Me }) {
  const [people, setPeople] = useState<Person[] | null>(null)
  const [who, setWho] = usePref<Who>('people.who', 'all')
  const [open, setOpen] = useState<Person | null>(null)
  const [form, setForm] = useState({ email: '', name: '', super: false })
  const [access, setAccess] = useState<Record<number, Role | ''>>({})
  const [error, setError] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)

  const mine = me.super
    ? brands
    : brands.filter((b) => me.memberships.some((m) => m.brand_id === b.id && m.role === 'admin'))
  const name = (id: number) => brands.find((b) => b.id === id)?.name ?? t('Brand {id}', { id })
  const load = () => api.get<Person[]>('/api/users').then(setPeople)
  useEffect(() => {
    load().catch((e: Error) => setError(e.message))
  }, [])

  const invite = async (e: Event) => {
    e.preventDefault()
    setError(null)
    try {
      await api.post('/api/users', {
        ...form,
        memberships: Object.entries(access)
          .filter(([, r]) => r)
          .map(([brand_id, role]) => ({ brand_id: Number(brand_id), role })),
      })
      notify(t('Invitation sent to {email}.', { email: form.email }))
      setForm({ email: '', name: '', super: false })
      setAccess({})
      setInviting(false)
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const roleBadge = (p: Person) =>
    p.super ? (
      <span class="sm-badge sm-badge--violet">{t('Super admin')}</span>
    ) : p.memberships.some((m) => m.role === 'admin') ? (
      <span class="sm-badge sm-badge--blue">{t('Admin')}</span>
    ) : !p.memberships.length ? (
      // New from Shades login, or with every brand taken away: Change access gives them one.
      <span class="sm-badge sm-badge--amber">{t('No access')}</span>
    ) : (
      <span class="sm-badge">{t('Viewer')}</span>
    )
  const statusBadge = (p: Person) =>
    p.disabled ? (
      <span class="sm-badge sm-badge--red">{t('Blocked')}</span>
    ) : !p.verified_at ? (
      <span class="sm-badge sm-badge--amber">{t('Invited')}</span>
    ) : (
      <span class="sm-badge sm-badge--green">{t('Active')}</span>
    )
  const act = (fn: () => Promise<unknown>, text: string) => () =>
    fn()
      .then(() => {
        notify(text)
        return load()
      })
      .catch((e: Error) => notify(e.message))
  const list = people ?? []
  const tally = {
    all: list.length,
    supers: list.filter((p) => p.super).length,
    admins: list.filter((p) => !p.super && p.memberships.some((m) => m.role === 'admin')).length,
    invited: list.filter((p) => !p.verified_at).length,
  }
  // The figures at the top are tabs: each shows only the people it counts.
  const shown = list.filter((p) =>
    who === 'supers'
      ? p.super
      : who === 'admins'
        ? !p.super && p.memberships.some((m) => m.role === 'admin')
        : who === 'invited'
          ? !p.verified_at
          : true,
  )

  return (
    <main class="sm-page">
      <Head
        title={t('People')}
        sub={t('Who can open the dashboard, and which brands they see')}
        actions={
          <>
            {actions}
            <button
              class="g-btn g-btn--primary g-btn--sm"
              type="button"
              onClick={() => setInviting(true)}
            >
              <Icon name="add" size={14} /> {t('Invite someone')}
            </button>
          </>
        }
      />

      {mode === 'json' ? (
        <JsonPanel value={list} />
      ) : (
        <>
          <div
            class="sm-ga__cards sm-hometabs sm-hometabs--4"
            role="tablist"
            aria-label={t('Show')}
          >
            {(
              [
                ['all', 'group', t('People'), tally.all],
                ['supers', 'star', t('Super admins'), tally.supers],
                ['admins', 'person', t('Brand admins'), tally.admins],
                ['invited', 'mail', t('Invited'), tally.invited],
              ] as [Who, IconName, string, number][]
            ).map(([k, icon, label, n]) => (
              <button
                type="button"
                role="tab"
                aria-selected={who === k}
                class="sm-ga__card"
                onClick={() => setWho(k)}
              >
                <span class="sm-ga__label">
                  <Icon name={icon} size={14} /> {label}
                </span>
                <span class="sm-ga__value g-num">{n}</span>
              </button>
            ))}
          </div>

          <section class="sm-box sm-box--table">
            <header class="sm-box__head">
              <h2>{t('Everyone')}</h2>
              <span class="sm-box__meta">{count(shown.length, 'person')}</span>
            </header>
            <div class="sm-scroll">
              <table class="sm-dtable sm-dtable--rows">
                <thead>
                  <tr>
                    <th>{t('Person')}</th>
                    <th>{t('Role')}</th>
                    <th>{t('Brands')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Last seen')}</th>
                    <th class="sm-num">
                      <span class="sm-sr">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr>
                      <td>
                        <span class="sm-personcell">
                          <span class="sm-nav__avatar" aria-hidden="true">
                            {(p.name || p.email).slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            <b>
                              {p.name || p.email}
                              {p.id === me.id && <span class="sm-quiet"> {t('(you)')}</span>}
                            </b>
                            <small>{p.email}</small>
                          </span>
                        </span>
                      </td>
                      <td>{roleBadge(p)}</td>
                      <td>
                        {p.super ? (
                          <span class="sm-quiet">{t('Every brand')}</span>
                        ) : (
                          <span class="sm-chiprow">
                            {p.memberships.map((m) => (
                              <span class="sm-chiplet">
                                {name(m.brand_id)} <b>{ROLE_TEXT[m.role]}</b>
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td>{statusBadge(p)}</td>
                      <td class="sm-nowrap">{p.last_seen_at ? ago(p.last_seen_at) : '–'}</td>
                      <td class="sm-num">
                        <Menu
                          label={t('Actions')}
                          items={[
                            { label: t('Change access'), onSelect: () => setOpen(p) },
                            {
                              label: p.verified_at
                                ? t('Send a reset link')
                                : t('Send the invitation again'),
                              onSelect: act(
                                () => api.post(`/api/users/${p.id}/invite`),
                                p.verified_at
                                  ? t('A reset link went to {email}.', { email: p.email })
                                  : t('The invitation went again to {email}.', { email: p.email }),
                              ),
                            },
                            ...(me.super && p.id !== me.id
                              ? [
                                  {
                                    label: p.super
                                      ? t('Remove super admin')
                                      : t('Make super admin'),
                                    onSelect: act(
                                      () => api.patch(`/api/users/${p.id}`, { super: !p.super }),
                                      t('Saved.'),
                                    ),
                                  },
                                  {
                                    label: p.disabled ? t('Unblock') : t('Block'),
                                    onSelect: act(
                                      () =>
                                        api.patch(`/api/users/${p.id}`, { disabled: !p.disabled }),
                                      t('Saved.'),
                                    ),
                                  },
                                  {
                                    label: t('Remove'),
                                    danger: true,
                                    onSelect: () =>
                                      confirm(
                                        t('Remove {name}? They lose access to every brand.', {
                                          name: p.name || p.email,
                                        }),
                                      ) &&
                                      act(
                                        () => api.del(`/api/users/${p.id}`),
                                        t('{name} is removed.', { name: p.name || p.email }),
                                      )(),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <Sheet open={inviting} title={t('Invite someone')} onClose={() => setInviting(false)}>
        <form class="sm-form" onSubmit={invite}>
          <label class="sm-row">
            <span class="sm-row__label">{t('Email')}</span>
            <input
              class="g-input"
              type="email"
              required
              value={form.email}
              onInput={(e) => setForm({ ...form, email: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="sm-row">
            <span class="sm-row__label">{t('Name')}</span>
            <input
              class="g-input"
              value={form.name}
              onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
            />
          </label>
          {me.super && (
            <label class="sm-row">
              <span class="sm-row__label">{t('Super admin')}</span>
              <span class="sm-check">
                <input
                  type="checkbox"
                  checked={form.super}
                  onChange={(e) =>
                    setForm({ ...form, super: (e.target as HTMLInputElement).checked })
                  }
                />
                {t('Sees every brand and manages everyone')}
              </span>
            </label>
          )}
          {!form.super && <AccessPicker brands={mine} value={access} onChange={setAccess} />}
          {error && <p class="g-error">{error}</p>}
          <div class="sm-form__actions">
            <button class="g-btn g-btn--primary g-btn--sm" type="submit">
              {t('Send invitation')}
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() => setInviting(false)}
            >
              {t('Cancel')}
            </button>
          </div>
        </form>
      </Sheet>

      {open && (
        <PersonSheet
          person={open}
          me={me}
          brands={mine}
          onClose={() => setOpen(null)}
          onSaved={async (text) => {
            notify(text)
            setOpen(null)
            await load()
          }}
        />
      )}
    </main>
  )
}

function PersonSheet({
  person,
  me,
  brands,
  onClose,
  onSaved,
}: {
  person: Person
  me: Me
  brands: AppState['brands']
  onClose: () => void
  onSaved: (text: string) => void
}) {
  const [roles, setRoles] = useState<Record<number, Role | ''>>(() =>
    Object.fromEntries(
      brands.map((b) => [b.id, person.memberships.find((m) => m.brand_id === b.id)?.role ?? '']),
    ),
  )
  const [error, setError] = useState<string | null>(null)
  const self = person.id === me.id
  const label = person.name || person.email
  const act = (fn: () => Promise<unknown>, text: string) => async () => {
    setError(null)
    try {
      await fn()
      onSaved(text)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Sheet
      open
      title={label}
      onClose={onClose}
      footer={
        <>
          {error && <p class="g-error">{error}</p>}
          <button
            class="g-btn g-btn--primary g-btn--block"
            type="button"
            onClick={act(
              () =>
                api.patch(`/api/users/${person.id}`, {
                  memberships: brands.map((b) => ({ brand_id: b.id, role: roles[b.id] || null })),
                }),
              t("{name}'s access is saved.", { name: label }),
            )}
          >
            {t('Save access')}
          </button>
        </>
      }
    >
      <p class="sm-quiet">{person.email}</p>
      {!person.super && <AccessPicker brands={brands} value={roles} onChange={setRoles} />}
      <div class="sm-sheet__actions">
        <button
          class="g-btn g-btn--sm"
          type="button"
          onClick={act(
            () => api.post(`/api/users/${person.id}/invite`),
            person.verified_at
              ? t('A reset link went to {email}.', { email: person.email })
              : t('The invitation went again to {email}.', { email: person.email }),
          )}
        >
          {person.verified_at ? t('Send a reset link') : t('Send the invitation again')}
        </button>
        {me.super && !self && (
          <>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={act(
                () => api.patch(`/api/users/${person.id}`, { super: !person.super }),
                person.super
                  ? t('{name} is no longer a super admin.', { name: label })
                  : t('{name} is now a super admin.', { name: label }),
              )}
            >
              {person.super ? t('Remove super admin') : t('Make super admin')}
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={act(
                () => api.patch(`/api/users/${person.id}`, { disabled: !person.disabled }),
                person.disabled
                  ? t('{name} can sign in again.', { name: label })
                  : t('{name} is blocked and signed out.', { name: label }),
              )}
            >
              {person.disabled ? t('Unblock') : t('Block')}
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() =>
                confirm(t('Remove {name}? They lose access to every brand.', { name: label })) &&
                act(
                  () => api.del(`/api/users/${person.id}`),
                  t('{name} is removed.', { name: label }),
                )()
              }
            >
              {t('Remove')}
            </button>
          </>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Brand access that stays usable with hundreds of brands: the brands this person can open, each
 * with its role, then a search that adds more. Brands left out have no access.
 */
function AccessPicker({
  brands,
  value,
  onChange,
}: {
  brands: { id: number; name: string }[]
  value: Record<number, Role | ''>
  onChange: (v: Record<number, Role | ''>) => void
}) {
  const [q, setQ] = useState('')
  const set = (id: number, role: Role | '') => onChange({ ...value, [id]: role })
  const chosen = brands.filter((b) => value[b.id])
  const words = q.toLowerCase().trim()
  const others = brands.filter((b) => !value[b.id] && b.name.toLowerCase().includes(words))
  const all = (role: Role | '') =>
    onChange(Object.fromEntries(brands.map((b) => [b.id, role])) as Record<number, Role | ''>)
  return (
    <div class="sm-access">
      <div class="sm-access__head">
        <b>{t('Brands they can open')}</b>
        <span class="sm-quiet">{count(chosen.length, 'brand')}</span>
        {brands.length > 1 && (
          <span class="sm-access__all">
            <button class="sm-textbtn" type="button" onClick={() => all('viewer')}>
              {t('Every brand as viewer')}
            </button>
            <button class="sm-textbtn" type="button" onClick={() => all('admin')}>
              {t('as admin')}
            </button>
            {chosen.length > 0 && (
              <button class="sm-textbtn" type="button" onClick={() => all('')}>
                {t('None')}
              </button>
            )}
          </span>
        )}
      </div>
      {chosen.length ? (
        <ul class="sm-access__list">
          {chosen.map((b) => (
            <li>
              <span class="sm-access__name">{b.name}</span>
              <span class="g-segmented sm-seg" role="radiogroup" aria-label={b.name}>
                {(['viewer', 'admin'] as const).map((r) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={value[b.id] === r}
                    class="g-segmented__item"
                    onClick={() => set(b.id, r)}
                  >
                    {ROLE_TEXT[r]}
                  </button>
                ))}
              </span>
              <button
                class="g-icon-btn"
                type="button"
                aria-label={t('Remove access to {brand}', { brand: b.name })}
                onClick={() => set(b.id, '')}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="sm-quiet">{t('No brands yet. Add one below.')}</p>
      )}
      {brands.length > chosen.length && (
        <>
          <input
            class="g-input sm-search"
            type="search"
            value={q}
            placeholder={t('Find a brand to add…')}
            aria-label={t('Find a brand to add')}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
          <ul class="sm-access__list sm-access__list--add">
            {others.slice(0, 8).map((b) => (
              <li>
                <span class="sm-access__name">{b.name}</span>
                <button class="sm-textbtn" type="button" onClick={() => set(b.id, 'viewer')}>
                  {t('Add as viewer')}
                </button>
                <button class="sm-textbtn" type="button" onClick={() => set(b.id, 'admin')}>
                  {t('Add as admin')}
                </button>
              </li>
            ))}
            {others.length > 8 && (
              <li class="sm-quiet">
                {t('{n} more: type to narrow the list.', { n: others.length - 8 })}
              </li>
            )}
            {!others.length && <li class="sm-quiet">{t('No brand matches.')}</li>}
          </ul>
        </>
      )}
    </div>
  )
}
