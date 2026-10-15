import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// The dashboard. In development Vite serves it on 4400 and passes /api and /media to the
// server on 4401; `yarn start` builds it into dist/, which the server serves itself on 4400.
export default defineConfig({
  root: 'src/web',
  plugins: [preact()],
  // The server's CSP allows fonts and scripts from this origin only, never data: URLs.
  build: { outDir: '../../dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    host: '127.0.0.1',
    port: 4400,
    strictPort: true,
    proxy: { '/api/': 'http://127.0.0.1:4401', '/media/': 'http://127.0.0.1:4401' },
  },
})
