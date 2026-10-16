#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-time setup of SocialMonitor's production server: the always-on Windows PC, inside WSL Ubuntu
# (or any Linux box with systemd). In WSL:
#
#   git clone https://github.com/Shades-Media-Group/SocialMonitor.git ~/shades/SocialMonitor
#   bash ~/shades/SocialMonitor/scripts/production-setup.sh
#
#   - checks Node 22 (nvm), yarn, git, gh, Claude Code, and systemd in /etc/wsl.conf
#   - clones ~/shades/SocialMonitor when it is missing (a clone is left as it is: the updater moves it)
#   - writes ~/.config/socialmonitor/allowed_signers: the Mac's signing key, and the PC's if you want
#   - writes .env (chmod 600), asking for each value that is missing; secrets are typed hidden and
#     never printed. Values already there are kept.
#   - makes the cloned commit the first release (no signature check: that history is the baseline)
#   - installs systemd units: socialmonitor (the app and its updater), socialmonitor-tunnel, and
#     timers for the nightly backup and the monthly restore test
#   - prints how to keep WSL running from Windows startup (scripts/windows-wsl-boot.ps1)
#
# Safe to run again: everything it finds done is kept. See "Production" in docs/server.md.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL=https://github.com/Shades-Media-Group/SocialMonitor.git
REPO="${SOCIALMONITOR_REPO:-$HOME/shades/SocialMonitor}"
CONF="$HOME/.config/socialmonitor"
SIGNERS="$CONF/allowed_signers"
STATE="$HOME/.local/state/socialmonitor"
CURRENT="$HOME/.local/share/socialmonitor/current"
# The Mac's signing key (~/.ssh/git_signing.pub there). Commits it signs are deployed.
MAC_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxMYdvjC8Dh0P93xGArDkpL2wLmecRAZk0Hsl8XIMxz cristian.brinza@shades.md (git signing, Mac)'

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}
yes_no() { # yes_no "question" default(y|n)
  local answer
  read -r -p "$1 [$([ "$2" = y ] && echo Y/n || echo y/N)] " answer </dev/tty
  answer="${answer:-$2}"
  [ "${answer,,}" = y ] || [ "${answer,,}" = yes ]
}

say "Checking the machine"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # nvm isn't written for set -u.
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
  set -u
fi
command -v node >/dev/null || fail "Node isn't installed. Install nvm (github.com/nvm-sh/nvm), then: nvm install 22 && nvm alias default 22"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===22&&b>=18||a>22?0:1)' ||
  fail "SocialMonitor needs Node 22.18 or newer (found $(node --version)): nvm install 22 && nvm alias default 22"
command -v yarn >/dev/null || fail "yarn isn't installed: npm install -g yarn"
command -v git >/dev/null || fail "git isn't installed: sudo apt install git"
command -v openssl >/dev/null || fail "openssl isn't installed: sudo apt install openssl"
command -v curl >/dev/null || fail "curl isn't installed: sudo apt install curl"
command -v ssh-keygen >/dev/null || fail "ssh-keygen isn't installed (it checks commit signatures): sudo apt install openssh-client"
NODE="$(command -v node)"
BIN_PATH="$(dirname "$NODE"):$(dirname "$(command -v yarn)"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
echo "Node $(node --version), yarn $(yarn --version), $(git --version)"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI: signed in"
else
  warn "GitHub CLI isn't signed in. The repository is public, so this setup and the updater don't need it; sign in (gh auth login) to work with GitHub from this PC."
fi
if command -v claude >/dev/null; then
  echo "Claude Code: $(claude --version 2>/dev/null | head -n1)"
else
  warn "Claude Code isn't installed, so comments aren't sorted: curl -fsSL https://claude.ai/install.sh | bash, then claude setup-token for CLAUDE_CODE_OAUTH_TOKEN."
fi
if grep -qi microsoft /proc/version && ! grep -qsE '^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true' /etc/wsl.conf; then
  fail "systemd is off in this WSL distribution. Turn it on, then run this again:
  printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
  and in Windows PowerShell:  wsl --shutdown   then open Ubuntu again."
fi
[ "$(ps -p 1 -o comm=)" = systemd ] || fail "systemd isn't running (PID 1 is $(ps -p 1 -o comm=)). In Windows PowerShell: wsl --shutdown, then open Ubuntu again."

say "The repository ($REPO)"
if [ -d "$REPO/.git" ]; then
  echo "Already cloned at $(git -C "$REPO" log -1 --format='%h %s'). Left as it is: the updater moves it."
