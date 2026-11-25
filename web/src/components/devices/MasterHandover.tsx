// Settings, Devices -> "Move master role" (#697):
// Closed by default (zero fetches on DevicesPanel mount). Opens on click to pick a target node,
// run a dry-run preflight check, execute guided handover, and roll back if needed.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardDevice } from '../../../../src/core/payload.ts'
import { ApiError, api, errorText } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type HandoverView, isHandoverView } from '../../models/master-handover.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'

export interface MasterHandoverProps {
  open?: boolean
  devices: readonly BoardDevice[]
  initial?: HandoverView
}

const isReply = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

export function MasterHandover({ open: panelOpen = true, devices, initial }: MasterHandoverProps) {
  const t = useT()
  const { canEdit, toast } = useBoardContext()
  const targets = devices.filter(d => d.id !== 'local' && d.kind !== null && !d.revoked)
  const [open, setOpen] = useState(!!initial)
  const [view, setView] = useState<HandoverView | null>(initial ?? null)
  const [target, setTarget] = useState(initial?.target ?? targets[0]?.id ?? '')
  const [reverseLink, setReverseLink] = useState('')
  const [sending, setSending] = useState<string | null>(null)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [said, setSaid] = useState('')
  const sudoRef = useRef<HTMLInputElement>(null)
  const live = open && panelOpen && !initial

  const refresh = useCallback(() => {
    api
      .get('/api/nodes/handover', isHandoverView, { cache: 'no-store' })
      .then(setView)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (live) refresh()
  }, [live, refresh])

  useEffect(() => {
    if (!target && targets[0]?.id) setTarget(targets[0].id)
  }, [target, targets])

  useEffect(() => {
    if (panelOpen || initial) return
    setOpen(false)
    setSaid('')
    if (sudoRef.current) sudoRef.current.value = ''
  }, [panelOpen, initial])

  async function send(body: Record<string, unknown>): Promise<void> {
    if (!canEdit || sending !== null) return
    setSaid('')
    setSending(String(body.op))
    const pw = sudoRef.current?.value
    const payload = pw ? { ...body, sudoPassword: pw } : body
    try {
      const r = await api.post('/api/nodes/handover', payload, isReply)
      if (isHandoverView(r.view)) setView(r.view)
      else refresh()
      if ((body.op === 'run' || body.op === 'rollback') && sudoRef.current) sudoRef.current.value = ''
    } catch (err) {
      if (err instanceof ApiError) {
        if (isHandoverView(err.reply.view)) setView(err.reply.view)
        setSaid(typeof err.reply.error === 'string' && err.reply.error ? err.reply.error : errorText(err, t))
      } else {
        toast(errorText(err, t), true)
      }
    } finally {
      setSending(null)
    }
  }

  if (!open) {
    return (
      <section className="devices-section devices-add">
        <h3 className="devices-head">{t('node.handover.title')}</h3>
        <p className="sheet-meta">{t('node.handover.about')}</p>
        <div className="access-actions">
          <button type="button" className="button" disabled={!canEdit} onClick={() => setOpen(true)}>
            {t('node.handover.open')}
          </button>
        </div>
      </section>
    )
  }

  const v = view
  const phase = v?.phase ?? 'idle'
  const working = sending !== null || phase === 'checking' || phase === 'running'
  const plan = v?.plan ?? null

  return (
    <section className="devices-section devices-add devices-handover" data-phase={phase}>
      <h3 className="devices-head">{t('node.handover.title')}</h3>
      <p className="sheet-meta">{t('node.handover.about')}</p>

      {targets.length === 0 ? (
        <p className="sheet-meta">{t('node.handover.noTargets')}</p>
      ) : (
        <div className="access-fields">
          <div className="access-entry">
            <label className="access-field">
              <span>{t('node.handover.target')}</span>
              <select
                className="path-add access-input"
                name="handover-target"
                value={target}
                disabled={!canEdit || working}
                onChange={e => setTarget(e.currentTarget.value)}
              >
                {targets.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.title || d.id} ({d.id})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <details className="access-keyfile">
            <summary className="access-summary">{t('node.handover.more')}</summary>
            <div className="access-entry">
              <label className="access-field">
                <span>{t('node.handover.reverseLink')}</span>
                <input
                  type="text"
                  className="path-add access-input"
                  name="handover-reverse-link"
                  value={reverseLink}
                  placeholder={t('node.handover.reverseLinkHint')}
                  disabled={!canEdit || working}
                  onChange={e => setReverseLink(e.currentTarget.value)}
                />
              </label>
            </div>
          </details>
          {(v?.need === 'sudoPassword' || Boolean(plan?.relaySetup)) && (
            <div className="access-entry">
              <label className="access-field">
                <span>{t('node.handover.sudoPassword')}</span>
                <input
                  ref={sudoRef}
                  type="password"
                  className="path-add access-input"
                  name="handover-sudo-password"
                  disabled={!canEdit || working}
                />
              </label>
              <p className="sheet-meta">{t('node.handover.sudoNote')}</p>
            </div>
          )}
          <div className="access-actions">
            <button
              type="button"
              className="button"
              disabled={!canEdit || working || !target}
              onClick={() =>
                void send({
                  op: 'check',
                  to: target,
                  ...(reverseLink.trim() && { reverseLink: reverseLink.trim() }),
                })
              }
            >
              {sending === 'check' ? t('node.handover.checking') : t('node.handover.check')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={
                !canEdit ||
                working ||
                !target ||
                (plan !== null &&
                  plan.to === target &&
                  !plan.ok &&
                  !(
                    plan.relaySetup?.needsSudoPassword &&
                    plan.checks.every(c => c.ok || !c.blocking || c.id === 'reverseLink')
                  ))
              }
              onClick={() =>
                void send({
                  op: 'run',
                  to: target,
                  ...(reverseLink.trim() && { reverseLink: reverseLink.trim() }),
                })
              }
            >
              {sending === 'run' ? t('node.handover.running') : t('node.handover.start')}
            </button>
            {v?.canRollback && !confirmRollback && (
              <button
                type="button"
                className="button"
                disabled={!canEdit || working}
                onClick={() => {
                  if (v.rollbackNeedsConfirm) setConfirmRollback(true)
                  else void send({ op: 'rollback' })
                }}
              >
                {sending === 'rollback' ? t('node.handover.rollingBack') : t('node.handover.rollback')}
              </button>
            )}
            {v?.canRollback && confirmRollback && (
              <>
                <span className="access-why-step">{t('node.handover.rollbackWarn')}</span>
                <button
                  type="button"
                  className="button primary"
                  disabled={!canEdit || working}
                  onClick={() => {
                    setConfirmRollback(false)
                    void send({ op: 'rollback', discardSinceCommit: true })
                  }}
                >
                  {sending === 'rollback' ? t('node.handover.rollingBack') : t('node.handover.rollbackConfirm')}
                </button>
                <button type="button" className="button" disabled={working} onClick={() => setConfirmRollback(false)}>
                  {t('node.handover.cancel')}
                </button>
              </>
            )}
            <button
              type="button"
              className="button"
              disabled={working}
              onClick={() => {
                setOpen(false)
                setSaid('')
              }}
            >
              {t('node.handover.close')}
            </button>
          </div>
        </div>
      )}

      {v?.step && working && (
        <p className="sheet-meta" role="status">
          {t(`node.handover.step.${v.step}`)}
        </p>
      )}

      {(said || v?.error) && (
        <p className="access-why devices-said" role="alert">
          {said || v?.error}
        </p>
      )}

      {phase === 'done' && (
        <p className="sheet-meta" role="status">
          {t('node.handover.done', { to: plan?.to ?? target })}
        </p>
      )}
      {phase === 'rolled-back' && (
        <p className="sheet-meta" role="status">
          {t('node.handover.rolledBack')}
        </p>
      )}

      {plan && (
        <div className="access-plan">
          <h4 className="access-sub">{t('node.handover.checks')}</h4>
          <ol className="access-plan-steps">
            {plan.checks.map(c => (
              <li className="access-plan-step" key={c.id} data-ok={c.ok ? 'true' : 'false'}>
                <div className="access-step-line">
                  <span className="access-title">{c.id}</span>
                  <span className={classNames('access-state', !c.ok && c.blocking && 'access-bad')}>
                    {c.ok ? 'ok' : c.blocking ? 'fail' : 'warn'}
                  </span>
                </div>
                <p className="access-why-step">{c.detail}</p>
              </li>
            ))}
          </ol>
          {plan.relaySetup && (
            <p className="sheet-meta">
              {t('node.handover.relayStep', {
                to: plan.to,
                host: plan.relaySetup.host,
                port: String(plan.relaySetup.sshPort),
              })}
            </p>
          )}
          <p className="sheet-meta">
            {t('node.handover.willMove', { files: plan.totalFiles, kb: Math.ceil(plan.totalBytes / 1024) })}
          </p>
        </div>
      )}

      {v?.verify && (
        <div className="access-plan">
          <h4 className="access-sub">{t('node.handover.verify')}</h4>
          <ol className="access-plan-steps">
            {v.verify.checks.map(c => (
              <li className="access-plan-step" key={c.name}>
                <div className="access-step-line">
                  <span className="access-title">{c.name}</span>
                  <span className={classNames('access-state', !c.ok && 'access-bad')}>
                    {c.skipped ? 'skip' : c.ok ? 'ok' : 'fail'}
                  </span>
                </div>
                <p className="access-why-step">{c.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}
