import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import type { Me } from './auth.tsx'
import { api } from './api.ts'
import { Head, Sheet, ago } from './ui.tsx'
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
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const status = (p: Person) =>
    p.disabled
      ? t('Blocked')
      : !p.verified_at
        ? t('Invited')
        : p.last_seen_at
          ? t('Seen {when}', { when: ago(p.last_seen_at) })
          : t('Active')
  const what = (p: Person) =>
    p.super
      ? t('Super admin, every brand')
      : p.memberships
          .map((m) => `${name(m.brand_id)} (${ROLE_TEXT[m.role].toLowerCase()})`)
          .join(', ') || t('No brands')

  return (
    <main class="sm-page">
      <Head
        title={t('People')}
        sub={t('Who can open the dashboard, and which brands they see')}
        actions={actions}
      />

      {mode === 'json' ? (
        <JsonPanel value={people ?? []} />
      ) : (
        <>
          <section class="sm-section">
            <h2>{t('Invite someone')}</h2>
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
              </div>
            </form>
          </section>

          <section class="sm-section">
            <h2>{t('Everyone')}</h2>
            <table class="g-table sm-table sm-people">
              <thead>
                <tr>
                  <th>{t('Person')}</th>
                  <th>{t('Access')}</th>
                  <th>{t('Status')}</th>
                  <th>
                    <span class="sm-sr">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(people ?? []).map((p) => (
                  <tr>
                    <td>
                      <b>{p.name || p.email}</b>
                      {p.name && <span class="sm-quiet"> {p.email}</span>}
                      {p.id === me.id && <span class="sm-quiet"> {t('(you)')}</span>}
                    </td>
                    <td>{what(p)}</td>
                    <td>{status(p)}</td>
                    <td class="sm-people__act">
                      <button class="sm-textbtn" type="button" onClick={() => setOpen(p)}>
                        {t('Change')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

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
