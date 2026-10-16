// The items on show and the lane each is in, from the live data, the page's filters and the
// cards the user moved (until the server agrees).
import { useMemo } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { catOf, visibleItems } from '../models/board-view.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export interface BoardView {
  visible: Item[]
  categoryOf: (item: Item) => string
}

export function useBoardView(): BoardView {
  const { data, ui } = useBoardContext()
  const { query, sleepers, moves } = ui
  return useMemo(() => {
    const categoryOf = (item: Item): string => catOf(moves, item)
    const visible = data ? visibleItems(data.items, { query, sleepers, categories: data.categories, categoryOf }) : []
    return { visible, categoryOf }
  }, [data, query, sleepers, moves])
}
