// What the board shows of the payload, pinned from web/app.js: the items on show (visibleItems,
// app.js:115-123), the lane and column of a card with the user's pending moves (catOf/colOf and
// their settling in onData, app.js:108-109,136-137), the lanes in category order (render(),
// app.js:535-598), and the pure parts of dragging and motion (app.js:611-795).
import { describe, expect, test } from 'bun:test'
import type { BoardCategory } from '../../src/core/payload.ts'
import type { ColumnId, Item } from '../../src/core/types.ts'
import {
  anyShown,
  appearing,
  categoryInfo,
  catOf,
  colOf,
  DRAG,
  dragStarted,
  dropLit,
  dropTarget,
  edgeScroll,
  laneShown,
  lanesOf,
  mayDrag,
  NO_MOVES,
  type PendingMoves,
  settleMoves,
  visibleItems,
  withMove,
  withoutMove,
} from '../../web/src/models/board-view.ts'
import { item } from './support/board.tsx'

const category = (id: string, title: string, color: string): BoardCategory => ({
  id,
  title,
  color,
  colorName: 'blue',
  paths: [],
  configured: true,
  fallback: false,
})
const categories = [category('proj', 'Client Work', '#007AFF')]
const categoryOf = (it: Item) => it.category
const keys = (items: Item[]) => items.map(i => i.key)

describe('visibleItems', () => {
  test('sleeping sessions in the idle column hide unless asked for; sleeping ones elsewhere stay', () => {
    const items = [
      item({ key: 'a', column: 'idle', sleeping: true }),
      item({ key: 'b', column: 'done', sleeping: true }),
      item({ key: 'c', column: 'idle' }),
    ]
    expect(keys(visibleItems(items, { query: '', sleepers: false, categories, categoryOf }))).toEqual(['b', 'c'])
    expect(keys(visibleItems(items, { query: '', sleepers: true, categories, categoryOf }))).toEqual(['a', 'b', 'c'])
  })

  test('the search matches names, texts, the workspace and the lane title, ignoring case and outer spaces', () => {
    const items = [
      item({ key: 'a', name: 'Alpha' }),
      item({ key: 'b', doing: 'Fixing the LOGIN form' }),
      item({ key: 'c', workspace: 'infra' }),
      item({ key: 'd', category: 'proj' }),
      item({ key: 'e', lastText: 'nothing here' }),
    ]
    const search = (query: string) => keys(visibleItems(items, { query, sleepers: true, categories, categoryOf }))
    expect(search('  alpha ')).toEqual(['a'])
    expect(search('login')).toEqual(['b'])
    expect(search('INFRA')).toEqual(['c'])
    expect(search('client')).toEqual(['d'])
    expect(search('zzz')).toEqual([])
  })

  test('the lane title searched is the one the user dropped the card in', () => {
    const items = [item({ key: 'a', category: 'other' })]
    const moves = withMove(NO_MOVES, 'a', { cat: 'proj', column: null, at: 0 })
    const moved = (it: Item) => catOf(moves, it)
    expect(keys(visibleItems(items, { query: 'client', sleepers: true, categories, categoryOf: moved }))).toEqual(['a'])
    expect(keys(visibleItems(items, { query: 'client', sleepers: true, categories, categoryOf }))).toEqual([])
  })

  test('lanes on show and the look of a lane the payload does not list', () => {
    expect(laneShown('all', 'x')).toBe(true)
    expect(laneShown('x', 'x')).toBe(true)
    expect(laneShown('y', 'x')).toBe(false)
    expect(categoryInfo(categories, 'proj').title).toBe('Client Work')
    expect(categoryInfo(categories, 'new')).toEqual({ id: 'new', title: 'new', color: 'var(--gray)' })
  })
})

