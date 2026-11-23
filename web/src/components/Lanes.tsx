// Flat typographic lane tabs (#651, Hybrid B+C header): "All" plus each category with its small
// color square and crisp 2px bottom underline when active. On desktop, overflowing tabs fold cleanly
// into a single "+N more" menu button (picks.open); on phone widths (<= 760px), all lanes sit in a
// smooth horizontal scrollable strip with edge fades. Also supports `folded` for single-picker mode.
import { useLayoutEffect, useRef, useState } from 'react'
import { useLaneFades } from '../hooks/useLaneFades.ts'
import type { SegmentPicks } from '../hooks/useSegmentPicks.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { type LanePicks, litLanes, toggledLane } from '../models/lane-picks.ts'
import type { LaneOption } from '../models/toolbar.ts'
import { classNames } from './class-names.ts'
import { DownIcon } from './icons.tsx'
import { SegmentPick } from './SegmentPick.tsx'

interface Props {
  /** null before the first board: the control stays empty. */
  options: LaneOption[] | null
  /** The lanes picked (models/lane-picks.ts); none: every lane. */
  picked: LanePicks
  /** A lane clicked: on show or off again ('all': every lane). */
  onPick: (id: string) => void
  /** Folded into its single picker pill (legacy/narrow mode). */
  folded?: boolean
  /** The picker's menu (hooks/useSegmentPicks.ts). */
  picks?: SegmentPicks | undefined
  /** A phone-wide toolbar. */
  narrow?: boolean
}

const toggled = (lit: readonly string[], id: string) => litLanes(toggledLane(lit, id))

/** Reserve room for "+N more" button on desktop when checking overflow. */
const MORE_W = 86

export function Lanes({ options, picked, onPick, folded = false, picks, narrow = false }: Props) {
  const t = useT()
  const control = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState<number | null>(null)
  useLaneFades(control)
  const lit = litLanes(picked)
  const total = options?.length ?? 0

  // On desktop (> 760px), compute how many tabs fit before showing "+N more".
  // On phone (<= 760px), show all tabs in the horizontal scroll strip.
  const optionKey = options ? options.map(o => `${o.id}:${o.title}`).join('|') : ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: optionKey tracks option titles/count
  useLayoutEffect(() => {
    const el = control.current
    if (!el || folded || !options?.length) {
      setVisibleCount(null)
      return
    }
    const measure = () => {
      if (typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches) {
        setVisibleCount(null)
        return
      }
      const available = el.clientWidth
      if (!available) return
      const buttons = Array.from(el.querySelectorAll<HTMLElement>('button[data-id]'))
      if (!buttons.length) return
      // Measure natural widths; temporarily unhide overflowed tabs synchronously so resize
      // measurements see every tab's true width without oscillation.
      const prevHidden = buttons.map(b => b.hidden)
      for (const b of buttons) b.hidden = false
      const widths = buttons.map(b => b.offsetWidth)
      buttons.forEach((b, i) => {
        b.hidden = prevHidden[i] ?? false
      })
      const gap = 2
      const fullWidth = widths.reduce((sum, w, i) => sum + (i ? gap : 0) + w, 0)
      if (fullWidth <= available) {
        setVisibleCount(null)
        return
      }
      let used = 0
      let fit = 1
      for (let i = 0; i < widths.length; i++) {
        const next = used + (i ? gap : 0) + (widths[i] ?? 0)
        if (next + MORE_W > available && i > 0) break
        used = next
        fit = i + 1
      }
      setVisibleCount(fit < widths.length ? fit : null)
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [optionKey, folded, total])

  const hiddenCount = visibleCount !== null && options ? Math.max(0, options.length - visibleCount) : 0
  const hiddenActive =
    visibleCount !== null && options ? options.slice(visibleCount).some(o => lit.includes(o.id)) : false
  const choices = options ? { label: t('tb.lanes'), options, picked: lit, tint: false, toggled, onPick } : null

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: group keeps horizontal flex sizing without fieldset min-inline-size */}
      <div className="lane-tabs" id="lanes" role="group" aria-label={t('tb.lanes')} hidden={folded} ref={control}>
        {options?.map((o, idx) => {
          const overflowed = visibleCount !== null && idx >= visibleCount
          const active = lit.includes(o.id)
          return (
            <button
              type="button"
              key={o.id}
              className={classNames('lane-tab', active && 'on', overflowed && 'lane-over')}
              data-id={o.id}
              aria-pressed={active}
              hidden={overflowed}
              onClick={() => onPick(o.id)}
            >
              {o.color && <span className="lane-dot" style={{ '--lane': o.color }} aria-hidden="true" />}
              <span className="lane-tab-title">{o.title}</span>
            </button>
          )
        })}
        {hiddenCount > 0 && choices && (
          <button
            type="button"
            className={classNames('lane-tab lane-more', hiddenActive && 'on')}
            id="lanes-more"
            aria-haspopup="menu"
            aria-expanded={picks?.expanded === 'lanes'}
            onClick={e => picks?.open('lanes', e.currentTarget, e.detail === 0, choices)}
          >
            <span>{t('tb.moreLanes', { n: hiddenCount })}</span>
            <DownIcon />
          </button>
        )}
      </div>
      {folded && choices && (
        <SegmentPick
          of="lanes"
          name="tb.lanesPick"
          nameMany="tb.lanesPicked"
          choices={choices}
          picks={picks}
          allTitle={narrow ? t('tb.lanesAll') : undefined}
        />
      )}
    </>
  )
}
