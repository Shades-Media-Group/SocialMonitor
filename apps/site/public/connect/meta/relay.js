// Facebook returns people only to a fixed https address. This page hands Facebook's one-time code
// to the SocialMonitor dashboard that asked for it, named in the state, and keeps nothing. It
// returns only to this computer or to a SocialMonitor address on shades.md.
;(() => {
  const q = new URLSearchParams(location.search)
  const state = q.get('state') || ''
  const origin = (() => {
    try {
      return atob((state.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/'))
    } catch {
      return ''
    }
  })()
  const ok =
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?$/.test(origin) ||
    /^https:\/\/([a-z0-9-]+\.)*socialmonitor\.shades\.md$/.test(origin)
  if (ok) location.replace(`${origin}/api/auth/meta/callback${location.search}`)
  else
    document.getElementById('msg').textContent =
      'This link did not come from SocialMonitor. Start again from the brand’s About page.'
})()
