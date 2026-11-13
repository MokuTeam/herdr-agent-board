// The toolbar's fit (#347) without a page: which actions stay in the row at a width, the order the
// rest leave for More, and what More lists.
import { describe, expect, test } from 'bun:test'
import {
  byPriority,
  fitToolbar,
  moreAlert,
  moreEntries,
  oneRowFits,
  ROW_GAP,
  TOOLBAR_PRIORITY,
  type ToolbarEntry,
  type ToolbarItem,
} from '../../web/src/models/toolbar-fit.ts'

const GAP = 6
const MORE = 28
/** A phone's toolbar with every action on: widths as the stylesheet draws them (icons 28, the presence pill and the usage chip wider). */
const WIDTHS: Record<string, number> = {
  'presence-switch': 130,
  'presence-offer': 96,
  'todos-open': 52,
  'new-session': 28,
  'presence-call': 28,
  'sched-open': 50,
  'next-attention': 88,
  'cal-tb': 28,
  'time-open': 28,
  limits: 190,
  'archive-open': 28,
  'cats-open': 28,
  'setup-note': 132,
  'backup-note': 120,
  'wake-note': 110,
}
const ALL: ToolbarItem[] = TOOLBAR_PRIORITY.map(id => ({ id, width: WIDTHS[id] ?? 28 }))
/** Settings, the live dot and their gaps. */
const PINNED = 28 + GAP + 8 + GAP
const opts = { gap: GAP, more: MORE, pinned: PINNED }

/** The room of the actions at a toolbar `width` px wide: less the page's gutters (there is no title: #351). */
const roomAt = (width: number) => width - 32

describe('the toolbar fit', () => {
  test('a row with room for all of them shows all of them and no More', () => {
    const fit = fitToolbar(ALL, 2000, opts)
    expect(fit.shown).toEqual([...TOOLBAR_PRIORITY])
    expect(fit.over).toEqual([])
  })

  test('the actions leave for More from the end of the priority list, never a pick of it', () => {
    for (let room = 40; room <= 1400; room += 3) {
      const fit = fitToolbar(ALL, room, opts)
      expect(fit.shown).toEqual(TOOLBAR_PRIORITY.slice(0, fit.shown.length))
      expect(fit.over).toEqual(TOOLBAR_PRIORITY.slice(fit.shown.length))
    }
  })

  test('a row that grows never takes an action back out of its place: the shown ones only increase', () => {
    let before = 0
    for (let room = 40; room <= 1400; room += 1) {
      const n = fitToolbar(ALL, room, opts).shown.length
      expect(n).toBeGreaterThanOrEqual(before)
      before = n
    }
  })

  test('what is shown, the pinned buttons and More (while something is in it) never take more than the room', () => {
    for (let width = 320; width <= 2560; width += 1) {
      const room = roomAt(width)
      const fit = fitToolbar(ALL, room, opts)
      const used =
        fit.shown.reduce((sum, id, i) => sum + (i ? GAP : 0) + (WIDTHS[id] ?? 28), 0) +
        PINNED +
        (fit.over.length ? GAP + MORE : 0)
      // The first alone may not fit at the very narrowest: it shrinks (Next cuts its words).
      if (fit.shown.length > 1 || fit.over.length === 0) expect(used).toBeLessThanOrEqual(room)
    }
  })

  test('the first action always stays: the row is never only More', () => {
    for (const room of [0, 10, 60, 100]) expect(fitToolbar(ALL, room, opts).shown).toEqual(['next-attention'])
  })

  test('an action too wide for the room does not let a narrower one after it jump the queue', () => {
    const items: ToolbarItem[] = [
      { id: 'a', width: 40 },
      { id: 'b', width: 200 },
      { id: 'c', width: 28 },
    ]
    // a and c would fit together; b does not: c waits behind it.
    const fit = fitToolbar(items, 40 + GAP + 28 + GAP + MORE + 10, { gap: GAP, more: MORE })
    expect(fit.shown).toEqual(['a'])
    expect(fit.over).toEqual(['b', 'c'])
  })

  test('More needs room too: with two left over the shown ones leave it its place', () => {
    const items: ToolbarItem[] = ['a', 'b', 'c'].map(id => ({ id, width: 40 }))
    // a, b and c need 40*3 + 2*6 = 132; a and b with More need 40*2 + 6 + 6 + 28 = 120.
    expect(fitToolbar(items, 131, { gap: GAP, more: MORE }).shown).toEqual(['a', 'b'])
    expect(fitToolbar(items, 132, { gap: GAP, more: MORE }).shown).toEqual(['a', 'b', 'c'])
    expect(fitToolbar(items, 119, { gap: GAP, more: MORE }).shown).toEqual(['a'])
  })

  test('the widths of a 320, 390, 768 and 1280 px toolbar leave the order the brief names', () => {
    // The usual phone: no offer, no call button, no quiet notes.
    const usual = ALL.filter(
      i => !['presence-offer', 'presence-call', 'setup-note', 'backup-note', 'wake-note'].includes(i.id),
    )
    const at = (width: number) => fitToolbar(usual, roomAt(width), opts).shown
    // A phone keeps what it uses most, Next first (#351); a tablet most of the list; a desk all of it.
    expect(at(320)).toEqual(['next-attention'])
    expect(at(390)).toEqual(['next-attention', 'presence-switch'])
    expect(at(768).length).toBeGreaterThan(at(390).length)
    expect(at(1280)).toEqual(usual.map(i => i.id))
  })

  test('Next is in the row wherever the presence pill is, and the pill leaves before it', () => {
    for (let width = 280; width <= 2560; width += 1) {
      const { shown, over } = fitToolbar(ALL, roomAt(width), opts)
      expect(shown).toContain('next-attention')
      if (shown.includes('presence-switch')) expect(over).not.toContain('next-attention')
    }
  })

  test('nothing is shown for a list with no actions', () => {
    expect(fitToolbar([], 300, opts)).toEqual({ shown: [], over: [] })
  })
})

