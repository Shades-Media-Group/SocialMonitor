# People, roles and sign-in

Everyone signs in to SocialMonitor, on the computer it runs on and through the tunnel alike. Signing in takes a password and then a second step: a six-digit code sent by email, or, for people who set one up, a passkey or a code from an authenticator app.

## The first account

Open the dashboard on the computer SocialMonitor runs on. It asks you to create the first account, which becomes the **super admin**. Through the tunnel this screen is refused, so nobody on the internet can claim an empty install.

To skip that screen, on a server for example, name the super admin in `.env` before the first start:

```bash
SOCIALMONITOR_ADMIN_EMAIL=you@yourdomain.com
SOCIALMONITOR_ADMIN_USERNAME=you                # optional
SOCIALMONITOR_ADMIN_NAME="Your Name"            # optional
SOCIALMONITOR_ADMIN_PASSWORD=                   # at least 10 characters
```

On start, SocialMonitor creates that account as a verified super admin if no one has that email yet, and logs one line saying so. An account that already exists is never changed: its password, role and username stay as they are. Values it can't use (a bad email, a short password) are logged and the server starts anyway. Once the account exists, delete the `SOCIALMONITOR_ADMIN_PASSWORD` line from `.env`: the password now lives hashed in the database, and changing it is done in the dashboard.

## Roles

| Role             | Sees                      | Can                                                                                                                                       |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer           | the brands they belong to | read the dashboard, translate comments, download reports and exports of those brands                                                      |
| Admin of a brand | the brands they belong to | everything a viewer can, and edit the brand and its network links, rate comments, run updates, set schedules, invite people to that brand |
| Super admin      | every brand               | everything: add and delete brands, settings, saved accounts, import and export, make other super admins                                   |

One person can be an admin of one brand and a viewer of another. Manage people under **People** in the top bar.

## Inviting someone

In People, give an email and choose each brand's role. They get a link to choose a password; it works once, for 72 hours. "Send the invitation again" makes a new one. For someone already set up, the same button sends a reset link instead.

## Two-step sign-in

Under **Settings**, anyone can add:

- **Passkeys:** the fingerprint, face or PIN of a phone or computer. A passkey works only at the address it was made at, and browsers refuse passkeys on a bare IP address: open the dashboard at `http://localhost:4400` (or through the tunnel) to add and use one.
- **An authenticator app:** scan the QR code, then type its first code to turn it on.
- **Recovery codes:** ten codes, shown once, that each work once, for when the phone is lost. The first passkey or app comes with them; "Make new codes" replaces them all.

With one of these, signing in asks for it after the password instead of emailing a code, and "Email me a code instead" stays there as a fallback. Changes to these ask for the password again when it was entered more than 15 minutes ago.

Super admins are asked to add a passkey or an authenticator app right after they sign in, and Settings reminds them until they do. Until then they keep signing in with the emailed code.

## Forgotten and changed passwords

"Forgot your password?" emails a six-digit code to the account; the code and a new password go on one screen. The answer looks the same whether or not the account exists. Codes work for 10 minutes, five wrong ones void the code, and each account can ask for three in 15 minutes.

Signed in, **Settings → Change password** takes the current password, or "Send me a code instead" emails a code.

Either way, an account with a passkey or an authenticator app also needs that (or a recovery code), so an emailed code alone can't take it over. The new password ends every other session; this browser stays signed in. Links from reset emails sent before codes keep working until they expire.

## Email

Codes, invitations and resets go out over SMTP. Add these to `.env` at the repository root:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@yourdomain.com          # the account that signs in to the mail server
SMTP_PASS=                            # an app password, never your normal password
SMTP_FROM="SocialMonitor <no-reply@yourdomain.com>"
```

With Google Workspace or Gmail: turn on 2-Step Verification for `SMTP_USER`, create an app password at myaccount.google.com/apppasswords, and paste it as `SMTP_PASS`. `SMTP_FROM` can be any address that account may send as (Gmail → Settings → Accounts → Send mail as). Other Shades projects read the same keys, so one mail setup serves them all.

Without `SMTP_HOST`, nothing is sent: codes and links are printed in the server's console, which is enough to finish setting up on that computer.

## Sessions

Each sign-in is a session kept in the database, named by a random id in a cookie scripts can't read, sent only to this dashboard (`__Host-sm_session` over the tunnel's HTTPS, `sm_session` on `http://127.0.0.1`). A session ends after 12 hours without use, or 30 days with "Keep me signed in", and never lasts more than 30 days. It gets a new id at every sign-in and whenever that person's role changes.

**Settings → Devices** lists every browser you're signed in on, with the browser, the system, the country when it came through the tunnel, and when it was last used. Sign out one of them, or all of them with "Sign out everywhere". Changing your password, being blocked or removed also end every session at once. Five wrong passwords lock that account for 15 minutes; five wrong codes void the code.

Short-lived tokens that let the PDF renderer open a report as you are signed with a key SocialMonitor keeps in `data/session.key`. On a server, give it its own key instead:

```bash
openssl rand -base64 48    # once; store it in the server's secret store as SOCIALMONITOR_JWT_SECRET
```

Passwords are hashed with scrypt (N=2^17, r=8, p=1), and older hashes are redone at the next sign-in. A new password must be at least 10 characters and not in a known data breach: SocialMonitor sends the first five characters of its SHA-1 fingerprint to Have I Been Pwned and compares the answers on this computer. If that service can't be reached, the password is accepted and the server logs a warning. Set `SOCIALMONITOR_HIBP=off` to skip the check.
