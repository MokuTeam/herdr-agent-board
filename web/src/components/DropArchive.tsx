// While a card is dragged (with a mouse), the archive is a place to drop it (upstream's #57): a
// pill at the foot of the board that materializes with the drag and goes with it (a spring), lit
// while the card is over it. A session that may not go yet shows why there, and a drop on it only
// says so again (hooks/useCardDrag.ts). In <body>, as upstream's: the dragged card's ghost comes
// after it, above it.
import { type Ref, type RefObject, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n/I18nProvider.tsx'
import type { DropArchiveView } from '../models/archive-drop.ts'
import { Spring } from '../models/spring.ts'
import { classNames } from './class-names.ts'
import { ArchiveGlyph } from './icons.tsx'

/** The place's spring: how it comes up and goes. */
export const DROP_SPRING = { damping: 1, response: 0.3, precision: 0.002 }

/** The place at `v` of the way up (0: gone, 1: up): it rises a little and grows into place. */
export function dropPlaceAt(style: { opacity: string; transform: string }, v: number): void {
  style.opacity = String(v)
  style.transform = `translateY(${(1 - v) * 18}px) scale(${0.92 + 0.08 * v})`
}

export interface DropPlaceProps {
  /** null: no drag yet. */
  view: DropArchiveView | null
  /** Drawn: while it is up, and until it has gone again. */
  on: boolean
  placeRef?: Ref<HTMLDivElement> | undefined
}

/** The place as drawn. */
export function DropPlace({ view, on, placeRef }: DropPlaceProps) {
  const t = useT()
  return (
    <div
      className={classNames('drop-archive', !!view?.why && 'blocked', on && 'on', !!view?.over && 'over')}
      aria-hidden="true"
      ref={placeRef}
    >
      <ArchiveGlyph />
      <span>{view ? t(view.why || 'archive.menu') : ''}</span>
    </div>
  )
}

export interface DropArchiveProps {
  view: DropArchiveView | null
  /** The place's element: the drag asks where it is. */
  placeRef: RefObject<HTMLDivElement | null>
}

export function DropArchive({ view, placeRef }: DropArchiveProps) {
  const up = !!view?.up
  const [gone, setGone] = useState(true)
  const spring = useRef<Spring | null>(null)
  useEffect(() => {
    const s = new Spring({
      ...DROP_SPRING,
      onUpdate: v => {
        if (placeRef.current) dropPlaceAt(placeRef.current.style, v)
      },
      onRest: v => {
        if (v === 0) setGone(true)
      },
    })
    spring.current = s
    return () => {
      s.stop()
      spring.current = null
    }
  }, [placeRef])
  useEffect(() => {
    const s = spring.current
    if (!s) return
    if (up) {
      setGone(false)
      s.to(1)
    } else if (s.moving || s.value !== 0) s.to(0)
  }, [up])
  if (typeof document === 'undefined') return null
  return createPortal(<DropPlace view={view} on={up || !gone} placeRef={placeRef} />, document.body)
}
