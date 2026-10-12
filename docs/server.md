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
- **Windows:** `pm2` with `pm2-windows-startup`, or a Task Scheduler task at startup.

## Sign in to the networks

"Sign in to networks" opens a browser window on the server itself, so do it once at the server's screen or over remote desktop. Through the tunnel the button is refused on purpose.

## The tunnel, next to other apps

If the server already runs a Cloudflare Tunnel for other apps, add SocialMonitor to it instead of starting a second one:

```bash
cloudflared tunnel list                      # find the existing tunnel's name
yarn tunnel setup socialmonitor-app.example.com that-tunnel-name
```

The script routes the hostname to that tunnel and prints the rule to add to its config. Then protect the hostname with Cloudflare Access, as in [remote access](remote-access.md).
