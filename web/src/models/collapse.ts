// A part of the sheet folding up and opening again (hooks/useCollapse.ts): between its folded size
// and its open one, as far along as the spring has come (`progress`: 0 folded, 1 open). Sizes are the
// ones the stylesheet gives each state, in pixels; what is not in the folded one is faded, and the
// content inside rises a little as it folds, so it goes back up the way it came.

/** The sizes of a part in one state. */
export interface Sizes {
  height: number
  paddingTop: number
  paddingBottom: number
  marginTop: number
  marginBottom: number
}

export const SIZE_PROPS = [
  'height',
  'paddingTop',
  'paddingBottom',
  'marginTop',
  'marginBottom',
] as const satisfies readonly (keyof Sizes)[]

export interface CollapseFrame extends Sizes {
  /** 0 to 1: the content's share of its colour (folded, it is gone). */
  opacity: number
  /** How far up the content sits, in pixels (0 when open). */
  shift: number
}

const lerp = (from: number, to: number, p: number): number => from + (to - from) * p

/** The part `progress` of the way from `folded` to `open`; the spring may overshoot, the sizes never go below 0. */
export function collapseFrame(
  progress: number,
  folded: Sizes,
  open: Sizes,
  rise: number,
  fade: boolean,
): CollapseFrame {
  const p = Number.isFinite(progress) ? progress : 1
  const size = (prop: keyof Sizes) => Math.max(0, lerp(folded[prop], open[prop], p))
  const shown = Math.min(1, Math.max(0, p))
  return {
    height: size('height'),
    paddingTop: size('paddingTop'),
    paddingBottom: size('paddingBottom'),
    marginTop: size('marginTop'),
    marginBottom: size('marginBottom'),
    opacity: fade ? shown : 1,
    shift: -rise * (1 - shown),
  }
}
