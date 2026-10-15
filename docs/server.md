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

On macOS the encryption key for saved accounts lives in the Keychain. On Windows and Linux it falls back to `data/vault.key`, next to the database, so give the server its own key instead and keep it out of `data/`:

```bash
openssl rand -hex 32    # once; store the result in the server's secret store
```

Set it as `SOCIALMONITOR_VAULT_KEY` in the service's environment (a systemd credential, a Windows service variable), not in `.env` inside the repository. Use full-disk encryption on the server too: it holds every account you save.

## Sign-in email and sessions

Set the `SMTP_*` keys and `SOCIALMONITOR_JWT_SECRET` as in [people and sign-in](people.md), in the service's environment rather than in `.env`. Then open the dashboard at the server's own screen once to create the first account, or set the `SOCIALMONITOR_ADMIN_*` keys from [the first account](people.md#the-first-account) so the first start creates it. After that start, remove `SOCIALMONITOR_ADMIN_PASSWORD` from the environment: the account exists and its password is kept hashed in the database.

## Sign in to the networks

"Sign in to networks" opens a browser window on the server itself, so do it once at the server's screen or over remote desktop. Through the tunnel the button is refused on purpose.

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
