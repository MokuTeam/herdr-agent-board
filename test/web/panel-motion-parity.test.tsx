// The React panel's motion against the old web/panel.js, step by step: both run in a fake DOM
// (support/panel-sides.tsx) from the old page and take the same events and frames; after every
// step the panels, the place menu, the dock preview, the board's room, the saved layout, focus,
// pointer capture and every spring (value and target) must be the same.
import { describe, expect, test } from 'bun:test'
import { reducedMotion } from '../../web/src/models/spring.ts'
import { box, type EventFields, type FakeElement } from './support/fake-dom.ts'
import { newSide, oldSide, type PanelSide, type SideOptions } from './support/panel-sides.tsx'

type Step = (side: PanelSide) => Promise<unknown>

/** Runs the steps on one side, a snapshot after each. */
async function run(make: (o: SideOptions) => Promise<PanelSide>, options: SideOptions, steps: Step[]) {
  const side = await make(options)
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
    side.dispose()
  }
}

/** Both sides the same after every step; returns the (old side's) snapshots, to say what happened. */
async function compare(options: SideOptions, steps: Step[]): Promise<string[]> {
  const old = await run(oldSide, options, steps)
  const react = await run(newSide, options, steps)
  expect(react.length).toBe(old.length)
  for (const [i, shot] of old.entries()) expect(`step ${i}\n${react[i]}`).toBe(`step ${i}\n${shot}`)
  return old
}

/** One line of a snapshot (`saved`, `closes`, `focus`, `cats-sheet`…), without its name. */
const lineOf = (shot: string | undefined, name: string): string =>
  (shot?.split('\n').find(l => l.startsWith(`${name}: `)) ?? '').slice(name.length + 2)
const last = (shots: string[], name: string) => lineOf(shots.at(-1), name)
/** Some step's snapshot had `text` in that line. */
const ever = (shots: string[], name: string, text: string) => shots.some(shot => lineOf(shot, name).includes(text))

// ---------------------------------------------------------------- the page around the panels

const VP = { w: 1600, h: 1000 }
/** What the stylesheet would make of elements the code measures: a phone's sheet, the menu, the place button, a card. */
function rects(el: FakeElement) {
  const n = el.node
  const cls = n.attrs.get('class') ?? ''
  if (cls.split(' ').includes('sheet') && !el.style.width) return box(0, 12, 380, 976)
  if (cls === 'layout-menu') return box(0, 0, 210, 180)
  if (n.attrs.has('data-layout')) return box(1500, 30, 30, 30)
  if (cls === 'card') {
    const room = Number.parseFloat(el.world.html.attrs.get('style')?.match(/--room-right: ([\d.]+)px/)?.[1] ?? '0')
    return box(40, 300 + room / 4, 260, 120)
  }
  return null
}
const desktop: SideOptions = { viewport: VP, rects, ids: ['cats-sheet', 'sched-sheet'] }

// ---------------------------------------------------------------- steps

const PANEL = 'cats-sheet'
const ticks = (n: number, ms = 16): Step[] => Array.from({ length: n }, () => (s: PanelSide) => s.world.tick(ms))
const settle: Step = s => s.world.settle()
const open =
  (id = PANEL): Step =>
  s =>
    s.open(id)
const closeButton =
  (id = PANEL): Step =>
  s =>
    s.close(id)
const placeButton =
  (id = PANEL): Step =>
  s =>
    s.place(id)

