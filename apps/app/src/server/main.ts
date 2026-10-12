import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, openDb } from '../core/db.ts'
import { HttpError, routes } from './routes.ts'
import { authRoutes } from './auth-routes.ts'
import { SESSION_COOKIE, readCookie, readSession } from '../core/auth.ts'
import { seedFromFile } from './seed.ts'
import { isLocal, publicHost, refuseRemote } from './access.ts'
import { closeStaleRuns } from '../core/store.ts'
import { startScheduler } from '../core/schedule.ts'
import { changed, onChange } from '../core/events.ts'

// Keys and options live in .env at the repository root, never in the code.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)))
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
seedFromFile(db)
closeStaleRuns(db)
startScheduler(db)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
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
  res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
  res.end(readFileSync(target))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  // Only the dashboard itself may drive the API from a browser: its own origin, the dev UI and the
  // tunnel. Other local ports count as the same site to cookies, so they are refused by name.
  const origin = req.headers.origin
  if (origin && !ORIGINS.has(origin)) return send(res, 403, { error: 'Forbidden origin.' })
  // A form or text/plain POST skips the browser's CORS check; JSON can't be sent cross-site without it.
  if (req.method === 'POST' && !/^application\/json\b/.test(req.headers['content-type'] ?? ''))
    return send(res, 415, { error: 'Send JSON.' })
  // Through a tunnel, only requests Cloudflare Access let in get anything at all.
  const refusal = await refuseRemote(req)
  if (refusal) return send(res, 403, { error: refusal })
  // Then the person: everything except the app's own files and the sign-in endpoints needs a session.
  const user = readSession(db, readCookie(req.headers.cookie, SESSION_COOKIE))
  const needsUser = url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')
  if (needsUser && !user && !url.pathname.startsWith('/api/auth/'))
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
        local: isLocal(req),
        user,
        cookies: [] as string[],
        secure: !isLocal(req),
        ip: String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? ''),
      }
      if (r.need !== 'public') {
        if (!user) throw new HttpError(401, 'Sign in first.')
        if (r.need === 'super' && !user.super)
          throw new HttpError(403, 'Only super admins can do that.')
        if (typeof r.need === 'function') r.need({ ...ctx, user })
      }
      const data = await r.handle(ctx)
      if (ctx.cookies.length) res.setHeader('set-cookie', ctx.cookies)
      if (req.method !== 'GET' && !url.pathname.startsWith('/api/auth/')) changed()
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
    const status = e instanceof HttpError ? e.status : 400
    send(res, status, { error: e instanceof Error ? e.message : String(e) })
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
