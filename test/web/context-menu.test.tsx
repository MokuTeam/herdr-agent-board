// The React context menu (components/menu) against the old page's menu.js, step by step: the old
// initMenu as it was at the parity baseline and as it is now, and the React engine on the levels
// <MenuLayer> draws, all in a fake DOM (support/menu-sides.tsx). After every step the menus in
// <body> (markup and the inline style the springs and placement wrote), the focus, what was
// scrolled into view, what was picked and every open and close must be the same.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { cardMenu, type MenuEntry } from '../../web/src/models/menu-model.ts'
import { reducedMotion } from '../../web/src/models/spring.ts'
import type { EventFields, FakeElement } from './support/fake-dom.ts'
import { type MenuSide, oldMenuSide, reactMenuSide } from './support/menu-sides.tsx'

type Step = (side: MenuSide) => Promise<unknown>

async function run(make: () => MenuSide, steps: Step[]): Promise<string[]> {
  const side = make()
  try {
    const shots = [side.snapshot()]
    for (const step of steps) {
      await step(side)
      shots.push(side.snapshot())
    }
    await side.world.settle()
    shots.push(side.snapshot())
    return shots
  } finally {
    await side.dispose()
  }
}

/** The three sides the same after every step; returns the baseline's snapshots. */
async function compare(steps: Step[]): Promise<string[]> {
  const baseline = await run(() => oldMenuSide(true), steps)
  const now = await run(() => oldMenuSide(false), steps)
  const react = await run(reactMenuSide, steps)
  for (const [name, shots] of [
    ['old page now', now],
    ['react', react],
  ] as const) {
    expect(shots.length).toBe(baseline.length)
    for (const [i, shot] of baseline.entries())
      expect(`${name} step ${i}\n${shots[i]}`).toBe(`${name} step ${i}\n${shot}`)
  }
  return baseline
}

// ---------------------------------------------------------------- menus and steps

const t = translator('en')
const categories = [
  { id: 'acme', title: 'Acme', color: '#007AFF' },
  { id: 'other', title: 'Other', color: '#8E8E93' },
]
const session = {
  key: 's1',
  session: 's1',
  pane: 'w1:p1',
  name: 'acme',
  cwd: 'C:\\Acme',
  status: 'idle',
  column: 'done',
  auto: 'idle',
  pin: 'done',
  attention: 'question',
}
const ctx = { t, canMutate: true, canEdit: true, categories, column: 'done', category: 'acme' }
/** A card's menu: hints, separators, two submenus (swatches; dots, checks and a pinned card's Auto), a red item. */
const CARD: MenuEntry[] = cardMenu(session, ctx)
/** The same without fresh herdr data: gray items, one shared reason under the menu. */
const STALE: MenuEntry[] = cardMenu(session, { ...ctx, canMutate: false })
const SHORT: MenuEntry[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', checked: true },
]

const at = (x: number, y: number, extra: Partial<Parameters<MenuSide['open']>[1]> = {}) => ({ x, y, ...extra })
const open =
  (items: MenuEntry[], options = at(100, 100, { label: 'acme', origin: 'opener' })): Step =>
  s =>
    s.open(items, options)
const target = (s: MenuSide) => s.world.document.activeElement ?? s.world.wrap(s.world.body)
const key =
  (k: string, fields: EventFields = {}): Step =>
  async s => {
    const e = await s.world.fire(target(s), 'keydown', { key: k, ...fields })
    if (e.defaultPrevented) s.log.push(`${k} prevented`)
  }
const tick =
  (ms = 16, n = 1): Step =>
  async s => {
    for (let i = 0; i < n; i++) await s.world.tick(ms)
  }
const settle: Step = s => s.world.settle()
/** Item `i` of level `level`. */
function item(s: MenuSide, level: number, i: number): FakeElement {
  const el = s.levels()[level]?.querySelector(`[data-i="${i}"]`)
  if (!el) throw new Error(`no item ${i} in level ${level}`)
  return el
}
const pointer =
  (type: string, level: number, i: number, fields: EventFields = {}): Step =>
  async s => {
    const e = await s.world.fire(item(s, level, i), type, fields)
    if (e.defaultPrevented) s.log.push(`${type} prevented`)
  }
const leave =
  (level: number): Step =>
  async s => {
    const el = s.levels()[level]
    if (el) await s.world.fire(el, 'pointerleave')
  }
