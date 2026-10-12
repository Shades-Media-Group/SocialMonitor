---
name: SocialMonitor
description: The local dashboard for what people say under a brand's posts, drawn in Gradient, the Shades design system.
colors:
  mark-red: '#f9000a'
  mark-rose: '#ff8299'
  mark-ink: '#0a0a0b'
  instagram-mark: '#e1306c'
  facebook-mark: '#1877f2'
typography:
  page-name:
    fontFamily: 'var(--g-font-display)'
    fontSize: 'clamp(48px, 6.4vw, 88px)'
    fontWeight: 600
    lineHeight: 0.95
    letterSpacing: '-0.035em'
  statement:
    fontFamily: 'var(--g-font-display)'
    fontSize: 'clamp(28px, 3.4vw, 44px)'
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: '-0.02em'
  brand-name:
    fontFamily: 'var(--g-font-display)'
    fontSize: '32px'
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-0.02em'
  figure:
    fontFamily: 'var(--g-font-display)'
    fontSize: '28px'
    fontWeight: 600
    lineHeight: 1
    fontFeature: 'tnum'
  headline:
    fontFamily: 'var(--g-font-display)'
    fontSize: '20px'
    fontWeight: 600
    letterSpacing: '-0.01em'
  lead:
    fontFamily: 'var(--g-font-body)'
    fontSize: '17px'
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: 'var(--g-font-body)'
    fontSize: '15px'
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: 'var(--g-font-body)'
    fontSize: '14px'
    fontWeight: 400
  meta:
    fontFamily: 'var(--g-font-body)'
    fontSize: '13px'
    fontWeight: 400
  label:
    fontFamily: 'var(--g-font-body)'
    fontSize: '12px'
    fontWeight: 600
  code:
    fontFamily: 'var(--g-font-code)'
    fontSize: '13px'
    lineHeight: 1.6
rounded:
  pill: 'var(--g-radius-pill)'
  panel: 'var(--g-radius-lg)'
  cover: '16px'
spacing:
  gutter: '40px'
  gutter-phone: '16px'
  page-max: '1200px'
  top-bar: '64px'
  top-bar-phone: '56px'
  head-gap: '40px'
  section-gap: '56px'
  stack: '24px'
components:
  button-primary:
    backgroundColor: 'var(--g-accent)'
    textColor: 'var(--g-on-accent)'
    rounded: '{rounded.pill}'
    height: '36px'
    padding: '0 16px'
  button-secondary:
    backgroundColor: 'var(--g-surface)'
    textColor: 'var(--g-text)'
    rounded: '{rounded.pill}'
    height: '36px'
  section-tab:
    textColor: 'var(--g-text-2)'
    typography: '{typography.body}'
    padding: '14px 14px 13px'
  section-tab-active:
    textColor: 'var(--g-text)'
  netswitch-option:
    backgroundColor: 'transparent'
    textColor: 'var(--g-text-2)'
    rounded: '{rounded.pill}'
    padding: '5px 12px'
  netswitch-option-active:
    backgroundColor: 'var(--g-surface)'
    textColor: 'var(--g-text)'
  segmented-option-active:
    backgroundColor: 'var(--g-surface)'
    textColor: 'var(--g-text)'
    rounded: '{rounded.pill}'
    padding: '6px 14px'
  label-pill:
    typography: '{typography.label}'
    rounded: '{rounded.pill}'
    height: '22px'
    padding: '0 9px 0 7px'
  rate-pill:
    backgroundColor: 'transparent'
    textColor: 'var(--g-text-2)'
    rounded: '{rounded.pill}'
    height: '28px'
    padding: '0 12px'
  commenter-face:
    rounded: '{rounded.pill}'
    size: '36px'
  brand-reply-tag:
    backgroundColor: 'var(--g-info-soft)'
    textColor: 'var(--g-info)'
    rounded: '{rounded.pill}'
    padding: '1px 8px'
  chip-selected:
    backgroundColor: 'var(--g-text)'
    textColor: 'var(--g-bg)'
    rounded: '{rounded.pill}'
    padding: '6px 14px'
---

# Design System: SocialMonitor

## Overview

**Creative North Star: "The Brand Ledger"**

