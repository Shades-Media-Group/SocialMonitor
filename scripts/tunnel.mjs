// Remote access through a Cloudflare Tunnel, protected by Cloudflare Access.
//
//   yarn tunnel setup <hostname>   once: creates SocialMonitor's own tunnel and its DNS record.
//                                  Needs `cloudflared tunnel login` first.
//   yarn tunnel                    runs it; the dashboard must be running with `yarn start` on port 4400
//
// One tunnel per app: SocialMonitor never joins a tunnel another app runs, so revoking one leaves the
// others up. Its only route is <hostname> -> http://127.0.0.1:4400, then 404 for everything else; the
// config is rewritten that way on every run. The tunnel's files live in data/tunnel (git-ignored), and
// its credentials file must stay readable by this user only (0600). Through the tunnel, SocialMonitor's
// own sign-in is the login; Cloudflare Access in front is optional: see docs/remote-access.md.
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const NAME = 'socialmonitor'
const dir = join(root, 'data', 'tunnel')
const config = join(dir, 'config.yml')
const credentials = join(dir, 'credentials.json')
const cf = (...args) =>
  execFileSync('cloudflared', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const ACCESS_NOTE =
  'Anyone who knows the address reaches the sign-in page: give every account a strong password and turn on two-step sign-in. See docs/remote-access.md.'

function setEnv(key, value) {
  const file = join(root, '.env')
  const lines = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !l.startsWith(`${key}=`))
    : []
  writeFileSync(file, [...lines.filter(Boolean), `${key}=${value}`, ''].join('\n'), { mode: 0o600 })
}

/** Anyone who can read the credentials file can run a connector for this tunnel and receive its
 * traffic, so it must be private to this user. Windows has no mode bits; there it relies on the
 * profile folder's permissions. */
function checkCredentials() {
  if (!existsSync(credentials))
    throw new Error(
      `No tunnel credentials at ${credentials}: run \`yarn tunnel setup <hostname>\`.`,
    )
  if (process.platform === 'win32') return
  const mode = statSync(credentials).mode & 0o777
  if (mode & 0o077)
    throw new Error(
      `${credentials} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 "${credentials}"`,
    )
}

/** Exactly one route, then 404: never SSH, RDP, a database or anything else on this computer. */
function writeConfig(host) {
  const { TunnelID } = JSON.parse(readFileSync(credentials, 'utf8'))
  writeFileSync(
    config,
    [
      `tunnel: ${TunnelID}`,
      `credentials-file: ${credentials}`,
      'ingress:',
      `  - hostname: ${host}`,
      '    service: http://127.0.0.1:4400',
      '  - service: http_status:404',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
}

const [cmd, host, extra] = process.argv.slice(2)

if (cmd === 'setup') {
  if (extra)
    throw new Error(
      "SocialMonitor runs its own tunnel and never joins another app's. Usage: yarn tunnel setup <hostname>",
    )
  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host))
    throw new Error('Usage: yarn tunnel setup <hostname>, e.g. socialmonitor-app.example.com')
  if (!existsSync(join(homedir(), '.cloudflared', 'cert.pem')))
    throw new Error(
      'Run `cloudflared tunnel login` first and choose the domain in the browser window it opens.',
    )
  mkdirSync(dir, { recursive: true })
  const exists = JSON.parse(cf('tunnel', 'list', '--output', 'json')).some((t) => t.name === NAME)
  if (!exists) {
    cf('tunnel', 'create', '--credentials-file', credentials, NAME)
    chmodSync(credentials, 0o600)
  } else if (!existsSync(credentials))
    throw new Error(
      `A tunnel named "${NAME}" exists in your Cloudflare account, but its credentials are not in ${dir}. Copy data/tunnel/credentials.json from the computer that created it, or delete the tunnel with \`cloudflared tunnel delete ${NAME}\` and run setup again.`,
    )
  checkCredentials()
  cf('tunnel', 'route', 'dns', '--overwrite-dns', NAME, host)
  writeConfig(host)
  setEnv('SOCIALMONITOR_PUBLIC_HOST', host)
  console.log(
    `Tunnel ${NAME} routes https://${host} to this computer's port 4400, and nothing else.`,
  )
  console.log(ACCESS_NOTE)
  console.log('Then run `yarn tunnel`.')
} else if (cmd) {
  throw new Error('Usage: yarn tunnel setup <hostname>, then yarn tunnel')
} else {
  try {
    process.loadEnvFile(join(root, '.env'))
  } catch {
    /* no .env */
  }
  const publicHost = process.env.SOCIALMONITOR_PUBLIC_HOST
  if (!publicHost) throw new Error('No tunnel yet: run `yarn tunnel setup <hostname>` first.')
  checkCredentials()
  writeConfig(publicHost)
  spawn('cloudflared', ['tunnel', '--config', config, 'run'], { stdio: 'inherit' }).on(
    'exit',
    (code) => process.exit(code ?? 0),
  )
}
