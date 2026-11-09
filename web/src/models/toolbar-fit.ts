// The board's toolbar without a page (#347): which of its actions stay in the row at the width it
// has, in what order the rest leave for More, and what More lists. The DOM side (measuring the
// actions, hiding the ones that left) is hooks/useToolbarFit.ts; the menu is components/Toolbar.tsx.

/** The gap between the title, the filters and the actions in the one-row toolbar (styles/toolbar.css). */
export const ROW_GAP = 16

/**
 * What the filters (the lanes control, the profile switch, search) need beside the title in the
 * one-row toolbar, folded into their pills as they fold when the room is short (hooks/useSegmentFolds.ts).
 */
export const FILTERS_MIN = 420

/** What the one row is made of, in px. */
export interface RowSizes {
  /** The title. */
  title: number
  /** Every action, the pinned buttons and the gaps between them, whole. */
  actions: number
}

/**
 * Whether a toolbar `width` px wide holds everything in one row: the title, the filters (folded into
 * pills if they must) and every action, none of them in More. Else it takes two rows (the title and
 * the actions, then the filters). The filters fold before an action leaves for More: this is what
 * keeps them from taking the room first.
 */
export const oneRowFits = (width: number, { title, actions }: RowSizes, filters = FILTERS_MIN): boolean =>
  title + ROW_GAP + filters + ROW_GAP + actions <= width

/**
 * The actions that may leave the row, the most used first: what stays longest comes first, what
 * goes first comes last. Each is the id of its button (the calendar's: of its wrapper). Settings,
 * More and the live dot are not here: they never leave.
 */
export const TOOLBAR_PRIORITY: readonly string[] = [
  'presence-switch',
  'presence-offer',
  'todos-open',
  'new-session',
  'presence-call',
  'sched-open',
  'next-attention',
  'cal-tb',
  'time-open',
  'limits',
  'archive-open',
  'cats-open',
  'setup-note',
  'backup-note',
  'wake-note',
]

/** One action as measured: its id and the width it takes whole. */
export interface ToolbarItem {
  id: string
  width: number
}

export interface ToolbarOptions {
  /** The gap between neighbours. */
  gap?: number
  /** More's width. */
  more?: number
  /** What always stays (the pinned buttons and the gaps before them), taken off the room first. */
  pinned?: number
}

export interface ToolbarFit {
  /** The ids that stay in the row, in priority order. */
  shown: string[]
  /** The ids that left for More, in priority order. */
  over: string[]
}

/**
 * How a row `room` px wide holds `items`, given in priority order: as many from the front as fit
 * beside what is pinned, and More (`more` px) for the rest; no More when all of them fit. The
 * first always stays, shrinking if it must (the presence pill cuts its words with an ellipsis): a
 * row never has nothing but More. No later item takes the place of one that does not fit, so
 * what is in More is always the end of the list, never a pick of it.
 */
export function fitToolbar(
  items: readonly ToolbarItem[],
  room: number,
  { gap = 6, more = 28, pinned = 0 }: ToolbarOptions = {},
): ToolbarFit {
  const ids = items.map(i => i.id)
  if (!items.length) return { shown: [], over: [] }
  const left = room - pinned
  const used = (n: number): number => items.slice(0, n).reduce((sum, it, i) => sum + (i ? gap : 0) + it.width, 0)
  if (used(items.length) <= left) return { shown: ids, over: [] }
  let shown = 1
  for (let n = 2; n < items.length; n++) {
    if (used(n) + gap + more > left) break
    shown = n
  }
  return { shown: ids.slice(0, shown), over: ids.slice(shown) }
}

/** The widths the row's items take, in the order the page draws them. */
export const byPriority = <T extends { id: string }>(items: readonly T[]): T[] =>
  TOOLBAR_PRIORITY.map(id => items.find(it => it.id === id)).filter((it): it is T => !!it)

/** What More offers for one action that left the row. */
export interface ToolbarEntry {
  id: string
  label: string
  /** A count after the label (Tasks, Schedule, Next). */
  count?: number
  /** The count in this color, as the due reminders' badge is orange. */
  tint?: string
  /** A line of its own after the label (the usage readings). */
  hint?: string
  disabled?: boolean
  reason?: string
  /** Something here needs a look: More's button carries a dot while an entry in it does. */
  alert?: boolean
}

/** More's entries: those of the actions that left, in the order they left. */
export function moreEntries(entries: readonly ToolbarEntry[], over: readonly string[]): ToolbarEntry[] {
  return over.flatMap(id => entries.filter(e => e.id === id))
}

/** More carries a dot while something in it needs a look. */
export const moreAlert = (entries: readonly ToolbarEntry[]): boolean => entries.some(e => e.alert === true)