const find = (s: PanelSide, selector: string, id = PANEL): FakeElement => {
  const el = s.aside(id).querySelector(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}
const head = (s: PanelSide) => find(s, 'h2')
const edge = (name: string) => (s: PanelSide) => find(s, `[data-edge="${name}"]`)
const grip = (s: PanelSide) => find(s, '.sheet-grip')

const pointer =
  (type: string, at: (s: PanelSide) => FakeElement, x: number, y: number, fields: EventFields = {}): Step =>
  s =>
    s.world.pointer(type, at(s), { clientX: x, clientY: y, ...fields })

/** Press at `from`, move through `path` `ms` apart, hold still `hold` frames, let go at the last point. */
function drag(
  at: (s: PanelSide) => FakeElement,
  from: [number, number],
  path: [number, number][],
  fields: EventFields = {},
  ms = 16,
  hold = 1,
): Step[] {
  const end = path.at(-1) ?? from
  return [
    pointer('pointerdown', at, from[0], from[1], fields),
    ...path.flatMap(([x, y]) => [...ticks(1, ms), pointer('pointermove', at, x, y, fields)]),
    ...ticks(hold, ms),
    pointer('pointerup', at, end[0], end[1], fields),
  ]
}

const line = (from: [number, number], to: [number, number], n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [
    from[0] + ((to[0] - from[0]) * (i + 1)) / n,
    from[1] + ((to[1] - from[1]) * (i + 1)) / n,
  ])

const key =
  (k: string, at: (s: PanelSide) => FakeElement, fields: EventFields = {}): Step =>
  s =>
    s.world.fire(at(s), 'keydown', { key: k, ...fields })
const onFocus = (s: PanelSide): FakeElement => {
  const el = s.world.document.activeElement
  if (!el) throw new Error('nothing focused')
  return el
}
const focus =
  (at: (s: PanelSide) => FakeElement): Step =>
  async s => {
    at(s).focus()
  }
const menuItem = (selector: string) => (s: PanelSide) => {
  const el = s.menu.querySelector(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}
const click =
  (at: (s: PanelSide) => FakeElement): Step =>
  s =>
    s.world.fire(at(s), 'click')
const resize =
  (w: number, h: number): Step =>
  s => {
    s.world.viewport = { w, h }
    return s.world.fire(s.world.window, 'resize')
  }
const phone =
  (on: boolean): Step =>
  s => {
    s.world.phone.matches = on
    return s.world.fire(s.world.phone, 'change')
  }
const body = (s: PanelSide) => s.world.wrap(s.world.body)

// ---------------------------------------------------------------- scenarios

describe('opening and closing', () => {
  test('in from its edge and out again, the board making room on springs', async () => {
    const shots = await compare(desktop, [open(), ...ticks(6), settle, closeButton(), ...ticks(4), settle])
    expect(ever(shots, 'cats-sheet', 'open true')).toBe(true)
    expect(last(shots, 'closes')).toBe('cats-sheet')
    expect(last(shots, 'cats-sheet')).toStartWith('open false')
  })
  test('caught while leaving it turns around; one at a time in the shared place', async () => {
    const shots = await compare(desktop, [
      open(),
      ...ticks(3),
      closeButton(),
      ...ticks(2),
      open(),
      ...ticks(3),
      settle,
      open('sched-sheet'),
      ...ticks(4),
      settle,
      open(),
      settle,
    ])
    expect(last(shots, 'closes')).toBe('cats-sheet,cats-sheet,sched-sheet')
    expect(last(shots, 'cats-sheet')).toStartWith('open true')
  })
})

describe('the head', () => {
  test('flicked out along its edge it closes; a small slow drag springs back; a press does nothing', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      ...drag(head, [1100, 40], line([1100, 40], [1300, 40], 6)),
      ...ticks(5),
      settle,
      open(),
      settle,
      ...drag(head, [1100, 40], line([1100, 40], [1140, 46], 10), {}, 50),
      ...ticks(5),
      settle,
      pointer('pointerdown', head, 1100, 40),
      pointer('pointerup', head, 1100, 40),
      settle,
      // Pushed back past its place it resists.
      ...drag(head, [1100, 40], line([1100, 40], [1050, 42], 5), {}, 40),
      settle,
    ])
    expect(last(shots, 'closes')).toBe('cats-sheet')
    expect(last(shots, 'cats-sheet')).toStartWith('open true mode right')
  })
  test('pulled any other way it comes loose, follows the pointer, and a throw docks it where the preview showed', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      pointer('pointerdown', head, 1100, 40),
      ...[
        [1090, 40],
        [1080, 60],
        [1040, 90],
        [900, 200],
        [700, 320],
        [500, 420],
        [300, 480],
        [150, 500],
      ].flatMap(([x = 0, y = 0]) => [...ticks(1), pointer('pointermove', head, x, y)]),
      // Held still: it aims again without the speed it had.
      ...ticks(9),
      pointer('pointermove', head, 140, 500),
      ...ticks(1),
      pointer('pointermove', head, 60, 505),
      ...ticks(1),
      pointer('pointerup', head, 20, 510),
      ...ticks(6),
      settle,
    ])
    expect(shots.some(shot => shot.includes('<div class="dock-preview" style='))).toBe(true)
    expect(ever(shots, 'cats-sheet', 'mode float')).toBe(true)
    expect(last(shots, 'saved')).toContain('"dock":"left"')
    expect(last(shots, 'cats-sheet')).toStartWith('open true mode left')
  })
  test('let go gently it floats where it glides to; a floating one moves by its head', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      ...drag(head, [1100, 40], line([1100, 40], [700, 400], 12), {}, 30),
      ...ticks(10, 30),
      settle,
      ...drag(head, [760, 420], line([760, 420], [600, 340], 8), {}, 16, 8),
      ...ticks(8),
      settle,
    ])
    // Saved where it landed, unrounded, as before (restoreLayout rounds it on the next visit).
    expect(ever(shots, 'saved', '"float":{"x":564.952380952381,"y":308')).toBe(true)
    expect(last(shots, 'saved')).toMatch(/"dock":"float".*"float":\{"x":[\d.]+/)
    expect(last(shots, 'cats-sheet')).toStartWith('open true mode float')
  })
  test('a touch moves the panel only by its grip; the session name and buttons never move it', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      ...drag(head, [1100, 40], line([1100, 40], [1300, 40], 4), { pointerType: 'touch' }),
      settle,
      ...drag(grip, [1034, 500], line([1034, 500], [1300, 500], 4), { pointerType: 'touch' }),
      settle,
      open(),
      settle,
      ...drag(s => find(s, '[data-close]'), [1560, 40], line([1560, 40], [1300, 40], 4)),
      settle,
      ...drag(head, [1100, 40], line([1100, 40], [1300, 40], 4), { button: 2 }),
      settle,
    ])
    expect(last(shots, 'closes')).toBe('cats-sheet')
  })
})

