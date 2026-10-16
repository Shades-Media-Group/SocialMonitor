// Checks production from the outside: `yarn deploy:verify`, from the Mac. Exits non-zero when any
// check fails.
//
//   - the dashboard (socialmonitor-app.shades.md) serves its sign-in page with HSTS, and its API
//     refuses anyone who is not signed in
//   - the website (socialmonitor.shades.md) is up and sends HSTS
//   - /api/health answers ok and runs the commit at the tip of origin/main
//
// If Cloudflare Access is ever put in front, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (a
// service token) let the checks through it. SOCIALMONITOR_APP_URL and SOCIALMONITOR_SITE_URL move
// the checks elsewhere.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
try {
  process.loadEnvFile(join(ROOT, '.env'))
} catch {
  /* no .env */
}
const APP = (process.env.SOCIALMONITOR_APP_URL ?? 'https://socialmonitor-app.shades.md').replace(
  /\/$/,
  '',
)
const SITE = (process.env.SOCIALMONITOR_SITE_URL ?? 'https://socialmonitor.shades.md').replace(
  /\/$/,
  '',
)

let failed = 0
async function check(name, run) {
  try {
    const detail = await run()
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    failed += 1
    // fetch hides the reason (no DNS record, refused, timeout) in its cause.
    const cause = e?.cause?.code ?? e?.cause?.message
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : e}${cause ? ` (${cause})` : ''}`)
  }
}
function expect(ok, message) {
  if (!ok) throw new Error(message)
}
const get = (url, headers = {}) =>
  fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(15_000) })

const id = process.env.CF_ACCESS_CLIENT_ID
const secret = process.env.CF_ACCESS_CLIENT_SECRET
const through = id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : {}

await check('dashboard: sign-in page, with HSTS', async () => {
  const r = await get(`${APP}/`, through)
  expect(r.status === 200, `status ${r.status}`)
  expect((r.headers.get('content-type') ?? '').includes('text/html'), 'not a page')
  expect(r.headers.get('content-security-policy'), 'no Content-Security-Policy header')
  const hsts = r.headers.get('strict-transport-security') ?? ''
  expect(/max-age=[1-9]/.test(hsts), 'no Strict-Transport-Security header')
  return hsts
})

await check('dashboard API: refuses without a session', async () => {
  const r = await get(`${APP}/api/settings`, through)
  const body = await r.json().catch(() => null)
  expect(r.status === 401 && body?.signin === true, `status ${r.status}: ${JSON.stringify(body)}`)
  return '401, sign in first'
})

await check('website: up, with HSTS', async () => {
  const r = await get(`${SITE}/`)
  expect(r.status === 200, `status ${r.status}`)
  const hsts = r.headers.get('strict-transport-security') ?? ''
  expect(/max-age=[1-9]/.test(hsts), 'no Strict-Transport-Security header')
  return hsts
})

await check('dashboard: healthy, on the tip of main', async () => {
  const r = await get(`${APP}/api/health`, through)
  const body = await r.json().catch(() => null)
  expect(r.status === 200 && body?.ok === true, `status ${r.status}: ${JSON.stringify(body)}`)
  expect(body.db === 'ok', `database: ${body.db}`)
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()
  try {
    git('fetch', '--quiet', 'origin', 'main')
  } catch {
    /* offline: compare with what is known */
  }
  const main = git('rev-parse', 'origin/main')
  expect(
    body.commit && main.startsWith(body.commit),
    `it runs ${body.commit}, main is ${main.slice(0, 7)}: the PC takes about a minute plus the build; if it stays behind, ask SocialMonitor [Server] for ~/.local/state/socialmonitor/status.json`,
  )
  return `version ${body.version}, commit ${body.commit}`
})

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
