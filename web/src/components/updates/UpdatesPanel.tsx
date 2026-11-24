// Settings → Updates… (#617), on the local board only: the board's update of itself from git. From
// the top: how it stands (a problem in the danger color first), where the checkout is and when it
// was last checked, with Check now; the switch and how often; what came in with the last update.
// The view is asked when the panel opens, again whenever the board's payload changes (an update
// restarting, a check done), and comes back with every answer.
import { useCallback, useEffect, useState } from 'react'
import type { Every } from '../../../../src/core/self-update.ts'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { cameIn, isUpdatesView, lastCheckLine, type UpdatesView, whereLine } from '../../models/self-update.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { Panel, type PanelBack } from '../panel/Panel.tsx'

export interface UpdatesPanelProps {
  open: boolean
  onClose(): void
  back?: PanelBack | undefined
}

export function UpdatesPanel({ open, onClose, back }: UpdatesPanelProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const latest = useLatest({ t })
  const [view, setView] = useState<UpdatesView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'check' | 'settings' | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const ask = useCallback(async () => {
    try {
      const res = await fetch('/api/self-update', { cache: 'no-store' })
      const value = await replyOf(res)
      if (res.ok && isUpdatesView(value)) {
        setView(value)
        setLoadError(null)
      } else setLoadError(latest.current.t('err.status', { code: res.status }))
    } catch (err) {
      setLoadError(errorText(err, latest.current.t))
    }
  }, [latest])

  // asked when it opens, and every few seconds while an update restarts the board or a check runs
  const moving = !!view && (view.running || !!view.state.pending)
  useEffect(() => {
    if (!open) return
    void ask()
    if (!moving) return
    const timer = setInterval(() => void ask(), 3000)
    return () => clearInterval(timer)
  }, [open, ask, moving])

  const send = async (kind: 'check' | 'settings', body: Record<string, unknown>) => {
    setBusy(kind)
    setNote(null)
    try {
      const res = await postJson('/api/self-update', body)
      const reply = (await replyOf(res)) as { ok?: boolean; error?: string; view?: unknown }
      if (isUpdatesView(reply.view)) setView(reply.view)
      if (!res.ok || reply.ok === false) setNote(reply.error || latest.current.t('err.status', { code: res.status }))
    } catch (err) {
      setNote(errorText(err, latest.current.t))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel
      id="updates-sheet"
      kind="updates"
      back={back}
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('selfUpdate.title')}</h2>
          <p className="sheet-meta">{t('selfUpdate.about')}</p>
        </>
      }
    >
      <UpdatesBody
        view={view}
        loadError={loadError}
        busy={busy}
        note={note}
        canEdit={canEdit}
        onCheck={() => void send('check', { op: 'check' })}
        onSettings={s => void send('settings', { op: 'settings', ...s })}
      />
    </Panel>
  )
}

export interface UpdatesBodyProps {
  view: UpdatesView | null
  loadError: string | null
  busy: 'check' | 'settings' | null
  note: string | null
  canEdit: boolean
  onCheck(): void
  onSettings(s: { on?: boolean; every?: Every; at?: string }): void
}

/** The panel's content, from its view: no fetching here (UpdatesPanel does it). */
export function UpdatesBody({ view, loadError, busy, note, canEdit, onCheck, onSettings }: UpdatesBodyProps) {
  const t = useT()
  const disabled = !canEdit || !view || busy !== null
  const [at, setAt] = useState(view?.config.at ?? '')
  const savedAt = view?.config.at ?? ''
  useEffect(() => setAt(savedAt), [savedAt])
  if (loadError)
    return (
      <div className="sheet-body cats-body updates-body">
        <p className="access-problem" role="alert">
          {t('selfUpdate.loadError', { error: loadError })}
        </p>
      </div>
    )
  if (!view)
    return (
      <div className="sheet-body cats-body updates-body">
        <p className="sheet-meta">{t('selfUpdate.loading')}</p>
      </div>
    )
  const last = lastCheckLine(view.state, t)
  const came = cameIn(view.state, t)
  const st = view.standing
  const canCheck = !view.node && view.checkout !== null
  return (
    <div className="sheet-body cats-body updates-body">
      <section className="updates-status" aria-live="polite">
        {st && (
          <p
            className={classNames(st.level === 'ok' ? 'access-status' : 'access-problem', 'updates-standing')}
            role={st.level === 'error' ? 'alert' : undefined}
          >
            {st.text}
          </p>
        )}
        <p className="updates-where">{whereLine(view, t)}</p>
        {last && <p className="updates-where">{last}</p>}
        {canCheck && (
          <div className="access-actions">
            <button type="button" className="button" disabled={disabled || view.running} onClick={onCheck}>
              {busy === 'check' || view.running ? t('selfUpdate.checking') : t('selfUpdate.checkNow')}
            </button>
          </div>
        )}
        {note && (
          <p className="access-problem updates-note" role="alert">
            {note}
          </p>
        )}
      </section>
      {canCheck && (
        <section className="time-set-group updates-set">
          <label className="time-switch">
            <input
              type="checkbox"
              role="switch"
              checked={view.config.on}
              aria-checked={view.config.on}
              disabled={disabled}
              onChange={e => onSettings({ on: e.target.checked })}
            />
            <span>{t('selfUpdate.switch')}</span>
          </label>
          {view.config.on && (
            <div className="time-field-row">
              <label className="time-field">
                <span>{t('selfUpdate.every')}</span>
                <select
                  value={view.config.every}
                  disabled={disabled}
                  onChange={e => onSettings({ every: e.target.value as Every })}
                >
                  <option value="hour">{t('selfUpdate.every.hour')}</option>
                  <option value="day">{t('selfUpdate.every.day')}</option>
                </select>
              </label>
              {view.config.every === 'day' && (
                <label className="time-field">
                  <input
                    type="time"
                    aria-label={t('selfUpdate.at')}
                    value={at}
                    disabled={disabled}
                    onChange={e => setAt(e.target.value)}
                    onBlur={() => {
                      if (at && at !== savedAt) onSettings({ at })
                    }}
                  />
                </label>
              )}
            </div>
          )}
        </section>
      )}
      <section className="updates-came">
        <h3 className="access-head">{came?.head ?? t('selfUpdate.cameNone')}</h3>
        {came && came.titles.length > 0 && (
          <ul className="updates-titles">
            {came.titles.map(title => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
