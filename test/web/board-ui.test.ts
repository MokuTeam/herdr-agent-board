import { expect, test } from 'bun:test'
import { type BoardUi, boardUi, initialUi, parseSeen } from '../../web/src/state/board-ui.ts'

const stored = (values: Record<string, string>) => (key: string, fallback: string) => values[key] ?? fallback

test('the page state starts from localStorage: lane, sleepers and view receipts, with defaults', () => {
  expect(initialUi(stored({}))).toEqual({
    filter: 'all',
    query: '',
    sleepers: true,
    viewed: {},
    open: null,
    limitsOpen: false,
    toasts: [],
    lastToast: 0,
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
