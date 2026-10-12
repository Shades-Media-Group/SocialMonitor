import { useState } from 'preact/hooks'
import type { BrandRow, Network } from './api.ts'
import { api } from './api.ts'
import { Row, Sheet, when } from './ui.tsx'
import { t } from './i18n.ts'

/**
 * The negative comments report: a PDF of every negative comment grouped by kind, downloaded
 * here or emailed to the brand's own list, now or after every update that brings new ones.
 */
export function BadReport({
  brand,
  network,
  open,
  onClose,
  notify,
  reload,
}: {
  brand: BrandRow
  network: Network | ''
  open: boolean
  onClose: () => void
  notify: (text: string) => void
  reload: () => Promise<void> | void
}) {
  const admin = brand.my_role === 'admin'
  const [days, setDays] = useState('30')
  const [emails, setEmails] = useState(() =>
    (JSON.parse(brand.alert_emails || '[]') as string[]).join('\n'),
  )
  const [auto, setAuto] = useState(!!brand.alert_auto)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const r = await api.put<{ emails: string[]; auto: boolean }>(`/api/brands/${brand.id}/alerts`, {
      emails: emails.split(/[\s,;]+/).filter(Boolean),
      auto,
    })
    setEmails(r.emails.join('\n'))
    await reload()
    return r
  }
  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await f()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const pdf = `/api/brands/${brand.id}/bad.pdf?days=${days}${network ? `&network=${network}` : ''}`

  return (
    <Sheet
      open={open}
      title={t('Negative comments report')}
      onClose={onClose}
      footer={
        <>
          <a class="g-btn g-btn--primary" href={pdf} download aria-disabled={busy}>
            {t('Download PDF')}
          </a>
          {admin && (
            <button
              class="g-btn"
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await save()
                  if (!r.emails.length) throw new Error(t('Add at least one address first.'))
                  const { sent } = await api.post<{ sent: number }>(
                    `/api/brands/${brand.id}/bad/send`,
                    { days: Number(days) || 0 },
                  )
                  notify(t('Sent to {n} addresses.', { n: sent }))
                })
              }
            >
              {busy ? t('Sending…') : t('Send now')}
            </button>
          )}
        </>
      }
    >
      <p class="sm-quiet">
        {t(
          'Every comment rated negative or sorted as a complaint, grouped by kind, as a PDF with the comments as they appear here.',
        )}
      </p>
      <Row label={t('Period')}>
        <select
          class="g-select"
          value={days}
          onChange={(e) => setDays((e.target as HTMLSelectElement).value)}
        >
          <option value="7">{t('Last {n} days', { n: 7 })}</option>
          <option value="30">{t('Last {n} days', { n: 30 })}</option>
          <option value="90">{t('Last {n} days', { n: 90 })}</option>
          <option value="0">{t('All time')}</option>
        </select>
      </Row>
      {admin && (
        <>
          <Row
            label={t('Send to')}
            hint={t('One address per line. Up to 20; they do not need an account.')}
          >
            <textarea
              class="g-input sm-textarea"
              rows={4}
              value={emails}
              placeholder="name@company.com"
              onInput={(e) => setEmails((e.target as HTMLTextAreaElement).value)}
            />
          </Row>
          <Row
            label={t('After each update')}
            hint={
              brand.alert_sent_at
                ? t('Last sent {when}.', { when: when(brand.alert_sent_at) })
                : undefined
            }
          >
            <label class="sm-check">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto((e.target as HTMLInputElement).checked)}
              />
              {t('Email the new negative comments when an update brings any')}
            </label>
          </Row>
          <button
            class="sm-textbtn"
            type="button"
            disabled={busy}
            onClick={() => run(async () => void (await save(), notify(t('Saved.'))))}
          >
            {t('Save the list')}
          </button>
        </>
      )}
      {error && <p class="g-error">{error}</p>}
    </Sheet>
  )
}
