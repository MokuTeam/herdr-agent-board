// Settings, Devices, "Add a computer" (#513, docs/design/nodes 11.2, 20.2):
// Generates a 10-minute one-line sh command for a Linux/macOS computer behind NAT, polls the
// relay until the computer answers with a verified proof, and claims it on Approve.
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, errorText } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  COMPUTER_POLL_PHASES,
  type ComputerSetupView,
  computerStepTitle,
  isComputerSetupView,
} from '../../models/computer-setup.ts'
import { loggedOut, stateWord, textOf } from '../../models/node-setup.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { CopyButton } from '../access/Snippets.tsx'
import { classNames } from '../class-names.ts'

export interface AddComputerProps {
  open?: boolean
  initial?: ComputerSetupView
}

const POLL_MS = 1000
const isReply = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

export function AddComputer({ open: panelOpen = true, initial }: AddComputerProps) {
  const t = useT()
  const { canEdit, toast } = useBoardContext()
  const [open, setOpen] = useState(!!initial)
  const [view, setView] = useState<ComputerSetupView | null>(initial ?? null)
  const [deviceId, setDeviceId] = useState(initial?.found?.id ?? '')
  const [port, setPort] = useState('')
  const [said, setSaid] = useState('')
  const [sending, setSending] = useState<string | null>(null)
  const live = open && panelOpen && !initial

  const refresh = useCallback(() => {
    api
      .get('/api/nodes/computer/setup', isComputerSetupView, { cache: 'no-store' })
      .then(setView)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (live) refresh()
  }, [live, refresh])

  const phase = view?.phase ?? 'idle'
  const polling = COMPUTER_POLL_PHASES.includes(phase)
  useEffect(() => {
    if (!live || (!polling && sending === null)) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [live, polling, sending, refresh])

  useEffect(() => {
    if (panelOpen || initial) return
    setOpen(false)
    setSaid('')
  }, [panelOpen, initial])

  const foundId = view?.found?.id ?? ''
  useEffect(() => {
    if (foundId) setDeviceId(d => (d ? d : foundId))
  }, [foundId])

  async function send(body: Record<string, unknown>): Promise<boolean> {
    if (!canEdit || sending !== null) return false
    setSaid('')
    setSending(String(body.op))
    try {
      await api.post('/api/nodes/computer/setup', body, isReply)
      return true
    } catch (err) {
      if (err instanceof ApiError) {
        setSaid(typeof err.reply.error === 'string' && err.reply.error ? err.reply.error : errorText(err, t))
      } else {
        toast(errorText(err, t), true)
      }
      return false
    } finally {
      setSending(null)
      refresh()
    }
  }

  const start = () => {
    const n = port.trim()
    void send({
      op: 'start',
      ...(deviceId.trim() && { id: deviceId.trim() }),
      ...(n && { port: /^\d+$/.test(n) ? Number(n) : n }),
    })
  }
  const approve = () => {
    void send({ op: 'approve', ...(foundId && { id: foundId }) })
  }
  const cancel = () => {
    setDeviceId('')
    setPort('')
    void send({ op: 'cancel' })
  }

  if (!open)
    return (
      <section className="devices-section devices-add">
        <h3 className="devices-head">{t('node.computer.title')}</h3>
        <p className="sheet-meta">{t('node.computer.about')}</p>
        <div className="access-actions">
          <button type="button" className="button primary" disabled={!canEdit} onClick={() => setOpen(true)}>
            {t('node.computer.open')}
          </button>
        </div>
      </section>
    )

  const v = view
  const working = sending !== null || phase === 'claiming' || phase === 'finishing'

  return (
    <section className="devices-section devices-add devices-computer" data-phase={phase}>
      <h3 className="devices-head">{t('node.computer.title')}</h3>
      <p className="sheet-meta">{t('node.computer.about')}</p>

      {(phase === 'idle' || phase === 'expired' || phase === 'failed') && (
        <div className="access-fields">
          <details className="access-keyfile">
            <summary className="access-summary">{t('node.add.more')}</summary>
            <div className="access-entry">
              <label className="access-field">
                <span>{t('node.add.id')}</span>
                <input
                  type="text"
                  className="path-add access-input"
                  name="computer-id"
                  value={deviceId}
                  placeholder={t('node.add.idHint')}
                  disabled={!canEdit || working}
                  onChange={e => setDeviceId(e.currentTarget.value)}
                />
              </label>
            </div>
            <div className="access-entry">
              <label className="access-field">
                <span>{t('node.add.port')}</span>
                <input
                  type="text"
                  className="path-add access-input"
                  name="computer-port"
                  value={port}
                  placeholder="12430"
                  disabled={!canEdit || working}
                  onChange={e => setPort(e.currentTarget.value)}
                />
              </label>
            </div>
          </details>
          <div className="access-actions">
            <button type="button" className="button primary" disabled={!canEdit || working} onClick={start}>
              {sending === 'start' ? t('node.computer.creating') : t('node.computer.start')}
            </button>
          </div>
        </div>
      )}

      {phase === 'expired' && <p className="access-caution">{v?.error || t('node.computer.expired')}</p>}

      {said && (
        <p className="access-why devices-said" role="alert">
          {said}
        </p>
      )}
      {v?.error && phase === 'failed' && !said && (
        <p className="access-why devices-said" role="alert">
          {v.error}
        </p>
      )}
      {v?.next && phase === 'failed' && <p className="sheet-meta devices-hint">{textOf(v.next, t)}</p>}

      {(phase === 'waiting' || phase === 'found') && v?.command && (
        <div className="access-plain">
          <p className="sheet-meta">{t('node.computer.paste')}</p>
          <div className="access-line devices-command">
            <code className="access-code">{v.command}</code>
            <CopyButton text={v.command} />
          </div>
          {v.script && (
            <details className="access-details">
              <summary className="access-summary">{t('node.computer.inside')}</summary>
              <pre className="access-code">{v.script}</pre>
            </details>
          )}
          {phase === 'waiting' && (
            <>
              <p className="sheet-meta">{t('node.computer.waiting')}</p>
              {v.next && (
                <p className="sheet-meta devices-hint" role="status">
                  {textOf(v.next, t)}
                </p>
              )}
              <div className="access-actions">
                <button type="button" className="button" disabled={!canEdit || working} onClick={cancel}>
                  {t('node.add.cancel')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {phase === 'found' && v?.found && (
        <div className="access-plain devices-computer-found">
          <p className="access-found-line">
            {t('node.computer.found', { id: v.found.id, host: v.found.host, platform: v.found.platform })}
          </p>
          <p className="sheet-meta">{t('node.computer.fingerprint', { fingerprint: v.found.fingerprint })}</p>
          <label className="access-field">
            <span>{t('node.computer.deviceId')}</span>
            <input
              type="text"
              className="path-add access-input"
              name="computer-approve-id"
              value={v.found.id}
              readOnly
              disabled
            />
          </label>
          <div className="access-actions">
            <button type="button" className="button primary" disabled={!canEdit || working} onClick={approve}>
              {sending === 'approve' ? t('node.computer.approving') : t('node.computer.approve')}
            </button>
            <button type="button" className="button" disabled={!canEdit || working} onClick={cancel}>
              {t('node.add.cancel')}
            </button>
          </div>
        </div>
      )}

      {v &&
        v.master.length > 0 &&
        (phase === 'claiming' || phase === 'finishing' || phase === 'done' || phase === 'failed') && (
          <div className="access-plan devices-run" aria-live="polite">
            <ol className="access-plan-steps devices-master">
              {v.master.map(s => (
                <li className="access-plan-step" key={s.id} data-state={s.state}>
                  <div className="access-step-line">
                    <span className="access-title">{computerStepTitle(s.id, t)}</span>
                    <span className={classNames('access-state', s.state === 'fail' && 'access-bad')}>
                      {stateWord(s.state, t)}
                    </span>
                  </div>
                  {s.said && (s.state !== 'wait' || s.id === 'login') && (
                    <p className="access-why-step">{textOf(s.said, t)}</p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

      {v && phase === 'done' && v.device && (
        <div className="devices-login devices-done">
          <p className="access-done">{t('node.computer.done', { device: v.device.id })}</p>
          {loggedOut(v.login?.profiles ?? [], false).length > 0 ? (
            <p className="sheet-meta">{t('node.computer.loginHint', { device: v.device.id })}</p>
          ) : (
            <p className="sheet-meta devices-logged">{t('node.add.loggedIn', { device: v.device.id })}</p>
          )}
          <div className="access-actions">
            <button type="button" className="button" disabled={working} onClick={cancel}>
              {t('node.add.close')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
