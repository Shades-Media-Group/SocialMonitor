# Connecting a brand's own Facebook Page and Instagram

SocialMonitor reads Facebook and Instagram from the web through its own browser. A brand can also connect **its own** Facebook Page, and the Instagram business account linked to it, through Facebook's sign-in. Their posts and comments are then read through Meta's official API (the Graph API), with no signed-in browser and no waiting between reads. SocialMonitor only reads; it never posts.

## Set it up

1. At developers.facebook.com create a **Business** app under your verified business portfolio and add **Facebook Login for Business**.
2. In Facebook Login for Business → Settings, add the redirect URI `https://socialmonitor.shades.md/connect/meta/`. Facebook only returns people to a fixed https address, so that page hands the one-time code back to the dashboard on your computer. It keeps nothing.
3. Ask for these permissions: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `business_management`, `instagram_basic`, `instagram_manage_comments`, `instagram_manage_insights`. The last one is what Business Discovery needs (below). While the app is in development they work for the app's own admins and testers; others need App Review. Every permission SocialMonitor asks for must be added to the app's use cases first, or Facebook's sign-in answers "Invalid Scopes".
4. Add the app's keys to `.env` at the repository root:

```bash
META_APP_ID=
META_APP_SECRET=
```

5. Restart, open the brand's About page and press **Connect with Facebook**. Pick the brand's Page; its Instagram comes with it.

The Page token stays in `data/socialmonitor.db` on your computer and does not expire while you keep admin access to the Page. **Disconnect** deletes it. To use your own hand-back page, set `META_REDIRECT_URI`.

The About page says under each Instagram and Facebook link how it is read: the connected account, an official route below, or the browser.

## Reading brands you don't manage

A brand you watch but do not run (a competitor, a client before it connects) has no Page you can connect. Meta offers two official routes for its public data. Both run on the token of a Page you **do** manage, connected on any brand.

### Instagram: Business Discovery (on)

Business Discovery lets one Instagram professional account look up another by its username and read its public profile and posts. Docs: [Business Discovery guide](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery), [IG User Business Discovery reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery), [IG Media fields](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media).

- **What it needs.** Your own Instagram professional account (business or creator), linked to a Facebook Page you manage, connected here with **Connect with Facebook**. Permissions: `instagram_basic`, `instagram_manage_insights` and `pages_read_engagement`. If your role on the Page comes through a business portfolio (Business Manager) rather than the Page itself, Meta also asks for `ads_read` or `ads_management`. The call is made on your account's Instagram id: `GET /{your-ig-user-id}?fields=business_discovery.username({their-username}){…}`.
- **What it returns.** For the other account: `username`, `followers_count`, `media_count` and the `media` edge, paged with `before` and `after` cursors (`media.after(cursor).limit(n)`). For each post: `id`, `caption`, `timestamp`, `permalink`, `shortcode`, `media_type`, `media_product_type`, `media_url`, `thumbnail_url`, `like_count`, `comments_count` and `view_count` (reels, paid and organic together; Business Discovery only). `like_count` is missing when the owner hides likes, and `media_url` when the post holds copyrighted material. `total_views_count`, `shares_count` and `saved_count` are not available this way.
- **What it does not return.** No comment text, no commenters and no insights: only `comments_count`. Opening a returned post by its id fails by design. Accounts that are personal, private or age-restricted are not returned.
- **Limits.** Business Discovery uses the Graph API's platform rate limit, about 200 calls per hour for each person using the app ([rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)), not Instagram's per-account limit. SocialMonitor makes one call per 25 posts per profile per update, so a brand costs one or two calls.
- **Development mode.** Without App Review the app has Standard Access, which serves accounts whose owners have a role on the app ([access levels](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/overview)). Business Discovery runs on your own account, so it works in development mode for you as the app's admin. Advanced Access, App Review and business verification are needed only if people without a role on the app connect their own accounts.

How SocialMonitor uses it: once any Instagram account is connected, every other brand's Instagram profile is read this way instead of the browser. Posts and their counts land in the same posts and history as before (the post ids are the website's, worked out from each post's shortcode, so a post read from the web earlier stays the same post). Each update logs that comment text is not available through this route. If Meta refuses (the account is not professional, the permission is missing, the hour's calls are used up), the log says so in plain words and that update reads the profile from the web as before.

### Facebook: Page Public Content Access (off until approved)

Page Public Content Access (PPCA) is a feature, not a permission: it lets an app read public data of Pages it has no role on: posts, engagement counts and public comments, through `/{page}/feed`, `/{page}/posts`, `/{post}` and `/{post}/comments`, plus the Pages Search API. Docs: [Page Public Content Access](https://developers.facebook.com/docs/features-reference/page-public-content-access).

- **What it needs.** App Review for the feature and a verified business (Meta may also ask for extra terms). Until it is approved, the app can read only Pages whose admins have a role on the app, so it cannot read a Page like the test brand's.
- **Allowed use.** Meta allows it for analysing or showing posts and engagement on Pages. Requests for other uses come back "not needed based on your submission details".
- **What SocialMonitor reads with it.** `META_PPCA=on` in `.env` turns it on (it is off by default). Every other brand's Facebook profile is then read from `GET /{page-name}/posts` with each post's text, time, link, picture and its reaction, comment and share counts, using a connected Page's token. Comment text is not read on this route yet. Without approval Meta refuses every call; the log explains that and the browser reads the Page.

**Submitting it for App Review:**

1. In the app dashboard: App Review → Permissions and Features → **Page Public Content Access** → Request. Business verification of the portfolio must be complete first (Settings → Basic → Verification).
2. Use-case description: SocialMonitor is a self-hosted dashboard a business runs on its own computer to follow the public Facebook Pages of brands it watches (its own sector, its clients). It reads each Page's public posts and their reaction, comment and share counts to chart engagement over time. It only reads; it never posts, and nothing leaves the user's computer.
3. Screencast: sign in to the dashboard, open a brand, show its Facebook link and the route line under it on About, run **Update**, then show the posts and their counts on Statistics. Meta accepts a recording made with your own Pages while live data is not yet available, if you say so in the notes.
4. Give reviewers a way in: a test account for the dashboard (or step-by-step notes if it cannot be reached from outside), and the Page names to try.
5. Once approved, set `META_PPCA=on` and restart.

### Other routes

- **Hashtags.** [Hashtag Search](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/hashtag-search) (`ig_hashtag_search`, then `/{hashtag-id}/top_media` and `/recent_media`) finds public posts with a hashtag, up to 30 different hashtags per account in a rolling seven days. It needs App Review for the **Instagram Public Content Access** feature and `instagram_basic`. Useful later for campaign hashtags; not built.
- **Mentions and tags.** [Mentions](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/mentions) (`/{ig-user-id}/tags`, `mentioned_media`, `mentioned_comment`, the `mentions` webhook) cover posts and comments that tag or @mention **your own** connected account, not another brand's. Useful for a connected brand's own monitoring; not built.
- **Meta Content Library.** For not-for-profit research organisations only ([eligibility](https://transparency.meta.com/researchtools/meta-content-library)); it does not fit a commercial tool.
