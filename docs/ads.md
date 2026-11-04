# Ads

The Ads dashboard shows what Meta's public [Ad Library](https://www.facebook.com/ads/library/) lists for a brand's own Facebook Page and its competitors' Pages: every ad running now and every ad that ran before, kept in the database so the history stays after Meta stops showing an ad.

## Who sees it

Only super admins. A super admin turns it on per brand in that brand's **Admin** tab, under **Plan**; it is off for every brand until then. A brand's own admins and viewers never see it, even when it is on:

- the **Ads** tab is drawn only for super admins;
- every `/api/brands/:id/ads…`, `/api/brands/:id/dashboards` and `/api/brands/:id/plan` route answers 403 to anyone else, and 404 while the brand's switch is off;
- `/api/brands` tells a brand's own people nothing about the switch;
- the ad and Page pictures under `/media/ads/` answer 404 to anyone but a super admin, by any spelling of the path;
- nothing about ads goes into exports, PDF and Excel reports, emails, the MCP server or search;
- turning a switch on or off is kept in the audit log without the brand's id, so only super admins read it.

The same **Plan** box holds **Share of voice**, Stories and the competitor limit ([Stories](stories.md)). Share of voice is on for every brand until a super admin turns it off. Off, the tab, its rivals in Settings and their routes are gone for the brand's people (403), super admins still see it, and updates skip the rivals; what was already read stays.

## What it reads

For each Page on the list, the Library page `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=<CC>&view_all_page_id=<ID>&media_type=all`, the same page anyone can open. Per ad it keeps:

- the Library ID, the Page's id and name, and whether it runs now;
- the day it started and, for a stopped ad, the day it ended;
- the platforms (Facebook, Instagram, Messenger, Audience Network, WhatsApp, Threads);
- the text, headline, caption, link description, call to action (its words and its kind, such as `SHOP_NOW`) and link;
- every creative, in order (table `ad_media`): a carousel's cards, a dynamic ad's versions, the pictures of a multi-picture ad, or its one picture or video, each with its own headline, text, link and call to action where it has them, up to 30 per ad;
- each creative's picture, or a video's still, saved in `data/media/ads/` with its width and height, so it outlives Meta's expiring links and is drawn at its own shape. Meta's resized pictures are 20–80 KB and a video still up to about 250 KB; a file over 1.5 MB is not kept, and full-size originals are never fetched;
- videos are **not** downloaded. Their links stay with the time Meta's link expires; the pop-up plays the video from Meta only when it is pressed, and after the link expires it shows the still and a link to the ad in the Library. The next read brings fresh links;
- the Page's small picture (once per Page, in `data/media/ads/pages/`), its address, likes and categories;
- how many ads use the same creative, where Meta groups them;
- "Paid for by", the category (political or issue ads), the countries Meta names, and Meta's label for digitally made or changed media, where the Library shows them;
- reach, impressions and spend, only where the Library shows them publicly (political and issue ads, and ads in the EU).

Rows are keyed by Library ID and never deleted. `first_seen_at` and `last_seen_at` say which reads found each ad. Removing a Page from the list, or a brand, keeps its ads. Ads read before creatives were kept still show, with their one picture, until the next read fills in the rest.

Read logged out from Moldova, the Library's list does not carry the ad's languages, its targeting, or the EU transparency breakdowns (reach by age, gender and country); those appear only on an ad's own details for ads delivered in the EU, which SocialMonitor does not open.

## Seeing the ads

**Cards** (the default) draw each ad as it runs in a feed: the Page and whether it runs, the text, the creative at its own shape (a 9:16 video stays tall, a carousel shows every card as you swipe or use the arrows), then where it leads and its button's words. **List** is the compact list. The choice is kept with your account.

A card opens a pop-up with the creative large, its full text and every field kept; the address gets `#ad=<Library ID>`, so the pop-up can be linked and Back closes it. The arrows (or the arrow keys) move to the previous and next ad.

The filters are the advertisers (several at once), running or stopped, media (picture, video, carousel, text only), platform, call to action, when it started (the last 7, 30 or 90 days, or between two days) and words in the headline, text or links; each choice shows how many ads it would leave. Sort by newest start, longest running or most versions. The filters live in the address, so a view can be linked, and the last ones used on a brand come back next time. 48 ads load at a time.

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

On 2026-11-02, the same way: Moldtelecom 4 ads and Orange Moldova (Page 117246441643821) 71 ads with all their creatives, 245 pictures in 12 MB; a 9:16 video played from Meta's link in the pop-up.
