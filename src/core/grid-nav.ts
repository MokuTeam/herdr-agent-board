// Moving the selection across the board by keys, the same on the terminal board (src/tui/state.ts)
// and on the web board in its Terminal style (web/src/hooks/useTerminalKeys.ts). A wide board is a
// grid, lanes by columns: left and right stay in the lane, up and down go on into the lanes above
// and below. A narrow one is a plain list, lane by lane and column by column.

export type Dir = 'up' | 'down' | 'left' | 'right' | 'home' | 'last'

export interface Keyed {
  key: string
}

/** A lane's cards, one list per column, in the columns' order. */
export interface GridLane<T extends Keyed = Keyed> {
  cols: readonly (readonly T[])[]
}

/** The key one step from `sel` in a list: back for up and left, on for down and right; the ends for home and last. */
export function listStep(list: readonly Keyed[], sel: string | null, dir: Dir): string | null {
  if (dir === 'home') return list[0]?.key ?? null
  if (dir === 'last') return list.at(-1)?.key ?? null
  const i = list.findIndex(x => x.key === sel)
  if (dir === 'up' || dir === 'left') return list[Math.max(0, i - 1)]?.key ?? null
  return list[Math.min(list.length - 1, i + 1)]?.key ?? null
}

/** Where `sel` sits in the grid. */
function positionOf(lanes: readonly GridLane[], sel: string | null): { li: number; ci: number; ii: number } | null {
  for (const [li, lane] of lanes.entries()) {
    for (const [ci, col] of lane.cols.entries()) {
      const ii = col.findIndex(x => x.key === sel)
      if (ii >= 0) return { li, ci, ii }
    }
  }
  return null
}

/**
 * The card of a lane in the column nearest to `ci` (the left one first on a tie): its last one
 * going up, its first going down. So up and down reach a lane with nothing in this column.
 */
function nearestIn(lane: GridLane | undefined, ci: number, last: boolean): Keyed | null {
  if (!lane) return null
  for (let d = 0; d < lane.cols.length; d++) {
    for (const c of d ? [ci - d, ci + d] : [ci]) {
      const col = lane.cols[c]
      if (col?.length) return (last ? col.at(-1) : col[0]) ?? null
    }
  }
  return null
}

/** The key of the neighbour of `sel` in the grid, or null at the edge (or with `sel` not in it). */
export function gridStep(
  lanes: readonly GridLane[],
  sel: string | null,
  dir: Exclude<Dir, 'home' | 'last'>,
): string | null {
  const pos = positionOf(lanes, sel)
  if (!pos) return null
  const { li, ci, ii } = pos
  const col = lanes[li]?.cols[ci] ?? []
  let next: Keyed | null = null
  if (dir === 'up') {
    if (ii > 0) next = col[ii - 1] ?? null
    else for (let l = li - 1; l >= 0 && !next; l--) next = nearestIn(lanes[l], ci, true)
  } else if (dir === 'down') {
    if (ii < col.length - 1) next = col[ii + 1] ?? null
    else for (let l = li + 1; l < lanes.length && !next; l++) next = nearestIn(lanes[l], ci, false)
  } else {
    const step = dir === 'right' ? 1 : -1
    const width = lanes[li]?.cols.length ?? 0
    for (let c = ci + step; c >= 0 && c < width && !next; c += step) {
      const other = lanes[li]?.cols[c] ?? []
      if (other.length) next = other[Math.min(ii, other.length - 1)] ?? null
    }
  }
  return next?.key ?? null
}