else
  mkdir -p "$(dirname "$REPO")"
  git clone --quiet "$REPO_URL" "$REPO"
  echo "Cloned at $(git -C "$REPO" log -1 --format='%h %s')."
fi
case "$REPO" in
  /mnt/*) warn "The repository is on a Windows drive. Clone it inside WSL (~/shades/SocialMonitor): it is faster and keeps Linux permissions." ;;
esac

say "Signed deploys ($SIGNERS)"
# The updater deploys only commits signed by these keys. The file lives outside the repository, so
# a pushed commit can't add its own key.
mkdir -p "$CONF"
chmod 700 "$CONF"
touch "$SIGNERS"
add_signer() { # add_signer "public key line"
  local body
  body="$(echo "$1" | awk '{print $1" "$2}')"
  grep -qF "$body" "$SIGNERS" || echo "cristian.brinza@shades.md namespaces=\"git\" $1" >>"$SIGNERS"
}
add_signer "$MAC_KEY"
echo "The Mac's key is trusted."
PC_KEY="$HOME/.ssh/git_signing"
if [ -f "$PC_KEY.pub" ] && grep -qF "$(awk '{print $2}' "$PC_KEY.pub")" "$SIGNERS"; then
  echo "This PC's key ($PC_KEY.pub) is trusted."
elif yes_no "Also deploy commits signed on this PC (a signing key here, for fixes made on the server)?" n; then
  if [ ! -f "$PC_KEY" ]; then
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    ssh-keygen -t ed25519 -f "$PC_KEY" -C "cristian.brinza@shades.md (git signing, PC)" </dev/tty
  fi
  add_signer "$(cat "$PC_KEY.pub")"
  git config --global gpg.format ssh
  git config --global user.signingkey "$PC_KEY.pub"
  git config --global commit.gpgsign true
  echo "Trusted, and git here now signs every commit with it. Add it to GitHub as a signing key"
  echo "(github.com/settings/ssh/new, Key type: Signing Key), so GitHub shows the commits as verified:"
  echo
  cat "$PC_KEY.pub"
fi
chmod 644 "$SIGNERS"

say "Settings ($REPO/.env)"
ENV="$REPO/.env"
touch "$ENV"
chmod 600 "$ENV"
get() { grep -E "^$1=" "$ENV" | tail -n1 | cut -d= -f2- || true; }
set_value() { # set_value KEY value: only when KEY has no value yet; values are never printed
  local key="$1" value="$2" line
  [ -n "$(get "$key")" ] && return 0
  [ -z "$value" ] && return 0
  if [[ "$value" =~ ^[A-Za-z0-9._@:/+=-]+$ ]]; then
    line="$key=$value"
  elif [[ "$value" != *"'"* ]]; then
    line="$key='$value'"
  else
    warn "$key has a ' in it: add it to $ENV by hand."
    return 0
  fi
  { grep -vE "^$key=" "$ENV" || true; printf '%s\n' "$line"; } >"$ENV.tmp"
  chmod 600 "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
}
ask() { # ask KEY "question" [default]: shown as typed, for values that aren't secret
  local answer
  [ -n "$(get "$1")" ] && return 0
  read -r -p "$2${3:+ [$3]}: " answer </dev/tty
  set_value "$1" "${answer:-${3:-}}"
}
ask_secret() { # ask_secret KEY "question": hidden while typed, never printed
  local answer
  [ -n "$(get "$1")" ] && return 0
  read -r -s -p "$2: " answer </dev/tty
  echo
  set_value "$1" "$answer"
}
echo "Enter skips a value; run this again, or edit .env, to add it later."
ask SOCIALMONITOR_PUBLIC_HOST "The dashboard's address" app.socialmonitor.shades.md
echo "Cloudflare Access (Zero Trust → Access → Applications → the dashboard's application):"
ask CF_ACCESS_TEAM "  Team name (the part before .cloudflareaccess.com)"
ask CF_ACCESS_AUD "  Application Audience (AUD) tag"
echo "Email (docs/people.md):"
ask SMTP_HOST "  SMTP host" smtp.gmail.com
ask SMTP_PORT "  SMTP port" 465
ask SMTP_USER "  SMTP user (the account that sends)"
ask_secret SMTP_PASS "  SMTP app password"
ask SMTP_FROM "  Sender people see" "SocialMonitor <no-reply@shades.md>"
echo "Claude (run  claude setup-token  to get a token valid for a year):"
ask_secret CLAUDE_CODE_OAUTH_TOKEN "  CLAUDE_CODE_OAUTH_TOKEN"
echo "Meta and TikTok connections (docs/meta.md, docs/tiktok.md):"
ask META_APP_ID "  Meta app ID"
ask_secret META_APP_SECRET "  Meta app secret"
ask TIKTOK_CLIENT_KEY "  TikTok client key"
ask_secret TIKTOK_CLIENT_SECRET "  TikTok client secret"
echo "The key that encrypts saved accounts (Enter makes a new one):"
ask_secret SOCIALMONITOR_VAULT_KEY "  SOCIALMONITOR_VAULT_KEY"
if [ -z "$(get SOCIALMONITOR_VAULT_KEY)" ]; then
  set_value SOCIALMONITOR_VAULT_KEY "$(openssl rand -hex 32)"
  printf '\033[1;31m%s\033[0m\n' "  A new key was made. Save it in your password manager now: without it, saved accounts can't be read."
  echo "  Show it with:  grep ^SOCIALMONITOR_VAULT_KEY= $ENV"
fi
set_value SOCIALMONITOR_JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n/+=')"
if [ ! -s "$REPO/data/socialmonitor.db" ]; then
  echo "The first account, a super admin made on the first start (docs/people.md):"
  ask SOCIALMONITOR_ADMIN_EMAIL "  Email"
  ask SOCIALMONITOR_ADMIN_USERNAME "  Username"
  ask SOCIALMONITOR_ADMIN_NAME "  Name"
  ask_secret SOCIALMONITOR_ADMIN_PASSWORD "  Password (at least 10 characters)"
fi
echo "Off-site backups to Cloudflare R2 or a folder such as OneDrive (docs/server.md#backups):"
ask RESTIC_REPOSITORY "  RESTIC_REPOSITORY (s3:https://<account-id>.r2.cloudflarestorage.com/socialmonitor-backup, or /mnt/c/Users/<you>/OneDrive/SocialMonitor-backup)"
if [ -n "$(get RESTIC_REPOSITORY)" ] && [ -z "$(get RESTIC_PASSWORD_FILE)" ]; then
  read -r -s -p "  The restic password (from your password manager): " restic_password </dev/tty
  echo
  if [ -n "$restic_password" ]; then
    (umask 077 && printf '%s\n' "$restic_password" >"$CONF/restic-password")
    set_value RESTIC_PASSWORD_FILE "$CONF/restic-password"
  fi
  unset restic_password
fi
# A folder repository (for example OneDrive under /mnt/c) needs no keys; only R2 does.
case "$(get RESTIC_REPOSITORY)" in
  s3:*)
    ask AWS_ACCESS_KEY_ID "  R2 access key ID (Object Read & Write, this bucket only)"
    ask_secret AWS_SECRET_ACCESS_KEY "  R2 secret access key"
    ;;
esac
chmod 600 "$ENV"
echo ".env is ready, readable by you only."

say "The first release"
if [ -s "$STATE/live" ]; then
  echo "Already set up: $(cut -c1-7 "$STATE/live") is live. The updater takes it from here."
else
  echo "Building $(git -C "$REPO" log -1 --format='%h %s'). Its history is the trusted baseline;"
  echo "from now on only commits signed by a key in $SIGNERS go live."
  (cd "$REPO" && PATH="$BIN_PATH" node scripts/production.mjs --baseline) ||
    fail "The first build failed: see $STATE/build.log"
fi

say "Chromium for \"Sign in to networks\""
if yes_no "Install the system libraries Chromium needs (sudo apt)?" y; then
  sudo env PATH="$BIN_PATH" "$CURRENT/node_modules/.bin/playwright" install-deps chromium
fi
if [ -d /mnt/wslg ] && [ ! -S /tmp/.X11-unix/X0 ]; then
  warn "WSLg's display socket /tmp/.X11-unix/X0 is missing, so the sign-in window can't open. With systemd on,
/tmp is cleaned at boot; this keeps the link (then, in Windows PowerShell: wsl --shutdown):
  echo 'L+ /tmp/.X11-unix - - - - /mnt/wslg/.X11-unix' | sudo tee /etc/tmpfiles.d/wslg.conf"
fi

say "Services (systemd)"
UNITS_CHANGED=""
unit() { # unit NAME: the unit text on stdin; written only when it changed
  local file="/etc/systemd/system/$1" text
  text="$(cat)"
  if [ "$(sudo cat "$file" 2>/dev/null)" != "$text" ]; then
    printf '%s\n' "$text" | sudo tee "$file" >/dev/null
    UNITS_CHANGED="$UNITS_CHANGED $1"
  fi
}
# WSLg's display, for the headful sign-in window. A systemd service doesn't get the variables a
# WSL shell has, so they are set here. /mnt/wslg/runtime-dir belongs to the first WSL user (uid
# 1000); see docs/server.md for what is uncertain.
unit socialmonitor.service <<EOF
[Unit]
Description=SocialMonitor: the dashboard and its updater
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$REPO
ExecStart=$NODE $REPO/scripts/production.mjs
Restart=always
RestartSec=5
TimeoutStopSec=30
Environment=PATH=$BIN_PATH
Environment=DISPLAY=:0
Environment=WAYLAND_DISPLAY=wayland-0
Environment=XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir
Environment=PULSE_SERVER=unix:/mnt/wslg/PulseServer

[Install]
WantedBy=multi-user.target
EOF
unit socialmonitor-tunnel.service <<EOF
[Unit]
Description=SocialMonitor: its Cloudflare Tunnel (app.socialmonitor.shades.md only)
After=network-online.target socialmonitor.service
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$REPO
ExecStart=$NODE $REPO/scripts/tunnel.mjs
Restart=always
RestartSec=10
Environment=PATH=$BIN_PATH

[Install]
WantedBy=multi-user.target
EOF
for job in backup restore-test; do
  args=""
  [ "$job" = restore-test ] && args=" --test-restore"
  unit "socialmonitor-$job.service" <<EOF
[Unit]
Description=SocialMonitor: the off-site $job (scripts/backup.mjs$args)

[Service]
Type=oneshot
User=$USER
WorkingDirectory=$REPO
ExecStart=$NODE $REPO/scripts/backup.mjs$args
Environment=PATH=$BIN_PATH
EOF
done
unit socialmonitor-backup.timer <<'EOF'
[Unit]
Description=SocialMonitor: the off-site backup, every night at 02:30

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
unit socialmonitor-restore-test.timer <<'EOF'
[Unit]
Description=SocialMonitor: the restore test, on the first Sunday of each month at 04:00

[Timer]
OnCalendar=Sun *-*-01..07 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
start_unit() { # enabled at boot, and running; restarted when its unit file changed
  sudo systemctl enable --quiet "$1"
  case " $UNITS_CHANGED " in
    *" $1 "*) sudo systemctl restart "$1" ;;
    *) sudo systemctl start "$1" ;;
  esac
}
start_unit socialmonitor.service
command -v restic >/dev/null || warn "restic isn't installed, so the backup timers will fail: sudo apt install restic"
start_unit socialmonitor-backup.timer
start_unit socialmonitor-restore-test.timer
if [ -f "$REPO/data/tunnel/credentials.json" ]; then
  start_unit socialmonitor-tunnel.service
  echo "The tunnel runs."
else
  warn "No tunnel yet. Install cloudflared, then:
  cloudflared tunnel login
  cd $REPO && node scripts/tunnel.mjs setup app.socialmonitor.shades.md
and run this setup again to start it (docs/remote-access.md)."
fi

say "Waiting for the dashboard"
healthy=""
for _ in $(seq 1 60); do
  if body="$(curl -fsS http://127.0.0.1:4400/api/health 2>/dev/null)"; then
    healthy="$body"
    break
  fi
  sleep 2
done
[ -n "$healthy" ] || fail "The dashboard didn't answer in 2 minutes: journalctl -u socialmonitor -n 50"
echo "$healthy"
if [ -n "$(get SOCIALMONITOR_ADMIN_PASSWORD)" ] && node -e '
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(process.argv[1], { readOnly: true })
  process.exit(db.prepare("SELECT count(*) AS n FROM users").get().n > 0 ? 0 : 1)' "$REPO/data/socialmonitor.db" 2>/dev/null; then
  { grep -v '^SOCIALMONITOR_ADMIN_PASSWORD=' "$ENV" || true; } >"$ENV.tmp"
  chmod 600 "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
  echo "The first account exists; its password is kept hashed in the database, so it was removed from .env."
fi

say "Done"
BOOT="$REPO/scripts/windows-wsl-boot.ps1"
command -v wslpath >/dev/null && BOOT="$(wslpath -w "$BOOT")"
cat <<EOF
SocialMonitor runs at http://127.0.0.1:4400 and follows main by itself.

  Status:   cat $STATE/status.json
  Updater:  tail -f $STATE/updater.log
  The app:  journalctl -u socialmonitor -f
  Release:  node $REPO/scripts/production.mjs --release <sha>

Keep WSL running from Windows startup, so all this comes back after a restart. In PowerShell
opened as administrator:

  powershell -ExecutionPolicy Bypass -File "$BOOT" -Distro ${WSL_DISTRO_NAME:-Ubuntu}

From the Mac:  yarn deploy:verify
EOF
