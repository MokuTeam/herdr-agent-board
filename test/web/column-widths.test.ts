// The columns' shares of the board's width (hooks/useColumnWidths.ts) against upstream's
// fitColumns and queueColumns at the compact toolbar's merge (#43), with its own spring.js: both
// run in a fake DOM's frames and write --cols on <html>; after every step they must have written
// the same.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { columnWidths } from '../../web/src/hooks/useColumnWidths.ts'
import { FakeWorld } from './support/fake-dom.ts'
import { oldCode, oldFunction, oldModule } from './support/old-app.ts'

const MERGE = '8c4b987'
const OLD_SPRING = await oldModule('web/spring.js', MERGE)

let world: FakeWorld
beforeEach(() => {
  world = new FakeWorld({ viewport: { w: 1400, h: 900 } })
  world.install()
})
afterEach(async () => {
  try {
    await world.settle()
  } finally {
    world.uninstall()
  }
})

const COLUMNS = ['work', 'me', 'ext', 'done', 'idle']

/** Upstream's two functions with their own state, writing to `out`. */
function oldWidths(out: string[]) {
  const code = oldCode(
    'web/app.js',
    ['fitColumns', 'queueColumns'],
    {
      colShares: new Map(),
      colIds: [],
      colsQueued: false,
      Spring: OLD_SPRING.get('Spring'),
      queueMicrotask,
      document: { documentElement: { style: { setProperty: (_name: string, value: string) => out.push(value) } } },
    },
    MERGE,
  )
  const fit = oldFunction(code, 'fitColumns')
  return (ids: string[], filled: boolean[]) => fit(ids, filled)
}

/** The steps: what the toolbar asks for, frames in between. */
type Fit = { ids: string[]; filled: boolean[] } | { frames: number }

async function run(steps: Fit[], fit: (ids: string[], filled: boolean[]) => void, out: string[]): Promise<string[][]> {
  const shots: string[][] = []
  for (const step of steps) {
    if ('frames' in step) for (let i = 0; i < step.frames; i++) await world.tick()
    else {
      fit(step.ids, step.filled)
      await world.flush()
    }
    shots.push([...out])
  }
  await world.settle()
  shots.push([...out])
  return shots
}

const STEPS: Fit[] = [
  // Nothing on show yet: no columns at all.
  { ids: [], filled: [] },
  { ids: COLUMNS, filled: [true, true, false, true, false] },
  { frames: 2 },
  // A column fills and another empties while the last change still moves.
  { ids: COLUMNS, filled: [true, false, true, true, false] },
  { frames: 3 },
  { ids: COLUMNS, filled: [true, false, true, true, false] },
  { frames: 40 },
  // Nothing on show at all: even widths again.
  { ids: COLUMNS, filled: [true, true, true, true, true] },
  { frames: 5 },
]

describe('the columns share the board by whether they have cards on show', () => {
  test('on springs, as upstream’s: a column that fills or empties glides to its new width', async () => {
    const theirs: string[] = []
    const old = await run(STEPS, oldWidths(theirs), theirs)
    const ours: string[] = []
    const widths = columnWidths(tracks => void ours.push(tracks))
    const react = await run(
      STEPS,
      (ids, filled) =>
        widths.fit(
          ids,
          filled.map(f => (f ? 1 : 0)),
        ),
      ours,
    )
    expect(react).toEqual(old)
    expect(theirs).toContain(
      'minmax(var(--col-min), 1.000fr) minmax(var(--col-min), 1.000fr) minmax(var(--col-min), 0.000fr) minmax(var(--col-min), 1.000fr) minmax(var(--col-min), 0.000fr)',
    )
    expect(theirs.length).toBeGreaterThan(10)
    widths.stop()
  })
})
