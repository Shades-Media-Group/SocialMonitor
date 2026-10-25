import * as auth from '../core/auth.ts'
import * as roles from '../core/shades-roles.ts'
import type { Ctx } from './routes.ts'
import { HttpError, r } from './routes.ts'

/**
 * The Shades roles API (docs/server.md): the Shades CRM sets who may use SocialMonitor. Called
 * server to server with `Authorization: Bearer $SHADES_ROLES_TOKEN` and `X-Acting-User: <email>`,
 * never with a browser session. Without a token of at least 32 characters, every route says 503.
 */
const header = (c: Ctx, name: string) => {
  const v = c.headers?.[name]
  return Array.isArray(v) ? v[0] : v
}

/** The checks every route makes, in order: configured, not rate-limited, the token, who asks. */
function caller(c: Ctx): roles.Who {
  const token = roles.rolesToken()
  if (!token) throw new HttpError(503, 'not configured')
  const key = `roles:${c.ip}`
  try {
    auth.checkRate(key, 10)
  } catch (e) {
    throw new HttpError(429, e instanceof Error ? e.message : 'Too many tries.')
  }
  if (!roles.bearerMatches(header(c, 'authorization'), token)) {
    auth.noteFailure(key)
    throw new HttpError(401, 'unauthorized')
  }
  const by = roles.actingUser(header(c, 'x-acting-user'))
  if (!by) throw new HttpError(400, 'X-Acting-User must be the email of the person acting.')
  return { by, ip: c.ip, ua: c.ua }
}

const subOf = (c: Ctx) => {
  try {
    return decodeURIComponent(c.params.sub ?? '')
  } catch {
    throw new HttpError(400, 'Give a Shades subject.')
  }
}

/** A RolesError keeps its status. */
const answer = <T>(f: () => T) => {
  try {
    return f()
  } catch (e) {
    if (e instanceof roles.RolesError) throw new HttpError(e.status, e.message)
    throw e
  }
}

export const shadesRolesRoutes = [
  r('GET', '/api/shades-roles/roles', 'public', (c) => {
    caller(c)
    return roles.listRoles(c.db)
  }),

  r('PUT', '/api/shades-roles/accounts/:sub', 'public', (c) => {
    const who = caller(c)
    return { account: answer(() => roles.putAccount(c.db, who, subOf(c), c.body)) }
  }),

  r('DELETE', '/api/shades-roles/accounts/:sub', 'public', (c) => {
    const who = caller(c)
    answer(() => roles.deleteAccount(c.db, who, subOf(c)))
    return { __status: 204 }
  }),
]
