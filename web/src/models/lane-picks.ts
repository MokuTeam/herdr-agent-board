// The lanes control's picks: the lanes on show, any set of them, in the order they were picked;
// none picked shows every lane. Kept in localStorage as board.filter, which held one lane's id or
// 'all' before: those still read as they did, and one lane (or none) is still written that way.

/** The lanes on show in the order they were picked; empty: every lane. */
export type LanePicks = readonly string[]

/** No lane picked: the board shows every lane. */
export const ALL_LANES: LanePicks = []

/** Whether the lanes control shows lane `category`. */
export const laneShown = (picks: LanePicks, category: string): boolean => !picks.length || picks.includes(category)

/**
 * A click on the lanes control: "All" (`id` 'all') shows every lane; a lane joins the picks, or
 * leaves them. `picks` may be the segments lit (litLanes), "All" among them.
 */
export function toggledLane(picks: readonly string[], id: string): LanePicks {
  if (id === 'all') return ALL_LANES
  const own = picks.filter(p => p !== 'all')
  return own.includes(id) ? own.filter(p => p !== id) : [...own, id]
}

/** The lanes control's segments lit: the lanes picked, else "All". */
export const litLanes = (picks: LanePicks): readonly string[] => (picks.length ? picks : ['all'])

/** "Show only", a digit key: that lane alone ('all': every lane). */
export const onlyLane = (id: string): LanePicks => (id === 'all' ? ALL_LANES : [id])

/** A lane that must be on show (a session just started there) joins the picks; with none picked it is already. */
export const withLane = (picks: LanePicks, id: string): LanePicks => (laneShown(picks, id) ? picks : [...picks, id])

/** The lane a new session starts in when nothing else names one: the first picked. */
export const firstPicked = (picks: LanePicks): string | null => picks[0] ?? null

/**
 * board.filter as stored: 'all', one lane's id (as before), or a JSON list of them. Text that is
 * no such list is one lane's id, whatever it starts with.
 */
export function parseLanes(text: string): LanePicks {
  if (!text || text === 'all') return ALL_LANES
  const list = text.startsWith('[') ? jsonList(text) : null
  if (!list) return [text]
  return [...new Set(list.filter(id => id !== '' && id !== 'all'))]
}

function jsonList(text: string): string[] | null {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : null
  } catch {
    return null
  }
}

/** The picks for board.filter: 'all' and one lane's id as before, several as a JSON list. */
export const lanesText = (picks: LanePicks): string =>
  picks.length === 0 ? 'all' : picks.length === 1 ? (picks[0] ?? 'all') : JSON.stringify(picks)
