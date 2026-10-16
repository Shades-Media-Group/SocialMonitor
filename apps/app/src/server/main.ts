import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, openDb } from '../core/db.ts'
import { guard, HttpError, routes } from './routes.ts'
import { authRoutes } from './auth-routes.ts'
import {
  cookieAge,
  cookieName,
  getSession,
  readCookie,
  readSession,
  rotateSession,
  seedAdmin,
  sessionCookie,
} from '../core/auth.ts'
import { seedFromFile } from './seed.ts'
import { clientOf, gate, publicHost } from './access.ts'
import { closeStaleRuns } from '../core/store.ts'
import { startScheduler } from '../core/schedule.ts'
import { AiLimitError, LIMIT_TEXT } from '../core/ai-limit.ts'
import { fillTikTok } from '../core/fill.ts'
import { changed, onChange } from '../core/events.ts'
import { baseHeaders, newNonce, pageCsp, withNonce } from './headers.ts'

// Keys and options live in .env at the repository root, never in the code. In production the app
// runs from a release folder, and scripts/production.mjs points it at the repository's .env.
try {
  process.loadEnvFile(
    process.env.SOCIALMONITOR_ENV_FILE ??
      fileURLToPath(new URL('../../../../.env', import.meta.url)),
  )
} catch {
  /* no .env: fine */
}

const PORT = Number(process.env.SOCIALMONITOR_API_PORT ?? process.env.PORT ?? 4400)
const HOST = '127.0.0.1' // never reachable from other devices directly; remote use goes through the tunnel
const WEB = fileURLToPath(new URL('../../dist', import.meta.url))

const ORIGINS = new Set(
  [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    process.env.SOCIALMONITOR_UI,
    process.env.SOCIALMONITOR_UI?.replace('127.0.0.1', 'localhost'),
    publicHost() && `https://${publicHost()}`,
  ].filter((o): o is string => !!o),
)

const db = openDb()
seedAdmin(db)
seedFromFile(db)
closeStaleRuns(db)
startScheduler(db)
// Photos and stickers for older TikTok comments, from public pages, a few seconds after start.
setTimeout(() => void fillTikTok(db, (l) => console.log(l)).catch(() => {}), 5000)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 200 * 1024 * 1024) throw new HttpError(413, 'The file is larger than 200 MB.')
    chunks.push(c as Buffer)
  }
  const s = Buffer.concat(chunks).toString('utf8')
  if (!s) return {}
  try {
    return JSON.parse(s)
  } catch {
    throw new HttpError(400, 'The request body is not JSON.')
  }
}

function send(res: ServerResponse, status: number, data: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(data) : (data as string | Buffer))
}

