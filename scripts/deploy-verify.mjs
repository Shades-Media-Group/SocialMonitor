// Checks production from the outside: `yarn deploy:verify`, from the Mac. Exits non-zero when any
// check fails.
//
//   - the dashboard (socialmonitor-app.shades.md) is behind Cloudflare Access: a request without
//     an Access session gets Access's sign-in, never the app
//   - the website (socialmonitor.shades.md) is up and sends HSTS
//   - with an Access service token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (the
//     environment or .env), /api/health answers ok and runs the commit at the tip of origin/main
//
// The service token: see "Production" in docs/server.md. SOCIALMONITOR_APP_URL and
// SOCIALMONITOR_SITE_URL move the checks elsewhere.
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

/** Access's answer to a visitor without a session: a redirect to the team's sign-in page, or its
 * own 403 page. The dashboard's own refusal is JSON, and means Access is not in front. */
async function behindAccess(url) {
  const r = await get(url)
  const location = r.headers.get('location') ?? ''
  if (r.status >= 300 && r.status < 400) {
    expect(
      /\.cloudflareaccess\.com\//.test(location) || location.includes('/cdn-cgi/access/login'),
      `redirects to ${location || 'nowhere'}, not to Cloudflare Access`,
    )
    return `${r.status} to Access sign-in`
  }
  const type = r.headers.get('content-type') ?? ''
  expect(
    r.status === 401 || r.status === 403,
    `status ${r.status}: the app answered without Access`,
  )
  expect(
    !type.includes('application/json'),
    `status ${r.status} from the app itself, not from Access`,
  )
  return `${r.status} from Access`
}

await check('dashboard: Cloudflare Access is in front', () => behindAccess(`${APP}/`))
await check('dashboard API: Cloudflare Access is in front', () => behindAccess(`${APP}/api/health`))

await check('website: up, with HSTS', async () => {
  const r = await get(`${SITE}/`)
  expect(r.status === 200, `status ${r.status}`)
  const hsts = r.headers.get('strict-transport-security') ?? ''
  expect(/max-age=[1-9]/.test(hsts), 'no Strict-Transport-Security header')
  return hsts
})

const id = process.env.CF_ACCESS_CLIENT_ID
const secret = process.env.CF_ACCESS_CLIENT_SECRET
if (!id || !secret) {
  console.log(
    'SKIP  dashboard health and commit: set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET',
  )
} else {
  await check('dashboard: healthy, on the tip of main', async () => {
    const r = await get(`${APP}/api/health`, {
      'CF-Access-Client-Id': id,
      'CF-Access-Client-Secret': secret,
    })
    const body = await r.json().catch(() => null)
    expect(r.status === 200 && body?.ok === true, `status ${r.status}: ${JSON.stringify(body)}`)
    expect(body.db === 'ok', `database: ${body.db}`)
    expect(r.headers.get('strict-transport-security'), 'no Strict-Transport-Security header')
    const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()
    try {
      git('fetch', '--quiet', 'origin', 'main')
    } catch {
      /* offline: compare with what is known */
    }
    const main = git('rev-parse', 'origin/main')
    expect(
      body.commit && main.startsWith(body.commit),
      `it runs ${body.commit}, main is ${main.slice(0, 7)}: the PC takes about a minute plus the build; if it stays behind, ask Server Remote for ~/.local/state/socialmonitor/status.json`,
    )
    return `version ${body.version}, commit ${body.commit}`
  })
}

if (failed) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
