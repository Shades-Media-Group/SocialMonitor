# Privacy policy

_Last updated: 15 October 2026_

SocialMonitor is an app you run on your own computer, made by Shades Media Group. This policy covers the app and its website, socialmonitor.shades.md.

## The short version

Shades Media Group receives nothing. Everything SocialMonitor collects stays on your computer. Two things leave it: the text it asks Claude to read, which goes to Anthropic through your own account, and the first five characters of a new password's fingerprint, to check it against known breaches.

## What the app collects, and where it goes

- **Posts and comments** from the public profiles you add, read through a browser profile on your computer. These include the names and words of the people who comment.
- **It stores them** in a database in the `data/` folder, on your computer only.
- **To describe posts and sort comments,** their text and each post's cover picture are sent to Claude through the Claude Code or Anthropic API key you configure. [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) covers that step.
- **To sum up each brand's week,** once a day after an update, Claude gets that week's comment counts against the week before and the text of a few top complaints and questions, clipped. Brands with the AI turned off are left out.
- **To draft a reply** when someone asks for one, Claude gets that comment, its author's name, the post's caption and the brand's saved replies.
- **For ideas for the next post,** when an admin asks, Claude gets the brand's best and weakest posts of the last 90 days with their figures, its best formats and hours, and up to 40 questions and suggestions people left.
- **To place posts in campaigns** that their hashtags and keywords did not match, Claude gets the post's caption and description and the brand's campaigns. Brands with the AI turned off are left out.
- **If you connect a brand's own Facebook Page,** Facebook returns you to the website's `/connect/meta/` page with a one-time code, which it passes straight to SocialMonitor on your computer and keeps nothing. SocialMonitor then reads that Page's posts and comments, and those of the Instagram account linked to it, through Meta's API, and keeps them and the Page's access token on your computer only.
- **Sign-in emails,** if you set up email, carry only a code or a link to the people you invite, through the mail server you configure.
- **People's accounts** (names, emails, usernames and hashed passwords) stay in the database on your computer.
- **When someone chooses a password,** the first five characters of its SHA-1 fingerprint go to [Have I Been Pwned](https://haveibeenpwned.com/Passwords), which answers with every breached fingerprint that starts with them; the match is made on your computer, so neither the password nor its full fingerprint leaves it. `SOCIALMONITOR_HIBP=off` in `.env` turns this check off.
- **Two-step sign-in** (passkeys, authenticator codes, recovery codes) and the list of signed-in devices (browser, system, address and, through the tunnel, the country Cloudflare reports) stay in the database on your computer.
- **Reports and exports** are files you save; they go wherever you put them.
- **Saved accounts** (usernames, passwords and notes you choose to keep) are encrypted on your computer and never leave it.
- **Remote access**, if you set it up, passes through your own Cloudflare account and is limited to the people your Cloudflare Access policy allows.

## Your responsibilities

Comments are personal data. If you run SocialMonitor for an organisation, it is the controller of that data. Watch only profiles you have a reason to watch, keep data no longer than you need (Settings → Keep data for), and respect the networks' terms. Delete a brand to delete all of its posts and comments.

## The website

The website is static. It sets no cookies and loads no third-party scripts, fonts or trackers. A display preference you choose stays in your browser.

## Data we receive

None. There are no accounts, analytics, crash reports or tracking of any kind.

## Changes

Changes to this policy are published in this file and noted in the [changelog](CHANGELOG.md).

## Contact

support@shades.md · [Shades Media Group](https://shades.md)