describe('the list in priority order', () => {
  test('byPriority puts the page-ordered items in priority order and leaves out what is not on show', () => {
    const drawn = [{ id: 'cats-open' }, { id: 'new-session' }, { id: 'presence-switch' }, { id: 'unknown' }]
    expect(byPriority(drawn).map(i => i.id)).toEqual(['presence-switch', 'new-session', 'cats-open'])
  })

  test('Next first, then presence (pill, offer), Tasks and New, the quiet notes last', () => {
    expect(TOOLBAR_PRIORITY.slice(0, 3)).toEqual(['next-attention', 'presence-switch', 'presence-offer'])
    expect(TOOLBAR_PRIORITY.indexOf('todos-open')).toBeLessThan(TOOLBAR_PRIORITY.indexOf('new-session'))
    expect(TOOLBAR_PRIORITY.slice(-3)).toEqual(['setup-note', 'backup-note', 'wake-note'])
    expect(new Set(TOOLBAR_PRIORITY).size).toBe(TOOLBAR_PRIORITY.length)
  })
})

describe('one row or two', () => {
  test('with no summary at the start of the row there is no gap for it either', () => {
    const actions = 600
    const need = 420 + ROW_GAP + actions
    expect(oneRowFits(need, { title: 0, actions })).toBe(true)
    expect(oneRowFits(need - 1, { title: 0, actions })).toBe(false)
    // A summary (a wide board's) takes its width and the gap after it.
    expect(oneRowFits(need + 200 + ROW_GAP, { title: 200, actions })).toBe(true)
    expect(oneRowFits(need + 200 + ROW_GAP - 1, { title: 200, actions })).toBe(false)
  })
})

describe('what More lists', () => {
  const entries: ToolbarEntry[] = [
    { id: 'todos-open', label: 'Tasks', count: 3 },
    { id: 'sched-open', label: 'Schedule', count: 2, tint: '#ff9500', alert: true },
    { id: 'archive-open', label: 'Archive' },
    { id: 'limits', label: 'Claude usage', hint: '5h 12%' },
  ]

  test('the entries of what left the row, in the order they left', () => {
    expect(moreEntries(entries, ['sched-open', 'todos-open']).map(e => e.id)).toEqual(['sched-open', 'todos-open'])
    expect(moreEntries(entries, ['limits', 'archive-open', 'unknown']).map(e => e.id)).toEqual([
      'limits',
      'archive-open',
    ])
    expect(moreEntries(entries, [])).toEqual([])
  })

  test('its button carries a dot only while something in it needs a look', () => {
    expect(moreAlert(moreEntries(entries, ['sched-open']))).toBe(true)
    expect(moreAlert(moreEntries(entries, ['todos-open', 'archive-open']))).toBe(false)
    expect(moreAlert([])).toBe(false)
  })
})
