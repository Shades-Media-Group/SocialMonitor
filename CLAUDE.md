# SocialMonitor: working notes for agents

SocialMonitor watches brands on Instagram, Facebook and TikTok. It keeps every post and comment in a local database, describes each post, and sorts the comments into good and bad with AI. It is a local dashboard people clone and run, plus a website at socialmonitor.shades.md. It is free, open source and part of the Shades family with PageRecast and ImageRefold. Product truth lives in [PRODUCT.md](PRODUCT.md); the patterns every Shades product avoids live in Gradient's [lessons](https://github.com/Shades-Media-Group/gradient/blob/main/docs/lessons.md). Read both before any visual work.

## Commands

```bash
yarn verify        # typecheck, lint, unit tests, site build and SEO check: before every commit
yarn start         # the dashboard and scheduler at http://localhost:4400
yarn mcp           # the MCP server on stdio
yarn dev:site      # the website with live reload
yarn deploy:site   # build, check, wrangler deploy to socialmonitor.shades.md
yarn deploy:verify # check production: Access in front, HSTS, the PC on the tip of main (docs/server.md#production)
yarn brand         # regenerate every logo file from one geometry
yarn release <patch|minor|major>   # then git push --follow-tags
```

Use Node 22: `export PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH`; the shell defaults to an older Node.

## Non-negotiables

- **Free forever:** no payments, plans, limits, accounts or upgrade prompts.
- **The dashboard is never hosted.** It runs on the user's computer and binds to `127.0.0.1` only. Only the website is deployed.
- **Data stays local:** the database, the browser profile and reports live in `data/` (git-ignored). No analytics or remote logging. The outbound flows are text sent to Claude for sorting and the five-character password prefix sent to Have I Been Pwned's range API; each must stay described exactly in PRIVACY.md and on the site.
- **Manual by default:** nothing runs until the user presses Update or turns on a schedule.
- **Token-lean storage:** the MCP tools and reports read compact rows (ids, short text, labels, counts), never raw page dumps.
- **Credits:** in the product, "Free and open source. Built by Shades Media Group". In the README, "Built by Cristian Brinza | Shades Media Group".
- **Never name or compare against other products in anything public:** README, docs, UI, site, commits.
- **Never invent proof:** no made-up numbers, users, ratings or testimonials.
- **One source per value:** the logo geometry in `scripts/brand.mjs`; generated files are never edited by hand.
- **Commits:** conventional, one logical change each, no AI attribution or Co-Authored-By lines.
- **Email:** every email is built with `shades-gradient/email` and follows Gradient's [email guide](https://github.com/Shades-Media-Group/gradient/blob/main/docs/guides/email.md). One-time codes lead the subject with the code and sit on the copyable code pass. Meetings attach an .ics invitation with Google and Outlook links. Bookings get a ticket pass and schema.org markup. Each kind ships a test that checks these.

## Brand

- **Mark:** "Share of voice", a speech bubble cut like a pie chart. The bottom-left corner is square (the tail); the other corners have radius 24 on a 96 grid. Left half red, top-right quarter rose, bottom-right quarter ink. On dark grounds the ink quarter turns paper; on red grounds the red half turns paper.
- **Palette:** the family's: red `#F9000A`, rose `#FF8299`, ink `#0A0A0B`, paper `#FDFDFC`. Rose appears only inside the mark.
- **Type:** Space Grotesk 700 for the wordmark, Hanken Grotesk for everything else.

## Design rules

The dashboard is built on Gradient's components and tokens and follows its [tool panel guide](https://github.com/Shades-Media-Group/gradient/blob/main/docs/guides/tool-panels.md): labelled rows, three type sizes, one red primary action per view, light by default with the theme in Settings. Charts, the dashboard shell, KPI figures and sortable tables come from Gradient, so every Shades product shares them. Never ship any of these:

- cards inside cards, KPI tiles with icons in circles, lists in rounded boxes, tinted callout boxes, coloured side borders
- monospace for numbers or metadata (use tabular figures, `.g-num`); monospace is for code only
- eyebrow labels, tracked small caps above headings, decorative section numbers
- an icon on every row, emoji or Unicode glyphs as icons
- gradient text, glass, glow, decorative blur, 3D or shadowed logos
- skeleton illustrations, or screenshots with real people's data. Website screenshots come from `scripts/demo-data.ts` (Tavelo, an invented brand; never telecom examples) through `scripts/demo-shots.ts`, and the site says the brand is made up

Before committing UI:

1. Look at the changed screens in light and dark, at 375 and 1440 px.
2. Run `impeccable detect` on the changed templates and CSS.
3. Run `yarn verify`.

## Versions

The root `package.json` version is the only version; `yarn release` bumps every workspace, writes the changelog and tags.
