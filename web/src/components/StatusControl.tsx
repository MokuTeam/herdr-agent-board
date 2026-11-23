// Composite top-bar Status control (#651): brings live connection dot, presence label,
// Claude usage reading, and system alert count into one calm borderless element. Clicking it
// opens the unified Status & Usage popover (LimitsPop.tsx).
import type { RefObject } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import { agyLimitInfo, agyWindowLabel, heat, limitInfo, profileUsage, windowLabel } from '../models/limits.ts'
import { presenceSwitch } from '../models/presence.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { classNames } from './class-names.ts'
import { WarnIcon } from './icons.tsx'
import { LiveDot } from './LiveDot.tsx'

export interface StatusControlProps {
  anchor: RefObject<HTMLButtonElement | null>
  /** Number of active system alerts (setup incomplete, backup problem, wake stopped). */
  alerts?: number
}

export function StatusControl({ anchor, alerts = 0 }: StatusControlProps) {
  const t = useT()
  const { data, connected, ui, dispatch } = useBoardContext()
  const presence = presenceSwitch(data?.presence, t)
  const usage = profileUsage(data?.profiles, { connected })
  const lim = limitInfo(data?.limits, { connected })
  const agy = agyLimitInfo(data?.agyLimits, { connected })

  // Pick the primary window to show concisely on the bar (prefer hottest Claude window,
  // falling back to recent Antigravity/Gemini usage when Claude has none).
  const windows = usage ? usage.filter(u => u.recent).flatMap(u => u.lim.windows) : lim.windows
  const warmest =
    windows.find(w => heat(w.usedPercentage) === 'hot') ??
    windows.find(w => heat(w.usedPercentage) === 'warm') ??
    windows.at(-1) ??
    null
  const agyWarmest =
    !warmest && agy?.recent
      ? (agy.windows.find(w => heat(w.usedPercentage) === 'hot') ??
        agy.windows.find(w => heat(w.usedPercentage) === 'warm') ??
        agy.windows[0] ??
        null)
      : null
  const reading = warmest
    ? { label: windowLabel(warmest, t), pct: Math.round(warmest.usedPercentage), tone: heat(warmest.usedPercentage) }
    : agyWarmest
      ? {
          label: agyWindowLabel(agyWarmest, t),
          pct: Math.round(agyWarmest.usedPercentage),
          tone: heat(agyWarmest.usedPercentage),
        }
      : null
  const stale = !usage && !agy?.recent && lim.windows.length > 0 && lim.stale

  return (
    <button
      type="button"
      ref={anchor}
      className={classNames('status-control', ui.limitsOpen && 'active', stale && 'stale', alerts > 0 && 'alert')}
      id="limits"
      aria-haspopup="dialog"
      aria-expanded={ui.limitsOpen}
      aria-controls="limits-pop"
      aria-label={t('tb.status')}
      title={t('limits.open')}
      onClick={() => dispatch({ type: 'limits', open: !ui.limitsOpen })}
    >
      <LiveDot />
      {presence && <span className="status-presence">{presence.label}</span>}
      {presence && reading && (
        <span className="status-sep" aria-hidden="true">
          ·
        </span>
      )}
      {reading ? (
        <span className={classNames('status-usage', reading.tone)}>
          {reading.label} <b>{reading.pct}%</b>
        </span>
      ) : (
        !presence && <span className="status-usage">{t('limits.unknown')}</span>
      )}
      {alerts > 0 && (
        <span className="status-alert" title={t('tb.statusAlerts', { n: alerts })}>
          <WarnIcon />
          <span>{alerts}</span>
        </span>
      )}
    </button>
  )
}