describe('the edges', () => {
  test('the edge towards the board resizes 1:1, softly past the limits, and lets go with its speed', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      ...drag(edge('w'), [1028, 500], line([1028, 500], [900, 500], 6)),
      ...ticks(4),
      settle,
      ...drag(edge('w'), [900, 500], line([900, 500], [100, 500], 8), {}, 40),
      settle,
    ])
    expect(ever(shots, 'saved', '"side":688')).toBe(true)
    expect(last(shots, 'saved')).toContain('"side":1200')
  })
  test('flung narrower than half the smallest size it folds away', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      ...drag(edge('w'), [1028, 500], line([1028, 500], [1500, 500], 5)),
      ...ticks(5),
      settle,
    ])
    expect(last(shots, 'closes')).toBe('cats-sheet')
    expect(last(shots, 'saved')).toBe('')
  })
  test('keys on the edge, double-click for the default size', async () => {
    const w = edge('w')
    const shots = await compare(desktop, [
      open(),
      settle,
      focus(w),
      key('ArrowLeft', w),
      ...ticks(3),
      key('ArrowLeft', w, { shiftKey: true }),
      key('ArrowRight', w),
      key('ArrowLeft', w, { altKey: true }),
      key('ArrowUp', w),
      settle,
      key('End', w),
      settle,
      key('Home', w),
      settle,
      s => s.world.fire(w(s), 'dblclick'),
      ...ticks(3),
      settle,
    ])
    expect(ever(shots, 'saved', '"side":576')).toBe(true)
    expect(ever(shots, 'saved', '"side":1200')).toBe(true)
    expect(last(shots, 'saved')).toContain('"side":null')
  })
  test('Esc while dragging puts everything back', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      pointer('pointerdown', edge('w'), 1028, 500),
      ...ticks(1),
      pointer('pointermove', edge('w'), 900, 500),
      key('Escape', body),
      ...ticks(3),
      settle,
      pointer('pointerdown', head, 1100, 40),
      ...line([1100, 40], [600, 400], 6).flatMap(([x, y]) => [...ticks(1), pointer('pointermove', head, x, y)]),
      key('Escape', body),
      pointer('pointerup', head, 600, 400),
      ...ticks(4),
      settle,
    ])
    expect(ever(shots, 'cats-sheet', 'mode float')).toBe(true)
    expect(last(shots, 'saved')).toBe('')
    expect(last(shots, 'cats-sheet')).toStartWith('open true mode right 1028/1028 12/12 560/560')
  })
})

