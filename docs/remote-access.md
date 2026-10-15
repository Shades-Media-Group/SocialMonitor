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
   CF_ACCESS_TEAM=yourteam                # or yourteam.cloudflareaccess.com
   CF_ACCESS_AUD=the-audience-tag
   ```

   The older names `SOCIALMONITOR_ACCESS_TEAM` and `SOCIALMONITOR_ACCESS_AUD` still work. Until both are set, every request through the tunnel is refused, and the log says so once.

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
- The dashboard checks the Access token itself: its RS256 signature against your team's keys, the audience tag, the issuer and its expiry. A request that carries Cloudflare's headers (`cf-connecting-ip`, `cf-ray`) or asks for the public hostname is refused without a valid one, even if a hostname is ever routed past Access by mistake.
- Every page carries a strict Content Security Policy with a fresh nonce, so only the dashboard's own scripts run and no other site can frame it; through the tunnel it also sends HSTS.
- It answers only to `127.0.0.1:<port>`, `localhost:<port>` and the public hostname. Any other `Host` gets nothing, so a web page can't reach it through DNS rebinding.
- The visitor's address and country (`cf-connecting-ip`, `cf-ipcountry`) are believed only on a request with a valid Access token; otherwise the connection's own address is used.
