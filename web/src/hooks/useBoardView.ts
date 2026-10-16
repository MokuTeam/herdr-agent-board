// The items on show and the lane each is in, from the live data and the page's filters.
import { useMemo } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { visibleItems } from '../models/board-view.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export interface BoardView {
  visible: Item[]
  categoryOf: (item: Item) => string
}

const categoryOf = (item: Item): string => item.category

export function useBoardView(): BoardView {
  const { data, ui } = useBoardContext()
  const { query, sleepers } = ui
  return useMemo(() => {
    const visible = data ? visibleItems(data.items, { query, sleepers, categories: data.categories, categoryOf }) : []
    return { visible, categoryOf }
  }, [data, query, sleepers])
}
