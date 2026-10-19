import { expect, test } from 'bun:test'
import { resultToken } from '../../web/src/models/attention.ts'
import { NO_EDITS } from '../../web/src/models/board-edits.ts'
import { catOf, colOf, NO_MOVES } from '../../web/src/models/board-view.ts'
import { type BoardUi, boardUi, initialUi, parseSeen } from '../../web/src/state/board-ui.ts'
import { item } from './support/board.tsx'

const stored = (values: Record<string, string>) => (key: string, fallback: string) => values[key] ?? fallback

test('the page state starts from localStorage: lane, sleepers and view receipts, with defaults', () => {
  expect(initialUi(stored({}))).toEqual({
    filter: 'all',
    profile: 'all',
    query: '',
    sleepers: true,
    viewed: {},
    open: null,
    opened: 0,
    compose: false,
    limitsOpen: false,
    toasts: [],
    lastToast: 0,
    moves: NO_MOVES,
    busy: new Map(),
    edits: NO_EDITS,
    launched: [],
  })
  const ui = initialUi(
    stored({ 'board.filter': 'proj', 'board.sleepers': '0', 'board.viewed': '{"a":"[1,\\"\\",\\"x\\"]","b":5}' }),
  )
  expect([ui.filter, ui.sleepers, ui.viewed]).toEqual(['proj', false, { a: '[1,"","x"]' }])
  expect(parseSeen('not json')).toEqual({})
  expect(parseSeen('null')).toEqual({})
})

test('actions: lane, search, sleepers, open session, usage popover and toasts', () => {
  let ui: BoardUi = initialUi(stored({}))
  ui = boardUi(ui, { type: 'filter', id: 'proj' })
  ui = boardUi(ui, { type: 'query', text: 'login' })
  ui = boardUi(ui, { type: 'toggleSleepers' })
  ui = boardUi(ui, { type: 'open', key: 'a' })
  ui = boardUi(ui, { type: 'limits', open: true })
  expect([ui.filter, ui.query, ui.sleepers, ui.open, ui.limitsOpen]).toEqual(['proj', 'login', false, 'a', true])
  ui = boardUi(ui, { type: 'toast', text: 'one', error: false })
  ui = boardUi(ui, { type: 'toast', text: 'two', error: true })
  expect(ui.toasts).toEqual([
    { id: 1, text: 'one', error: false },
    { id: 2, text: 'two', error: true },
  ])
  ui = boardUi(ui, { type: 'toastGone', id: 1 })
  ui = boardUi(ui, { type: 'toast', text: 'three', error: false })
  expect(ui.toasts.map(toast => [toast.id, toast.text])).toEqual([
    [2, 'two'],
    [3, 'three'],
  ])
})

test('moves: a drop shows at once, a failure takes it back, a board settles what the server agreed to', () => {
  const a = item({ key: 'a', category: 'other', column: 'done' })
  let ui: BoardUi = initialUi(stored({}))
  ui = boardUi(ui, { type: 'move', key: 'a', cat: 'proj', column: 'me', at: 1000 })
  expect([catOf(ui.moves, a), colOf(ui.moves, a)]).toEqual(['proj', 'me'])
  const failed = boardUi(ui, { type: 'unmove', key: 'a' })
  expect([catOf(failed.moves, a), colOf(failed.moves, a)]).toEqual(['other', 'done'])
  const agreed = boardUi(ui, { type: 'settle', items: [{ ...a, category: 'proj' }], now: 2000 })
  expect([[...agreed.moves.cat.keys()], [...agreed.moves.col.keys()]]).toEqual([[], ['a']])
  // Nothing settled: the same state, so the page does not draw again for it.
  expect(boardUi(ui, { type: 'settle', items: [a], now: 2000 })).toBe(ui)
})

test('busy: what is happening to a session ("Waking…") until it is over', () => {
  let ui: BoardUi = initialUi(stored({}))
  ui = boardUi(ui, { type: 'busy', key: 'a', label: 'Waking…' })
  ui = boardUi(ui, { type: 'busy', key: 'b', label: 'Going to sleep…' })
  expect([...ui.busy]).toEqual([
    ['a', 'Waking…'],
    ['b', 'Going to sleep…'],
  ])
  ui = boardUi(ui, { type: 'busy', key: 'a', label: null })
  expect([...ui.busy]).toEqual([['b', 'Going to sleep…']])
})

test('opening: each one counts (the same session again starts its sheet over), "Write" asks for the message box', () => {
  let ui: BoardUi = initialUi(stored({}))
  ui = boardUi(ui, { type: 'open', key: 'a' })
  expect([ui.open, ui.opened, ui.compose]).toEqual(['a', 1, false])
  ui = boardUi(ui, { type: 'open', key: 'a', compose: true })
  expect([ui.open, ui.opened, ui.compose]).toEqual(['a', 2, true])
  ui = boardUi(ui, { type: 'open', key: null })
  expect([ui.open, ui.opened, ui.compose]).toEqual([null, 2, true])
  ui = boardUi(ui, { type: 'open', key: 'b' })
  expect([ui.open, ui.opened, ui.compose]).toEqual(['b', 3, false])
})

test('a result read in the sheet is recorded as viewed', () => {
  const done = item({ key: 'a', column: 'done', result: 'Fixed', activity: 5 })
  const ui = boardUi(initialUi(stored({})), { type: 'viewed', item: done })
  expect(ui.viewed).toEqual({ a: resultToken(done) })
})
