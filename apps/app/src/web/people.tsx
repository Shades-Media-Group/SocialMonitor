import { useEffect, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import type { Me } from './auth.tsx'
import { api } from './api.ts'
import { Sheet, ago } from './ui.tsx'
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

const ROLE_TEXT: Record<Role | '', string> = { '': 'No access', viewer: 'Viewer', admin: 'Admin' }

/**
 * Who can open the dashboard. Super admins see everyone and every brand; a brand's admins see
 * and invite the people of their own brands. Viewers read; admins edit the brand, rate comments
 * and run updates.
 */
export function People({ brands, me, notify, mode }: AppState & { me: Me }) {
  const [people, setPeople] = useState<Person[] | null>(null)
  const [open, setOpen] = useState<Person | null>(null)
  const [form, setForm] = useState({ email: '', name: '', super: false })
  const [access, setAccess] = useState<Record<number, Role | ''>>({})
  const [error, setError] = useState<string | null>(null)

  const mine = me.super
    ? brands
    : brands.filter((b) => me.memberships.some((m) => m.brand_id === b.id && m.role === 'admin'))
  const name = (id: number) => brands.find((b) => b.id === id)?.name ?? `Brand ${id}`
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
      notify(`Invitation sent to ${form.email}.`)
      setForm({ email: '', name: '', super: false })
      setAccess({})
      await load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const status = (p: Person) =>
    p.disabled
      ? 'Blocked'
      : !p.verified_at
        ? 'Invited'
        : p.last_seen_at
          ? `Seen ${ago(p.last_seen_at)}`
          : 'Active'
  const what = (p: Person) =>
    p.super
      ? 'Super admin, every brand'
      : p.memberships
          .map((m) => `${name(m.brand_id)} (${ROLE_TEXT[m.role].toLowerCase()})`)
          .join(', ') || 'No brands'

  return (
    <main class="sm-page">
      <header class="sm-head">
        <h1>People</h1>
        <div class="sm-head__lead">
          <p>
            Viewers read a brand's dashboard. Admins also edit the brand and its links, rate
            comments, run updates and invite people.{' '}
            {me.super && 'Super admins manage every brand and everyone.'}
          </p>
        </div>
      </header>

      {mode === 'json' ? (
        <JsonPanel value={people ?? []} />
      ) : (
        <>
          <section class="sm-section">
            <h2>Invite someone</h2>
            <form class="sm-form" onSubmit={invite}>
              <label class="sm-row">
                <span class="sm-row__label">Email</span>
                <input
                  class="g-input"
                  type="email"
                  required
                  value={form.email}
                  onInput={(e) => setForm({ ...form, email: (e.target as HTMLInputElement).value })}
                />
              </label>
              <label class="sm-row">
                <span class="sm-row__label">Name</span>
                <input
                  class="g-input"
                  value={form.name}
                  onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })}
                />
              </label>
              {me.super && (
                <label class="sm-row">
                  <span class="sm-row__label">Super admin</span>
                  <span class="sm-check">
                    <input
                      type="checkbox"
                      checked={form.super}
                      onChange={(e) =>
                        setForm({ ...form, super: (e.target as HTMLInputElement).checked })
                      }
                    />
                    Sees every brand and manages everyone
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
                      <option value="">No access</option>
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
                ))}
              {error && <p class="g-error">{error}</p>}
              <div class="sm-form__actions">
                <button class="g-btn g-btn--primary g-btn--sm" type="submit">
                  Send invitation
                </button>
              </div>
            </form>
          </section>

          <section class="sm-section">
            <h2>Everyone</h2>
            <table class="g-table sm-table sm-people">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th>
                    <span class="sm-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(people ?? []).map((p) => (
                  <tr>
                    <td>
                      <b>{p.name || p.email}</b>
                      {p.name && <span class="sm-quiet"> {p.email}</span>}
                      {p.id === me.id && <span class="sm-quiet"> (you)</span>}
                    </td>
                    <td>{what(p)}</td>
                    <td>{status(p)}</td>
                    <td class="sm-people__act">
                      <button class="sm-textbtn" type="button" onClick={() => setOpen(p)}>
                        Change
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
              `${label}'s access is saved.`,
            )}
          >
            Save access
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
              <option value="">No access</option>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
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
              ? `A reset link went to ${person.email}.`
              : `The invitation went again to ${person.email}.`,
          )}
        >
          {person.verified_at ? 'Send a reset link' : 'Send the invitation again'}
        </button>
        {me.super && !self && (
          <>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={act(
                () => api.patch(`/api/users/${person.id}`, { super: !person.super }),
                person.super
                  ? `${label} is no longer a super admin.`
                  : `${label} is now a super admin.`,
              )}
            >
              {person.super ? 'Remove super admin' : 'Make super admin'}
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={act(
                () => api.patch(`/api/users/${person.id}`, { disabled: !person.disabled }),
                person.disabled
                  ? `${label} can sign in again.`
                  : `${label} is blocked and signed out.`,
              )}
            >
              {person.disabled ? 'Unblock' : 'Block'}
            </button>
            <button
              class="g-btn g-btn--ghost g-btn--sm"
              type="button"
              onClick={() =>
                confirm(`Remove ${label}? They lose access to every brand.`) &&
                act(() => api.del(`/api/users/${person.id}`), `${label} is removed.`)()
              }
            >
              Remove
            </button>
          </>
        )}
      </div>
    </Sheet>
  )
}
