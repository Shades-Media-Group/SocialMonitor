import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { SESSION_COOKIE } from './auth.ts'

/**
 * A brand's report as a PDF: the dashboard's own print page, rendered by a headless browser.
 * The page sets data-ready on <body> once its data is in, so the PDF never captures a half-load.
 */
/** Where the dashboard's pages are served, for the headless browser to open. */
export const uiOrigin = () =>
  process.env.SOCIALMONITOR_UI ??
  `http://127.0.0.1:${process.env.SOCIALMONITOR_API_PORT ?? process.env.PORT ?? 4400}`

/** `session` is a short-lived token for the person asking, so the page loads only what they may see. */
export async function brandPdf(uiOrigin: string, brandId: number, query: string, session: string) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } })
    await page
      .context()
      .addCookies([
        { name: SESSION_COOKIE, value: session, url: uiOrigin, httpOnly: true, sameSite: 'Strict' },
      ])
    await page.addInitScript(() => {
      try {
        localStorage.setItem('sm-view', 'visual')
        localStorage.setItem('sm-theme', 'light')
      } catch {
        /* no storage */
      }
    })
    await page.goto(`${uiOrigin}/print/${brandId}${query ? `?${query}` : ''}`, {
      // Not 'networkidle': the page keeps its live-update stream open, so the network never rests.
      waitUntil: 'load',
    })
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 })
    await page.emulateMedia({ media: 'print' })
    await loadImages(page)
    await shrinkImages(page)
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    })
  } finally {
    await browser.close()
  }
}

/**
 * Pictures load lazily on screen, so the ones below the first page never start in a headless
 * browser. Each is asked to load now, and the PDF waits for them at most 20 seconds in all.
 */
async function loadImages(page: Page) {
  await page.evaluate(async () => {
    const imgs = [...document.images]
    for (const img of imgs) img.loading = 'eager'
    const done = imgs.map((img) =>
      img.complete
        ? null
        : new Promise((ok) => {
            img.addEventListener('load', ok, { once: true })
            img.addEventListener('error', ok, { once: true })
          }),
    )
    await Promise.race([Promise.all(done), new Promise((ok) => setTimeout(ok, 20_000))])
  })
}

/**
 * Pictures are kept at full size, but a PDF shows them a few centimetres wide. Each one is
 * redrawn at twice its printed size as a JPEG, so the file stays small and still sharp.
 */
async function shrinkImages(page: Page) {
  await page.evaluate(async () => {
    const imgs = [...document.images]
    for (const img of imgs) {
      if (!img.complete) continue // never arrived: printed as the browser has it
      // A logo (data-crisp) keeps sharp edges and its transparency: a PNG at three times its size.
      const crisp = img.hasAttribute('data-crisp')
      const k = crisp ? 3 : 2
      const w = Math.round(img.getBoundingClientRect().width * k)
      const h = Math.round(img.getBoundingClientRect().height * k)
      if (!w || !h || !img.naturalWidth) continue
      // With object-fit: cover only the middle shows, so only that is kept; otherwise the whole
      // picture is kept, in its own proportions.
      const cover = getComputedStyle(img).objectFit === 'cover'
      const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
      if (scale >= 0.9) continue // already about the size it prints at
      const sw = cover ? w / scale : img.naturalWidth
      const sh = cover ? h / scale : img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = cover ? w : Math.round(img.naturalWidth * scale)
      canvas.height = cover ? h : Math.round(img.naturalHeight * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      // Stickers and logos can be see-through; JPEG has no transparency, so they sit on paper.
      if (!crisp) {
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      try {
        ctx.drawImage(
          img,
          (img.naturalWidth - sw) / 2,
          (img.naturalHeight - sh) / 2,
          sw,
          sh,
          0,
          0,
          canvas.width,
          canvas.height,
        )
        img.src = crisp ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.82)
        // A data URL decodes at once; the limit only guards against a stuck picture.
        await Promise.race([
          img.decode().catch(() => null),
          new Promise((ok) => setTimeout(ok, 2000)),
        ])
      } catch {
        /* a picture from elsewhere can't be redrawn; it stays as it is */
      }
    }
  })
}
