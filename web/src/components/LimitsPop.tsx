// The usage popover under the pill. A press outside, Escape or a resize closes it; Escape and the
// close button give the focus back to the pill.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import { limitInfo, popoverPosition } from '../models/limits.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { LimitsReport } from './LimitsReport.tsx'

export function LimitsPop({ anchor }: { anchor: RefObject<HTMLButtonElement | null> }) {
  const t = useT()
  const { data, connected, ui, dispatch } = useBoardContext()
  const pop = useRef<HTMLDivElement>(null)
  const open = ui.limitsOpen

  const close = useCallback(
    (refocus: boolean) => {
      dispatch({ type: 'limits', open: false })
      if (refocus) anchor.current?.focus({ preventScroll: true })
    },
    [dispatch, anchor],
  )

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
        <LimitsReport lim={limitInfo(data?.limits, { connected })} />
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
