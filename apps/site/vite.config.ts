import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { pages } from './pages'
import { theme } from './theme'

// Served at the root of socialmonitor.shades.md by a Cloudflare Worker. The pages
// themselves are generated per language by ./pages.ts.
export default defineConfig({
  base: '/',
  plugins: [pages(), theme()],
  // `vite preview` sends the production CSP, so a page that breaks it fails locally too.
  preview: {
    headers: {
      'Content-Security-Policy': readFileSync(
        new URL('public/_headers', import.meta.url),
        'utf8',
      ).match(/Content-Security-Policy: (.+)/)![1]!,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // The CSP allows fonts and images from this origin only, never data: URLs.
    assetsInlineLimit: 0,
  },
})
