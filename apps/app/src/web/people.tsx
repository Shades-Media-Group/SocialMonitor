import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import type { Me } from './auth.tsx'
import { api } from './api.ts'
import { Head, Icon, Menu, Sheet, ago, count } from './ui.tsx'
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
export function People({ brands, me, notify, mode, actions }: AppState & { me: Me }) {
  const [people, setPeople] = useState<Person[] | null>(null)
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
          <dl class="sm-kpis sm-kpis--row">
            <div class="sm-kpi sm-tone--blue">
              <dt>
                <span class="sm-kpi__icon">
                  <Icon name="group" size={16} />
                </span>
                {t('People')}
              </dt>
              <dd class="sm-kpi__value">
                <span class="g-num">{tally.all}</span>
              </dd>
            </div>
            <div class="sm-kpi sm-tone--violet">
              <dt>
                <span class="sm-kpi__icon">
                  <Icon name="star" size={16} />
                </span>
                {t('Super admins')}
              </dt>
              <dd class="sm-kpi__value">
                <span class="g-num">{tally.supers}</span>
              </dd>
            </div>
            <div class="sm-kpi sm-tone--green">
              <dt>
                <span class="sm-kpi__icon">
                  <Icon name="person" size={16} />
                </span>
                {t('Brand admins')}
              </dt>
              <dd class="sm-kpi__value">
                <span class="g-num">{tally.admins}</span>
              </dd>
            </div>
            <div class="sm-kpi sm-tone--amber">
              <dt>
                <span class="sm-kpi__icon">
                  <Icon name="mail" size={16} />
                </span>
                {t('Invited')}
              </dt>
              <dd class="sm-kpi__value">
                <span class="g-num">{tally.invited}</span>
              </dd>
            </div>
          </dl>

          <section class="sm-box sm-box--table">
            <header class="sm-box__head">
              <h2>{t('Everyone')}</h2>
              <span class="sm-box__meta">{count(list.length, 'person')}</span>
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
                  {list.map((p) => (
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
          {!form.super &&
            mine.map((b) => (
              <label class="sm-row">
                <span class="sm-row__label">{b.name}</span>
                <select
                  class="g-select sm-select-sm"
                  value={access[b.id] ?? ''}
                  onChange={(e) =>
                    setAccess({
                      ...access,
                      [b.id]: (e.target as HTMLSelectElement).value as Role | '',
                    })
                  }
                >
                  <option value="">{ROLE_TEXT['']}</option>
                  <option value="viewer">{ROLE_TEXT.viewer}</option>
                  <option value="admin">{ROLE_TEXT.admin}</option>
                </select>
              </label>
            ))}
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
      {!person.super &&
        brands.map((b) => (
          <label class="sm-row">
            <span class="sm-row__label">{b.name}</span>
            <select
              class="g-select sm-select-sm"
              value={roles[b.id]}
              onChange={(e) =>
                setRoles({ ...roles, [b.id]: (e.target as HTMLSelectElement).value as Role | '' })
              }
            >
              <option value="">{ROLE_TEXT['']}</option>
              <option value="viewer">{ROLE_TEXT.viewer}</option>
              <option value="admin">{ROLE_TEXT.admin}</option>
            </select>
          </label>
        ))}
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