SocialMonitor inherits Gradient, the Shades design system (npm `shades-gradient` 0.5.0, live at gradient.shades.md). Every colour role, ramp, font stack, radius, shadow, duration and easing comes from Gradient's tokens (`node_modules/shades-gradient/dist/tokens.css`) and is referenced here by name (`--g-bg`, `--g-danger-soft`, `--g-blue-100`), never re-declared. Gradient's components (`g-btn`, `g-segmented`, `g-table`, `g-input`, `g-link`, `g-num`, `g-icon-btn`) are used as shipped. This file records only SocialMonitor's own decisions on top: the page grid and widths, the type scale it actually uses, its signature components and their states, its responsive rules, and the lessons that bind it.

The product is brand-first. Home is a list of brands on hairlines. Each brand page reads like a Gradient page: a big Space Grotesk name on the left, a "what it is" lead on the right, Gradient's sticky text section bar (Overview, Comments, Posts, Reports, Schedules, About) with a network switch on its right, then the body. The overview opens with one sentence in the display face, not a row of KPI tiles. Comments read as threads, posts as a contact sheet of real covers. There is no sidebar nav and no card grid.

The ground is Gradient's paper (`--g-bg`), light by default; dark follows Gradient's own dark tokens with no SocialMonitor overrides beyond the mark's ink quarter. Colour appears only where it means something.

**Key Characteristics:**

- Inherits Gradient; references its tokens by name, adds no colour roles of its own.
- Brand-first navigation: brand list, then brand page with a sticky text section bar.
- Hairline lists and tables; one surface panel at most per view.
- Pill controls throughout; one red primary action per view.
- Colour is meaning: network marks, label roles, ratings, commenter initials, the mood bar.
- A display-face statement sentence leads the overview instead of KPI tiles.

## Colors

The palette is Gradient's paper and ink with role colours spent only on meaning; SocialMonitor's own hexes are the logo mark and the networks' own marks.

### Primary

