// What the board shows of the payload: the items on show and the lane each is in.
import type { BoardCategory } from '../../../src/core/payload.ts'
import type { Item } from '../../../src/core/types.ts'

/** Whether the lanes control (`filter`: a category id or 'all') shows lane `category`. */
export const laneShown = (filter: string, category: string): boolean => filter === 'all' || filter === category

export type CategoryLook = { id: string; title: string; color: string }

/** A lane's title and color; one the payload does not list shows its id in gray. */
export function categoryInfo(categories: BoardCategory[], id: string): CategoryLook {
  return categories.find(c => c.id === id) ?? { id, title: id, color: 'var(--gray)' }
}

export interface ViewOptions {
  query: string
  /** Show sessions asleep in the idle column. */
  sleepers: boolean
  categories: BoardCategory[]
  categoryOf: (item: Item) => string
}

/** The items on the board: sleeping idle ones only when asked for, and those the search matches. */
export function visibleItems(items: Item[], { query, sleepers, categories, categoryOf }: ViewOptions): Item[] {
  const q = query.trim().toLowerCase()
  return items.filter(it => {
    if (!sleepers && it.sleeping && it.column === 'idle') return false
    if (!q) return true
    const title = categoryInfo(categories, categoryOf(it)).title
    return [it.name, it.autoName, it.doing, it.wait, it.title, it.lastText, it.prompt, it.workspace, title].some(
      v => v && String(v).toLowerCase().includes(q),
    )
  })
}
