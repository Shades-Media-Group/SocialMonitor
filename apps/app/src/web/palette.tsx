import { useEffect, useRef, useState } from 'preact/hooks'
import type { IconName } from 'shades-gradient'
import type { AppState } from './app.tsx'
import { TABS } from './app.tsx'
import type { BrandRow } from './api.ts'
import { LANGS, lang, setLang, t } from './i18n.ts'
import { Icon } from './ui.tsx'

interface Command {
  group: string
  label: string
  hint?: string
  icon: IconName
  run: () => void
}

const go = (hash: string) => () => (location.hash = hash)

/**
 * Search and jump, from anywhere with ⌘K (Ctrl+K): every brand and its sections, people,
 * settings, an update, the language. Type to filter, arrows to move, Enter to run.
 */
export function Palette({
  brands,
  brand,
  me,
  manages,
  onClose,
  openSettings,
  openUpdate,
}: AppState & {
  brand?: BrandRow
  manages: boolean
  onClose: () => void
  openSettings: () => void
  openUpdate: (brandId?: number) => void
}) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const ICON: Record<string, IconName> = {
    overview: 'grid',
    comments: 'chat',
    posts: 'image',
    calendar: 'calendar',
    reports: 'file',
    schedules: 'schedule',
    about: 'info',
  }
  const all: Command[] = [
    ...(brand
      ? TABS.filter(([k]) => k !== 'schedules' || brand.my_role === 'admin').map(([k, text]) => ({
          group: brand.name,
          label: t(text),
          icon: ICON[k]!,
          run: go(`#/b/${brand.id}/${k}`),
        }))
      : []),
    ...(brand?.my_role === 'admin'
      ? [
          {
            group: brand.name,
            label: t('Update'),
            hint: brand.name,
            icon: 'refresh' as IconName,
            run: () => openUpdate(brand.id),
          },
        ]
      : []),
    ...brands.map((b) => ({
      group: t('Brands'),
      label: b.name,
      hint: b.industry ?? undefined,
      icon: 'grid' as IconName,
      run: go(`#/b/${b.id}/overview`),
    })),
    { group: t('Go to'), label: t('All brands'), icon: 'home', run: go('#/') },
    ...(manages
      ? [{ group: t('Go to'), label: t('People'), icon: 'group' as IconName, run: go('#/people') }]
      : []),
    ...(me.super
      ? [{ group: t('Go to'), label: t('Add a brand'), icon: 'add' as IconName, run: go('#/new') }]
      : []),
    { group: t('Go to'), label: t('Settings'), icon: 'settings', run: openSettings },
    ...LANGS.filter(([l]) => l !== lang).map(([l, name]) => ({
      group: t('Language'),
      label: name,
      icon: 'globe' as IconName,
      run: () => setLang(l),
    })),
  ]
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const list = all.filter((c) =>
    words.every((w) => `${c.label} ${c.hint ?? ''} ${c.group}`.toLowerCase().includes(w)),
  )
  const pick = Math.min(i, Math.max(0, list.length - 1))
  const run = (c?: Command) => {
    if (!c) return
    onClose()
    c.run()
  }

  return (
    <div class="sm-palette" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sm-palette__box" role="dialog" aria-label={t('Search and jump')}>
        <label class="sm-palette__search">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={q}
            placeholder={t('Search brands, pages and actions…')}
            aria-label={t('Search and jump')}
            onInput={(e) => {
              setQ((e.target as HTMLInputElement).value)
              setI(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setI((pick + 1) % Math.max(1, list.length))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setI((pick - 1 + list.length) % Math.max(1, list.length))
              } else if (e.key === 'Enter') run(list[pick])
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <ul class="sm-palette__list" role="listbox">
          {list.length ? (
            list.map((c, n) => (
              <>
                {(n === 0 || list[n - 1]!.group !== c.group) && (
                  <li class="sm-palette__group">{c.group}</li>
                )}
                <li
                  role="option"
                  aria-selected={n === pick}
                  class="sm-palette__item"
                  onMouseMove={() => setI(n)}
                  onClick={() => run(c)}
                >
                  <Icon name={c.icon} size={15} />
                  <span>{c.label}</span>
                  {c.hint && <small>{c.hint}</small>}
                  {n === pick && <kbd>↵</kbd>}
                </li>
              </>
            ))
          ) : (
            <li class="sm-palette__empty">{t('Nothing matches.')}</li>
          )}
        </ul>
      </div>
    </div>
  )
}