- **Gradient Red** (`--g-accent`): the one primary button per view (Update, Save, Add). Its text sibling `--g-accent-text` carries the overview statement's inline action and a running report's status.
- **Mark Red** (#f9000a), **Mark Rose** (#ff8299), **Mark Ink** (#0a0a0b; paper `#fdfdfc` in dark): the three fills of the "share of voice" logo mark. They live in the mark and nowhere else.

### Secondary

- **Network marks**: Instagram (#e1306c) and Facebook (#1877f2) draw in their own colours; TikTok draws in `--g-text`. These are the networks' identity, which is why they are the only raw hexes outside the logo.

### Tertiary (meaning roles, all Gradient)

- **Trouble** (`--g-danger`, `--g-danger-soft`, `--g-danger-fill`): Complaint pills, Negative ratings, complaint tallies, the "to answer" figure when non-zero, error statuses, the flagged-post badge, the delete action.
- **Good news** (`--g-success`, `--g-success-soft`, `--g-success-fill`): Praise pills, Positive ratings, praise tallies, healthy statuses.
- **A question waits** (`--g-info`, `--g-info-soft`): Question pills and the "Brand reply" tag.
- **Suggestion** (`--g-warning`, `--g-warning-soft`): Suggestion pills.
- **Commenter initials**: one of six hues per author, `--g-{blue,violet,pink,orange,amber,green}-100` disc with `-800` text; the brand's own face is inverted (`--g-text` disc, `--g-bg` letters).
- **Mood bar**: complaint `--g-danger-fill`, question `--g-blue-500`, suggestion `--g-amber-500`, praise `--g-green-500`, neutral `--g-ink-300`, spam `--g-ink-200`.

### Neutral

- **Paper** (`--g-bg`): page ground, top bar, section bar and save bar (sticky surfaces sit on the ground colour, not a tint).
- **Surface** (`--g-surface`): the selected pill in a switch, the add-brand panel, the JSON editor, sheets.
- **Sunken** (`--g-sunken`): row hover, tally tracks, cover placeholders, Neutral label pill.
- **Lines** (`--g-line`, `--g-line-strong`): every hairline; strong for list tops and resting pill outlines.
- **Text** (`--g-text`, `--g-text-2`, `--g-text-3`): primary, secondary (tabs, leads, labels), quiet (meta, hints, counts' captions).

### Named Rules

**The Meaning-Only Rule.** A colour appears only when it says something: a network, a label, a rating, a person, a share. No decorative tint, no accent wash, no coloured section.

**The Mark-Only Rule.** Mark Red, Rose and Ink are for the logo. Interface red is always Gradient's `--g-accent` or `--g-danger` family.

**The Colour-Once-Chosen Rule.** Rating pills are outlined and grey until pressed; only the chosen rating takes its role fill.

## Typography

**Display Font:** Space Grotesk (`--g-font-display`)
**Body Font:** Hanken Grotesk (`--g-font-body`)
**Code Font:** Gradient's mono stack (`--g-font-code`), for JSON and report logs only

**Character:** Space Grotesk at real scale for names, figures and the statement; Hanken for everything read.

### Hierarchy

- **Page name** (600, clamp(48px, 6.4vw, 88px), 0.95, -0.035em): the brand's name or "Brands" in the page head. 24px brand rows on phones.
- **Statement** (500, clamp(28px, 3.4vw, 44px), 1.15, max 30ch): the overview's opening sentence. Its numbers are 700 with tabular figures; the waiting count turns `--g-danger`.
- **Brand name** (600, 32px): each row on Home.
- **Figure** (600, 28px, tabular): the three counts on a brand row.
- **Headline** (600, 20px): section heads (h2); report headings scale to 32px; sheet titles 24px; empty-state titles 20px.
- **Lead** (400, 17px, 1.5, max 46ch): the "what it is" text in the page head.
- **Body** (400, 15px, 1.5): comments (1.55, max 70ch), tabs, form controls; posts text 14px.
- **Meta** (13px): timestamps, statuses, hints, legends, captions under figures.
- **Label** (600, 12px): label pills, "Brand reply", the flagged-post badge, cover meta.

### Named Rules

**The Tabular-Not-Mono Rule.** Every number is `.g-num` tabular figures in its own face. Monospace is only the JSON view and the report log, because those are code.

## Layout

- **Page:** centred, max 1200px plus 40px gutters each side (`--sm-max`, `--sm-gutter`), padded 40px top and 96px bottom.
- **Top bar:** sticky, 64px, on paper: logo, breadcrumb, freshness dot, view switch, the one red action, the gear.
- **Page head:** two columns 1.2fr / 1fr, 40px gap, bottom-aligned: name left, lead right, 40px below.
- **Section bar:** sticky directly under the top bar, a hairline beneath, 40px below it before the body.
- **Home rows:** grid of name, network marks, three 104px figures, a 150px freshness column and a 24px chevron; 28px vertical padding.
- **Overview:** sections stacked with 56px gaps; a 1.55fr / 1fr split with a sticky side column (sticky 72px under the top bar).
- **Reports:** a 260px run list beside the report, 48px gap.
- **Forms:** labelled rows, 150px label column and one control up to 560px; actions indent to the control column. About caps at 880px.
- **Posts:** auto-fill covers at min 210px, 32px row gap, 20px column gap.
- **Rhythm:** 24px stacks, 40px between head and body, 56px between overview sections, 8–16px inside components.

**At 1080px:** Home drops the network marks and freshness column (figures shrink to 84px); the overview split becomes one column and the side stops sticking; the latest-posts strip becomes a horizontal scroll of 160px covers with snap.

**At 760px:** gutters become 16px and the top bar 56px; the breadcrumb, freshness and view switch hide; the page head stacks with a 16px gap; the section bar stacks its tabs over a scrollable network switch; Home keeps only the name and the "to answer" figure; reports, labelled rows and the kinds grid go single-column; replies indent 24px; posts become two columns; sheets dock to the bottom with 18px top corners.

## Elevation & Depth

Flat by default and tonal: depth comes from paper, surface and sunken, and from hairlines. Gradient's shadows are used three ways only: `--g-shadow-sm` lifts the selected pill in a segmented control and the add-brand panel; `--g-shadow-lg` sits under the sheet; `--g-shadow-accent` comes with Gradient's primary button. Sticky bars stay on the paper colour with no shadow.

### Named Rules

**The Paper Bars Rule.** Sticky surfaces (top bar, section bar, save bar) are the ground colour with at most a hairline; never a blur, glass or drop shadow.

## Shapes

Pills for every control (`--g-radius-pill`): buttons, segmented options, network switch, chips, label and rating pills, tally tracks, the mood bar. Circles for faces, the live dot and mood dots. Real covers, inputs and the JSON field take Gradient's `--g-radius-lg` and `--g-radius-md`; small selects take `--g-radius-sm`. No raw pixel radii. The single surface panel uses `--g-radius-lg`. Empty states are a 1px dashed `--g-line-strong` box. Lists and tables have no container at all: hairlines only.

## Components

### Buttons

- **Shape:** Gradient pill buttons, compact size (36px, 1rem padding, 14px).
- **Primary:** `g-btn--primary`, Gradient red with its accent shadow. One per view.
- **Secondary / Ghost:** `g-btn` outlined and `g-btn--ghost`; destructive is `g-btn` on `--g-danger-fill` inside the About danger zone only.
- **Text button:** 13px 600 `--g-text-2`, underline in `--g-line-strong`; underline and text darken on hover.

### Section bar (signature)

Gradient's sticky text bar: plain-text tabs (15px, `--g-text-2`), the current tab in `--g-text` 600 with a 2px ink underline sitting on the hairline. The network switch sits on its right: pill options with the network's mark and name, the active one on `--g-surface` with a `--g-line-strong` outline. Hidden when a brand has one network, and on About and Schedules.

### Segmented controls and chips

- **Segmented:** Gradient's sunken track; the checked pill is `--g-surface`, 600, `--g-shadow-sm`. The mode switch in the top bar is the small variant (12px).
- **Chips (multi-select):** outlined pills; selected is an ink fill (`--g-text` background, `--g-bg` text).

### Brand line (signature)

A full-width link row on hairlines (strong line on top): display-face name with the field of work beneath, the three network marks (missing ones as empty hairline rings), three figures (to answer, complaints, comments), freshness ("Updated 3 hours ago", or "Needs you" in danger 600), a chevron. Hover: `--g-sunken` over `--g-dur-snap`.

### Statement (signature)

One sentence in the statement style saying what waits, the complaint share and the week's count. With nothing read, it ends in an inline accent-text action underlined at 2px.

### Comment thread (signature)

Threads on hairlines, 20px vertical padding. Each comment: a 36px initials disc, then author (15px 600), meta, label pill, the text, and actions (rating pills, links). The brand's own replies indent under the comment (50px, 24px on phones) with a 28px inverted face, a "Brand reply" tag on info-soft, and text in `--g-text-2`.

### Label pills

A word on one soft role fill, 22px, 12px 600: Complaint (danger), Question (info), Praise (success), Suggestion (warning), Neutral (sunken), Spam (quiet text, no fill). A reply carries " · reply".

### Rating pills

Positive, Negative, Neutral: 28px outlined pills in `--g-text-2`. Pressed: Positive on success-soft, Negative on danger-soft (then the kind select appears), Neutral on `--g-ink-100` with a strong outline. 26px on phones.

### Mood bar and tallies

The mood bar is a 14px pill split by share with 2px gaps, trouble first, legend of dots and tabular percentages beneath. Tallies are 8px bars on a sunken track, danger-fill for complaints and success-fill for praise, counts right-aligned.

### Inputs / Fields

Gradient `g-input` / `g-select` in labelled rows, 40px. The JSON editor is a 13px mono textarea on surface with a hairline border, 64vh tall.

### Sheets

Native `<dialog>` docked right at up to 500px, full height, on surface with `--g-shadow-lg`; a bottom sheet on phones. Head title 24px, footer above a hairline.

## Do's and Don'ts

### Do:

- **Do** reference Gradient tokens by name (`var(--g-danger-soft)`); add a SocialMonitor value only for layout.
- **Do** keep one red primary action per view.
- **Do** put lists and tables on hairlines with no container.
- **Do** use `.g-num` tabular figures for every count, in the display face for figures and the statement.
- **Do** show real covers and real data; when there is none, a two-line empty state that says what to do.
- **Do** check light and dark at 375 and 1440px.

### Don't:

- **Don't** add a KPI tile row, a card grid or a sidebar nav.
- **Don't** nest cards, box lists in rounded containers, use tinted callout boxes or coloured side borders.
- **Don't** use monospace for numbers or metadata; mono is for the JSON view and logs only.
- **Don't** put eyebrows, kickers, tracked small caps or section numbers above headings.
- **Don't** put an icon on every row, icons in circles, or emoji and Unicode glyphs as icons.
- **Don't** use gradient text, glass, glow, decorative blur, or a shadowed logo.
- **Don't** use skeleton illustrations, fake data or made-up sample brands.
