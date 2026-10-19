// The usage popover under the pill. A press outside, Escape or a resize closes it; Escape and the
// close button give the focus back to the pill. With two or more profiles shown, each shown profile
// has its part: its windows, or "No session lately".
import { type Dispatch, type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import { limitInfo, popoverPosition, profileUsage } from '../models/limits.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import type { BoardAction } from '../state/board-ui.ts'
import { LimitsReport } from './LimitsReport.tsx'

type Pill = RefObject<HTMLButtonElement | null>

/** Closes the popover; `refocus` gives the focus back to the pill (Escape, Back, its close button). */
export function closeLimits(dispatch: Dispatch<BoardAction>, pill: Pill, refocus: boolean): void {
  dispatch({ type: 'limits', open: false })
  if (refocus) pill.current?.focus({ preventScroll: true })
}

export function LimitsPop({ anchor }: { anchor: Pill }) {
  const t = useT()
  const { data, connected, ui, dispatch } = useBoardContext()
  const pop = useRef<HTMLDivElement>(null)
  const open = ui.limitsOpen
  const usage = profileUsage(data?.profiles, { connected })

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
      if (!target?.closest('#limits-pop, #limits')) close(false)
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
        <h3 id="limits-title">{t('limits.title')}</h3>
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
        ) : (
          <LimitsReport lim={limitInfo(data?.limits, { connected })} />
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
