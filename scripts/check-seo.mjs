// Checks the built website (apps/site/dist) before it can ship: every page in
// every language has its lang, title, description, canonical, the full hreflang
// set and valid JSON-LD; the FAQ in the JSON-LD is on the page; the sitemap,
// robots.txt and llms files exist and agree. Exits 1 with every problem found.
//
// Usage: node scripts/check-seo.mjs [dist directory]
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = 'https://socialmonitor.shades.md'
// Matches LOCALES in apps/site/pages.ts.
const LANGS = {
  en: 'en',
  fr: 'fr',
  ro: 'ro',
  ru: 'ru',
  es: 'es',
  it: 'it',
  tr: 'tr',
  hi: 'hi',
  ja: 'ja',
  zh: 'zh-Hans',
  'zh-hant': 'zh-Hant',
}
const HREFLANGS = [...Object.values(LANGS), 'x-default'].sort()
// Products kept out of every public file are listed in the git-ignored research/banned.txt, one per line.
const bannedFile = fileURLToPath(new URL('../research/banned.txt', import.meta.url))
const BANNED = existsSync(bannedFile)
  ? readFileSync(bannedFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  : []
const dist = process.argv[2] ?? fileURLToPath(new URL('../apps/site/dist', import.meta.url))
const errors = []
const fail = (where, message) => errors.push(`${where}: ${message}`)

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
const files = walk(dist)
const pages = files.filter((file) => file.endsWith(`${sep}index.html`))

/** Path of a dist file on the site: dist/fr/privacy/index.html → /fr/privacy/. */
const pathOf = (file) =>
  `/${relative(dist, file).split(sep).slice(0, -1).join('/')}/`.replace('//', '/')
const exists = (url) => {
  if (!url.startsWith(`${SITE}/`)) return false
  return existsSync(join(dist, url.slice(SITE.length), 'index.html'))
}
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1]
const tags = (html, pattern) => html.match(new RegExp(`<${pattern}[^>]*>`, 'g')) ?? []
const meta = (html, key, value) =>
  tags(html, 'meta')
    .filter((tag) => attr(tag, key) === value)
    .map((tag) => attr(tag, 'content'))
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '')

/** schema.org fields Google and the vocabulary need for each type used here. */
const REQUIRED = {
  Organization: ['name', 'url'],
  WebSite: ['name', 'url'],
  WebPage: ['url', 'name', 'inLanguage'],
  SoftwareApplication: ['name', 'applicationCategory', 'operatingSystem', 'offers'],
  HowTo: ['name', 'step'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
}

function checkJsonLd(where, html, path) {
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? []
  if (!blocks.length) return fail(where, 'no JSON-LD')
  const nodes = []
  for (const block of blocks) {
    try {
      const data = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, ''))
      if (data['@context'] !== 'https://schema.org')
        fail(where, 'JSON-LD @context is not schema.org')
      nodes.push(...(data['@graph'] ?? [data]))
    } catch (error) {
      fail(where, `JSON-LD does not parse: ${error.message}`)
    }
  }
  const types = nodes.map((node) => node['@type'])
  for (const node of nodes) {
    for (const field of REQUIRED[node['@type']] ?? [])
      if (node[field] === undefined || node[field] === '' || node[field]?.length === 0)
        fail(where, `${node['@type']} has no ${field}`)
  }
  const isHome = /^\/([a-z]{2}(-hant)?\/)?$/.test(path)
  const expected = isHome
    ? ['Organization', 'WebSite', 'WebPage', 'SoftwareApplication', 'HowTo', 'FAQPage']
    : ['Organization', 'WebSite', 'WebPage', 'BreadcrumbList']
  for (const type of expected) if (!types.includes(type)) fail(where, `JSON-LD has no ${type}`)

  const visible = text(html)
  for (const node of nodes) {
    if (node['@type'] === 'SoftwareApplication' && node.offers?.price !== '0')
      fail(where, 'SoftwareApplication is not free (offers.price)')
    if (node['@type'] === 'FAQPage')
      for (const question of node.mainEntity) {
        if (!question.name || !question.acceptedAnswer?.text)
          fail(where, 'a FAQ question has no name or answer')
        else if (!visible.includes(question.name))
          fail(where, `FAQ question not on the page: ${question.name}`)
      }
    if (node['@type'] === 'HowTo')
      for (const step of node.step)
        if (!step.text || !visible.includes(step.text)) fail(where, `HowTo step not on the page`)
    if (node['@type'] === 'BreadcrumbList')
      node.itemListElement.forEach((item, i) => {
        if (item.position !== i + 1 || !item.name || !exists(item.item))
          fail(where, `breadcrumb ${i + 1} is incomplete or points nowhere`)
      })
  }
}

