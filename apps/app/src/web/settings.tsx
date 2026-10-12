import { useEffect, useRef, useState } from 'preact/hooks'
import type { AppState } from './app.tsx'
import { api } from './api.ts'
import { Row, Segmented, Sheet } from './ui.tsx'
import { JsonPanel } from './json.tsx'
import { Accounts } from './accounts.tsx'

interface Settings {
  gap_hours: number
  keep_days: number
  analyzer: 'auto' | 'claude' | 'api'
  analyzer_status: string
  version: string
}

type Theme = 'light' | 'dark' | 'auto'

export function SettingsSheet({
  open,
  onClose,
  notify,
  reload,
  mode,
}: AppState & { open: boolean; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme) || 'light',
  )
  const file = useRef<HTMLInputElement>(null)
  const [signed, setSigned] = useState<Record<string, boolean> | null>(null)

  useEffect(() => {
    if (!open) return
    api
      .get<Settings>('/api/settings')
      .then(setS)
      .catch(() => setS(null))
    api
      .get<Record<string, boolean>>('/api/browser/status')
      .then(setSigned)
      .catch(() => setSigned(null))
  }, [open])

  const chooseTheme = (t: Theme) => {
    setTheme(t)
    if (t === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
    try {
      localStorage.setItem('sm-theme', t === 'auto' ? '' : t)
    } catch {
      /* private mode */
    }
  }

  const save = async (patch: Partial<Settings>) => {
    const next = await api.patch<Settings>('/api/settings', patch)
    setS(next)
  }

  const importFile = async (f: File) => {
    try {
      const data = JSON.parse(await f.text())
      const r = await api.post<{ brands: number; posts: number; comments: number }>(
        '/api/import',
        data,
      )
      notify(`Imported ${r.brands} brands, ${r.posts} posts and ${r.comments} comments.`)
      reload()
    } catch (e) {
      notify(`Import failed: ${(e as Error).message}`)
    }
  }

  if (mode === 'json' && s)
    return (
      <Sheet open={open} title="Settings" onClose={onClose}>
        <JsonPanel
          value={{ theme, gap_hours: s.gap_hours, keep_days: s.keep_days, analyzer: s.analyzer }}
          note="theme: light, dark or auto. gap_hours: 4 to 48. keep_days: 7 to 3650. analyzer: auto, claude or api."
          onSave={async (next) => {
            const x = next as Partial<Settings> & { theme?: Theme }
            if (x.theme && ['light', 'dark', 'auto'].includes(x.theme)) chooseTheme(x.theme)
            const r = await api.patch<Settings>('/api/settings', x)
            setS(r)
            return 'Saved.'
          }}
        />
      </Sheet>
    )

  return (
    <Sheet open={open} title="Settings" onClose={onClose}>
      <Row label="Theme">
        <Segmented
          label="Theme"
          value={theme}
          onChange={chooseTheme}
          options={[
            ['light', 'Light'],
            ['dark', 'Dark'],
            ['auto', 'Automatic'],
          ]}
        />
      </Row>
      {s && (
        <>
          <Row label="Gap" hint="hours between updates that use a signed-in network">
            <input
              class="g-input sm-input-num"
              type="number"
              min={4}
              max={48}
              value={s.gap_hours}
              onChange={(e) => save({ gap_hours: Number((e.target as HTMLInputElement).value) })}
            />
          </Row>
          <Row label="Keep" hint="days of comments; older ones are deleted">
            <input
              class="g-input sm-input-num"
              type="number"
              min={7}
              max={3650}
              value={s.keep_days}
              onChange={(e) => save({ keep_days: Number((e.target as HTMLInputElement).value) })}
            />
          </Row>
          <Row label="AI" hint={s.analyzer_status}>
            <Segmented
              label="AI"
              value={s.analyzer}
              onChange={(analyzer) => save({ analyzer })}
              options={[
                ['auto', 'Automatic'],
                ['claude', 'Claude Code'],
                ['api', 'API key'],
              ]}
            />
          </Row>
        </>
      )}
      <Row
        label="Sign in"
        hint={`${
          signed && !signed.busy
            ? `Signed in: ${
                (['tiktok', 'instagram', 'facebook'] as const)
                  .filter((n) => signed[n])
                  .map(
                    (n) => ({ tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook' })[n],
                  )
                  .join(', ') || 'none yet'
              }. `
            : ''
        }Opens SocialMonitor's own Chrome window. Sign in by hand; the app never sees passwords.`}
      >
        <button
          class="g-btn g-btn--sm"
          type="button"
          onClick={() =>
            api
              .post('/api/browser/sign-in')
              .then(() => notify('Sign in in the window that opened, then close it.'))
              .catch((e: Error) => notify(e.message))
          }
        >
          Sign in to networks
        </button>
      </Row>
      <Row label="Saved accounts">
        <Accounts notify={notify} />
      </Row>
      <Row label="Data">
        <div class="sm-inline">
          <a class="g-btn g-btn--sm" href="/api/export" download>
            Export everything
          </a>
          <button
            class="g-btn g-btn--ghost g-btn--sm"
            type="button"
            onClick={() => file.current?.click()}
          >
            Import
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0]
              if (f) importFile(f)
              ;(e.target as HTMLInputElement).value = ''
            }}
          />
        </div>
      </Row>
      <p class="sm-credit">
        SocialMonitor {s?.version ?? ''}. Free and open source. Built by Shades Media Group.{' '}
        <a
          class="g-link"
          href="https://github.com/Shades-Media-Group/SocialMonitor"
          target="_blank"
          rel="noreferrer"
        >
          Source
        </a>
      </p>
    </Sheet>
  )
}
