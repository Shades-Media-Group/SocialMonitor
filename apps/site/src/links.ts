export const REPO = 'https://github.com/Shades-Media-Group/SocialMonitor'
export const SHADES = 'https://shades.md'

/** Every `data-link` in the page templates, resolved when the pages are built. */
export const LINKS: Record<string, string> = {
  repo: REPO,
  shades: SHADES,
  // The README's "Run it" section: how to start the dashboard from source.
  run: `${REPO}#run-it`,
  mcp: `${REPO}/blob/main/docs/mcp.md`,
  changelog: `${REPO}/blob/main/CHANGELOG.md`,
  releases: `${REPO}/releases`,
  issues: `${REPO}/issues/new/choose`,
  security: `${REPO}/blob/main/SECURITY.md`,
  license: `${REPO}/blob/main/LICENSE`,
  anthropic: 'https://www.anthropic.com/legal/privacy',
  preferred: 'https://www.google.com/preferences/source?q=socialmonitor.shades.md',
}