describe('pending moves', () => {
  const a = item({ key: 'a', category: 'other', column: 'done' })

  test('a card shows in the lane and column it was dropped in until the server agrees', () => {
    expect([catOf(NO_MOVES, a), colOf(NO_MOVES, a)]).toEqual(['other', 'done'])
    const moves = withMove(NO_MOVES, 'a', { cat: 'proj', column: 'idle', at: 1000 })
    expect([catOf(moves, a), colOf(moves, a)]).toEqual(['proj', 'idle'])
    expect([catOf(moves, item({ key: 'b' })), colOf(moves, item({ key: 'b' }))]).toEqual(['other', 'idle'])
  })

  test('a drop changes only what it names; a failed move takes both back', () => {
    let moves = withMove(NO_MOVES, 'a', { cat: 'proj', column: null, at: 1000 })
    moves = withMove(moves, 'a', { cat: null, column: 'me', at: 2000 })
    expect([catOf(moves, a), colOf(moves, a)]).toEqual(['proj', 'me'])
    expect(moves.col.get('a')).toEqual({ col: 'me', at: 2000 })
    moves = withoutMove(moves, 'a')
    expect([catOf(moves, a), colOf(moves, a)]).toEqual(['other', 'done'])
    expect(withMove(NO_MOVES, 'a', { cat: null, column: null, at: 0 })).toEqual(NO_MOVES)
  })

  test('each board settles them: the server agrees, or a column waited 8 s; the rest stay', () => {
    let moves: PendingMoves = NO_MOVES
    moves = withMove(moves, 'a', { cat: 'proj', column: 'idle', at: 1000 })
    moves = withMove(moves, 'b', { cat: 'proj', column: 'me', at: 1000 })
    moves = withMove(moves, 'c', { cat: null, column: 'ext', at: 5000 })
    const items = [
      item({ key: 'a', category: 'proj', column: 'idle' }), // both agreed
      item({ key: 'b', category: 'other', column: 'done' }), // nothing agreed yet
      item({ key: 'c', column: 'done' }),
    ]
    const at8999 = settleMoves(moves, items, 8999)
    expect([...at8999.cat.keys()]).toEqual(['b'])
    expect([...at8999.col.keys()]).toEqual(['b', 'c'])
    const at9001 = settleMoves(moves, items, 9001) // b's column was set at 1000: 8001 ms ago
    expect([...at9001.col.keys()]).toEqual(['c'])
    expect([...settleMoves(moves, items, 13_001).col.keys()]).toEqual([])
    // A card no longer on the board keeps its lane move; its column move only times out.
    expect([...settleMoves(moves, [], 2000).cat.keys()]).toEqual(['a', 'b'])
  })

  test('settling with nothing to settle keeps the same object (no new page state)', () => {
    const moves = withMove(NO_MOVES, 'b', { cat: 'proj', column: null, at: 0 })
    expect(settleMoves(moves, [item({ key: 'b' })], 1)).toBe(moves)
    expect(settleMoves(NO_MOVES, [], 1)).toBe(NO_MOVES)
  })
})

describe('lanesOf', () => {
  const columns: { id: ColumnId }[] = [{ id: 'work' }, { id: 'me' }, { id: 'ext' }, { id: 'done' }, { id: 'idle' }]
  const board = {
    categories: [
      category('proj', 'Project', '#007AFF'),
      category('other', 'Other', '#8E8E93'),
      category('x', 'X', '#f00'),
    ],
    columns,
  }
  const visible = [
    item({ key: 'a', category: 'other', column: 'done' }),
    item({ key: 'b', category: 'proj', column: 'work' }),
    item({ key: 'c', category: 'proj', column: 'done' }),
    item({ key: 'd', category: 'gone', column: 'idle' }), // a lane the payload does not list: on no lane
    item({ key: 'e', category: 'proj', column: 'done' }),
  ]

  test('one lane per category in the payload order, its cards per column in board order', () => {
    const lanes = lanesOf(board, visible, 'all', NO_MOVES)
    expect(lanes.map(l => [l.id, l.title, l.color, keys(l.items), l.shown])).toEqual([
      ['proj', 'Project', '#007AFF', ['b', 'c', 'e'], true],
      ['other', 'Other', '#8E8E93', ['a'], true],
      ['x', 'X', '#f00', [], true],
    ])
    expect(lanes[0]?.columns.map(c => [c.id, keys(c.items)])).toEqual([
      ['work', ['b']],
      ['me', []],
      ['ext', []],
      ['done', ['c', 'e']],
      ['idle', []],
    ])
    expect(anyShown(lanes)).toBe(true)
  })

  test('the lanes control hides the other lanes; nothing on show when the picked lane is empty', () => {
    const lanes = lanesOf(board, visible, 'other', NO_MOVES)
    expect(lanes.map(l => l.shown)).toEqual([false, true, false])
    expect(anyShown(lanes)).toBe(true)
    expect(anyShown(lanesOf(board, visible, 'x', NO_MOVES))).toBe(false)
    expect(anyShown(lanesOf(board, [], 'all', NO_MOVES))).toBe(false)
  })

  test('pending moves place the card in its new lane and column', () => {
    const moves = withMove(NO_MOVES, 'a', { cat: 'proj', column: 'me', at: 0 })
    const proj = lanesOf(board, visible, 'all', moves)[0]
    expect(keys(proj?.items ?? [])).toEqual(['a', 'b', 'c', 'e'])
    expect(proj?.columns.find(c => c.id === 'me')?.items.map(i => i.key)).toEqual(['a'])
  })
})

