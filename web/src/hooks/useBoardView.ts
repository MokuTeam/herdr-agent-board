// The items on show and the lane each is in, from the live data, the page's filters and the
// cards the user moved (until the server agrees), less those on their way to the archive; sessions
// on their way show whatever the search, and those of the profile the switch shows, and of the device
// its switch shows (#502, only on a master's board with more than one device). With one column
// shown alone (the Terminal style's W M O D I), only that column's.
import { useMemo } from 'react'
import type { BoardCategory } from '../../../src/core/payload.ts'
import type { Item, LaunchView } from '../../../src/core/types.ts'
import type { BoardPayload } from '../api/client.ts'
import { catOf, colOf, deviceLanes, visibleItems } from '../models/board-view.ts'
import { deviceShown, pickedDevice } from '../models/devices.ts'
import { pendingLaunches, placeholderOf } from '../models/launch.ts'
import { pickedProfile, profileShown } from '../models/profiles.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export interface BoardView {
  visible: Item[]
  categoryOf: (item: Item) => string
  /** The items on show whatever the profile switch picks: what it counts. */
  anyProfile: Item[]
  /** The items on show whatever the device switch picks: what it counts (#502). */
  anyDevice: Item[]
  /** The lanes drawn: the payload's, or the picked device's own (#923, deviceLanes). */
  lanes: BoardCategory[]
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
  const device = pickedDevice(ui.device ?? 'all', data?.devices)
  return useMemo(() => {
    const categoryOf = (item: Item): string => catOf(moves, item)
    if (!data) return { visible: [], categoryOf, anyProfile: [], anyDevice: [], lanes: [] }
    const options = { query, sleepers, categories: data.categories, categoryOf, archiving }
    const onTheirWay = launchesOnTheirWay(data, launched, now).map(placeholderOf)
    const anyProfileHere = visibleItems(data.items, options).concat(onTheirWay)
    const anyDevice =
      profile === 'all'
        ? anyProfileHere
        : visibleItems(data.items, { ...options, profile }).concat(onTheirWay.filter(l => profileShown(profile, l)))
    // The device switch: 'all' on every board but a master's with a device picked, the lists as they are.
    const onDevice = (list: Item[]): Item[] =>
      device === 'all' ? list : list.filter(it => deviceShown(device, it, data.devices))
    const anyProfile = onDevice(anyProfileHere)
    const all = onDevice(anyDevice)
    const visible = column ? all.filter(it => colOf(moves, it) === column) : all
    const lanes = deviceLanes(data.categories, data.devices, device, all, categoryOf)
    return { visible, categoryOf, anyProfile, anyDevice, lanes }
  }, [data, query, sleepers, profile, device, moves, launched, now, archiving, column])
}
