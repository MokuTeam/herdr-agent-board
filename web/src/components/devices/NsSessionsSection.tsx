// NetSuite sessions view under Settings > Devices (#897): metadata only, one row per
// (account, user) entry, live SSE updates, per-account notify toggle, and Forget (owner only).
import { useCallback, useEffect, useState } from 'react'
import { api, errorText, replyOf } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  isNsSessionsSnapshot,
  type NsSessionEntry,
  type NsSessionsSnapshot,
  nsSessionCounts,
  nsSessionRow,
  sanitizeNsSessionsSnapshot,
} from '../../models/ns-sessions.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { Switch } from '../team/Switch.tsx'

export interface NsSessionsSectionProps {
  open: boolean
  canEdit: boolean
  /** Initial snapshot for tests that render without a server. */
  initial?: NsSessionsSnapshot
}

type LoadState = 'loading' | 'ready' | 'unavailable'

export function NsSessionsSection({ open, canEdit, initial }: NsSessionsSectionProps) {
  const t = useT()
  const { now, toast } = useBoardContext()
  const [snapshot, setSnapshot] = useState<NsSessionsSnapshot>(() =>
    initial ? sanitizeNsSessionsSnapshot(initial) : { entries: [], notify: {} },
  )
  const [status, setStatus] = useState<LoadState>(initial ? 'ready' : 'loading')
  const [forgetting, setForgetting] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!initial) return
    setSnapshot(sanitizeNsSessionsSnapshot(initial))
    setStatus('ready')
  }, [initial])

  const load = useCallback((signal?: AbortSignal) => {
    fetch('/api/ns-sessions/list', {
      headers: { 'x-board': '1' },
      cache: 'no-store',
      ...(signal && { signal }),
    })
      .then(async res => {
        if (res.status === 503) {
          setStatus('unavailable')
          return
        }
        const body = await replyOf(res)
        if (res.ok && isNsSessionsSnapshot(body)) {
          setSnapshot(sanitizeNsSessionsSnapshot(body))
          setStatus('ready')
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!open || initial) return
    const ctl = new AbortController()
    load(ctl.signal)
    if (typeof EventSource !== 'function') return () => ctl.abort()
    const es = new EventSource('/api/ns-sessions/events')
    const onSessions = (ev: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(String(ev.data))
        if (isNsSessionsSnapshot(parsed)) {
          setSnapshot(sanitizeNsSessionsSnapshot(parsed))
          setStatus('ready')
        }
      } catch {}
    }
    es.addEventListener('sessions', onSessions as EventListener)
    return () => {
      ctl.abort()
      es.removeEventListener('sessions', onSessions as EventListener)
      es.close()
    }
  }, [open, initial, load])

  const toggleNotify = async (entry: NsSessionEntry, next: boolean) => {
    if (!canEdit) return
    const prev = snapshot.notify
    const hadPrev = Object.hasOwn(prev, entry.account)
    const prevVal = prev[entry.account]
    setSnapshot(s => ({ ...s, notify: { ...s.notify, [entry.account]: next } }))
    try {
      await api.post('/api/ns-sessions/notify', { account: entry.account, notify: next })
    } catch (err) {
      setSnapshot(s => {
        const restored = { ...s.notify }
        if (hadPrev && prevVal !== undefined) restored[entry.account] = prevVal
        else delete restored[entry.account]
        return { ...s, notify: restored }
      })
      toast(errorText(err, t) || t('ns.notifyFailed'), true)
    }
  }

  const forgetEntry = async (entry: NsSessionEntry) => {
    if (!canEdit) return
    const key = `${entry.account}\u0000${entry.user ?? ''}`
    if (forgetting[key]) return
    setForgetting(f => ({ ...f, [key]: true }))
    try {
      await api.post('/api/ns-sessions/forget', { account: entry.account, user: entry.user })
      setSnapshot(s => ({
        ...s,
        entries: s.entries.filter(e => !(e.account === entry.account && e.user === entry.user)),
      }))
      toast(t('ns.forgotten', { account: entry.account }))
    } catch (err) {
      toast(errorText(err, t) || t('ns.forgetFailed'), true)
    } finally {
      setForgetting(f => {
        const next = { ...f }
        delete next[key]
        return next
      })
    }
  }

  const counts = nsSessionCounts(snapshot.entries)
  const summaryParts = [
    counts.live > 0 ? t('ns.count.live', { n: counts.live }) : '',
    counts.dying > 0 ? t('ns.count.dying', { n: counts.dying }) : '',
    counts.dead > 0 ? t('ns.count.dead', { n: counts.dead }) : '',
  ].filter(Boolean)

  return (
    <section className="devices-section ns-sessions" aria-labelledby="ns-sessions-head">
      <div className="ns-head-row">
        <h3 id="ns-sessions-head" className="devices-head">
          {t('ns.title')}
        </h3>
        {status === 'ready' && summaryParts.length > 0 && (
          <span className="ns-summary">{summaryParts.join(' · ')}</span>
        )}
      </div>
      <p className="sheet-meta">{t('ns.about')}</p>
      {status === 'loading' && (
        <p className="sheet-meta ns-empty" role="status">
          {t('ns.loading')}
        </p>
      )}
      {status === 'unavailable' && (
        <p className="sheet-meta ns-empty" role="status">
          {t('ns.unavailable')}
        </p>
      )}
      {status === 'ready' && snapshot.entries.length === 0 && (
        <p className="sheet-meta ns-empty" role="status">
          {t('ns.empty')}
        </p>
      )}
      {status === 'ready' && snapshot.entries.length > 0 && (
        <div className="ns-list">
          {snapshot.entries.map(entry => {
            const row = nsSessionRow(entry, snapshot.notify, now, t)
            const busy = !!forgetting[row.key]
            return (
              <div className="ns-row" key={row.key} data-state={row.state} data-account={row.account}>
                <div className="ns-row-top">
                  <span className={classNames('ns-dot', row.state)} aria-hidden="true" />
                  <strong className="ns-account">{row.account}</strong>
                  <span className={classNames('ns-state', row.state)}>
                    {row.stateLabel}
                    {row.deadReason ? ` · ${row.deadReason}` : ''}
                  </span>
                  <span className={classNames('ns-user', row.userUnknown && 'unknown')}>{row.user}</span>
                  {row.role && <span className="ns-role">{row.role}</span>}
                  <code className="ns-fp" title={row.fp}>
                    {t('ns.fp', { fp: row.fp })}
                  </code>
                </div>
                {row.noTotp && <p className="ns-hint">{t('ns.noTotpHint')}</p>}
                {row.lockLabel && <p className="ns-lock">{row.lockLabel}</p>}
                <dl className="ns-meta-grid">
                  <div className="ns-meta-item">
                    <dt className="ns-meta-label">{t('ns.loginAt')}</dt>
                    <dd className="ns-meta-val">{row.loginText}</dd>
                  </div>
                  <div className="ns-meta-item">
                    <dt className="ns-meta-label">{t('ns.absExpiry')}</dt>
                    <dd className="ns-meta-val">{row.absExpiryText}</dd>
                  </div>
                  <div className="ns-meta-item">
                    <dt className="ns-meta-label">{t('ns.idleLeft')}</dt>
                    <dd className={classNames('ns-meta-val', row.idleLow && 'low')}>{row.idleLeftText}</dd>
                  </div>
                  <div className="ns-meta-item">
                    <dt className="ns-meta-label">{t('ns.lastActivity')}</dt>
                    <dd className="ns-meta-val">{row.lastActivityText}</dd>
                  </div>
                  <div className="ns-meta-item">
                    <dt className="ns-meta-label">{t('ns.holders')}</dt>
                    <dd className="ns-meta-val ns-holders">
                      {row.holders.length > 0 ? (
                        row.holders.map(h => (
                          <span className="ns-holder-chip" key={h}>
                            {h}
                          </span>
                        ))
                      ) : (
                        <span className="ns-none">{t('ns.holdersNone')}</span>
                      )}
                    </dd>
                  </div>
                  <div className="ns-meta-item">
                    <dt className="ns-meta-label">{t('ns.lastEvent')}</dt>
                    <dd className="ns-meta-val">{row.lastEventText}</dd>
                  </div>
                </dl>
                <div className="ns-actions">
                  <div className="ns-notify-row" title={t('ns.notifyWhy')}>
                    <Switch
                      name={`ns-notify-${row.account}`}
                      label={t('ns.notify')}
                      on={row.notifyOn}
                      disabled={!canEdit}
                      onFlip={next => void toggleNotify(entry, next)}
                    />
                    <span>{t('ns.notify')}</span>
                    {row.notifyIsDefault && <span className="ns-default">({t('ns.notifyDefault')})</span>}
                  </div>
                  <button
                    type="button"
                    className="ns-forget"
                    aria-label={t('ns.forgetLabel', { account: row.account })}
                    disabled={!canEdit || busy}
                    onClick={() => void forgetEntry(entry)}
                  >
                    {t('ns.forget')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
