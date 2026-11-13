// When the toolbar folds its filters and brings them back (#347), without a page.
import { describe, expect, test } from 'bun:test'
import {
  COLLAPSE_AFTER,
  filterCount,
  filterText,
  foldedAt,
  HOLD,
  OPEN,
  openedAt,
  TOP,
  type ToolbarScroll,
  TURN,
  toolbarScroll,
} from '../../web/src/models/toolbar-collapse.ts'

/** The state after the page goes through these positions one after the other. */
const through = (ys: readonly number[], from: ToolbarScroll = OPEN): ToolbarScroll => ys.reduce(toolbarScroll, from)

describe('folding the toolbar with the scroll', () => {
  test('the top of the page has it whole, whatever came before', () => {
    expect(through([300, 500, 600, TOP]).collapsed).toBe(false)
    expect(through([0]).collapsed).toBe(false)
    expect(toolbarScroll(foldedAt(400), 0).collapsed).toBe(false)
  })

  test('a short scroll down does not fold it; past COLLAPSE_AFTER and a turn it does', () => {
    expect(through([10, 30, COLLAPSE_AFTER]).collapsed).toBe(false)
    expect(through([10, 30, COLLAPSE_AFTER + 1]).collapsed).toBe(true)
    // Far enough from the top, but not TURN px below the lowest point yet.
    expect(through([200]).collapsed).toBe(true)
  })

  test('folded, a scroll up of less than TURN leaves it folded, TURN brings it back', () => {
    const folded = through([100, 300])
    expect(folded.collapsed).toBe(true)
    expect(toolbarScroll(folded, 300 - TURN + 1).collapsed).toBe(true)
    expect(toolbarScroll(folded, 300 - TURN).collapsed).toBe(false)
  })

  test('folded, going further down moves the point the turn is counted from', () => {
    const state = through([100, 300, 280, 500])
    expect(state.collapsed).toBe(true)
    // 500 is the highest point now: 480 is still inside the turn, 470 is out of it.
    expect(toolbarScroll(state, 480).collapsed).toBe(true)
    expect(toolbarScroll(state, 500 - TURN).collapsed).toBe(false)
  })

  test('open, going up moves the point the fold is counted from, so a short wobble never folds it', () => {
    let state = through([300, 100]) // folded at 300, brought back by the climb to 100
    expect(state.collapsed).toBe(false)
    state = through([90, 80, 70, 70 + TURN - 1], state)
    expect(state.collapsed).toBe(false)
    expect(toolbarScroll(state, 70 + TURN).collapsed).toBe(true)
  })

  test('a jitter of a pixel or two never flips it either way', () => {
    let state = through([400, 401, 400, 402, 399])
    expect(state.collapsed).toBe(true)
    state = through([200, 190], state)
    state = through([200, 201, 199, 200, 202], state)
    // Up 10 px from the highest point is not enough.
    expect(toolbarScroll(foldedAt(400), 390).collapsed).toBe(true)
  })

  test('the same object comes back while nothing changed, so a render is not asked for', () => {
    const state = through([300])
    expect(toolbarScroll(state, 300)).toBe(state)
    expect(toolbarScroll(state, 299)).toBe(state)
    expect(toolbarScroll(OPEN, 0)).toBe(OPEN)
  })

  test('a tap that opened it keeps it open for TURN + HOLD of travel down', () => {
    const opened = openedAt(500)
    expect(opened.collapsed).toBe(false)
    expect(toolbarScroll(opened, 500 + TURN).collapsed).toBe(false)
    expect(toolbarScroll(opened, 500 + HOLD + TURN).collapsed).toBe(true)
    // Up from there it follows the climb.
    expect(toolbarScroll(opened, 480).collapsed).toBe(false)
  })

  test('folded by hand it stays folded until the page moves up TURN px or reaches the top', () => {
    const hand = foldedAt(120)
    expect(hand.collapsed).toBe(true)
    expect(toolbarScroll(hand, 130).collapsed).toBe(true)
    expect(toolbarScroll(hand, 120 - TURN).collapsed).toBe(false)
  })

  test('a long flick to the top is one step back to whole', () => {
    expect(through([200, 900, 3]).collapsed).toBe(false)
  })
})

describe('the filters in words', () => {
  const none = { lanes: [], profile: null, query: '' }

  test('the number of filters on: lanes, profile and search count one each', () => {
    expect(filterCount(none)).toBe(0)
    expect(filterCount({ ...none, lanes: ['Alpha', 'Beta'] })).toBe(1)
    expect(filterCount({ lanes: ['Alpha'], profile: 'Work', query: 'login' })).toBe(3)
  })

  test('what the folded toolbar says is on: names joined, the search text quoted, nothing for none', () => {
    expect(filterText(none)).toBe('')
    expect(filterText({ lanes: ['Alpha', 'Beta'], profile: 'Work', query: 'login' })).toBe(
      'Alpha, Beta · Work · “login”',
    )
    expect(filterText({ ...none, query: 'x' })).toBe('“x”')
    expect(filterText({ ...none, profile: 'Default' })).toBe('Default')
  })
})
