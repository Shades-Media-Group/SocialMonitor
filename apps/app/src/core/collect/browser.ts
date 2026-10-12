import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext, Page, Response } from 'playwright'
import { chromium } from 'playwright'
import { DATA_DIR } from '../db.ts'

/**
 * SocialMonitor reads the networks through one browser profile of its own, in data/browser.
 * The user signs in there by hand, once; the app never types a password. It uses the
 * installed Google Chrome when there is one, so the networks see an ordinary Chrome on
 * the user's own computer and connection.
 */
export const PROFILE_DIR = join(DATA_DIR, 'browser')

const hasChrome = () =>
  process.platform === 'darwin'
    ? existsSync('/Applications/Google Chrome.app')
    : process.platform === 'win32'
      ? existsSync(
          join(
            process.env.PROGRAMFILES ?? 'C:\\Program Files',
            'Google/Chrome/Application/chrome.exe',
          ),
        )
      : existsSync('/usr/bin/google-chrome') || existsSync('/opt/google/chrome/chrome')

let shared: BrowserContext | null = null

/** One context at a time: the profile directory can only be open once. */
export async function openBrowser({ visible = false } = {}): Promise<BrowserContext> {
  if (shared) {
    if (!visible) return shared
    await shared.close().catch(() => {})
    shared = null
  }
  shared = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: hasChrome() ? 'chrome' : undefined,
    headless: !visible,
    viewport: visible ? null : { width: 1366, height: 900 },
    // Chrome's own automation banner and flag are the giveaway on every network.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  })
  shared.on('close', () => (shared = null))
  return shared
}

export async function closeBrowser() {
  await shared?.close().catch(() => {})
  shared = null
}

/** Opens a visible window on the three networks so the user can sign in by hand. */
export async function openSignInWindow() {
  const ctx = await openBrowser({ visible: true })
  const pages = ctx.pages()
  const urls = [
    'https://www.tiktok.com/login',
    'https://www.instagram.com/accounts/login/',
    'https://www.facebook.com/login',
  ]
  for (const [i, url] of urls.entries()) {
    const page = pages[i] ?? (await ctx.newPage())
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
  }
}

const SESSION_COOKIES = {
  tiktok: ['https://www.tiktok.com', 'sessionid'],
  instagram: ['https://www.instagram.com', 'sessionid'],
  facebook: ['https://www.facebook.com', 'c_user'],
} as const

/** Which networks the profile is signed in to, read from its cookies (never their values). */
export async function signInStatus(): Promise<
  Record<keyof typeof SESSION_COOKIES, boolean> & { busy?: boolean }
> {
  const opened = !shared
  const ctx = shared ?? (await openBrowser().catch(() => null))
  if (!ctx) return { tiktok: false, instagram: false, facebook: false, busy: true }
  const out = { tiktok: false, instagram: false, facebook: false }
  for (const [net, [url, name]] of Object.entries(SESSION_COOKIES))
    out[net as keyof typeof out] = (await ctx.cookies(url)).some(
      (c) => c.name === name && !!c.value && (c.expires === -1 || c.expires * 1000 > Date.now()),
    )
  // Opened only to look: close it again so no Chrome stays running in the background.
  if (opened) await closeBrowser()
  return out
}

/** A human pause: a random wait between `min` and `max` milliseconds. */
export const pause = (min = 2500, max = 7000) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))

/** Scrolls like a reader: a few uneven steps with pauses, not one jump to the bottom. */
export async function readScroll(page: Page, steps = 3, selector?: string) {
  for (let i = 0; i < steps; i++) {
    const dy = 500 + Math.random() * 600
    if (selector) {
      await page
        .locator(selector)
        .first()
        .evaluate((el, d) => el.scrollBy(0, d), dy)
        .catch(() => page.mouse.wheel(0, dy))
    } else await page.mouse.wheel(0, dy)
    await pause(1200, 3200)
  }
}

/** Thrown when a network shows a captcha, a checkpoint or a login wall. The update stops there for that network. */
export class Challenge extends Error {
  constructor(network: string, what: string) {
    super(`${network}: ${what}. Open "Sign in to networks", check the account, then update again.`)
    this.name = 'Challenge'
  }
}

/** Collects every JSON response whose URL matches, while `action` runs. */
export async function capture<T = unknown>(
  page: Page,
  match: (url: string) => boolean,
  action: () => Promise<void>,
) {
  const out: T[] = []
  const pending: Promise<void>[] = []
  const onResponse = (r: Response) => {
    if (!match(r.url())) return
    pending.push(
      r
        .text()
        .then((t) => {
          // Some endpoints prefix JSON with "for (;;);" or send several JSON lines.
          for (const chunk of t.replace(/^for \(;;\);/, '').split('\n')) {
            const s = chunk.trim()
            if (s.startsWith('{') || s.startsWith('[')) {
              try {
                out.push(JSON.parse(s) as T)
              } catch {
                /* not JSON */
              }
            }
          }
        })
        .catch(() => {}),
    )
  }
  page.on('response', onResponse)
  try {
    await action()
  } finally {
    page.off('response', onResponse)
    await Promise.all(pending)
  }
  return out
}

/** Every object in a JSON tree that passes `test`. Network payloads change shape often; shapes outlive paths. */
const IMAGE = /^https:\/\/[^\s"]+$/
/** The first image address found under the given keys, at any depth (lists of sizes included). */
export function imageIn(o: unknown, keys: RegExp): string | null {
  let found: string | null = null
  const walk = (v: unknown, hit: boolean, depth: number) => {
    if (found || !v || depth > 6) return
    if (typeof v === 'string') {
      if (hit && IMAGE.test(v)) found = v
      return
    }
    if (typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, hit, depth + 1))
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      walk(x, hit || keys.test(k), depth + 1)
  }
  walk(o, false, 0)
  return found
}

export function findAll<T>(root: unknown, test: (o: Record<string, unknown>) => boolean): T[] {
  const out: T[] = []
  const seen = new Set<unknown>()
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) return v.forEach(walk)
    const o = v as Record<string, unknown>
    if (test(o)) out.push(o as T)
    for (const k in o) walk(o[k])
  }
  walk(root)
  return out
}

export const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : null
}
export const isoFromUnix = (s: unknown) => {
  const n = num(s)
  return n ? new Date(n * 1000).toISOString() : null
}
