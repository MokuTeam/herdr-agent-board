// The unified Status & Usage popover under the top bar's Status button (#651).
// Keeps 100% compatibility with usage-only callers (tests); when `status` props are given,
// shows Presence quick switching, session summary, connection state, and active system alerts
// cleanly above the Claude usage report.
import { type Dispatch, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PresenceState } from '../../../src/core/presence.ts'
import { api, errorText } from '../api/client.ts'
import type { SetupNoteState } from '../hooks/useSetupNote.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { backupNoteText } from '../models/backup.ts'
import { pressAway } from '../models/click-away.ts'
import {
  AGY_LIMIT_COLOR,
  agyLimitInfo,
  CLAUDE_LIMIT_COLOR,
  limitInfo,
  popoverPosition,
  profileUsage,
} from '../models/limits.ts'
import { presenceBody, presenceSwitch } from '../models/presence.ts'
import { adminHere, remotePage } from '../models/remote-page.ts'
import { summaryParts, summaryText } from '../models/toolbar.ts'
import { isWakeView, noteShown } from '../models/wake.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import type { BoardAction } from '../state/board-ui.ts'
import { classNames } from './class-names.ts'
import { WarnIcon } from './icons.tsx'
import { AgyLimitsReport, LimitsReport } from './LimitsReport.tsx'

type Pill = RefObject<HTMLButtonElement | null>

export interface LimitsPopProps {
  anchor: Pill
  /** When true, includes presence switcher, session summary, and system alerts above usage. */
  unified?: boolean
  setup?: SetupNoteState
  onBackup?: (() => void) | undefined
  onWake?: (() => void) | undefined
}

/** Closes the popover; `refocus` gives the focus back to the pill (Escape, Back, its close button). */
export function closeLimits(dispatch: Dispatch<BoardAction>, pill: Pill, refocus: boolean): void {
  dispatch({ type: 'limits', open: false })
  if (refocus) pill.current?.focus({ preventScroll: true })
}

