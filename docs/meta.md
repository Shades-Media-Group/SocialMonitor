# Connecting a brand's own Facebook Page and Instagram

SocialMonitor reads Facebook and Instagram from the web through its own browser. A brand can also connect **its own** Facebook Page, and the Instagram business account linked to it, through Facebook's sign-in. Their posts and comments are then read through Meta's official API (the Graph API), with no signed-in browser and no waiting between reads. SocialMonitor only reads; it never posts.

## Set it up

1. At developers.facebook.com create a **Business** app under your verified business portfolio and add **Facebook Login for Business**.
2. In Facebook Login for Business → Settings, add the redirect URI `https://socialmonitor.shades.md/connect/meta/`. Facebook only returns people to a fixed https address, so that page hands the one-time code back to the dashboard on your computer. It keeps nothing.
3. Ask for these permissions: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `business_management`, `instagram_basic`, `instagram_manage_comments`. While the app is in development they work for the app's own admins and testers; others need App Review.
4. Add the app's keys to `.env` at the repository root:

```bash
META_APP_ID=
META_APP_SECRET=
```

5. Restart, open the brand's About page and press **Connect with Facebook**. Pick the brand's Page; its Instagram comes with it.

The Page token stays in `data/socialmonitor.db` on your computer and does not expire while you keep admin access to the Page. **Disconnect** deletes it. To use your own hand-back page, set `META_REDIRECT_URI`.
