// A menu asked to open upward (the session panel's More, low in its window), on the React engine
// and on the old page's menu.js at the session panel's row (upstream PR #54), both in a fake DOM
// (support/menu-sides.tsx): above the point whenever it fits there, else down as any menu.
import { expect, test } from 'bun:test'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import { type MenuOpenStep, type MenuSide, oldMenuSide, reactMenuSide } from './support/menu-sides.tsx'

const ITEMS: MenuEntry[] = [
  { id: 'sheet-term', label: 'Terminal' },
  { id: 'sheet-history', label: 'History' },
  { separator: true },
  { id: 'sheet-new', label: 'New here', disabled: true, reason: 'Read-only' },
  { separator: true },
  { id: 'sheet-sleep', label: 'Sleep' },
  { id: 'sheet-restart', label: 'Restart' },
]

async function shots(make: () => MenuSide, steps: MenuOpenStep[]): Promise<string[]> {
  const side = make()
  try {
    const out: string[] = []
    for (const step of steps) {
      await side.open(ITEMS, step)
      await side.world.settle()
      out.push(side.snapshot())
      await side.close()
      await side.world.settle()
    }
    return out
  } finally {
    await side.dispose()
  }
}

test('asked to go up it opens above the point when it fits, else below it, as upstream’s at #54', async () => {
  const steps: MenuOpenStep[] = [
    // More at the panel's foot, low and high in the window, by mouse and by keys.
    { x: 600, y: 640, up: true, origin: 'opener', label: 'More actions' },
    { x: 600, y: 60, up: true, origin: 'opener', label: 'More actions' },
    { x: 990, y: 400, up: true, source: 'keyboard', origin: 'opener' },
    { x: 600, y: 400, up: false },
    { x: 600, y: 400 },
  ]
  const old = await shots(oldMenuSide, steps)
  const react = await shots(reactMenuSide, steps)
  expect(react).toEqual(old)
  // Low in the window it went above, high below; not asked, below as any menu.
  const placed = (shot = '') => {
    const m = /top:(-?[\d.]+)px;.*transform-origin:(\w+ \w+)/.exec(shot)
    return m && [Number(m[1]), m[2]]
  }
  expect(react.map(placed)).toEqual([
    [488, 'left bottom'],
    [60, 'left top'],
    [248, 'right bottom'],
    [400, 'left top'],
    [400, 'left top'],
  ])
})
