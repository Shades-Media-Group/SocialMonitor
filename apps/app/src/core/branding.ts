import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { DB } from './db.ts'
import { DATA_DIR } from './db.ts'
import { validColor } from './color.ts'

/**
 * A brand's own look on its PDF reports: its logo at the top, its accent colour on the rules
 * and marks. Set by the brand's admins; without it the report keeps SocialMonitor's look.
 */

/** The largest logo file accepted. */
export const LOGO_MAX = 1024 * 1024

/** What a picture is, from its first bytes; the type it claims is not trusted. */
export function sniff(data: Buffer): 'png' | 'jpg' | 'svg' | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  // SVG is text: an <svg> root, after an optional BOM, XML declaration, doctype or comments.
  // (JavaScript's \s covers the BOM.)
  const head = data.subarray(0, 4096).toString('utf8')
  if (/^\s*(<\?xml[^>]*>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head))
    return 'svg'
  return null
}

/**
 * An SVG drawn to a PNG by the headless browser, as an <img> on a page with no network: an
 * image never runs scripts or loads anything, and only the pixels are kept, so nothing active
 * from the file reaches the dashboard. At most 1600 × 480 pixels, in its own proportions.
 */
async function rasterise(svg: Buffer): Promise<Buffer> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1700, height: 600 } })
    await page.route('**/*', (r) => r.abort())
    await page.setContent(
      `<body style="margin:0;background:transparent"><img id="l" style="display:block;height:480px;width:auto" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body>`,
    )
    const ok = await page.evaluate(async () => {
      const img = document.getElementById('l') as HTMLImageElement
      await img.decode().catch(() => null)
      // Too wide at 480 high: 1600 wide instead, the height following the proportions.
      if (img.getBoundingClientRect().width > 1600) img.style.cssText = 'display:block;width:1600px'
      return img.naturalWidth > 0
    })
    if (!ok) throw new Error('The SVG could not be drawn.')
    return await page.locator('#l').screenshot({ omitBackground: true, type: 'png' })
  } finally {
    await browser.close()
  }
}

/** Where the brand's report files live, and the path the dashboard reads them by. */
const folder = (brandId: number) => join(DATA_DIR, 'media', 'brands', String(brandId))

/**
 * Keeps an uploaded logo, a data: URL of a PNG, JPEG or SVG, and returns its /media/ path. An
 * SVG is kept as a PNG. Each upload gets a new name, so a cached old logo never shows.
 */
export async function saveLogo(brandId: number, dataUrl: string): Promise<string> {
  const m = /^data:[\w/+.-]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!m) throw new Error('Send the logo as a PNG, JPG or SVG file.')
  let data: Buffer = Buffer.from(m[1]!, 'base64')
  if (!data.length) throw new Error('The logo file is empty.')
  if (data.length > LOGO_MAX) throw new Error('The logo is larger than 1 MB.')
  let kind = sniff(data)
  if (!kind) throw new Error('The logo must be a PNG, JPG or SVG file.')
  if (kind === 'svg') {
    data = await rasterise(data)
    kind = 'png'
  }
  const dir = folder(brandId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const file = `logo-${Date.now().toString(36)}.${kind}`
  writeFileSync(join(dir, file), data)
  return `/media/brands/${brandId}/${file}`
}

/**
 * Sets what is given: `logo` a data: URL to keep, or null to remove it; `color` a hex colour,
 * or null to remove it. Left out, each keeps its value.
 */
export async function setBranding(db: DB, brandId: number, x: { logo?: unknown; color?: unknown }) {
  if (x.color !== undefined) {
    const color = x.color === null || x.color === '' ? null : validColor(x.color)
    if (x.color && !color) throw new Error('The colour is a hex value like #1a6bd6.')
    db.prepare('UPDATE brands SET report_color = ? WHERE id = ?').run(color, brandId)
  }
  if (x.logo === null) {
    rmSync(folder(brandId), { recursive: true, force: true })
    db.prepare('UPDATE brands SET report_logo = NULL WHERE id = ?').run(brandId)
  } else if (x.logo !== undefined) {
    if (typeof x.logo !== 'string') throw new Error('Send the logo as a PNG, JPG or SVG file.')
    const path = await saveLogo(brandId, x.logo)
    db.prepare('UPDATE brands SET report_logo = ? WHERE id = ?').run(path, brandId)
  }
  return db.prepare('SELECT report_logo, report_color FROM brands WHERE id = ?').get(brandId) as {
    report_logo: string | null
    report_color: string | null
  }
}
