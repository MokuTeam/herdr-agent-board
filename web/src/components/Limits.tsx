// Claude's usage windows in a small pill by the live dot; a click opens the popover (LimitsPop.tsx).
// With two or more profiles shown, each profile with recent usage is named, in its color, before
// its windows.
import { Fragment, type ReactNode, type RefObject } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import {
  AGY_LIMIT_COLOR,
  type AgyLimitInfo,
  type AgyLimitReading,
  agyLimitInfo,
  agyWindowLabel,
  CLAUDE_LIMIT_COLOR,
  heat,
  isAgyThirdParty,
  type LimitReading,
  limitInfo,
  type ProfileUsage,
  profileUsage,
  windowLabel,
} from '../models/limits.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export function Limits({ anchor }: { anchor: RefObject<HTMLButtonElement | null> }) {
  const t = useT()
  const { data, connected, ui, dispatch } = useBoardContext()
  const usage = profileUsage(data?.profiles, { connected })
  const lim = limitInfo(data?.limits, { connected })
  const agy = agyLimitInfo(data?.agyLimits, { connected })
  const hasAgyRecent = !!agy?.recent
  // Per profile (and when Gemini has fresh usage), only fresh readings show: the pill is never dimmed.
  const stale = !usage && !hasAgyRecent && lim.windows.length > 0 && lim.stale
  return (
    <button
      type="button"
      ref={anchor}
      className={stale ? 'limits stale' : 'limits'}
      id="limits"
      aria-haspopup="dialog"
      aria-expanded={ui.limitsOpen}
      aria-controls="limits-pop"
      aria-label={t(agy ? 'limits.titleAll' : 'limits.title')}
      title={t('limits.open')}
      onClick={() => dispatch({ type: 'limits', open: !ui.limitsOpen })}
    >
      {usage
        ? profilesUsed(usage, agy, t)
        : hasAgyRecent && agy
          ? singleWithAgy(lim, agy, t)
          : lim.windows.length
            ? windows(lim.windows, t)
            : t('limits.unknown')}
    </button>
  )
}

/** Single-profile Claude plus fresh Antigravity (Gemini) usage in the pill. */
function singleWithAgy(lim: ReturnType<typeof limitInfo>, agy: AgyLimitInfo, t: Translator): ReactNode {
  const claudeFresh = lim.windows.length > 0 && !lim.stale
  return (
    <>
      {claudeFresh && (
        <>
          <span className="limits-profile" style={{ '--c': CLAUDE_LIMIT_COLOR }}>
            {t('limits.claudeTitle')}
          </span>
          {windows(lim.windows, t)}
        </>
      )}
      <span className="limits-profile" style={{ '--c': AGY_LIMIT_COLOR }}>
        {t('limits.agyPill')}
      </span>
      {agyWindows(agy.windows, t)}
    </>
  )
}

/** Each profile with recent usage, its name in its color then its windows; "Usage —" for none. */
function profilesUsed(usage: ProfileUsage[], agy: AgyLimitInfo | null, t: Translator): ReactNode {
  const recent = usage.filter(u => u.recent)
  if (!recent.length && !agy?.recent) return t('limits.unknown')
  return (
    <>
      {recent.map(u => (
        <Fragment key={u.id}>
          <span className="limits-profile" style={{ '--c': u.color }}>
            {u.title}
          </span>
          {windows(u.lim.windows, t)}
        </Fragment>
      ))}
      {agy?.recent && (
        <>
          <span className="limits-profile" style={{ '--c': AGY_LIMIT_COLOR }}>
            {t('limits.agyPill')}
          </span>
          {agyWindows(agy.windows, t)}
        </>
      )}
    </>
  )
}

/** "5h 92%", red from 90 %, orange from 70 %. */
const windows = (list: LimitReading[], t: Translator): ReactNode =>
  list.map((w, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: two windows may share a length; the list is redrawn whole per reading
    <span key={i} className={heat(w.usedPercentage) || undefined}>
      {windowLabel(w, t)} <b>{Math.round(w.usedPercentage)}%</b>
    </span>
  ))

const agyWindows = (list: AgyLimitReading[], t: Translator): ReactNode =>
  list.map(w => (
    <span
      key={w.id}
      className={heat(w.usedPercentage) || undefined}
      title={isAgyThirdParty(w.id) ? t('limits.agyOtherModelsHint') : undefined}
    >
      {agyWindowLabel(w, t)} <b>{Math.round(w.usedPercentage)}%</b>
    </span>
  ))
