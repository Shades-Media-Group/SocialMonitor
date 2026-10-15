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
- **Windows without WSL:** in PowerShell opened as administrator, from the repository, run `powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1`. It adds a startup task that runs before anyone signs in, restarts SocialMonitor within a minute if it stops, and logs to `data\service.log`. Add `-Remove` to take it out. It runs the checkout as it is and never updates it; with WSL, use [production](#production) instead.

## Production

Shades' own copy runs on the always-on Windows PC, inside WSL Ubuntu, at `~/shades/SocialMonitor`. It is reached at `app.socialmonitor.shades.md` through its own Cloudflare Tunnel, with Cloudflare Access in front. Development happens on the Mac. Code reaches the PC only through `main` on GitHub: the PC pulls by itself, and nobody copies files to it or edits it by hand.

### From the Mac to the PC

1. Commit on the Mac. Every commit is signed with the Mac's SSH key, `~/.ssh/git_signing`.
2. Push to `main`. Merge pull requests on the command line, not with GitHub's button, so the merge commit carries your signature too.
3. Within a minute the PC sees the new commit. It builds it, backs up the database, switches, and checks that it is healthy. If it isn't, the PC rolls back by itself.
4. From the Mac, run `yarn deploy:verify`. It passes once the PC runs the tip of `main`; allow a minute for the poll plus the build.

### Signatures

The PC deploys a commit only when every commit between the live one and the new tip is signed by a key in `~/.config/socialmonitor/allowed_signers`. That includes merge commits and every commit on a merged branch. The file holds the Mac's key, and the PC's own key if you added it at setup. It lives outside the repository, so a push can't add a key of its own. Change it on the PC itself, by hand, and only for a key you made. `SOCIALMONITOR_ALLOWED_SIGNERS` moves it.

The PC refuses anything else and leaves the live release running:

- an unsigned commit
- a commit signed by a key it doesn't know
- a branch that isn't a fast-forward of the live commit, such as a force-push

`status.json` then says `refused` and why. A newer push that fixes it goes live as usual. To fix an unsigned commit, sign it again (`git rebase --exec 'git commit --amend --no-edit -S' <live>`) and push.

The history the PC first cloned is the trusted baseline: setup made that commit the first release without checking signatures, because it predates signing.

### What the updater does

`scripts/production.mjs` is one Node process, run by the systemd unit `socialmonitor`. It runs the dashboard as a child process, on `127.0.0.1:4400`, and starts it again with growing pauses if it stops. Every 60 seconds it runs `git fetch origin main`. When the tip is new and passes the signature checks, it goes through these steps:

1. **Build.** It checks the commit out with `git worktree` into `~/.local/share/socialmonitor/releases/<sha>`, then runs `yarn install --frozen-lockfile`, the dashboard's build and Playwright's Chromium install there. The live app isn't touched. A build that fails twice changes nothing.
2. **Back up.** It makes a consistent copy of the database to `data/backups/pre-<sha>-<time>.db` and keeps the last 20. When restic is set up, it also runs `scripts/backup.mjs`.
3. **Switch.** It stops the app, points `~/.local/share/socialmonitor/current` at the new release, and starts it. Every release reads the repository's own `data/` and `.env`.
4. **Check its health.** It waits up to 120 seconds for `/api/health` to report the new commit.
5. **Roll back when unhealthy.** It goes back to the previous release. If the new release changed the database's schema, it first restores the copy from step 2; that loses only what the failed release wrote in the minutes it was up. The commit is then left alone until a newer one comes.

After a healthy release, the checkout at `~/shades/SocialMonitor` fast-forwards to the live commit, so its scripts (the updater, backups, the tunnel) match. When the updater's own file changed, it restarts itself through systemd.

The updater never runs anything from a fetched commit before the signatures check out. It never merges, and it runs git with the repository's hooks turned off.

### Status, logs and going back

| What                                                                                                | Where                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| The last result (`ok`, `building`, `refused`, `failed`, `rolled-back`), the live commit and version | `~/.local/state/socialmonitor/status.json` |
| The updater's log                                                                                   | `~/.local/state/socialmonitor/updater.log` |
| The last build's output                                                                             | `~/.local/state/socialmonitor/build.log`   |
| The app's own output                                                                                | `journalctl -u socialmonitor -f`           |
| Backups before each release                                                                         | `data/backups/`                            |

To go back to an earlier commit by hand, run `node scripts/production.mjs --release <sha>` on the PC. Any commit already in the live history works. The updater then leaves the tip of `main` alone until a newer commit comes. The same command releases a newer signed commit at once, without waiting for the poll.

### Ask the server

From a Mac chat, send the **Server Remote** chat a message for anything on the PC: the status, the logs, a backup, a restore or a setup step. For example: "SocialMonitor: send status.json and the last 30 lines of updater.log". That chat acts on the PC and tells Cristian. Secrets stay on the PC; they never go into a chat.

### Set the PC up, once

In WSL Ubuntu, with the Server Remote chat:

1. Turn on systemd: run `printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf`, then `wsl --shutdown` in Windows PowerShell, then open Ubuntu again.
2. Install Node 22 with nvm (`nvm install 22 && nvm alias default 22`), then `npm install -g yarn`, then `sudo apt install git restic`. Install Claude Code too (`curl -fsSL https://claude.ai/install.sh | bash`), and get its token with `claude setup-token`.
3. Clone the repository and run the setup. It asks for each setting; secrets are typed hidden, and it is safe to run again:

   ```bash
   git clone https://github.com/Shades-Media-Group/SocialMonitor.git ~/shades/SocialMonitor
   bash ~/shades/SocialMonitor/scripts/production-setup.sh
   ```

4. Set up the tunnel as in [remote access](remote-access.md) (`cloudflared tunnel login`, then `node scripts/tunnel.mjs setup app.socialmonitor.shades.md`). Then run the setup again, which starts it as the `socialmonitor-tunnel` service.
5. In Windows PowerShell opened as administrator, run the command the setup prints last. It runs `scripts\windows-wsl-boot.ps1`, so WSL starts with Windows and stays up.
6. At the PC's own screen, open the dashboard at `http://127.0.0.1:4400` and use "Sign in to networks". The browser window shows on the Windows desktop through WSLg.

### Check it from the Mac

`yarn deploy:verify` makes these checks:

- The dashboard's address answers with Cloudflare Access's sign-in, not with the app.
- `socialmonitor.shades.md` is up and sends HSTS.
- With a service token, `/api/health` is ok and runs the commit at the tip of `origin/main`.

Each check prints PASS or FAIL, and the command exits non-zero when any check fails.

To give it a service token, once:

1. In Cloudflare Zero Trust, open Access → Service credentials → Service Tokens → Create Service Token. Name it `deploy-verify`. Copy the Client ID and the Client Secret; the secret is shown only once.
2. Open Access → Applications, then the dashboard's application → Policies → Add a policy. Set Action to **Service Auth**, and Include → Service Token → `deploy-verify`.
3. On the Mac, put both in the repository's `.env` (it is git-ignored): `CF_ACCESS_CLIENT_ID=…` and `CF_ACCESS_CLIENT_SECRET=…`.

The token passes Access only, and only for the dashboard's address. It doesn't sign anyone in to SocialMonitor. `/api/health` is the one route it can read.

### What is not certain yet

- **The sign-in window under systemd.** The `socialmonitor` unit sets `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0` and `XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir`, the values a WSLg shell has. They assume the Linux user is uid 1000, WSLg's own. With systemd on, `/tmp/.X11-unix` can be cleaned at boot; the setup checks for that and prints the fix (a tmpfiles rule that links it to `/mnt/wslg/.X11-unix`). If WSL was started by the startup task before anyone signed in to Windows, the window may not reach the desktop. If it doesn't show, sign in to Windows first, then run `sudo systemctl restart socialmonitor` in Ubuntu and try again.
- **Keeping WSL up.** WSL stops a distribution shortly after its last Windows-side process ends, even with systemd services running. That's why the startup task keeps a `sleep infinity` attached. Running `wsl.exe` from a task that runs before anyone signs in (S4U) works on current WSL, but not on every build. After the first Windows restart, check from the Mac with `yarn deploy:verify` before signing in to Windows. If it fails, set the task to "Run only when user is logged on" and turn on automatic sign-in, as LMS does.

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

## Lock down the server

The tunnel only dials out, so nothing on the server needs to be reachable from the internet. Check these once, and again after any big update:

- **Router:** no port forwards to the server, and UPnP off, so no program can open a port by itself.
- **Windows Firewall:** on for every network profile (Domain, Private and Public).
- **Remote Desktop:** off. If you need it, reach it only through Cloudflare Access for Infrastructure, never through an open port or a tunnel route.
- **BitLocker:** on for the whole disk. Automatic sign-in is fine only together with BitLocker and a screen that locks.
- **WSL:** `networkingMode` stays NAT (the default) in `.wslconfig`, never `mirrored`, so ports opened inside WSL stay on the PC.
- **Docker Desktop:** Settings → General → "Expose daemon on tcp://localhost:2375 without TLS" stays off.
- **Remote-desktop tools** (AnyDesk, Chrome Remote Desktop and the like): removed, or locked with two-factor sign-in and an allow-list of devices.

Turn on the Cloudflare alerts in [remote access](remote-access.md#alerts) too.

## One tunnel per app

SocialMonitor runs its own Cloudflare Tunnel, even when the server already runs tunnels for other apps. Revoking one tunnel then leaves the others up, and no tunnel can reach another app's ports. Set it up as in [remote access](remote-access.md):

```bash
yarn tunnel setup socialmonitor-app.example.com
```

Its only route is that hostname to `http://127.0.0.1:4400`; everything else gets a 404. `yarn tunnel` writes the config again on every start, so the route can't drift. Never add SSH, remote desktop, a database or Docker to any tunnel. The credentials file, `data/tunnel/credentials.json`, lets whoever holds it run a connector and receive the traffic. Keep it readable only by your user (`chmod 600`; `yarn tunnel` refuses to start otherwise), and leave it out of chats, logs and backups. If it leaks, delete the tunnel in Cloudflare and run setup again.

## Backups

`scripts/backup.mjs` makes an encrypted backup of `data/` every night with [restic](https://restic.net) and sends it to a Cloudflare R2 bucket. It takes a consistent copy of the database while SocialMonitor runs, and adds the reports, the media, `templates.json` and `brands.seed.json`. It leaves out the browser profile, the cache, the keys and the tunnel's files, because they belong to one machine. Once a month a restore test brings the latest backup back into a temporary folder and checks the database there.

Every run writes to `data/backup.log` and puts its result in `data/backup-status.json`. It exits with an error when something fails, so Task Scheduler or launchd shows the failure.

### Set up the bucket, once

1. **Create the bucket.** In Cloudflare, open R2 → Create bucket and name it, for example, `socialmonitor-backup`. Note your account ID from the R2 overview.
2. **Create the nightly key.** Open R2 → Manage API tokens → Create API token, choose **Object Read & Write** and limit it to this one bucket. Copy the Access Key ID and the Secret Access Key; Cloudflare shows them only once. Only this key goes on the server.
3. **Create the restic password.** Run `openssl rand -base64 32`. Save the result in your password manager and keep a printed copy somewhere safe and offline. **If you lose this password, you lose every backup**: nobody, Cloudflare included, can decrypt them without it. On the server, put it in a file outside the repository that only your user can read, for example `~/.config/socialmonitor/restic-password` (`chmod 600`) or `%USERPROFILE%\.socialmonitor\restic-password`.
4. **Add the settings to `.env`** at the repository root (it is git-ignored), or to the server's environment:

   ```bash
   RESTIC_REPOSITORY=s3:https://<account-id>.r2.cloudflarestorage.com/socialmonitor-backup
   RESTIC_PASSWORD_FILE=/home/you/.config/socialmonitor/restic-password
   AWS_ACCESS_KEY_ID=<nightly key id>
   AWS_SECRET_ACCESS_KEY=<nightly key secret>
   ```

5. **Initialize the repository.** Install restic (`winget install restic.restic`, `brew install restic` or `apt install restic`). In a terminal with those four values set, run `restic init`.
6. **Lock the bucket.** R2 has no write-only key: an Object Read & Write key can also delete objects. R2 also has no object versioning. A **bucket lock** is what protects the backups. Open the bucket → Settings → Bucket lock rules → Add rule, and add one rule for each of these prefixes, with retention **Indefinite**: `config`, `keys/`, `data/`, `index/` and `snapshots/`. Leave `locks/` out, because restic removes its own lock files after each run. From then on, a stolen nightly key or ransomware on the server can add backups but cannot delete or overwrite them. The rules can only be changed from your Cloudflare account, which is why that account needs two-factor sign-in.
7. **Run it once by hand** and check the log:

   ```bash
   node scripts/backup.mjs
   node scripts/backup.mjs --test-restore
   ```

Also keep `SOCIALMONITOR_VAULT_KEY` in your password manager. The backup holds the saved accounts encrypted, and they open again only with the same key.

### Schedule

- **Windows:** in PowerShell opened as administrator, from the repository, run `powershell -ExecutionPolicy Bypass -File scripts\windows-backup.ps1`. It registers the backup every night at 02:30 and the restore test every four weeks, on Sunday at 04:00. Both run as your user, whether or not anyone is signed in, and a run missed while the PC was off starts once it is back. Add `-Remove` to take them out.
- **macOS:** add a launchd agent at `~/Library/LaunchAgents/md.shades.socialmonitor.backup.plist`, then run `launchctl load` on that file. Copy it with `--test-restore` added to the arguments, a different label, and `<key>Day</key><integer>1</integer>` in the interval, for the monthly restore test. A LaunchAgent runs only while you are signed in, so on a headless Mac make it a LaunchDaemon with a `UserName` key.

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>Label</key><string>md.shades.socialmonitor.backup</string>
    <key>WorkingDirectory</key><string>/Users/you/SocialMonitor</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/you/.nvm/versions/node/v22.23.1/bin/node</string>
      <string>scripts/backup.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict><key>RESTIC_BIN</key><string>/opt/homebrew/bin/restic</string></dict>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>30</integer></dict>
  </dict>
  </plist>
  ```

### Retention and pruning

The aim is to keep 30 daily and 12 monthly snapshots. Removing the older ones deletes objects, so the nightly run never does it. It forgets old snapshots only when a separate prune credential is set (`RESTIC_PRUNE_AWS_ACCESS_KEY_ID` and `RESTIC_PRUNE_AWS_SECRET_ACCESS_KEY`), and that credential never lives on the server. Once a month, by hand:

1. Create an R2 token with **Admin Read & Write**, or take it from your password manager.
2. Remove the bucket lock rules.
3. On the server, run one backup with the admin token set for that command only. It runs `restic forget --keep-daily 30 --keep-monthly 12 --prune`:

   ```bash
   RESTIC_PRUNE_AWS_ACCESS_KEY_ID=<admin id> RESTIC_PRUNE_AWS_SECRET_ACCESS_KEY=<admin secret> node scripts/backup.mjs
   ```

   In PowerShell, set them with `$env:RESTIC_PRUNE_AWS_ACCESS_KEY_ID='…'`, run `node scripts\backup.mjs`, then close the window.

4. Add the lock rules back.

Skipping a month costs only storage; nothing is lost.

### Restore

1. On the machine you restore to, install restic and set the four settings above. Take the password from your password manager.
2. Stop SocialMonitor, then pick a snapshot with `restic snapshots --tag socialmonitor`.
3. Run `restic restore latest --tag socialmonitor --target restore` (or give a snapshot ID instead of `latest`). Restic recreates the original folders under `restore/`.
4. Copy `…/data/backup-snapshot/socialmonitor.db` to `data/socialmonitor.db`. Delete any `data/socialmonitor.db-wal` and `data/socialmonitor.db-shm` left from the old database. Then copy `reports/`, `media/`, `templates.json` and `brands.seed.json` back into `data/`.
5. Start SocialMonitor. Then set things up again as in [What moves](#what-moves-and-what-does-not): sign in to the networks, and re-enter saved accounts unless `SOCIALMONITOR_VAULT_KEY` is the same.
