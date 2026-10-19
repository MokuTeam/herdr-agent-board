// The page's own edits of the board it shows (models/board-edits.ts, state/board-ui.ts 'edit'), as
// the old page made them on its state.data: lanes sorted by the order dragged to
// (web/app.js endCatDrag), a cancelled reminder filtered out (cancelSchedule), a switched one's
// `idle` set or taken back (toggleMode) — until the next board, which is the server's word.
import { describe, expect, test } from 'bun:test'
import type { BoardCategory } from '../../src/core/payload.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { NO_EDITS, withEdit, withEdits } from '../../web/src/models/board-edits.ts'
import { boardUi, initialUi } from '../../web/src/state/board-ui.ts'
import { item, payload } from './support/board.tsx'

const cat = (id: string): BoardCategory => ({
  id,
  title: id,
  color: '#000',
  colorName: 'gray',
  paths: [],
  configured: true,
  fallback: false,
})
const CATEGORIES = ['a', 'b', 'c', 'other'].map(cat)
const SCHEDULES: ScheduleEntry[] = [
  { id: 's1', key: 'k', text: 'one', next: 1, idle: true },
  { id: 's2', key: 'k', text: 'two', next: 2 },
  { id: 's3', key: 'k', text: 'three', next: 3 },
]
const data = payload({ items: [item({ key: 'k' })], categories: CATEGORIES, schedules: SCHEDULES })

describe('the board with the page’s edits', () => {
  test('none: the very same board', () => {
    expect(withEdits(data, NO_EDITS)).toBe(data)
  })

  test('lanes in the order dragged to, as Array.prototype.sort with indexOf put them', () => {
    const ids = ['c', 'a', 'b', 'other']
    const shown = withEdits(data, withEdit(NO_EDITS, { type: 'order', ids }))
    expect(shown.categories.map(c => c.id)).toEqual(ids)
    // A lane the order does not name (made while dragging) comes first, as before.
    const old = [...CATEGORIES, cat('new')].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id))
    const more = { ...data, categories: [...CATEGORIES, cat('new')] }
    expect(withEdits(more, withEdit(NO_EDITS, { type: 'order', ids })).categories).toEqual(old)
    expect(shown.schedules).toBe(data.schedules)
    expect(shown.items).toBe(data.items)
  })

  test('a cancelled reminder is off the board at once', () => {
    const shown = withEdits(data, withEdit(NO_EDITS, { type: 'cancelled', id: 's2' }))
    expect(shown.schedules.map(e => e.id)).toEqual(['s1', 's3'])
    expect(shown.categories).toBe(data.categories)
  })

  test('a switch shows at once (`idle: true`, or no `idle`), and is taken back when the server says no', () => {
    let edits = withEdit(NO_EDITS, { type: 'idle', id: 's1', idle: false })
    edits = withEdit(edits, { type: 'idle', id: 's2', idle: true })
    const shown = withEdits(data, edits)
    expect(shown.schedules).toEqual([
      { id: 's1', key: 'k', text: 'one', next: 1 },
      { id: 's2', key: 'k', text: 'two', next: 2, idle: true },
      SCHEDULES[2] as ScheduleEntry,
    ])
    const back = withEdits(data, withEdit(edits, { type: 'idle', id: 's1', idle: null }))
    expect(back.schedules[0]).toBe(SCHEDULES[0] as ScheduleEntry)
  })
})

test('the next board lets the edits go; a board with nothing to settle and no edits changes nothing', () => {
  let ui = initialUi((_key, fallback) => fallback)
  ui = boardUi(ui, { type: 'edit', edit: { type: 'order', ids: ['b', 'a'] } })
  ui = boardUi(ui, { type: 'edit', edit: { type: 'cancelled', id: 's1' } })
  expect(ui.edits.order).toEqual(['b', 'a'])
  expect([...ui.edits.cancelled]).toEqual(['s1'])
  const next = boardUi(ui, { type: 'settle', items: [], now: 0 })
  expect(next.edits).toBe(NO_EDITS)
  expect(boardUi(next, { type: 'settle', items: [], now: 0 })).toBe(next)
})
