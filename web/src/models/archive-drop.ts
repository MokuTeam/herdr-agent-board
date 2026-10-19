// The archive as a place to drop a dragged card on (upstream's #57, web/archive-model.js dropsOn
// and app.js showDropPlace): where a card let go lands on it, and why a session may not go there
// now. A rule of the page only; components/DropArchive.tsx draws the place, hooks/useCardDrag.ts
// asks these while a card is dragged.
import { type ArchiveCandidate, type ArchiveEntryFacts, archiveBlock } from '../../../src/core/archive.ts'

/** A rectangle on screen (a DOMRect will do). */
export interface DropRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface DropPoint {
  x: number
  y: number
}

/** The place as the drag has it: up while a card is dragged, lit while the card is over it. */
export interface DropArchiveView {
  up: boolean
  over: boolean
  /** Why the dragged card's session may not go now, a text key, or '' (dropWhy). */
  why: string
}

export interface DropSlop {
  /** Px of slop around the place that still count as over it. */
  pad?: number
  /** Px from the place within which a flick counts. */
  reach?: number
  /** The deceleration rate of the flick's projection (models/spring.ts project). */
  rate?: number
}

/**
 * Whether a card let go at `p` (moving at `v`, px/s) lands on the drop place `r` (a rect): over
 * it, with `pad` px of slop around it, or flicked at it from within `reach` px, so that where the
 * flick would come to rest (the scroll-view projection, models/spring.ts) is on it.
 */
export function dropsOn(
  r: DropRect,
  p: DropPoint,
  v: DropPoint = { x: 0, y: 0 },
  { pad = 18, reach = 160, rate = 0.99 }: DropSlop = {},
): boolean {
  const on = (q: DropPoint) =>
    q.x >= r.left - pad && q.x <= r.right + pad && q.y >= r.top - pad && q.y <= r.bottom + pad
  if (on(p)) return true
  const dx = Math.max(r.left - p.x, 0, p.x - r.right)
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom)
  if (dx * dx + dy * dy > reach * reach) return false
  const k = rate / (1 - rate) / 1000
  return on({ x: p.x + v.x * k, y: p.y + v.y * k })
}

/**
 * Why a dragged card's session may not go to the archive now, a text key, or '': the archive's
 * own reasons (src/core/archive.ts archiveBlock), then a board that cannot act (read-only, or
 * offline), as "Archive" in its menu checks them.
 */
export const dropWhy = (
  it: ArchiveCandidate | null | undefined,
  schedules: readonly ArchiveEntryFacts[],
  canMutate: boolean,
  canEdit: boolean,
): string => archiveBlock(it, schedules) || (canMutate ? '' : canEdit ? 'mobile.readOnly' : 'live.off')
