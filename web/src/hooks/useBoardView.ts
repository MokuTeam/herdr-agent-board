// The items on show and the lane each is in, from the live data, the page's filters and the
// cards the user moved (until the server agrees); sessions on their way show whatever the search.
import { useMemo } from 'react'
import type { Item, LaunchView } from '../../../src/core/types.ts'
import type { BoardPayload } from '../api/client.ts'
import { catOf, visibleItems } from '../models/board-view.ts'
import { pendingLaunches, placeholderOf } from '../models/launch.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export interface BoardView {
  visible: Item[]
  categoryOf: (item: Item) => string
}

/** Launches not yet a session on the board: the server's, and the page's own until the server has them. */
export const launchesOnTheirWay = (
  data: Pick<BoardPayload, 'launches' | 'items'> | null,
  launched: readonly LaunchView[],
  now: number,
): LaunchView[] => (data ? pendingLaunches(data.launches, launched, data.items, now) : [])

export function useBoardView(): BoardView {
  const { data, ui, now } = useBoardContext()
  const { query, sleepers, moves, launched } = ui
  return useMemo(() => {
    const categoryOf = (item: Item): string => catOf(moves, item)
    const visible = data
      ? visibleItems(data.items, { query, sleepers, categories: data.categories, categoryOf }).concat(
          launchesOnTheirWay(data, launched, now).map(placeholderOf),
        )
      : []
    return { visible, categoryOf }
  }, [data, query, sleepers, moves, launched, now])
}
