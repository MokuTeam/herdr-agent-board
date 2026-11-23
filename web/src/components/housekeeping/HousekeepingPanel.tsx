// Settings → Housekeeping… (#652), on the local board only: memory guard (off by default, sleeps
// idle sessions through the existing safe path) and leftover browser tab sweep (off by default,
// skips pinned/leased/last/beforeunload/recent tabs), plus a read-only dry-run preview.
import { useCallback, useEffect, useState } from 'react'
import { formatDryRun, type HousekeepingDryRun } from '../../../../src/core/housekeeping.ts'
import type { HousekeepingView } from '../../../../src/services/housekeeping.ts'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface HousekeepingPanelProps {
  open: boolean
  onClose(): void
}

function isHousekeepingView(v: unknown): v is HousekeepingView {
  return !!v && typeof v === 'object' && 'config' in v && 'log' in v
}

export function HousekeepingPanel({ open, onClose }: HousekeepingPanelProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const latest = useLatest({ t })
  const [view, setView] = useState<HousekeepingView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'settings' | 'dry-run' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState<HousekeepingDryRun | null>(null)

  const ask = useCallback(async () => {
    try {
      const res = await fetch('/api/housekeeping', { cache: 'no-store' })
      const value = await replyOf(res)
      if (res.ok && isHousekeepingView(value)) {
        setView(value)
        setLoadError(null)
      } else setLoadError(latest.current.t('err.status', { code: res.status }))
    } catch (err) {
      setLoadError(errorText(err, latest.current.t))
    }
  }, [latest])

  useEffect(() => {
    if (open) void ask()
  }, [open, ask])

  const send = async (kind: 'settings' | 'dry-run', body: Record<string, unknown>) => {
    setBusy(kind)
    setNote(null)
    try {
      const res = await postJson('/api/housekeeping', body)
      const reply = (await replyOf(res)) as {
        ok?: boolean
        error?: string
        view?: unknown
        report?: HousekeepingDryRun
      }
      if (isHousekeepingView(reply.view)) setView(reply.view)
      if (reply.report) setDryRun(reply.report)
      if (!res.ok || reply.ok === false) setNote(reply.error || latest.current.t('err.status', { code: res.status }))
    } catch (err) {
      setNote(errorText(err, latest.current.t))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel
      id="housekeeping-sheet"
      kind="housekeeping"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('hk.title')}</h2>
          <p className="sheet-meta">{t('hk.about')}</p>
        </>
      }
    >
      <HousekeepingBody
        view={view}
        dryRun={dryRun}
        loadError={loadError}
        busy={busy}
        note={note}
        canEdit={canEdit}
        onSave={patch => void send('settings', { op: 'settings', ...patch })}
        onDryRun={() => void send('dry-run', { op: 'dry-run' })}
      />
    </Panel>
  )
}

export interface HousekeepingBodyProps {
  view: HousekeepingView | null
  dryRun: HousekeepingDryRun | null
  loadError: string | null
  busy: 'settings' | 'dry-run' | null
  note: string | null
  canEdit: boolean
  onSave(patch: Record<string, unknown>): void
  onDryRun(): void
}

const optNum = (raw: string): number | null | undefined => {
  const s = raw.trim()
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) ? n : undefined
}

