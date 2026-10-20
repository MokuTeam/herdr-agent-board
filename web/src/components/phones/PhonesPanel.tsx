// The Phones panel, opened from Settings → Phones… while the remote mode is on (core/remote.ts):
// where phones reach the board, the phones that ask to pair (Approve, Deny), the paired ones
// (Unpair, two clicks) and turning the remote mode off. A phone that asks opens it by itself.
// Every answer goes to the board at once (POST /api/remote) and comes back over the live stream.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { ago } from '../../models/card.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface PhonesPanelProps {
  open: boolean
  onClose(): void
}

/** Whether the Phones panel is open; a request to pair that the page has not seen yet opens it. */
export function usePhonesPanel(): [boolean, (open: boolean) => void] {
  const { data } = useBoardContext()
  const [open, setOpen] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const pending = data?.remote?.pending
  useEffect(() => {
    const ids = (pending ?? []).map(r => r.id)
    // The requests already there when the page loaded open nothing; a new one does.
    if (seen.current && ids.some(id => !seen.current?.has(id))) setOpen(true)
    seen.current = new Set(ids)
  }, [pending])
  return [open, setOpen]
}

export function PhonesPanel({ open, onClose }: PhonesPanelProps) {
  const t = useT()
  const { data, canEdit, toast } = useBoardContext()
  const latest = useLatest({ t, toast })
  const [sure, setSure] = useState<string | null>(null)

  const send = useCallback(
    async (op: string, id = '') => {
      const { t, toast } = latest.current
      try {
        await api.post('/api/remote', { op, id })
      } catch (err) {
        toast(errorText(err, t), true)
      }
    },
    [latest],
  )

  const remote = data?.remote
  if (!remote) return null
  const now = Date.now()
  return (
    <Panel
      id="phones-sheet"
      kind="phones"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('phones.title')}</h2>
          <p className="sheet-meta">{t('phones.about')}</p>
        </>
      }
    >
      <div className="sheet-body cats-body phones-body">
        <p className="phones-url">
          {remote.error
            ? t('phones.error', { why: remote.error })
            : remote.url
              ? t('phones.url', { url: remote.url })
              : t('phones.starting')}
        </p>
        {remote.pending.map(r => (
          <div className="profile-note phones-ask" key={r.id}>
            <p>
              {t('phones.asks', { name: r.name, device: r.device })}
              <br />
              <span className="sheet-meta">{r.os ? t('phones.asksFrom', { login: r.login, os: r.os }) : r.login}</span>
            </p>
            <button
              type="button"
              className="button primary"
              disabled={!canEdit}
              onClick={() => void send('approve', r.id)}
            >
              {t('phones.approve')}
            </button>
            <button type="button" className="button" disabled={!canEdit} onClick={() => void send('deny', r.id)}>
              {t('phones.deny')}
            </button>
          </div>
        ))}
        <h3 className="phones-head">{t('phones.paired')}</h3>
        {remote.devices.length === 0 && <p className="sheet-meta">{t('phones.none')}</p>}
        <div className="cats-list">
          {remote.devices.map(d => (
            <div className="phones-device" key={d.id}>
              <div>
                <strong>{d.name}</strong> · {d.device}
                <br />
                <span className="sheet-meta">
                  {d.login} · {d.seenAt ? t('phones.seen', { when: ago(d.seenAt, now, t) }) : t('phones.never')}
                </span>
              </div>
              <button
                type="button"
                className="button"
                disabled={!canEdit}
                onBlur={() => setSure(null)}
                onClick={() => {
                  if (sure !== d.id) return setSure(d.id)
                  setSure(null)
                  void send('revoke', d.id)
                }}
              >
                {sure === d.id ? t('phones.revokeSure') : t('phones.revoke')}
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="button phones-off" disabled={!canEdit} onClick={() => void send('off')}>
          {t('phones.off')}
        </button>
      </div>
    </Panel>
  )
}
