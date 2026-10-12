# Connecting a brand's own TikTok

SocialMonitor reads any TikTok profile from TikTok's public pages: posts, comments, replies, photos and stickers, with no account. A brand can also connect **its own** TikTok account through TikTok's sign-in. That adds exact figures for its videos and its follower count, read through TikTok's official API (Login Kit and Display API). SocialMonitor only reads; it never posts.

## Set it up

1. Create an app at developers.tiktok.com, add **Login Kit** (Web) and **Display API**, and the scopes `user.info.basic`, `user.info.profile`, `user.info.stats` and `video.list`.
2. Add the redirect URI `https://socialmonitor.shades.md/connect/tiktok/`. TikTok only returns people to a fixed https address, so that page hands the one-time code back to the dashboard on your computer. It keeps nothing.
3. Add the app's keys to `.env` at the repository root (while the app waits for review, use the Sandbox pair):

```bash
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
```

4. Restart, open the brand's About page and press **Connect with TikTok**.

The tokens stay in `data/socialmonitor.db` on your computer. **Disconnect** deletes them. To use your own hand-back page, set `TIKTOK_REDIRECT_URI`.
