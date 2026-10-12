import { chromium } from 'playwright'
import { SESSION_COOKIE } from './auth.ts'

/**
 * A brand's report as a PDF: the dashboard's own print page, rendered by a headless browser.
 * The page sets data-ready on <body> once its data is in, so the PDF never captures a half-load.
 */
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
    await page.goto(`${uiOrigin}/#/print/${brandId}${query ? `?${query}` : ''}`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 })
    await page.emulateMedia({ media: 'print' })
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    })
  } finally {
    await browser.close()
  }
}
