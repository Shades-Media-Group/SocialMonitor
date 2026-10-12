/**
 * Renders the raster files the repository and the website need, from the
 * brand files scripts/brand.mjs writes, with Playwright's Chromium:
 *
 *   assets/brand/social-preview.png        1280 × 640, the site's social card
 *   assets/brand/readme-banner-light.png   1280 × 640 at 2×
 *   assets/brand/readme-banner-dark.png    1280 × 640 at 2×
 *   apps/site/public/apple-touch-icon.png  180 × 180
 *
 * Real brand elements only: the mark, the logo and the one-line claim.
 *
 * Usage: yarn assets   (after yarn brand)
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { color, markShapes } from './brand.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const font = (pkg, file) =>
  `data:font/woff2;base64,${readFileSync(join(root, 'node_modules', pkg, 'files', file)).toString('base64')}`
const body = font('@fontsource-variable/hanken-grotesk', 'hanken-grotesk-latin-wght-normal.woff2')
const brand = (file) => readFileSync(join(root, 'assets/brand', file), 'utf8')

const CLAIM = 'Know what people say about your brand.'
const LINE = 'Instagram, Facebook and TikTok, kept on your computer. Free and open source.'

const mark = (shapes) =>
  `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`

const page = (width, height, ground, ink, content) => `<!doctype html>
<html><head><style>
@font-face { font-family: Body; src: url(${body}); font-weight: 100 900; }
* { margin: 0; box-sizing: border-box; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
body { background: ${ground}; color: ${ink}; font-family: Body; position: relative; }
svg { display: block; width: 100%; height: 100%; }
</style></head><body>${content}</body></html>`

/** The card: the logo top left, the claim, and the mark oversized and cropped by the corner. */
function card(theme) {
  const dark = theme === 'dark'
  const ground = dark ? color.ink : color.paper
  const ink = dark ? color.paper : color.ink
  const logo = brand(dark ? 'logo-dark.svg' : 'logo.svg')
  return page(
    1280,
    640,
    ground,
    ink,
    `<div style="position:absolute; right:-150px; bottom:-170px; width:640px; height:640px">${mark(markShapes({ inkFill: ink }))}</div>
    <div style="position:absolute; left:80px; top:76px; height:54px">${logo.replace('<svg ', '<svg style="width:auto;height:54px" ')}</div>
    <h1 style="position:absolute; left:80px; top:214px; width:680px; font-size:76px; line-height:1.02; font-weight:650; letter-spacing:-0.035em; text-wrap:balance">${CLAIM}</h1>
    <p style="position:absolute; left:80px; bottom:76px; width:560px; font-size:24px; line-height:1.35; color:${dark ? '#c3c3c9' : '#3d3d40'}">${LINE}</p>`,
  )
}

const touchIcon = page(
  180,
  180,
  color.paper,
  color.ink,
  `<div style="padding:22px; width:180px; height:180px">${mark(markShapes())}</div>`,
)

const JOBS = [
  ['assets/brand/social-preview.png', 1280, 640, 1, card('light')],
  ['assets/brand/readme-banner-light.png', 1280, 640, 2, card('light')],
  ['assets/brand/readme-banner-dark.png', 1280, 640, 2, card('dark')],
  ['apps/site/public/apple-touch-icon.png', 180, 180, 1, touchIcon],
]

const browser = await chromium.launch()
for (const [out, width, height, scale, html] of JOBS) {
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
  await tab.setContent(html)
  await tab.evaluate(() => document.fonts.ready)
  mkdirSync(dirname(join(root, out)), { recursive: true })
  await tab.screenshot({ path: join(root, out) })
  await tab.close()
  console.log(`Wrote ${out}`)
}
await browser.close()
