import { ro } from './i18n/ro.ts'
import { ru } from './i18n/ru.ts'
import { fr } from './i18n/fr.ts'
import { zh } from './i18n/zh.ts'

/**
 * The dashboard's languages. Strings are written in English in the code and looked up by that
 * English text, so English needs no file and a missing translation falls back to English.
 * Placeholders are {name}. Nouns that are counted live in NOUNS, with each language's plural forms.
 */
export type Lang = 'en' | 'ro' | 'ru' | 'fr' | 'zh'
export const LANGS: [Lang, string][] = [
  ['en', 'English'],
  ['ro', 'Română'],
  ['ru', 'Русский'],
  ['fr', 'Français'],
  ['zh', '中文'],
]
const LOCALE: Record<Lang, string> = {
  en: 'en-GB',
  ro: 'ro-RO',
  ru: 'ru-RU',
  fr: 'fr-FR',
  zh: 'zh-CN',
}

export interface Dict {
  strings: Record<string, string>
  /** Plural forms per counted noun, by Intl.PluralRules category. */
  nouns: Record<string, Partial<Record<Intl.LDMLPluralRule, string>>>
}
const DICTS: Partial<Record<Lang, Dict>> = { ro, ru, fr, zh }

function initial(): Lang {
  try {
    const saved = localStorage.getItem('sm-lang') as Lang | null
    if (saved && LANGS.some(([l]) => l === saved)) return saved
  } catch {
    /* no storage */
  }
  const nav = (navigator.language || 'en').slice(0, 2) as Lang
  return LANGS.some(([l]) => l === nav) ? nav : 'en'
}

export const lang: Lang = initial()
export const locale = LOCALE[lang]
document.documentElement.lang = lang

/** Switches language; the page reloads so every string, date and number follows. */
export function setLang(l: Lang) {
  try {
    localStorage.setItem('sm-lang', l)
  } catch {
    /* no storage */
  }
  location.reload()
}

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : s

/** The string in the chosen language. */
export const t = (s: string, vars?: Record<string, string | number>) =>
  fill(DICTS[lang]?.strings[s] ?? s, vars)

const rules = new Intl.PluralRules(locale)
const EN_NOUNS: Record<string, [string, string]> = {
  comment: ['comment', 'comments'],
  like: ['like', 'likes'],
  view: ['view', 'views'],
  post: ['post', 'posts'],
  brand: ['brand', 'brands'],
  time: ['time', 'times'],
  person: ['person', 'people'],
  update: ['update', 'updates'],
  profile: ['profile', 'profiles'],
  hour: ['hour', 'hours'],
  day: ['day', 'days'],
}

/** The noun for n in the chosen language: "1 comment", "5 comentarii", "5 комментариев". */
export function noun(n: number, key: string) {
  const forms = DICTS[lang]?.nouns[key]
  if (forms) return forms[rules.select(n)] ?? forms.other ?? key
  const en = EN_NOUNS[key] ?? [key, `${key}s`]
  return n === 1 ? en[0] : en[1]
}