export function LimitsPop({ anchor, unified = false, setup, onBackup, onWake }: LimitsPopProps) {
  const t = useT()
  const { data, connected, ui, dispatch, toast, now } = useBoardContext()
  const pop = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const open = ui.limitsOpen
  const usage = profileUsage(data?.profiles, { connected })
  const agy = agyLimitInfo(data?.agyLimits, { connected })
  const presence = unified ? presenceSwitch(data?.presence, t) : null

  const close = useCallback((refocus: boolean) => closeLimits(dispatch, anchor, refocus), [dispatch, anchor])

  // Placed again whenever its text changes while it is open.
  useLayoutEffect(() => {
    if (open && pop.current && anchor.current) place(pop.current, anchor.current)
  })
  useLayoutEffect(() => {
    if (open) pop.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPress = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('#limits-pop, #limits')) return
      pressAway(e, window)
      close(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close(true)
    }
    const onResize = () => close(false)
    addEventListener('pointerdown', onPress, true)
    addEventListener('keydown', onKey, true)
    addEventListener('resize', onResize)
    return () => {
      removeEventListener('pointerdown', onPress, true)
      removeEventListener('keydown', onKey, true)
      removeEventListener('resize', onResize)
    }
  }, [open, close])

  const sendPresence = async (state: PresenceState) => {
    setBusy(true)
    try {
      await api.post('/api/presence', presenceBody(state, remotePage()))
    } catch (err) {
      toast(errorText(err, t), true)
    } finally {
      setBusy(false)
    }
  }

  const backupProblem = unified ? data?.backup?.problem : undefined
  const wakeDown = unified && adminHere() && noteShown(isWakeView(data?.wake) ? data.wake : undefined, now) && !!onWake
  const setupWarn = unified && !!setup?.shown

  return (
    <div
      className="limits-pop"
      id="limits-pop"
      role="dialog"
      aria-labelledby="limits-title"
      tabIndex={-1}
      hidden={!open}
      ref={pop}
    >
      <header>
        <h3 id="limits-title">{t(unified ? 'tb.status' : agy ? 'limits.titleAll' : 'limits.title')}</h3>
        <button
          type="button"
          className="icon-button"
          id="limits-close"
          aria-label={t('sheet.closeLabel')}
          onClick={() => close(true)}
        >
          ×
        </button>
      </header>
      {unified && (
        <div className="status-pop-head">
          {presence && (
            <div className="status-pop-row">
              <span className="status-pop-lbl">{t('tb.presence')}</span>
              {/* biome-ignore lint/a11y/useSemanticElements: group keeps compact inline flex sizing without fieldset min-inline-size */}
              <div className="status-seg" role="group" aria-label={t('tb.presence')}>
                <button
                  type="button"
                  className={classNames('status-seg-btn', presence.state === 'here' && 'on')}
                  aria-pressed={presence.state === 'here'}
                  disabled={busy}
                  onClick={() => void sendPresence('here')}
                >
                  {t('tb.presenceHere')}
                </button>
                <button
                  type="button"
                  className={classNames('status-seg-btn', presence.state === 'away' && 'on')}
                  aria-pressed={presence.state === 'away'}
                  disabled={busy}
                  onClick={() => void sendPresence('away')}
                >
                  {t('tb.presenceAway')}
                </button>
                {presence.call && (
                  <button
                    type="button"
                    className={classNames('status-seg-btn', presence.state === 'call' && 'on')}
                    aria-pressed={presence.state === 'call'}
                    disabled={busy}
                    onClick={() => void sendPresence('call')}
                  >
                    {t('tb.presenceCall')}
                  </button>
                )}
              </div>
            </div>
          )}
          {presence?.offer && (
            <button
              type="button"
              className="status-pop-offer"
              disabled={busy}
              onClick={() => presence.offer && void sendPresence(presence.offer.state)}
            >
              {presence.offer.text}
            </button>
          )}
          {data && (
            <div className="status-pop-row">
              <span className="status-pop-lbl">{t('tb.sessions')}</span>
              <span className="status-pop-val">{summaryText(summaryParts(data.items, t))}</span>
            </div>
          )}
          <div className="status-pop-row">
            <span className="status-pop-lbl">{t('tb.connection')}</span>
            <span className={classNames('status-pop-val', connected && !data?.stale && 'ok')}>
              {!connected ? t('live.none') : data?.stale ? t('live.staleShort') : t('live.on')}
            </span>
          </div>
          {(setupWarn || backupProblem || wakeDown) && (
            <div className="status-pop-alerts">
              {setupWarn && setup && (
                <button
                  type="button"
                  className="status-pop-alert"
                  onClick={() => {
                    close(false)
                    setup.toggle()
                  }}
                >
                  <WarnIcon />
                  <span>{t('setup.incomplete')}</span>
                </button>
              )}
              {backupProblem && (
                <button
                  type="button"
                  className="status-pop-alert"
                  onClick={() => {
                    const text = backupNoteText(backupProblem, t)
                    close(false)
                    if (onBackup) onBackup()
                    else toast(text, true)
                  }}
                >
                  <WarnIcon />
                  <span>{backupNoteText(backupProblem, t)}</span>
                </button>
              )}
              {wakeDown && onWake && (
                <button
                  type="button"
                  id="wake-note"
                  className="status-pop-alert"
                  title={t('wake.stoppedHint')}
                  onClick={() => {
                    close(false)
                    onWake()
                  }}
                >
                  <WarnIcon />
                  <span>{t('wake.stopped')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div id="limits-content">
        {usage ? (
          usage.map(u => (
            <section key={u.id} className="limits-for" data-profile={u.id}>
              <h4 style={{ '--c': u.color }}>{u.title}</h4>
              {u.lim.windows.length ? (
                <LimitsReport lim={u.lim} />
              ) : (
                <p className="limits-none">{t('limits.noSession')}</p>
              )}
            </section>
          ))
        ) : agy ? (
          <section className="limits-for" data-provider="claude">
            <h4 style={{ '--c': CLAUDE_LIMIT_COLOR }}>{t('limits.claudeTitle')}</h4>
            <LimitsReport lim={limitInfo(data?.limits, { connected })} />
          </section>
        ) : (
          <LimitsReport lim={limitInfo(data?.limits, { connected })} />
        )}
        {agy && (
          <section className="limits-for" data-provider="agy">
            <h4 style={{ '--c': AGY_LIMIT_COLOR }}>
              {agy.planTier ? `${t('limits.agyTitle')} · ${agy.planTier}` : t('limits.agyTitle')}
            </h4>
            {agy.windows.length ? (
              <AgyLimitsReport lim={agy} />
            ) : (
              <p className="limits-none">{t('limits.agyUnavailable')}</p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function place(pop: HTMLElement, anchor: HTMLElement): void {
  const { left, top } = popoverPosition(anchor.getBoundingClientRect(), pop.getBoundingClientRect(), {
    width: innerWidth,
    height: innerHeight,
  })
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
}
