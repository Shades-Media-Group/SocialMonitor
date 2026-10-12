/**
 * Screenshots of the dashboard filled with the Tavelo demo (scripts/demo-data.ts), for the
 * website. Runs the real server on data/demo with the UI from Vite, signs in as the demo
 * account with a session minted by the app's own auth code, and captures each view in light
 * and dark at 1440 × 900 (2×), plus phone shots at 390 × 844.
 *
 * Ports 4410 (API) and 4411 (UI), so a dashboard already running on 4400 is left alone.
 * Nothing reaches the networks: the demo has no browser session, and the script refuses to run
 * when a schedule is due within the next 20 minutes.
 *
 * Usage: node scripts/demo-data.ts && node scripts/demo-shots.ts
 * Output: data/demo/shots/*.png
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext as Context, Page } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(root, 'data', 'demo')
process.env.SOCIALMONITOR_DATA = DEMO
const API = 4410
const UI = 4411
const ORIGIN = `http://127.0.0.1:${UI}`
const OUT = join(DEMO, 'shots')
const ONLY = process.argv.slice(2)

if (!existsSync(join(DEMO, 'socialmonitor.db')))
  throw new Error('No demo data: run node scripts/demo-data.ts first.')

const { openDb } = await import('../apps/app/src/core/db.ts')
const { signSession, getUser } = await import('../apps/app/src/core/auth.ts')
const { listSchedules, listBrands } = await import('../apps/app/src/core/store.ts')
const db = openDb()

const soon = listSchedules(db).find(
  (s) => s.enabled && s.next_run_at && Date.parse(s.next_run_at) - Date.now() < 20 * 60_000,
)
if (soon)
  throw new Error(
    `A schedule is due at ${soon.next_run_at}; the server would start an update. Try after it.`,
  )
const brandId = listBrands(db)[0]!.id
const token = signSession(getUser(db, 1)!)

// The server, on the demo data only.
const server = spawn(process.execPath, [join(root, 'apps/app/src/server/main.ts')], {
  env: {
    ...process.env,
    SOCIALMONITOR_DATA: DEMO,
    SOCIALMONITOR_API_PORT: String(API),
    SOCIALMONITOR_UI: ORIGIN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d: Buffer) => {
  const s = d.toString()
  if (!s.includes('ExperimentalWarning') && !s.includes('--trace-warnings')) process.stderr.write(s)
})
await new Promise<void>((ok, fail) => {
  server.stdout.on('data', (d: Buffer) => {
    process.stdout.write(`server: ${d}`)
    if (d.toString().includes('SocialMonitor:')) ok()
  })
  server.on('exit', (c) => fail(new Error(`The server stopped (${c}).`)))
})

// The dashboard's own UI, from source, with /api and /media passed to the demo server.
const { createServer } = await import('vite')
const { default: preact } = await import('@preact/preset-vite')
const vite = await createServer({
  configFile: false,
  root: join(root, 'apps/app/src/web'),
  cacheDir: join(root, 'node_modules/.vite-demo'),
  plugins: [preact()],
  logLevel: 'warn',
  server: {
    host: '127.0.0.1',
    port: UI,
    strictPort: true,
    proxy: { '/api/': `http://127.0.0.1:${API}`, '/media/': `http://127.0.0.1:${API}` },
  },
})
await vite.listen()

const { chromium } = await import('@playwright/test')
const browser = await chromium.launch()

async function context(theme: 'light' | 'dark', phone = false) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: phone ? 3 : 2,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
    locale: 'en-GB',
  })
  await ctx.addCookies([
    { name: 'sm_session', value: token, url: ORIGIN, httpOnly: true, sameSite: 'Strict' },
  ])
  return ctx
}

/** View choices go through the app's own prefs, kept with the account. */
async function prefs(ctx: Context, p: Record<string, unknown>) {
  const r = await ctx.request.patch(`${ORIGIN}/api/auth/me`, {
    data: { prefs: p },
    headers: { 'content-type': 'application/json' },
  })
  if (!r.ok()) throw new Error(`prefs: ${r.status()} ${await r.text()}`)
}

async function settle(page: Page) {
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready)
  await page
    .waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 8000 })
    .catch(() => {})
  await page.waitForTimeout(1200)
  // Park the pointer where it hovers nothing.
  const vp = page.viewportSize()!
  await page.mouse.move(vp.width - 2, vp.height - 2)
  await page.waitForTimeout(150)
}