function serveStatic(res: ServerResponse, path: string) {
  const file = normalize(join(WEB, path === '/' ? 'index.html' : path))
  const target =
    file.startsWith(WEB) && existsSync(file) && statSync(file).isFile()
      ? file
      : join(WEB, 'index.html')
  if (!existsSync(target))
    return send(res, 503, 'The dashboard is not built yet: run yarn start.', 'text/plain')
  if (target.endsWith('index.html')) {
    // The page: a fresh nonce on its scripts, and a CSP that runs nothing else.
    const nonce = newNonce()
    res.writeHead(200, {
      'content-type': TYPES['.html'],
      'cache-control': 'no-store',
      'content-security-policy': pageCsp(nonce),
    })
    return res.end(withNonce(readFileSync(target, 'utf8'), nonce))
  }
  res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
  res.end(readFileSync(target))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  for (const [k, v] of Object.entries(baseHeaders(false))) res.setHeader(k, v)
  // First the address and the tunnel: a Host outside the allow-list (DNS rebinding) gets nothing,
  // and anything that came through Cloudflare must use the public hostname.
  const pass = await gate(req, PORT)
  if (!pass.ok) return send(res, pass.status, { error: pass.error })
  // Through the tunnel the browser sees HTTPS: tell it to keep using it.
  if (pass.tunnel)
    res.setHeader('strict-transport-security', baseHeaders(true)['strict-transport-security']!)
  // Only the dashboard itself may drive the API from a browser: its own origin, the dev UI and the
  // tunnel. Other local ports count as the same site to cookies, so they are refused by name.
  const origin = req.headers.origin
  if (origin && !ORIGINS.has(origin)) return send(res, 403, { error: 'Forbidden origin.' })
  // A form or text/plain POST skips the browser's CORS check; JSON can't be sent cross-site without it.
  if (req.method === 'POST' && !/^application\/json\b/.test(req.headers['content-type'] ?? ''))
    return send(res, 415, { error: 'Send JSON.' })
  // Then the person: everything except the app's own files and the sign-in endpoints needs a session.
  const secure = !pass.local
  // The visitor's address and country: Cloudflare's headers count only through the tunnel.
  const who = clientOf(req.headers, req.socket.remoteAddress, !!pass.tunnel)
  const ip = who.ip
  const country = who.country
  const client = { ua: String(req.headers['user-agent'] ?? '').slice(0, 300), ip, country }
  const signed = readSession(db, readCookie(req.headers.cookie, cookieName(secure)), client)
  const user = signed?.user ?? null
  let session = signed?.session ?? null
  const cookies: string[] = []
  // A change of role gives the session a new id on its next request.
  if (session?.rotate) {
    const next = rotateSession(db, session)
    session = getSession(db, next.id) ?? null
    if (session) cookies.push(sessionCookie(next.token, secure, cookieAge(session)))
  }
  if (cookies.length) res.setHeader('set-cookie', cookies)
  const needsUser = url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')
  if (
    needsUser &&
    !user &&
    !url.pathname.startsWith('/api/auth/') &&
    url.pathname !== '/api/health'
  )
    return send(res, 401, { error: 'Sign in first.', signin: true })
  // Live updates: open dashboards keep one event stream and refetch when told something changed.
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write('retry: 3000\n\n')
    const off = onChange((event) => res.write(`data: ${event}\n\n`))
    const ping = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      off()
      clearInterval(ping)
    })
    return
  }
  if (!url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/media/')) return serveMedia(res, url.pathname)
    return serveStatic(res, url.pathname)
  }
  try {
    for (const r of [...authRoutes, ...routes]) {
      if (r.method !== req.method) continue
      const m = r.path.exec(url.pathname)
      if (!m) continue
      const ctx = {
        db,
        params: m.groups ?? {},
        query: url.searchParams,
        body: req.method === 'GET' ? {} : await body(req),
        local: pass.local,
        user,
        cookies,
        secure,
        ip,
        country,
        ua: client.ua,
        session,
        client,
        origin: origin ?? `${secure ? 'https' : 'http'}://${req.headers.host ?? HOST}`,
      }
      guard(r, ctx)
      const data = await r.handle(ctx)
      if (ctx.cookies.length) res.setHeader('set-cookie', ctx.cookies)
      if (req.method !== 'GET' && !url.pathname.startsWith('/api/auth/')) changed()
      if (data && typeof data === 'object' && '__redirect' in data) {
        res.writeHead(302, { location: (data as { __redirect: string }).__redirect })
        return res.end()
      }
      if (data && typeof data === 'object' && '__download' in data) {
        const d = data as { __download: string; data: unknown; type?: string }
        res.writeHead(200, {
          'content-type': d.type ?? 'application/json',
          'content-disposition': `attachment; filename="${d.__download}"`,
        })
        return res.end(
          typeof d.data === 'string' || d.data instanceof Uint8Array
            ? d.data
            : JSON.stringify(d.data),
        )
      }
      return send(res, 200, data ?? { ok: true })
    }
    send(res, 404, { error: 'No such endpoint.' })
  } catch (e) {
    // Claude at its usage limit: the message stays a template the dashboard translates, with the
    // time it can be tried again beside it, shown in the reader's own clock.
    if (e instanceof AiLimitError)
      return send(res, 503, { error: LIMIT_TEXT[e.kind], until: e.until.toISOString() })
    const status = e instanceof HttpError ? e.status : 400
    const extra = e instanceof HttpError ? e.extra : undefined
    send(res, status, { ...extra, error: e instanceof Error ? e.message : String(e) })
  }
})

function serveMedia(res: ServerResponse, path: string) {
  const root = join(DATA_DIR, 'media')
  const file = normalize(join(root, decodeURIComponent(path.slice('/media/'.length))))
  if (!file.startsWith(root) || !existsSync(file)) return send(res, 404, { error: 'No such file.' })
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'max-age=86400',
  })
  res.end(readFileSync(file))
}

server.listen(PORT, HOST, () => console.log(`SocialMonitor: http://${HOST}:${PORT}`))
