// The lanes control and the profile switch folded into a pill without a page: where the toolbar
// has no room for all of a control's segments, it shows as one pill naming the choice on show,
// its choices in a menu. Whether a control's segments fit the room they get, which control folds
// or unfolds first, and the choices as that menu. The DOM side (measuring the segments, trying
// them in the pill's place) is hooks/useSegmentFolds.ts; the pill is components/SegmentPick.tsx.
import type { MenuItem } from './menu-model.ts'

/**
 * How much room past their natural width folded segments need to unfold: a control that only
 * just fits stays folded, so it does not unfold only to fold again at the next pixel.
 */
export const FOLD_SLACK = 8

/** A control's segments as laid out: the width all of them take at full size, and the room they get. */
export interface SegmentsRoom {
  natural: number
  room: number
}

/**
 * Whether a control shows as its pill. Drawn as segments: once they are cut (by more than a
 * pixel, which rounding gives). Folded: until they fit with `slack` to spare.
 */
export const foldsNow = (folded: boolean, { natural, room }: SegmentsRoom, slack = FOLD_SLACK): boolean =>
  natural + (folded ? slack : 0) - room > 1

/** A control as the toolbar's pass finds it, in the row's order. */
export interface FoldControl {
  folded: boolean
  /**
   * Its segments' room, measured when asked: as drawn, or, folded, tried in the pill's place
   * (`slack` past their natural width); null when trying them cuts another control's.
   */
  room(): SegmentsRoom | null
}

/**
 * The control to change next, -1 for none: one at a time, the toolbar drawn again between. While
 * some control's segments are cut, the last such one folds (the lanes keep theirs over the
 * profile switch). Else the first folded one whose segments fit again unfolds, each one deciding
 * for itself in the room it gets.
 */
export function nextFold(controls: readonly FoldControl[], slack = FOLD_SLACK): number {
  for (let i = controls.length - 1; i >= 0; i--) {
    const c = controls[i]
    const room = c && !c.folded ? c.room() : null
    if (room && foldsNow(false, room, slack)) return i
  }
  for (const [i, c] of controls.entries()) {
    const room = c.folded ? c.room() : null
    if (room && !foldsNow(true, room, slack)) return i
  }
  return -1
}

/** The folded controls (their ids) with `id` folded or not; the same set when that is so already. */
export function withFold(folded: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (folded.has(id) === on) return folded
  const next = new Set(folded)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

/** A segment: a lane (models/toolbar.ts LaneOption) or a profile with its color (models/profiles.ts ProfileOption). */
export type SegmentOption = { id: string; title: string; n: number; color?: string }

/**
 * The choices the pill names, in the segments' order: those lit (`picked`: the one picked, or
 * every lane on show), else the first, as the segments light it.
 */
export function pickedOptions<T extends SegmentOption>(options: readonly T[], picked: readonly string[]): T[] {
  const lit = options.filter(o => picked.includes(o.id))
  return lit.length ? lit : options.slice(0, 1)
}

/**
 * The pill's menu: every choice with its count, those on show checked; `tint`, each count in its
 * choice's color as a profile's segment has it ('' for none, "All profiles"). `several`: a choice
 * checks on or off and keeps the menu open for the next, but for "All" ('all'), which closes it.
 */
export function segmentMenu(
  options: readonly SegmentOption[],
  picked: readonly string[],
  tint: boolean,
  several = false,
): MenuItem[] {
  return options.map(o => ({
    id: o.id,
    label: o.title,
    checked: picked.includes(o.id),
    count: o.n,
    ...(tint && { tint: o.color ?? '' }),
    ...(several && o.id !== 'all' && { keep: true }),
  }))
}
