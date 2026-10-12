import '@fontsource-variable/hanken-grotesk/wght.css'
// Cyrillic only in practice: Hanken Grotesk covers Latin first.
import '@fontsource-variable/inter/wght.css'
import './common.css'
import './site.css'
import 'shades-gradient/preferences.css'
import type { ConsentLabels } from 'shades-gradient/consent'
import { preferences, type PreferenceLabels } from 'shades-gradient/preferences'
import { strings } from './strings'

// The language menu closes like a menu: on Escape and on a click outside it.
for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.lang')) {
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target as Node)) menu.open = false
  })
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return
    menu.open = false
    menu.querySelector('summary')?.focus()
  })
}

// Switching language keeps your place on the page.
const keepHash = () => {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[hreflang]')) {
    if (a.host === location.host) a.hash = location.hash
  }
}
keepHash()
addEventListener('hashchange', keepHash)

// Reveal chapters as they scroll into view.
document.documentElement.classList.add('js')
const reveal = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible')
        reveal.unobserve(entry.target)
      }
    }
  },
  { rootMargin: '0px 0px -12% 0px' },
)
for (const el of document.querySelectorAll('[data-reveal]')) reveal.observe(el)

// The display and accessibility panel, shared with every Shades site.
const shared = strings<{ prefs: PreferenceLabels; consent: ConsentLabels }>()
preferences({ labels: shared.prefs, consent: shared.consent })