async function shot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide' })
  console.log(`shot ${name}.png`)
}

/** Saved reports for the Reports tab, made by the app itself once, then dated to look lived-in. */
async function savedReports(ctx: Context) {
  const n = (db.prepare('SELECT count(*) AS n FROM saved_reports').get() as { n: number }).n
  if (n) return
  const made: [string, number][] = [
    [`/api/brands/${brandId}/report.pdf?days=30`, 1.2],
    [`/api/brands/${brandId}/bad.pdf?days=7`, 3.4],
    [`/api/brands/${brandId}/export.xlsx?days=30`, 6.1],
    [`/api/comments.csv?brand=${brandId}&reply=1`, 9.3],
  ]
  for (const [path] of made) {
    const r = await ctx.request.get(`${ORIGIN}${path}`, { timeout: 60000 })
    if (!r.ok()) throw new Error(`${path}: ${r.status()} ${await r.text()}`)
  }
  const rows = db.prepare('SELECT id, filename FROM saved_reports ORDER BY id').all() as {
    id: number
    filename: string
  }[]
  rows.forEach((r, i) => {
    const at = new Date(Date.now() - made[i]![1] * 86400_000).toISOString()
    db.prepare('UPDATE saved_reports SET created_at = ?, filename = ? WHERE id = ?').run(
      at,
      r.filename.replace(/\d{4}-\d{2}-\d{2}/, at.slice(0, 10)),
      r.id,
    )
  })
}

interface Shot {
  name: string
  hash: string
  prefs?: Record<string, unknown>
  then?: (page: Page) => Promise<void>
  phone?: boolean
}

const SHOTS: Shot[] = [
  { name: 'home', hash: '#/', prefs: { 'home.tab': 'brands' } },
  { name: 'overview', hash: `#/b/${brandId}/overview` },
  { name: 'comments', hash: `#/b/${brandId}/comments`, prefs: { 'comments.filter': 'reply' } },
  { name: 'posts', hash: `#/b/${brandId}/posts`, prefs: { 'posts.look.v2': 'table' } },
  { name: 'reports', hash: `#/b/${brandId}/reports` },
  {
    name: 'posts-grid',
    hash: `#/b/${brandId}/posts`,
    prefs: { 'posts.look.v2': 'grid' },
    // The pictures, not the tables above them.
    then: async (page) => {
      await page
        .locator('.sm-main img')
        .first()
        .evaluate((el) =>
          el.closest('a, button, article, li, figure')?.scrollIntoView({ block: 'start' }),
        )
      await page.waitForTimeout(400)
    },
  },
  {
    name: 'calendar',
    hash: `#/b/${brandId}/calendar`,
    // From the first of last month to today, so no empty month leads the view.
    then: async (page) => {
      const day = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const now = new Date()
      const dates = page.locator('input[type="date"]')
      await dates.nth(0).fill(day(new Date(now.getFullYear(), now.getMonth() - 1, 1)))
      await dates.nth(1).fill(day(now))
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await settle(page)
    },
  },
  { name: 'schedules', hash: `#/b/${brandId}/schedules` },
  {
    name: 'update',
    hash: `#/b/${brandId}/overview`,
    then: async (page) => {
      await page.getByRole('button', { name: 'Update', exact: true }).first().click()
      await page.waitForSelector('dialog[open]')
      await page.waitForTimeout(600)
    },
  },
  { name: 'overview-phone', hash: `#/b/${brandId}/overview`, phone: true },
  {
    name: 'comments-phone',
    hash: `#/b/${brandId}/comments`,
    prefs: { 'comments.filter': 'reply' },
    phone: true,
  },
]

try {
  for (const theme of ['light', 'dark'] as const) {
    for (const s of SHOTS) {
      if (ONLY.length && !ONLY.some((o) => s.name.startsWith(o))) continue
      const ctx = await context(theme, s.phone)
      await savedReports(ctx)
      await prefs(ctx, { theme, ...s.prefs })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.error(`page error (${s.name}): ${e.message}`))
      page.on(
        'console',
        (m) => m.type() === 'error' && console.error(`console (${s.name}): ${m.text()}`),
      )
      await page.goto(`${ORIGIN}/${s.hash}`)
      await settle(page)
      await s.then?.(page)
      await shot(page, `${s.name}-${theme}`)
      await ctx.close()
    }
  }
} finally {
  await browser.close()
  await vite.close()
  server.kill()
  db.close()
}