export function HousekeepingBody({
  view,
  dryRun,
  loadError,
  busy,
  note,
  canEdit,
  onSave,
  onDryRun,
}: HousekeepingBodyProps) {
  const t = useT()
  const disabled = !canEdit || !view || busy !== null
  const savedWarn = view?.config.memory.warnMb === null || view === null ? '' : String(view.config.memory.warnMb)
  const savedAction = view?.config.memory.actionMb === null || view === null ? '' : String(view.config.memory.actionMb)
  const savedIdle = view === null ? '' : String(view.config.tabs.idleMinutes)
  const [warnMb, setWarnMb] = useState(savedWarn)
  const [actionMb, setActionMb] = useState(savedAction)
  const [idleMin, setIdleMin] = useState(savedIdle)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => setWarnMb(savedWarn), [savedWarn])
  useEffect(() => setActionMb(savedAction), [savedAction])
  useEffect(() => setIdleMin(savedIdle), [savedIdle])

  if (loadError) {
    return (
      <div className="sheet-body cats-body">
        <p className="access-problem" role="alert">
          {loadError}
        </p>
      </div>
    )
  }
  if (!view) {
    return (
      <div className="sheet-body cats-body">
        <p className="sheet-meta">{t('hk.loading')}</p>
      </div>
    )
  }

  const shownError = localError || note

  return (
    <div className="sheet-body cats-body">
      {shownError && (
        <p className="access-problem" role="alert">
          {shownError}
        </p>
      )}
      <section className="time-set-group">
        <h3 className="access-head">{t('hk.memory.title')}</h3>
        <p className="sheet-meta">{t('hk.memory.about')}</p>
        <label className="time-switch">
          <input
            type="checkbox"
            role="switch"
            checked={view.config.memory.on}
            aria-checked={view.config.memory.on}
            disabled={disabled}
            onChange={e => {
              setLocalError(null)
              onSave({ memory: { on: e.target.checked } })
            }}
          />
          <span>{t('hk.memory.enable')}</span>
        </label>
        <div className="time-field-row">
          <label className="time-field">
            <span>{t('hk.memory.warnMb')}</span>
            <input
              type="number"
              min={256}
              placeholder="auto"
              value={warnMb}
              disabled={disabled}
              onChange={e => setWarnMb(e.target.value)}
            />
          </label>
          <label className="time-field">
            <span>{t('hk.memory.actionMb')}</span>
            <input
              type="number"
              min={256}
              placeholder="auto"
              value={actionMb}
              disabled={disabled}
              onChange={e => setActionMb(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => {
              const w = optNum(warnMb)
              const a = optNum(actionMb)
              if (w === undefined || a === undefined) {
                setLocalError(t('hk.invalidNumber'))
                return
              }
              setLocalError(null)
              onSave({ memory: { warnMb: w, actionMb: a } })
            }}
          >
            {t('hk.save')}
          </button>
        </div>
      </section>

      <section className="time-set-group">
        <h3 className="access-head">{t('hk.tabs.title')}</h3>
        <p className="sheet-meta">{t('hk.tabs.about')}</p>
        <label className="time-switch">
          <input
            type="checkbox"
            role="switch"
            checked={view.config.tabs.on}
            aria-checked={view.config.tabs.on}
            disabled={disabled}
            onChange={e => {
              setLocalError(null)
              onSave({ tabs: { on: e.target.checked } })
            }}
          />
          <span>{t('hk.tabs.enable')}</span>
        </label>
        <div className="time-field-row">
          <label className="time-field">
            <span>{t('hk.tabs.idleMin')}</span>
            <input
              type="number"
              min={5}
              value={idleMin}
              disabled={disabled}
              onChange={e => setIdleMin(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => {
              const m = optNum(idleMin)
              if (m === undefined || m === null) {
                setLocalError(t('hk.invalidNumber'))
                return
              }
              setLocalError(null)
              onSave({ tabs: { idleMinutes: m } })
            }}
          >
            {t('hk.save')}
          </button>
        </div>
      </section>

      <section className="time-set-group">
        <div className="access-actions">
          <button type="button" className="button" disabled={disabled} onClick={onDryRun}>
            {busy === 'dry-run' ? t('hk.dryRunning') : t('hk.dryRun')}
          </button>
        </div>
        {dryRun && <pre className="sheet-meta">{formatDryRun(dryRun).join('\n')}</pre>}
      </section>

      {view.log.length > 0 && (
        <section className="time-set-group">
          <h3 className="access-head">{t('hk.log')}</h3>
          <ul className="updates-titles">
            {view.log.slice(0, 10).map(entry => (
              <li key={entry.id ?? `${entry.at}-${entry.kind}-${entry.text}`}>
                {new Date(entry.at).toLocaleTimeString(t.lang, { timeStyle: 'short' })} · {entry.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