describe('the place menu', () => {
  test('opens on the dock in use, walks with the arrows, Esc and Tab put it away', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      placeButton(),
      ...ticks(3),
      key('ArrowDown', onFocus),
      key('ArrowDown', onFocus),
      key('ArrowUp', onFocus),
      key('End', onFocus),
      key('Home', onFocus),
      key('n', onFocus),
      key('Escape', onFocus),
      settle,
      placeButton(),
      settle,
      key('Tab', onFocus),
      settle,
      placeButton(),
      settle,
      pointer('pointerdown', body, 300, 300),
      settle,
      placeButton(),
      placeButton(),
      settle,
    ])
    expect(ever(shots, 'focus', 'button[data-dock=bottom]')).toBe(true)
    expect(ever(shots, 'focus', 'button[class=icon-button][data-layout=]')).toBe(true)
    expect(last(shots, 'menu')).toStartWith('false')
  })
  test('picks a place: bottom, floating, the default size; closing the panel puts it away', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      placeButton(),
      click(menuItem('[data-dock="bottom"]')),
      ...ticks(5),
      settle,
      ...drag(edge('n'), [800, 568], line([800, 568], [800, 400], 5)),
      settle,
      placeButton(),
      click(menuItem('[data-dock="float"]')),
      ...ticks(4),
      settle,
      placeButton(),
      click(menuItem('[data-dock="float"]')),
      settle,
      placeButton(),
      click(menuItem('[data-reset]')),
      settle,
      placeButton(),
      closeButton(),
      settle,
    ])
    expect(ever(shots, 'cats-sheet', 'mode bottom')).toBe(true)
    expect(ever(shots, 'saved', '"bottom":588')).toBe(true)
    expect(last(shots, 'saved')).toContain('"dock":"float"')
    expect(last(shots, 'saved')).toContain('"float":null')
    expect(last(shots, 'closes')).toBe('cats-sheet')
  })
})

describe('floating', () => {
  const float: SideOptions = { ...desktop, saved: JSON.stringify({ dock: 'float' }) }
  test('it fades in place and resizes by any edge', async () => {
    const shots = await compare(float, [
      open(),
      ...ticks(4),
      settle,
      ...drag(edge('nw'), [1068, 148], line([1068, 148], [980, 90], 5)),
      ...ticks(3),
      settle,
      ...drag(edge('e'), [1552, 400], line([1552, 400], [1900, 400], 5)),
      settle,
      ...drag(edge('s'), [1300, 832], line([1300, 832], [1300, 700], 5), {}, 40),
      settle,
    ])
    expect(last(shots, 'saved')).toMatch(/"float":\{"x":[\d.]+,"y":[\d.]+,"w":[\d.]+,"h":[\d.]+\}/)
  })
  test('its corner takes the arrows; double-click: the default size and spot', async () => {
    const se = edge('se')
    const shots = await compare(float, [
      open(),
      settle,
      key('ArrowRight', se),
      key('ArrowDown', se, { shiftKey: true }),
      key('ArrowLeft', se),
      key('ArrowUp', se),
      key('x', se),
      settle,
      s => s.world.fire(se(s), 'dblclick'),
      settle,
      closeButton(),
      ...ticks(3),
      settle,
    ])
    expect(ever(shots, 'saved', '"w":496')).toBe(true)
    expect(last(shots, 'saved')).toContain('"float":null')
    expect(last(shots, 'closes')).toBe('cats-sheet')
  })
})

