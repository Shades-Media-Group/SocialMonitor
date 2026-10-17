import { useEffect, useRef, useState } from 'preact/hooks'
import { t } from './i18n.ts'
import { Modal, Row, when } from './ui.tsx'
import { bytes } from './views/admin.tsx'

interface BackupFile {
  name: string
  size: number
  at: string
}

/** How many of the automatic copies show before "and n more". */
const SHOWN = 5
const WORD = 'RESTORE'

/**
 * Settings → Backups, for super admins: the database as one file to keep, a file like it put back
 * in place of everything, and the automatic copies the server keeps in data/backups.
 */
export function Backups({ open }: { open: boolean }) {
  const [list, setList] = useState<BackupFile[] | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const pick = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/admin/backups')
      .then((r) => (r.ok ? (r.json() as Promise<BackupFile[]>) : null))
      .then(setList)
      .catch(() => setList(null))
  }, [open])

  return (
    <>
      <Row
        label={t('Backups')}
        hint={t(
          'The database only: media and reports stay as files on the computer SocialMonitor runs on.',
        )}
      >
        <div class="sm-inline">
          <a class="g-btn g-btn--sm" href="/api/admin/backup" download>
            {t('Download backup')}
          </a>
          <button
            class="g-btn g-btn--ghost g-btn--sm"
            type="button"
            onClick={() => pick.current?.click()}
          >
            {t('Restore from backup')}
          </button>
          <input
            ref={pick}
            type="file"
            accept=".db,application/vnd.sqlite3,application/x-sqlite3,application/octet-stream"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0]
              if (f) setFile(f)
              ;(e.target as HTMLInputElement).value = ''
            }}
          />
        </div>
      </Row>
      {list && (
        <Row
          label={t('Automatic copies')}
          hint={t('Made before each release and each restore, in data/backups.')}
        >
          {list.length ? (
            <div class="sm-accounts">
              <ul class="sm-accounts__list">
                {list.slice(0, SHOWN).map((b) => (
                  <li>
                    <div class="sm-accounts__who">
                      <strong>{b.name}</strong>
                      <span class="sm-quiet">
                        {when(b.at)} · <span class="g-num">{bytes(b.size)}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {list.length > SHOWN && (
                <span class="sm-quiet">{t('And {n} older.', { n: list.length - SHOWN })}</span>
              )}
            </div>
          ) : (
            <span class="sm-quiet">{t('None yet.')}</span>
          )}
        </Row>
      )}
      {file && <Restore file={file} onClose={() => setFile(null)} />}
    </>
  )
}

/** The confirmation: what happens, the word to type, then the upload and the swap. */
function Restore({ file, onClose }: { file: File; onClose: () => void }) {
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = word.trim() === WORD && !busy

  const run = async (e: Event) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const q = new URLSearchParams({ name: file.name, size: String(file.size) })
      const res = await fetch(`/api/admin/restore?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok)
        throw new Error(t(data.error ?? 'The server answered {status}.', { status: res.status }))
      // Everyone is signed out, this browser too: the sign-in screen says why.
      location.assign('/?restored=1')
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={t('Restore from backup')} onClose={() => !busy && onClose()}>
      <form class="sm-ask" onSubmit={run} aria-busy={busy}>
        <h2>{t('Restore from backup')}</h2>
        <p>
          {t(
            'Everything in SocialMonitor now is replaced by {file} ({size}): brands, posts, comments, people and settings.',
            { file: file.name, size: bytes(file.size) },
          )}
        </p>
        <p>
          {t(
            'A safety copy of the current database is saved in data/backups first. Then everyone is signed out, you too, and signs in with the accounts in the backup.',
          )}
        </p>
        <p>
          {t(
            'Saved network passwords open only when SOCIALMONITOR_VAULT_KEY is the same as when the backup was made. Media and reports are not in the backup.',
          )}
        </p>
        <label class="sm-auth__field">
          <span>{t('Type {word} to confirm', { word: WORD })}</span>
          <input
            class="g-input"
            autocomplete="off"
            spellcheck={false}
            autofocus
            value={word}
            disabled={busy}
            onInput={(e) => setWord((e.target as HTMLInputElement).value)}
          />
        </label>
        {error && (
          <p class="g-error" role="alert">
            {error}
          </p>
        )}
        <div class="sm-sheet__actions">
          <button class="g-btn g-btn--primary" type="submit" disabled={!ready}>
            {busy ? t('Restoring…') : t('Replace everything')}
          </button>
          <button class="g-btn g-btn--ghost" type="button" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
