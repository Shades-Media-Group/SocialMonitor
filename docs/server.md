# Running on a server

SocialMonitor can run on an always-on computer, such as a small home server, and be reached from anywhere through [remote access](remote-access.md). It runs the same way as on a laptop; only a few things belong to each machine.

## What moves, and what does not

| Moves with a copy of `data/`                                               | Set up again on the server                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Brands, posts, comments, ratings, reports, schedules                       | Saved accounts: their key stays in the old computer's keychain, so enter them again |
| Local templates (`data/templates.json`) and seed (`data/brands.seed.json`) | Network sign-ins: sign in once in SocialMonitor's own browser on the server         |
|                                                                            | The AI: sign in to Claude Code on the server, or set `ANTHROPIC_API_KEY` in `.env`  |

Copy `data/` without `data/browser/`; the browser profile belongs to the old machine. Or use **Settings → Export everything** on the old computer and **Import** on the server.

## Install

You need Node 22.18 or newer, Yarn 1 and Git. Google Chrome is optional; without it, install Playwright's Chromium.

```bash
git clone https://github.com/Shades-Media-Group/SocialMonitor.git
cd SocialMonitor
yarn install
npx playwright install chromium
yarn start
```

## Keep it running

Run `yarn start` under the server's own process manager, so it starts with the machine and restarts if it stops:

- **Linux:** a systemd service with `WorkingDirectory` set to the repository and `ExecStart` running `yarn start`.
- **macOS:** a launchd agent, or `pm2 start "yarn start" --name socialmonitor`.
- **Windows:** in PowerShell opened as administrator, from the repository, run `powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1`. It adds a startup task that runs before anyone signs in, restarts SocialMonitor within a minute if it stops, and logs to `data\service.log`. Add `-Remove` to take it out.

## Keep Claude signed in

The sign-in Claude Code keeps after `/login` expires, and an unattended server cannot log in again. Give it a token made for this instead, valid for a year:

```bash
claude setup-token      # once, on the server; it opens the browser to approve
```

Put the token it prints in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=…` and restart SocialMonitor. On Windows, install the native Claude Code (`irm https://claude.ai/install.ps1 | iex`), not the npm one. If sorting stops anyway, the brand's Settings tab shows the last problem, and the comments it could not sort are sorted on the next update.

## Protect the saved accounts

The encryption key for saved accounts lives in the operating system's secret store, never next to the database:

- **macOS:** the Keychain.
- **Windows:** protected with DPAPI for the Windows user, in `%LOCALAPPDATA%\SocialMonitor\vault.key.dpapi`. Only that user on that PC can unlock it.
- **Any server:** `SOCIALMONITOR_VAULT_KEY` in the service's environment wins over both.

A `data/vault.key` from an older version is moved into the secret store the first time it is read, then deleted, so accounts you saved stay readable. Where no secret store works (Linux, or a Windows startup task that runs before anyone signs in and can't use DPAPI), SocialMonitor falls back to `data/vault.key` and says so loudly, in its log and in Settings. Give the server its own key instead:

```bash
openssl rand -hex 32    # once; store the result in the server's secret store
```

Set it as `SOCIALMONITOR_VAULT_KEY` in the service's environment (a systemd credential, a Windows service variable), not in `.env` inside the repository. If you switch to it on a computer that already saved accounts, enter them again. Use full-disk encryption on the server too: it holds every account you save.

## Sign-in email and sessions

Set the `SMTP_*` keys and `SOCIALMONITOR_JWT_SECRET` as in [people and sign-in](people.md), in the service's environment rather than in `.env`. Then open the dashboard at the server's own screen once to create the first account, or set the `SOCIALMONITOR_ADMIN_*` keys from [the first account](people.md#the-first-account) so the first start creates it. After that start, remove `SOCIALMONITOR_ADMIN_PASSWORD` from the environment: the account exists and its password is kept hashed in the database.

## Sign in to the networks

"Sign in to networks" opens a browser window on the server itself, so do it once at the server's screen or over remote desktop. Through the tunnel the button is refused on purpose.

## The tunnel, next to other apps

If the server already runs a Cloudflare Tunnel for other apps, add SocialMonitor to it instead of starting a second one:

```bash
cloudflared tunnel list                      # find the existing tunnel's name
yarn tunnel setup socialmonitor-app.example.com that-tunnel-name
```

The script routes the hostname to that tunnel and prints the rule to add to its config. Then protect the hostname with Cloudflare Access, as in [remote access](remote-access.md).