describe('the window around it', () => {
  test('a resize keeps it in its place, even mid-motion; the room jumps', async () => {
    const shots = await compare(desktop, [
      open(),
      ...ticks(3),
      resize(1200, 900),
      ...ticks(3),
      settle,
      resize(1800, 1000),
      settle,
      resize(1800, 1000),
      closeButton(),
      ...ticks(2),
      resize(1500, 900),
      settle,
    ])
    expect(ever(shots, 'html', '--room-right: 572px')).toBe(true) // 1800 wide: room beside it
    expect(ever(shots, 'cats-sheet', '628/628 12/12 560/560 876/876')).toBe(true) // 1200 × 900
    expect(last(shots, 'html')).toStartWith('--room-left: 0px; --room-right: 0px; --room-bottom: 0px')
  })
  test('a phone keeps the full-height sheet: it slides, flicks right, does not resize', async () => {
    const shots = await compare(desktop, [
      open(),
      settle,
      phone(true),
      settle,
      ...drag(edge('w'), [1028, 500], line([1028, 500], [900, 500], 3)),
      placeButton(),
      settle,
      key('Escape', onFocus),
      ...drag(grip, [10, 500], line([10, 500], [-40, 500], 4), { pointerType: 'touch' }),
      settle,
      ...drag(grip, [10, 500], line([10, 500], [300, 500], 4), { pointerType: 'touch' }),
      ...ticks(4),
      settle,
      open(),
      ...ticks(3),
      phone(false),
      settle,
    ])
    expect(ever(shots, 'cats-sheet', 'mode mobile')).toBe(true)
    expect(last(shots, 'closes')).toBe('cats-sheet')
    expect(last(shots, 'cats-sheet')).toStartWith('open true mode right')
  })
  test('the card the panel is about keeps its place while the board makes room', async () => {
    const card = (s: PanelSide) => {
      const found = body(s).querySelector('.card')
      if (found) return found
      const el = s.world.document.createElement('div')
      el.className = 'card'
      body(s).append(el)
      return el
    }
    const shots = await compare({ ...desktop, viewport: { w: 1800, h: 1000 } }, [
      async s => s.keepInSight({ target: () => card(s), top: () => 120 }),
      open(),
      ...ticks(6),
      settle,
      ...drag(edge('w'), [1228, 500], line([1228, 500], [1100, 500], 4)),
      settle,
      placeButton(),
      click(menuItem('[data-dock="bottom"]')),
      ...ticks(4),
      settle,
      closeButton(),
      settle,
    ])
    expect(last(shots, 'scrolls')).not.toBe('[]')
  })
})

describe('the viewer’s layout', () => {
  test('a saved place and size is where it opens; garbage falls back', async () => {
    const left = await compare({ ...desktop, saved: JSON.stringify({ dock: 'left', side: 700 }) }, [open(), settle])
    expect(last(left, 'cats-sheet')).toStartWith('open true mode left 12/12 12/12 700/700')
    const garbage = await compare({ ...desktop, saved: '{oops' }, [open(), settle])
    expect(last(garbage, 'cats-sheet')).toStartWith('open true mode right 1028/1028')
    await compare({ ...desktop, saved: JSON.stringify({ dock: 'bottom', bottom: 380 }) }, [
      open(),
      ...ticks(3),
      settle,
      closeButton(),
      settle,
    ])
  })
  test('on whole device pixels at 125 %', async () => {
    await compare({ ...desktop, dpr: 1.25 }, [
      open(),
      ...ticks(5),
      settle,
      ...drag(head, [1100, 40], line([1100, 40], [1170, 41], 7), {}, 33),
      settle,
    ])
  })
  test('with reduced motion a change of place is a cross-fade', async () => {
    const motion: { matches: boolean } = reducedMotion
    motion.matches = true
    try {
      const shots = await compare({ ...desktop, saved: JSON.stringify({ dock: 'float' }) }, [
        open(),
        placeButton(),
        click(menuItem('[data-dock="left"]')),
        closeButton(),
        open(),
      ])
      expect(last(shots, 'animations')).toContain('[{"opacity":0},{"opacity":1}],{"duration":180,"easing":"ease-out"}')
    } finally {
      motion.matches = false
    }
  })
})
