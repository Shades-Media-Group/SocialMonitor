// Remote access through a Cloudflare Tunnel, protected by Cloudflare Access.
//
//   yarn tunnel setup <hostname>   once: creates the tunnel and its DNS record (needs `cloudflared tunnel login` first)
//   yarn tunnel                    runs it; the dashboard must be running with `yarn start` on port 4400
//
// The tunnel's files live in data/tunnel (git-ignored). The dashboard itself refuses every request
// that does not carry a valid Cloudflare Access token, so set up the Access application before
// sharing the address: see docs/remote-access.md.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dir = join(root, 'data', 'tunnel')
const config = join(dir, 'config.yml')
const NAME = 'socialmonitor'
const cf = (...args) =>
  execFileSync('cloudflared', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function setEnv(key, value) {
  const file = join(root, '.env')
  const lines = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !l.startsWith(`${key}=`))
    : []
  writeFileSync(file, [...lines.filter(Boolean), `${key}=${value}`, ''].join('\n'), { mode: 0o600 })
}

const [cmd, host] = process.argv.slice(2)

if (cmd === 'setup') {
  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host))
    throw new Error('Usage: yarn tunnel setup <hostname>, e.g. socialmonitor-app.example.com')
  if (!existsSync(join(homedir(), '.cloudflared', 'cert.pem')))
    throw new Error(
      'Run `cloudflared tunnel login` first and choose the domain in the browser window it opens.',
    )
  mkdirSync(dir, { recursive: true })
  const list = JSON.parse(cf('tunnel', 'list', '--output', 'json'))
  let tunnel = list.find((t) => t.name === NAME)
  if (!tunnel) {
    cf('tunnel', 'create', '--credentials-file', join(dir, 'credentials.json'), NAME)
    tunnel = JSON.parse(cf('tunnel', 'list', '--output', 'json')).find((t) => t.name === NAME)
  }
  cf('tunnel', 'route', 'dns', '--overwrite-dns', NAME, host)
  writeFileSync(
    config,
    [
      `tunnel: ${tunnel.id}`,
      `credentials-file: ${join(dir, 'credentials.json')}`,
      'ingress:',
      `  - hostname: ${host}`,
      '    service: http://127.0.0.1:4400',
      '  - service: http_status:404',
      '',
    ].join('\n'),
  )
  setEnv('SOCIALMONITOR_PUBLIC_HOST', host)
  console.log(`Tunnel ${NAME} routes https://${host} to this computer's port 4400.`)
  console.log(
    'Next: create the Cloudflare Access application for it (docs/remote-access.md), then `yarn tunnel`.',
  )
} else {
  if (!existsSync(config))
    throw new Error('No tunnel yet: run `yarn tunnel setup <hostname>` first.')
  spawn('cloudflared', ['tunnel', '--config', config, 'run'], { stdio: 'inherit' }).on(
    'exit',
    (code) => process.exit(code ?? 0),
  )
}
