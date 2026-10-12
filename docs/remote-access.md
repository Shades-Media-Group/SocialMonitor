# Remote access

SocialMonitor runs on your computer and answers only there. To reach it from another device, put it behind a Cloudflare Tunnel with Cloudflare Access in front. Access checks who you are, and the dashboard checks Access: every request through the tunnel must carry a valid Access token, or it is refused.

## Set it up once

1. **Sign cloudflared in to your Cloudflare account.** A browser window opens; choose the domain the address will live on.

   ```bash
   cloudflared tunnel login
   ```

2. **Create the tunnel and its address.** This writes the tunnel's files to `data/tunnel/` and `SOCIALMONITOR_PUBLIC_HOST` to `.env`.

   ```bash
   yarn tunnel setup socialmonitor-app.example.com
   ```

3. **Protect the address with Cloudflare Access.** In the Cloudflare dashboard, open Zero Trust → Access → Applications → Add an application → Self-hosted:
   - Application domain: the hostname from step 2.
   - Policy: Allow, Include, Emails: only your own address.
   - After saving, copy the application's **Audience (AUD) tag**, and your team domain (Zero Trust → Settings, ending in `.cloudflareaccess.com`).

4. **Tell the dashboard about Access.** Add both to `.env`:

   ```bash
   SOCIALMONITOR_ACCESS_TEAM=yourteam.cloudflareaccess.com
   SOCIALMONITOR_ACCESS_AUD=the-audience-tag
   ```

## Run it

```bash
yarn start    # the dashboard, on 127.0.0.1:4400
yarn tunnel   # in a second terminal: the tunnel
```

Open the address and pass Cloudflare Access with the code it emails you. Then sign in to SocialMonitor itself: your password and the code it emails you. Access keeps strangers out; SocialMonitor's own roles decide which brands each person sees. See [people and sign-in](people.md).

## What stays local

- Saved account passwords are never revealed through the tunnel, only on the computer itself.
- "Sign in to networks" opens a window on the computer itself, so it is refused remotely.
- The dashboard still listens only on 127.0.0.1; the tunnel reaches it from inside your computer.