const titles = new Map()
const descriptions = new Map()
for (const file of pages) {
  const path = pathOf(file)
  const where = path
  const html = readFileSync(file, 'utf8')
  const code = path.split('/')[1]
  const lang = LANGS[code] ?? 'en'

  if (attr(tags(html, 'html')[0] ?? '', 'lang') !== lang) fail(where, `<html lang> is not ${lang}`)

  const title = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim()
  if (!title) fail(where, 'no <title>')
  else if (titles.has(title)) fail(where, `same title as ${titles.get(title)}`)
  else titles.set(title, path)

  const [description] = meta(html, 'name', 'description')
  if (!description) fail(where, 'no meta description')
  else if (descriptions.has(description))
    fail(where, `same description as ${descriptions.get(description)}`)
  else descriptions.set(description, path)

  const canonical = tags(html, 'link').find((tag) => attr(tag, 'rel') === 'canonical')
  if (attr(canonical ?? '', 'href') !== `${SITE}${path}`) fail(where, 'canonical is not this page')

  const alternates = tags(html, 'link').filter(
    (tag) => attr(tag, 'rel') === 'alternate' && attr(tag, 'hreflang'),
  )
  const hreflangs = alternates.map((tag) => attr(tag, 'hreflang')).sort()
  if (hreflangs.join() !== HREFLANGS.join()) fail(where, `hreflang set is ${hreflangs.join(', ')}`)
  for (const tag of alternates)
    if (!exists(attr(tag, 'href'))) fail(where, `hreflang ${attr(tag, 'hreflang')} points nowhere`)
  const self = alternates.find((tag) => attr(tag, 'hreflang') === lang)
  if (attr(self ?? '', 'href') !== `${SITE}${path}`) fail(where, 'hreflang does not include itself')

  if (meta(html, 'property', 'og:url')[0] !== `${SITE}${path}`)
    fail(where, 'og:url is not this page')
  if (!meta(html, 'property', 'og:locale')[0]) fail(where, 'no og:locale')
  if (meta(html, 'property', 'og:locale:alternate').length !== Object.keys(LANGS).length - 1)
    fail(where, 'og:locale:alternate does not list every other language')
  if (!meta(html, 'property', 'og:image')[0]) fail(where, 'no og:image')
  if (!meta(html, 'name', 'twitter:card')[0]) fail(where, 'no twitter:card')

  checkJsonLd(where, html, path)
}

// Crawler and model files.
const read = (name) => (existsSync(join(dist, name)) ? readFileSync(join(dist, name), 'utf8') : '')
const robots = read('robots.txt')
if (!robots.includes(`Sitemap: ${SITE}/sitemap.xml`)) fail('robots.txt', 'no Sitemap line')
if (/^Disallow: \/\s*$/m.test(robots)) fail('robots.txt', 'disallows the whole site')
const sitemap = read('sitemap.xml')
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
if (!locs.length) fail('sitemap.xml', 'no URLs')
for (const loc of locs) if (!exists(loc)) fail('sitemap.xml', `${loc} has no page`)
for (const llms of ['llms.txt', 'llms-full.txt'])
  if (!read(llms).startsWith('# SocialMonitor')) fail(llms, 'missing or without its title')

for (const file of files.filter((f) => /\.(html|txt|xml|json)$/.test(f)))
  for (const pattern of BANNED)
    if (pattern.test(readFileSync(file, 'utf8'))) fail(relative(dist, file), 'names a competitor')

if (errors.length) {
  console.error(`check-seo: ${errors.length} problems\n  ${errors.join('\n  ')}`)
  process.exit(1)
}
console.log(
  `check-seo: ${pages.length} pages in ${Object.keys(LANGS).length} languages, ${locs.length} sitemap URLs: titles, descriptions, canonicals, hreflang, social tags and JSON-LD all present and valid`,
)
