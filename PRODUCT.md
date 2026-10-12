# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Two surfaces share the Shades design system:

- **The dashboard:** a local web app served by `yarn start` at `http://localhost:4400`. It is never hosted: each user clones the repository and runs it on their own computer. Everyone signs in (a password and an emailed code), and each person sees only the brands they belong to, as a viewer or an admin.
- **The website**, socialmonitor.shades.md: a static site on a Cloudflare Worker, in the eleven Shades languages (English at `/`, French, Romanian, Russian, Spanish, Italian, Turkish, Hindi, Japanese, Simplified and Traditional Chinese). The dashboard is in English for now.

## Stack

TypeScript, Preact, Vite and Vitest in a Yarn 1 workspace, like PageRecast and ImageRefold. The server runs on Node 22.18+ with native type stripping. Data lives in SQLite through `node:sqlite`, so there is no native module to compile. Playwright reads the networks through a browser profile on the user's machine. The MCP server uses the official TypeScript SDK.

## Users

- **Brand and social media managers** who answer for what customers say under their posts.
- **Agencies** watching several client brands, and the brands those clients compete with.
- **Customer support teams** who need the complaints buried in comment sections.

They check the dashboard daily, on a laptop, often between meetings. They need the bad news first: the complaint, the post it sits under, and how many people agree.

## Product Purpose

Know what people say about a brand on social media without reading every comment. SocialMonitor keeps every post and comment, describes each post, and sorts the comments into praise, questions, complaints and the ones that need an answer. Success means a manager opens one report and knows which comments to answer today.

## Positioning

A free, open-source social listening tool that runs on your own computer:

- **No subscription:** free forever, with no seats, plans or limits.
- **Your data stays yours:** the database and reports never leave your machine.
- **AI that explains, not only counts:** each post described and each comment sorted, with the reason.
- **Claude-native:** an MCP server lets Claude answer questions about the data.

Made by Shades Media Group.

## Operating Context

1. The user adds a brand and its profile links on Instagram, Facebook and TikTok.
2. **Update:** they press Update, choose the brands, the networks, and new posts or all posts. SocialMonitor reads the posts and comments, stores them, and sorts the new comments.
3. **Report:** each update ends with a report: new posts and what they are about, the comments that need an answer, the share of praise and complaints, and changes since the last update.
4. **Schedule (optional):** every N hours, daily, or at set times of day, per brand.
5. **Freshness:** every brand and network shows when it was last updated, and whether that update worked.
6. **Export and import:** the whole database, or one brand, as a file.

## Capabilities and Constraints

**Constraints**

- **Free forever:** no payments, tiers, limits, trials or upgrade prompts.
- **Local only:** no SocialMonitor server, accounts, analytics or remote logging. The one outbound flow is comment and post text sent to Claude for sorting, through the user's own Claude Code or API key.
- **Licence:** MIT © Shades Media Group. The name and logo are reserved (TRADEMARKS.md).

**Platform limits**

- The networks offer no public API for other people's comments. SocialMonitor reads them through the user's own browser session. Their terms restrict automated access, so the documentation recommends a separate account and gentle schedules.
- Comments contain personal data. Users keep it on their own machine, and set how long it is kept.
