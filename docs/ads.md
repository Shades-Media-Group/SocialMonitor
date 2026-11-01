# Ads

The Ads dashboard shows what Meta's public [Ad Library](https://www.facebook.com/ads/library/) lists for a brand's own Facebook Page and its competitors' Pages: every ad running now and every ad that ran before, kept in the database so the history stays after Meta stops showing an ad.

## Who sees it

Only super admins. A super admin turns it on per brand in that brand's **Admin** tab, under **Dashboards**; it is off for every brand until then. A brand's own admins and viewers never see it, even when it is on:

- the **Ads** tab is drawn only for super admins;
- every `/api/brands/:id/ads…` and `/api/brands/:id/dashboards` route answers 403 to anyone else, and 404 while the brand's switch is off;
- `/api/brands` tells a brand's own people nothing about the switch;
- the ad pictures under `/media/ads/` answer 404 to anyone but a super admin;
- nothing about ads goes into exports, PDF and Excel reports, emails, the MCP server or search;
- turning a switch on or off is kept in the audit log without the brand's id, so only super admins read it.

The same **Dashboards** box holds the **Share of voice** switch. It is on for every brand until a super admin turns it off. Off, the tab, its rivals in Settings and their routes are gone for everyone, and updates skip the rivals; what was already read stays.

## What it reads

For each Page on the list, the Library page `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=<CC>&view_all_page_id=<ID>&media_type=all`, the same page anyone can open. Per ad it keeps:

- the Library ID, the Page's id and name, and whether it runs now;
- the day it started and, for a stopped ad, the day it ended;
- the platforms (Facebook, Instagram, Messenger, Audience Network, WhatsApp, Threads);
- the text, headline, caption, call to action and link;
- the picture, or a video's still, saved small in `data/media/ads/` so it outlives Meta's expiring links;
- how many ads use the same creative, where Meta groups them;
- reach, impressions and spend, only where the Library shows them publicly (political and issue ads, and ads in the EU).

Rows are keyed by Library ID and never deleted. `first_seen_at` and `last_seen_at` say which reads found each ad. Removing a Page from the list, or a brand, keeps its ads.

## How it reads

Logged out, with no account of any kind. Each read starts a fresh, throwaway Chrome (the same logged-out browser TikTok uses), separate from the browser profile in `data/browser`, with no saved cookies; it closes when the read ends. It never signs in, never uses a Facebook or personal account, and never uses Meta's Ad Library API. Where Meta asks about cookies, it keeps only the essential ones.

The page carries its first ads in its own HTML and loads the rest as it scrolls; SocialMonitor reads that JSON, not the drawn page.

Pacing: one Page at a time, a few seconds between pages and between scrolls, and at most 200 ads per Page in one read (the table says how many the Library holds when there are more).

**A login wall or a captcha ends the read.** Nothing after it is asked for, the read's status says "Meta asked for a login", and what was read before it is kept. Try again later.

## Running it

**Update ads** on the Ads tab reads every Page on the list in the background; the line beside it follows the read and **Stop reading** ends it after the page it is on. It needs no AI. A read waits for nothing and blocks nothing for long: it does not start while an update runs, and an update started during it waits for it to end. A read is not part of a brand's normal update or its schedules.

## Adding Pages

Paste the Page's numeric ID, or its Ad Library link (the number after `view_all_page_id=`). A link to a Page by name (`facebook.com/Name`) carries no ID: search the Ad Library for the name, open the Page's ads and copy that link. Up to 12 Pages per brand. **Country** sets where the Library is searched; **All countries** searches everywhere.

## Checked live

On 2026-11-01, read logged out from the PC in Moldova: Moldtelecom (Page 493563500503276) 4 ads, and three other Pages with 75, 166 and 200 of 714 ads, with no login wall.
