// Generates every SocialMonitor logo file from one geometry definition.
// Usage: node scripts/brand.mjs   (writes assets/brand/** and the site favicon)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import opentype from 'opentype.js'
import { chromium } from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// The family palette, shared with PageRecast and ImageRefold.
export const color = {
  red: '#F9000A',
  rose: '#FF8299',
  ink: '#0A0A0B',
  paper: '#FDFDFC',
}

// The mark, "Share of voice": a speech bubble cut like a pie chart. The
// bottom-left corner is square, the bubble's tail; the other three are round.
// Left half red, top-right quarter rose, bottom-right quarter ink: how much of
// the conversation is about you. Drawn on the family's 96-unit grid.
const r = 24
// Each piece, with `g` units cut out of the seams (0 for the colour mark).
const pieces = (g = 0) => {
  const l = 48 - g / 2
  const m = 48 + g / 2
  return {
    left: `M${8 + r} 8H${l}V88H8V${8 + r}A${r} ${r} 0 0 1 ${8 + r} 8Z`,
    top: `M${m} 8H${88 - r}A${r} ${r} 0 0 1 88 ${8 + r}V${l}H${m}Z`,
    bottom: `M${m} ${m}H88V${88 - r}A${r} ${r} 0 0 1 ${88 - r} 88H${m}Z`,
  }
}

// inkFill: the bottom-right quarter, which turns to paper on dark grounds.
// redFill: the left half, which turns to paper on a red ground.
export function markShapes({ inkFill = color.ink, redFill = color.red, mono } = {}) {
  if (mono) {
    // One colour: the three pieces with a gap along the seams.
    const p = pieces(5)
    return `<path fill="${mono}" d="${p.left}${p.top}${p.bottom}"/>`
  }
  const p = pieces()
  return `<path fill="${redFill}" d="${p.left}"/><path fill="${color.rose}" d="${p.top}"/><path fill="${inkFill}" d="${p.bottom}"/>`
}

const svg = (viewBox, body, title = 'SocialMonitor') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`

// opentype.js's own toPathData writes NaN for some coordinates, so serialise here.
const n = (v) => String(Math.round(v * 100) / 100)
const pathData = (commands) =>
  commands
    .map((c) => {
      if (c.type === 'Z') return 'Z'
      if (c.type === 'Q') return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`
      if (c.type === 'C') return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`
      return `${c.type}${n(c.x)} ${n(c.y)}`
    })
    .join('')

async function wordmarkPath() {
  const buffer = await readFile(
    require.resolve('@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff'),
  )
  const font = opentype.parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
  )
  const size = 100
  const tracking = -0.035 * size
  let x = 0
  const parts = []
  for (const char of 'SocialMonitor') {
    const glyph = font.charToGlyph(char)
    parts.push(pathData(glyph.getPath(x, 0, size).commands))
    x += (glyph.advanceWidth / font.unitsPerEm) * size + tracking
  }
  const capHeight = (font.tables.os2.sCapHeight / font.unitsPerEm) * size
  return { d: parts.join(''), width: x - tracking, capHeight }
}

async function main() {
  const out = join(root, 'assets/brand')
  await mkdir(join(out, 'png'), { recursive: true })

  const files = {
    'logomark.svg': svg('0 0 96 96', markShapes()),
    'logomark-dark.svg': svg('0 0 96 96', markShapes({ inkFill: color.paper })),
    'logomark-mono-ink.svg': svg('0 0 96 96', markShapes({ mono: color.ink })),
    'logomark-mono-paper.svg': svg('0 0 96 96', markShapes({ mono: color.paper })),
  }

  // Primary logo: mark + wordmark, with PageRecast's proportions.
  // Mark height = 1.9 × cap height, gap = 0.3 × mark.
  const word = await wordmarkPath()
  const markSize = word.capHeight * 1.9
  const scale = markSize / 96
  const gap = markSize * 0.3
  const baseline = markSize / 2 + word.capHeight / 2
  const width = markSize + gap + word.width
  const lockup = (inkFill, textFill) =>
    svg(
      `0 0 ${width.toFixed(1)} ${markSize.toFixed(1)}`,
      `<g transform="scale(${scale.toFixed(4)})">${markShapes({ inkFill })}</g>` +
        `<path fill="${textFill}" transform="translate(${(markSize + gap).toFixed(1)} ${baseline.toFixed(1)})" d="${word.d}"/>`,
    )
  files['logo.svg'] = lockup(color.ink, color.ink)
  files['logo-dark.svg'] = lockup(color.paper, color.paper)

  // App icon: the mark on a paper tile.
  files['app-icon.svg'] = svg(
    '0 0 128 128',
    `<rect width="128" height="128" rx="28" fill="${color.paper}"/><g transform="translate(16 16)">${markShapes()}</g>`,
  )

  for (const [name, content] of Object.entries(files)) await writeFile(join(out, name), content)

  // The website's favicon and the wordmark the site draws inline.
  await mkdir(join(root, 'apps/site/public'), { recursive: true })
  await writeFile(join(root, 'apps/site/public/favicon.svg'), files['logomark.svg'])
  // The dashboard draws the logo inline, from the same outlines.
  await mkdir(join(root, 'apps/app/src/web'), { recursive: true })
  await writeFile(
    join(root, 'apps/app/src/web/brand.ts'),
    `// Generated by scripts/brand.mjs. Do not edit by hand.\n` +
      `export const WORDMARK = ${JSON.stringify({ d: word.d, width: Number(word.width.toFixed(2)), capHeight: Number(word.capHeight.toFixed(2)) })}\n` +
      `/** The mark's three pieces: left half (red), top-right quarter (rose), bottom-right quarter (ink). */\n` +
      `export const MARK = ${JSON.stringify(Object.values(pieces()))}\n`,
  )

  // Raster exports.
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const render = async (markup, size, file) => {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
    )
    await page.screenshot({ path: file, omitBackground: true })
  }
  for (const size of [32, 180])
    await render(files['logomark.svg'], size, join(out, `png/logomark-${size}.png`))
  await render(files['app-icon.svg'], 128, join(out, 'png/app-icon-128.png'))
  await render(files['app-icon.svg'], 512, join(out, 'png/app-icon-512.png'))
  await browser.close()

  console.log(`brand: wrote ${Object.keys(files).length} SVGs and 4 PNGs to assets/brand`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
