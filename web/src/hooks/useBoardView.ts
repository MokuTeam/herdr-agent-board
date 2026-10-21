// The items on show and the lane each is in, from the live data, the page's filters and the
// cards the user moved (until the server agrees), less those on their way to the archive; sessions
// on their way show whatever the search, and those of the profile the switch shows. With one column
// shown alone (the Terminal style's W M O D I), only that column's.
import { useMemo } from 'react'
import type { Item, LaunchView } from '../../../src/core/types.ts'
import type { BoardPayload } from '../api/client.ts'
import { catOf, colOf, visibleItems } from '../models/board-view.ts'
import { pendingLaunches, placeholderOf } from '../models/launch.ts'
import { pickedProfile, profileShown } from '../models/profiles.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export interface BoardView {
  visible: Item[]
  categoryOf: (item: Item) => string
  /** The items on show whatever the profile switch picks: what it counts. */
  anyProfile: Item[]
}

/** Launches not yet a session on the board: the server's, and the page's own until the server has them. */
export const launchesOnTheirWay = (
  data: Pick<BoardPayload, 'launches' | 'items'> | null,
  launched: readonly LaunchView[],
  now: number,
): LaunchView[] => (data ? pendingLaunches(data.launches, launched, data.items, now) : [])

export function useBoardView(): BoardView {
  const { data, ui, now } = useBoardContext()
  const { query, sleepers, moves, launched, archiving, column } = ui
  const profile = pickedProfile(ui.profile, data?.profiles)
  return useMemo(() => {
    const categoryOf = (item: Item): string => catOf(moves, item)
    if (!data) return { visible: [], categoryOf, anyProfile: [] }
    const options = { query, sleepers, categories: data.categories, categoryOf, archiving }
    const onTheirWay = launchesOnTheirWay(data, launched, now).map(placeholderOf)
    const anyProfile = visibleItems(data.items, options).concat(onTheirWay)
    const all =
      profile === 'all'
        ? anyProfile
        : visibleItems(data.items, { ...options, profile }).concat(onTheirWay.filter(l => profileShown(profile, l)))
    const visible = column ? all.filter(it => colOf(moves, it) === column) : all
    return { visible, categoryOf, anyProfile }
  }, [data, query, sleepers, profile, moves, launched, now, archiving, column])
}
