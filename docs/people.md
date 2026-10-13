# People, roles and sign-in

Everyone signs in to SocialMonitor, on the computer it runs on and through the tunnel alike. Signing in takes a password and then a six-digit code sent by email.

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

A session lasts 12 hours, in a cookie scripts can't read, sent only to this dashboard. Changing your password, "Sign out everywhere", being blocked or removed all end every session at once. Five wrong passwords lock that account for 15 minutes; five wrong codes void the code.

On a server, give sessions their own signing key instead of the one SocialMonitor keeps in `data/session.key`:

```bash
openssl rand -base64 48    # once; store it in the server's secret store as SOCIALMONITOR_JWT_SECRET
```
