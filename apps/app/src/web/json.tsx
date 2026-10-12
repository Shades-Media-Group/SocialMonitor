import { useEffect, useState } from 'preact/hooks'

/**
 * The JSON side of a screen: exactly the data the screen shows, to copy into a chat with
 * Claude or to edit and save back. Editing is offered only where saving is safe; removing
 * an item from the JSON never deletes it (deleting stays a deliberate click in the UI).
 */
export function JsonPanel({
  value,
  onSave,
  note,
}: {
  value: unknown
  onSave?: (next: unknown) => Promise<string>
  note?: string
}) {
  const pretty = JSON.stringify(value, null, 2)
  const [text, setText] = useState(pretty)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setText(pretty)
    setError(null)
  }, [pretty])

  const dirty = text !== pretty

  const parse = (): unknown => {
    try {
      return JSON.parse(text)
    } catch (e) {
      // V8 reports a character position; turn it into the line people see.
      const at = Number(/position (\d+)/.exec((e as Error).message)?.[1])
      const line = Number.isFinite(at) ? text.slice(0, at).split('\n').length : null
      throw new Error(
        `Not valid JSON${line ? ` on line ${line}` : ''}: ${(e as Error).message.replace(/^JSON\.parse: |^Unexpected/, 'unexpected')}`,
        { cause: e },
      )
    }
  }

  const save = async () => {
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      setStatus(await onSave!(parse()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setStatus('Copied.')
  }

  return (
    <div class="sm-json">
      <div class="sm-json__bar">
        <span class="sm-quiet">
          {note ??
            (onSave ? 'Edit and save, or copy it into a chat.' : 'Read-only. Copy it into a chat.')}
        </span>
        <span class="sm-json__actions">
          {status && <span class="sm-quiet">{status}</span>}
          <button class="g-btn g-btn--ghost g-btn--sm" type="button" onClick={copy}>
            Copy
          </button>
          {onSave && (
            <>
              <button
                class="g-btn g-btn--ghost g-btn--sm"
                type="button"
                disabled={!dirty}
                onClick={() => setText(pretty)}
              >
                Undo changes
              </button>
              <button
                class="g-btn g-btn--primary g-btn--sm"
                type="button"
                disabled={!dirty || busy}
                onClick={save}
              >
                Save
              </button>
            </>
          )}
        </span>
      </div>
      {error && <p class="g-error">{error}</p>}
      <textarea
        class="sm-json__text"
        spellcheck={false}
        readOnly={!onSave}
        value={text}
        aria-label="JSON"
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value)
          setStatus(null)
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's' && onSave) {
            e.preventDefault()
            if (dirty) save()
          }
        }}
      />
    </div>
  )
}

export type ViewMode = 'visual' | 'json'

export const readMode = (): ViewMode => {
  try {
    return localStorage.getItem('sm-view') === 'json' ? 'json' : 'visual'
  } catch {
    return 'visual'
  }
}
export const saveMode = (m: ViewMode) => {
  try {
    localStorage.setItem('sm-view', m)
  } catch {
    /* private mode */
  }
}