describe('dragging a card', () => {
  const it = item({ key: 'a', category: 'proj', column: 'done' })

  test('the constants of the old page', () => {
    expect(DRAG).toEqual({ threshold: 6, clickAfterMs: 350, samples: 12, edgeTop: 150, edgeBottom: 70, scrollStep: 14 })
  })

  test('a drag starts with the left button of a mouse or pen, off the card buttons, on a session the board can edit', () => {
    const ok = { canEdit: true, pointerType: 'mouse', button: 0, onControl: false, known: true }
    expect(mayDrag(ok)).toBe(true)
    expect(mayDrag({ ...ok, pointerType: 'pen' })).toBe(true)
    expect(mayDrag({ ...ok, canEdit: false })).toBe(false)
    expect(mayDrag({ ...ok, pointerType: 'touch' })).toBe(false)
    expect(mayDrag({ ...ok, button: 2 })).toBe(false)
    expect(mayDrag({ ...ok, onControl: true })).toBe(false)
    expect(mayDrag({ ...ok, known: false })).toBe(false)
  })

  test('it becomes a drag once the pointer travelled 6 px', () => {
    expect(dragStarted({ x: 10, y: 10 }, { x: 13, y: 15 })).toBe(false) // 5.83 px
    expect(dragStarted({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(true)
    expect(dragStarted({ x: 10, y: 10 }, { x: 14, y: 14.5 })).toBe(true)
  })

  test('the drop target: another lane, another column, both or nothing; "Working" takes no cards', () => {
    expect(dropTarget(it, NO_MOVES, { lane: null, column: null })).toBeNull()
    expect(dropTarget(undefined, NO_MOVES, { lane: 'other', column: 'me' })).toBeNull()
    expect(dropTarget(it, NO_MOVES, { lane: 'proj', column: 'done' })).toBeNull()
    expect(dropTarget(it, NO_MOVES, { lane: 'proj', column: null })).toBeNull()
    expect(dropTarget(it, NO_MOVES, { lane: 'other', column: null })).toEqual({ cat: 'other', column: null })
    expect(dropTarget(it, NO_MOVES, { lane: 'other', column: 'done' })).toEqual({ cat: 'other', column: null })
    expect(dropTarget(it, NO_MOVES, { lane: 'proj', column: 'me' })).toEqual({ cat: null, column: 'me' })
    expect(dropTarget(it, NO_MOVES, { lane: 'other', column: 'idle' })).toEqual({ cat: 'other', column: 'idle' })
    expect(dropTarget(it, NO_MOVES, { lane: 'proj', column: 'work' })).toBeNull()
    expect(dropTarget(it, NO_MOVES, { lane: 'other', column: 'work' })).toEqual({ cat: 'other', column: null })
    expect(dropTarget(it, NO_MOVES, { lane: 'proj', column: 'nonsense' })).toBeNull()
  })

  test('the drop target counts the pending move: where the card is on screen', () => {
    const moves = withMove(NO_MOVES, 'a', { cat: 'other', column: 'me', at: 0 })
    expect(dropTarget(it, moves, { lane: 'other', column: 'me' })).toBeNull()
    expect(dropTarget(it, moves, { lane: 'proj', column: 'done' })).toEqual({ cat: 'proj', column: 'done' })
  })

  test('what lights up: the column when the column changes, else the lane', () => {
    expect(dropLit(null, { lane: 'proj', column: 'done' })).toBeNull()
    expect(dropLit({ cat: 'other', column: null }, { lane: 'other', column: 'done' })).toEqual({
      lane: 'other',
      column: null,
    })
    expect(dropLit({ cat: null, column: 'me' }, { lane: 'proj', column: 'me' })).toEqual({ lane: 'proj', column: 'me' })
    expect(dropLit({ cat: 'other', column: 'me' }, { lane: 'other', column: 'me' })).toEqual({
      lane: 'other',
      column: 'me',
    })
  })

  test('near the top or above a bottom panel the page scrolls 14 px per move', () => {
    expect(edgeScroll(149, 1000, 0)).toBe(-14)
    expect(edgeScroll(150, 1000, 0)).toBe(0)
    expect(edgeScroll(930, 1000, 0)).toBe(0)
    expect(edgeScroll(931, 1000, 0)).toBe(14)
    expect(edgeScroll(731, 1000, 200)).toBe(14)
    expect(edgeScroll(730, 1000, 200)).toBe(0)
  })
})

describe('appearing cards', () => {
  test('every card appears on the first board; later only new ones', () => {
    expect(appearing(['a', 'b'], null)).toEqual(['a', 'b'])
    expect(appearing(['a', 'b', 'c'], new Set(['a', 'b']))).toEqual(['c'])
    expect(appearing(['a'], new Set(['a', 'b']))).toEqual([])
  })

  test('a card that takes over another one on screen (a started session its launch card) does not', () => {
    const aliases = new Map([['s1', 'launch:1']])
    expect(appearing(['s1'], new Set(['launch:1']), aliases)).toEqual([])
    expect(appearing(['s1'], new Set(['x']), aliases)).toEqual(['s1'])
  })
})