const onPage =
  (type: string, id: string, fields: EventFields = {}): Step =>
  async s => {
    const e = await s.world.fire(s.page(id), type, fields)
    if (e.defaultPrevented) s.log.push(`${type} on ${id} prevented`)
  }
const onWindow =
  (type: string): Step =>
  s =>
    s.world.fire(s.world.window, type)
const close: Step = s => s.close()

/** Index of the item with `id` in a menu. */
const indexOf = (items: MenuEntry[], id: string) => items.findIndex(it => !it.separator && it.id === id)
const CATEGORY = indexOf(CARD, 'category')
const STATUS = indexOf(CARD, 'status')
/** How many menus a snapshot has in <body>. */
const levels = (shot: string | undefined) => (shot ?? '').split('role="menu"').length - 1

describe('the context menu', () => {
  test('opens at the point, grows out of its corner on a spring, and closes with Esc back to where the focus was', async () => {
    const shots = await compare([open(CARD), tick(), tick(), tick(), settle, key('Escape'), tick(), settle])
    expect(shots[1]).toContain('focus: menu 0')
    expect(shots[1]).toContain('style="left:100px;top:100px;max-height:684px;transform-origin:left top"')
    expect(shots.at(-1)).toContain('focus: button#opener')
    expect(shots.at(-1)).toContain('open: false')
  })

  test('flips at the window’s edges and scrolls when taller than the window', async () => {
    const shots = await compare([open(CARD, at(950, 650)), settle, close, settle, open(CARD, at(4, 690)), settle])
    expect(shots[1]).toContain('transform-origin:right bottom')
    expect(shots[5]).toContain('left:8px')
    expect(shots[5]).toContain('transform-origin:left bottom')
  })

  test('keys: arrows over separators and gray items, Home, End, typing a label, Enter picks after it closed', async () => {
    const shots = await compare([
      open(STALE, at(100, 100, { source: 'keyboard', origin: 'opener' })),
      key('ArrowDown'),
      key('ArrowDown'),
      key('ArrowUp'),
      key('End'),
      key('Home'),
      key('ArrowUp'),
      key('r'),
      key('c'),
      tick(800),
      key('c'),
      key('l'),
      key('x', { ctrlKey: true }),
      key('Enter'),
      settle,
    ])
    // Keyboard: the first item lit at once; "Go to herdr" (gray) passed over.
    expect(shots[1]).toContain('aria-activedescendant="menu-1-0"')
    expect(shots[2]).toContain('aria-activedescendant="menu-1-2"')
    expect(shots[1]).toContain('class="menu-note" role="note"')
    expect(shots.at(-1)).toContain('picked clear')
  })

  test('submenus: → opens one with its first item lit, ← and Esc close it, a second Esc the menu', async () => {
    const shots = await compare([
      open(CARD),
      settle,
      // "Message…", then "Move to category".
      key('m'),
      key('m'),
      key('ArrowRight'),
      settle,
      key('ArrowDown'),
      key('ArrowLeft'),
      key('ArrowRight'),
      key('Escape'),
      // "Status": its last item is the pinned card's Auto.
      key('ArrowDown'),
      key('ArrowRight'),
      settle,
      key('End'),
      key(' '),
      settle,
    ])
    expect(shots[5]).toContain('aria-expanded="true"')
    expect(shots[5]).toContain('aria-activedescendant="menu-2-0"')
    expect(shots[5]).toContain('style="--dot:#007AFF"')
    expect(shots[8]).toContain('focus: menu 0')
    expect(shots.at(-1)).toContain('picked col:idle')
  })

  test('the pointer lights items, opens a submenu once it rests and closes it when it moves on; the opening press is no pick', async () => {
    const shots = await compare([
      open(CARD),
      // The release of the press that opened it (macOS opens on press).
      pointer('pointerup', 0, 0),
      settle,
      pointer('pointermove', 0, 0),
      pointer('pointermove', 0, CATEGORY),
      tick(100),
      pointer('pointermove', 0, STATUS),
      tick(150),
      settle,
      pointer('pointermove', 1, 2),
      leave(1),
      pointer('pointermove', 0, 0),
      tick(300),
      settle,
      leave(0),
      pointer('pointerdown', 0, 0),
      pointer('pointerup', 0, 0),
      settle,
    ])
    expect(shots[2]).toContain('open: true')
    expect(shots[2]).not.toContain('picked')
    // Resting on "Status" opens its submenu (not on "Move to category", left before it rested).
    expect(levels(shots[7])).toBe(1)
    expect(levels(shots[9])).toBe(2)
    expect(shots[9]).toContain('id="menu-2-0"')
    // Back on "Open", the submenu goes after a while.
    expect(levels(shots[15])).toBe(1)
    expect(shots[17]).toContain('pointerdown prevented')
    expect(shots.at(-1)).toContain('picked open')
  })

  test('a release long enough after it opened picks, without a press inside; a submenu item picks from the pointer', async () => {
    const shots = await compare([
      open(CARD),
      tick(400),
      pointer('pointermove', 0, STATUS),
      tick(150),
      settle,
      pointer('pointerup', 1, 1),
      settle,
    ])
    expect(shots.at(-1)).toContain('picked col:ext')
  })

  test('gray items say why (once, under the menu, when they share it) and do nothing', async () => {
    const stale = indexOf(STALE, 'focus')
    const shots = await compare([
      open(STALE),
      settle,
      pointer('pointermove', 0, stale),
      tick(400),
      pointer('pointerup', 0, stale),
    ])
    expect(shots[1]).toContain('aria-disabled="true"')
    expect(shots[1]).toContain('fresh data from herdr')
    expect(shots.at(-1)).toContain('open: true')
    expect(shots.at(-1)).not.toContain('picked')
  })

  test('a press outside closes it: a left one is spent on that (its click goes nowhere), a right one gives the focus back', async () => {
    const shots = await compare([
      open(CARD),
      settle,
      onPage('pointerdown', 'outside', { button: 0 }),
      onPage('click', 'outside'),
      onPage('click', 'outside'),
      open(SHORT),
      onPage('pointerdown', 'outside', { button: 2 }),
      tick(700),
      open(SHORT),
      onPage('pointerdown', 'outside', { button: 0 }),
      tick(700),
      onPage('click', 'outside'),
    ])
    expect(shots[3]).toContain('open: false')
    expect(shots[3]).toContain('focus: menu 0')
    expect(shots[4]).toContain('click on outside prevented')
    expect(shots[5]).not.toContain('click on outside prevented | click on outside prevented')
    expect(shots[7]).toContain('focus: button#opener')
    expect(shots.at(-1)).not.toContain('click on outside prevented | click on outside prevented')
  })

  test('the window leaving, resizing or scrolling closes it; Tab closes it and gives the focus back', async () => {
    const shots = await compare([
      open(SHORT),
      onWindow('blur'),
      open(SHORT),
      onWindow('resize'),
      open(SHORT),
      onPage('scroll', 'outside'),
      open(SHORT),
      key('Tab'),
      settle,
    ])
    for (const i of [2, 4, 6, 8]) expect(shots[i]).toContain('open: false')
    expect(shots.at(-1)).toContain('focus: button#opener')
  })

  test('a scroll inside it, or its own context menu, leaves it open', async () => {
    const shots = await compare([open(CARD), pointer('scroll', 0, 1), pointer('contextmenu', 0, 1)])
    expect(shots[3]).toContain('open: true')
    expect(shots[3]).toContain('contextmenu prevented')
  })

  test('touch: bigger rows in the menu and its submenus; another menu opens while the last one fades', async () => {
    const shots = await compare([
      open(CARD, at(300, 200, { source: 'touch' })),
      settle,
      pointer('pointermove', 0, CATEGORY),
      tick(150),
      tick(),
      open(SHORT, at(500, 300)),
      tick(),
      tick(),
      settle,
    ])
    expect(shots[5]?.match(/class="menu [^"]*touch"/g)?.length).toBe(2)
    expect(levels(shots[6])).toBe(3)
    expect(shots[6]).toContain('pointer-events:none')
    expect(levels(shots.at(-1))).toBe(1)
  })

  test('with reduced motion it shows and goes at once', async () => {
    const motion: { matches: boolean } = reducedMotion
    motion.matches = true
    try {
      const shots = await compare([open(CARD), key('ArrowDown'), key('ArrowRight'), key('Escape'), key('Escape')])
      expect(shots[1]).toContain('opacity:1')
      expect(shots.join('\n')).not.toContain('scale(')
      expect(levels(shots[5])).toBe(0)
    } finally {
      motion.matches = false
    }
  })
})
