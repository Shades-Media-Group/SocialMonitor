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

## Keep Access in front

Cloudflare Access stays in front of the dashboard's address (for Shades, `app.socialmonitor.shades.md`) for as long as the tunnel exists. Never route the hostname without its Access application, not even for a quick test. The dashboard refuses requests without a valid Access token, but that check is the second line, not the first. If you remove the Access application, stop the tunnel too.

## Rate limit sign-in

Strangers never get past Access, but someone who does, or a stolen Access session, could still guess passwords. Add a rate limiting rule in the Cloudflare dashboard: your domain → Security → WAF → Rate limiting rules → Create rule.

On the **Free plan** the rule can only match the path, and it counts and blocks for 10 seconds at most. Use one rule for the whole zone; it covers every app there with the same paths:

- **Expression** (Edit expression):

  ```
  (http.request.uri.path in {"/api/auth/login" "/api/auth/code" "/api/auth/resend" "/api/auth/forgot" "/api/auth/setup" "/api/auth/accept"})
  ```

- **With the same characteristics:** IP.
- **When rate exceeds:** 10 requests per 10 seconds.
- **Then take action:** Block, for 10 seconds.

The list names the sign-in endpoints rather than all of `/api/auth/*`. The free rule can't match the method, and the dashboard reads `GET /api/auth/me` on every page load and saves preferences with `PATCH /api/auth/me`, which must not count.

On **Pro or higher**, narrow the rule to the host, count over a minute and block for longer:

```
(http.host eq "app.socialmonitor.shades.md" and starts_with(http.request.uri.path, "/api/auth/") and http.request.uri.path ne "/api/auth/me")
```

Use IP, **10 requests per 1 minute**, Block for **10 minutes**. On Business, add `and http.request.method eq "POST"` and drop the exception for `/api/auth/me`.

## Alerts

In the Cloudflare dashboard, open Notifications → Add and turn on, by email:

- **Tunnel Health Alert:** when the tunnel turns Degraded, Down or Inactive. Usually the computer is off or offline; sometimes it means something else took over the connection.
- **Tunnel Creation or Deletion Event:** when any tunnel in the account is created or deleted, which you should only ever see after your own changes.

Cloudflare has no alert for a new connector joining an existing tunnel, and a second connector is exactly what someone holding `data/tunnel/credentials.json` would add. Check now and then that the tunnel has one connector, from this computer: run `cloudflared tunnel info socialmonitor`, or look in Zero Trust → Networks → Tunnels. If you see one you don't know, delete the tunnel and run `yarn tunnel setup` again.

## The computer behind the tunnel

The tunnel is only as safe as the computer it runs on. Go through the checklist in [lock down the server](server.md#lock-down-the-server): no port forwards and UPnP off on the router, the firewall on, Remote Desktop off, BitLocker on, WSL in NAT mode, Docker's TCP daemon off, and remote-desktop tools removed or locked with two-factor sign-in.

## What stays local

- The dashboard listens only on `127.0.0.1:4400`, never on a network address. The tunnel reaches it from inside your computer. Don't change that, and don't forward port 4400 on the router.
- Saved account passwords are never revealed through the tunnel, only on the computer itself.
- "Sign in to networks" opens a window on the computer itself, so it is refused remotely.
- The dashboard still listens only on 127.0.0.1; the tunnel reaches it from inside your computer.
- The dashboard checks the Access token itself: its RS256 signature against your team's keys, the audience tag, the issuer and its expiry. A request that carries Cloudflare's headers (`cf-connecting-ip`, `cf-ray`) or asks for the public hostname is refused without a valid one, even if a hostname is ever routed past Access by mistake.
- Every page carries a strict Content Security Policy with a fresh nonce, so only the dashboard's own scripts run and no other site can frame it; through the tunnel it also sends HSTS.
- It answers only to `127.0.0.1:<port>`, `localhost:<port>` and the public hostname. Any other `Host` gets nothing, so a web page can't reach it through DNS rebinding.
- The visitor's address and country (`cf-connecting-ip`, `cf-ipcountry`) are believed only on a request with a valid Access token; otherwise the connection's own address is used.
