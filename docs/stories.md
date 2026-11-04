# Stories

The Stories tab keeps what a brand and its competitors post as stories, which last a day on the networks: every story SocialMonitor finds is kept with its video or picture after it is gone, with Claude's reading of what it is about and the figures over all of them.

## The plan

What a brand's people see is set per brand by super admins, in the brand's **Admin** tab under **Plan** (it takes over the earlier **Dashboards** box):

| Part | What it gives the brand's admins and viewers | For brands from before the plan |
| --- | --- | --- |
| Share of voice | The tab, its rivals in Settings and their reads | As its switch stood (on unless turned off) |
| Competitors tracked | How many rivals it may track, 0 to 5 | At least as many as it tracked, and 3 at least |
| Stories | The Stories tab with the brand's own stories | Off |
| Competitor stories | The tracked rivals' stories in the same tab | Off |
| Ads | Nothing: Ads is for super admins only ([Ads](ads.md)) | As its switch stood |

- A part that is off is not drawn for the brand's people, and its routes answer **403** to them. Super admins, who set the plan, always see every tab.
- At the limit, adding a rival is refused with "Your plan tracks up to N competitors. Ask SocialMonitor to raise it." in the reader's language.
- Lowering the limit never deletes a rival: the rivals added last are **paused**, kept with everything read so far, marked in Settings and left out of updates and stories checks. Raising the limit resumes them.
- Every change is kept in the audit log without the brand's id, so only super admins read it.
- The plan lives in `brand_plans`. The first start of this version copies `brand_dashboards` into it once per brand and leaves that table as it was.

## Where stories come from

**TikTok, logged out.** For the brand's own TikTok (with Stories on) and its active rivals' (with Competitor stories on), SocialMonitor opens the public profile, which says whether the account has a story up (`UserStoryStatus`), and then the story list the TikTok web app itself loads (`/api/story/item_list/?authorId=…`). First from Node with no cookies; where TikTok's "Please wait" check stops that, from a throwaway logged-out browser, the same one the post reader uses. No account, cookie or login is ever used. A captcha or the check ends the read until the next one.

**Instagram and Facebook, through Meta's official API**, only for the brand's own Page connected on **About**, and only once `META_STORIES=on` is set in `.env`: SocialMonitor's Meta app review is not approved yet, so the route is built and tested but off. Then it reads `/{ig-user-id}/stories` and `/{page-id}/stories`, with each Instagram story's insights (reach, replies, taps forward and back, exits, shares, follows, profile visits). Meta offers no route to anyone else's stories, so competitors' stories come from TikTok only. The tab says so while it is off.

## When

Every three hours for each brand whose plan has Stories or Competitor stories, the brands a few minutes apart. A check waits while an update, an Ads read, a restore, or other heavy work on the computer (the shared lock `/tmp/shades-heavy.lock`) runs. **Check stories now** runs one at once: a super admin's reads the brand and its active rivals whatever the plan says; a brand admin's follows the plan.

## What is kept

A row per story in `stories`, never deleted: the network, the account and its brand, the story's id, when it was posted and when it expires, when SocialMonitor first and last saw it, its caption, the words on its stickers, the accounts it tags, links, its music, its views, likes, shares and replies where the network shows them, and Instagram's insights when connected.

Its files, in `story_media`:

- **The original**, at the best quality the network offers (TikTok's highest-resolution rendition, whatever its codec), in `data/stories/`, outside `data/media`. It stays **10 days** (`STORIES_ORIGINAL_DAYS`) for **Download original**; a daily cleanup then deletes it.
- **A compact copy, kept for good**, in `data/media/stories/`: a video as H.264 High, CRF 24 (`STORIES_CRF`), preset slow, at its own size, AAC 96 kb/s, with `+faststart`, so every browser plays it, Safari included; a picture as WebP quality 82 at its own size. When the original is already H.264 and no encode makes it smaller (TikTok's own renditions often are), the original itself, moved into a quick-start MP4, is the copy.
- **A poster**, 360 px wide WebP, for the gallery.

Encoding runs in the background, one file at a time, at the lowest CPU and disk priority (`nice`, `ionice`), under the shared lock where the computer has one (`SOCIALMONITOR_HEAVY_LOCK`, `off` to skip it). A file whose compact copy failed keeps its original. Admin's **Data held** shows the originals still held, the copies kept and the space saved.

Measured on live stories, 4 November 2026 (SSIM 1 is identical; above 0.99 looks the same on a phone and a laptop):

| Original | Compact copy | SSIM | PSNR |
| --- | --- | --- | --- |
| Photo, JPEG 720 × 1280, 73.0 KB | WebP q82, 44.8 KB (61%) | 0.996 | 45.6 dB |
| Video, HEVC 720 × 1280, 10 s, 344 KB | H.264 CRF 24, 674 KB (196%) | 0.997 | 44.8 dB |
| Video, H.264 576 × 1024, 17 s, 1.53 MB | H.264 CRF 24 would be 1.66 MB, so the original, re-wrapped, is kept: 1.53 MB | 1 | – |

The CRF ladder on that last video: CRF 22, 1.90 MB, SSIM 0.9959; CRF 24, 1.66 MB, 0.9944; CRF 26, 1.43 MB, 0.9922; CRF 28, 1.22 MB, 0.9894. CRF 24 gives the smallest file that stays above 0.994 on both videos.

## Claude's reading

Once a story's files are ready, Claude (the brand's AI, on the Claude subscription, recorded as **Reading stories** in Admin's usage) reads its caption, stickers, tags and music with its picture, or three frames of a video side by side, and answers: what it is about in a sentence, its kind (promotion, product, event, repost, behind the scenes, customer content, announcement, other), the words shown on it, the accounts it names, its tone, and for a repost, whose content it shares. Mentioned accounts link to their profiles. Brands with the AI off are skipped; while Claude is at its usage limit, readings wait; a failed reading is tried again six hours later.

## Who sees what

- The tab, its routes and its files follow the plan: a brand's people see the brand's own stories with Stories on, and its rivals' with Competitor stories on. Super admins see both always.
- Story files under `/media/stories/<brand>/` answer only to someone who may see that story, by any spelling of the path, with byte ranges so videos play in Safari. Originals are handed out only by `/api/stories/:id/download`, with the same check, and each download is in the audit log.
- Nothing about stories goes into exports, reports, emails or the MCP server.
