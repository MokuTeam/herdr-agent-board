// The side panels and the page around them, in a fake DOM (support/panel-sides.tsx): a click on
// the board beside an open panel closes it (app.js's listener), the page's usePanelLayout, and
// the viewer's layout in localStorage under today's key and format.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PanelPlace } from '../../web/src/components/panel/place.ts'
import { listenClickAway } from '../../web/src/hooks/usePanelClickAway.ts'
import { type PanelLayoutApi, usePanelLayout } from '../../web/src/hooks/usePanelLayout.ts'
import { roomFor } from '../../web/src/models/panel-layout.ts'
import { PanelContext } from '../../web/src/state/PanelProvider.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { newSide, type ReactSide } from './support/panel-sides.tsx'

const VP = { w: 1600, h: 1000 }
const PANEL = 'cats-sheet'

/** The React side with one panel, run by `body`; the world is put back after. */
async function withSide(body: (side: ReactSide) => Promise<void>, saved?: string): Promise<void> {
  const side = await newSide({ viewport: VP, ids: [PANEL], ...(saved === undefined ? {} : { saved }) })
  try {
    await body(side)
  } finally {
    // The springs' one frame loop must end in this world, or the next world never gets a frame.
    await side.world.settle()
    side.dispose()
  }
}

/** A board beside the panel: a blank stretch, a card and a button. */
function mountBoard(side: ReactSide): { board: FakeElement; card: FakeElement; button: FakeElement } {
  const [node] = parseHtml(
    '<main class="board" id="board"><div class="card" data-key="a"></div><button type="button">x</button></main>',
  )
  if (node?.kind !== 'element') throw new Error('no board')
  const board = side.world.mount(node)
  const card = board.querySelector('.card')
  const button = board.querySelector('button')
  if (!card || !button) throw new Error('no card or button')
  return { board, card, button }
}

/** A press at (x, y) let go at `to`, then the click the browser sends. */
async function clickOn(side: ReactSide, el: FakeElement, x = 300, y = 300, to: [number, number] = [x, y]) {
  await side.world.pointer('pointerdown', el, { clientX: x, clientY: y })
  await side.world.pointer('pointerup', el, { clientX: to[0], clientY: to[1] })
  await side.world.fire(el, 'click', { clientX: to[0], clientY: to[1] })
}

async function openPanel(side: ReactSide): Promise<void> {
  await side.open(PANEL)
  await side.world.settle()
}

describe('a click on the board beside an open panel', () => {
  test('closes it; on the panel, a card, a control, or after the press travelled it does not', async () => {
    await withSide(async side => {
      const stop = listenClickAway(side.shared)
      const { board, card, button } = mountBoard(side)
      await openPanel(side)
      await clickOn(side, side.aside(PANEL))
      await clickOn(side, card)
      await clickOn(side, button)
      await clickOn(side, board, 300, 300, [320, 300])
      expect(side.panel(PANEL).isOpen).toBe(true)
      await clickOn(side, board)
      expect(side.panel(PANEL).isOpen).toBe(false)
      expect(side.closes).toEqual([PANEL])
      stop()
    })
  })
  test('one that only put the place menu away leaves the panel; none at all once stopped', async () => {
    await withSide(async side => {
      const stop = listenClickAway(side.shared)
      const { board } = mountBoard(side)
      await openPanel(side)
      await side.place(PANEL)
      expect(side.menuOpen()).toBe(true)
      await clickOn(side, board)
      expect(side.menuOpen()).toBe(false)
      expect(side.panel(PANEL).isOpen).toBe(true)
      stop()
      await clickOn(side, board)
      expect(side.panel(PANEL).isOpen).toBe(true)
    })
  })
})

/** What usePanelLayout gives a component under the place. */
function layoutApi(place: PanelPlace): PanelLayoutApi {
  const got: { api?: PanelLayoutApi } = {}
  function Probe() {
    got.api = usePanelLayout()
    return null
  }
  renderToStaticMarkup(
    <PanelContext.Provider value={place}>
      <Probe />
    </PanelContext.Provider>,
  )
  if (!got.api) throw new Error('not rendered')
  return got.api
}

describe('usePanelLayout', () => {
  test('with no panel open, dockTo keeps the place for the next one; the same place again keeps nothing new', async () => {
    await withSide(async side => {
      const api = layoutApi(side.shared)
      expect(api.layout).toEqual({ dock: 'right', side: null, bottom: null, float: null })
      expect(api.open).toBe(false)
      api.dockTo('bottom')
      expect(side.world.storage.get('board.panel')).toBe(
        '{"v":1,"dock":"bottom","side":null,"bottom":null,"float":null}',
      )
      side.world.storage.delete('board.panel')
      api.dockTo('bottom')
      expect(side.world.storage.has('board.panel')).toBe(false)
      expect(layoutApi(side.shared).layout.dock).toBe('bottom')
      await openPanel(side)
      expect(side.panel(PANEL).mode).toBe('bottom')
    })
  })
  test('with one open, dockTo moves it, closeOpen closes it, roomBelow is the room a bottom panel takes', async () => {
    await withSide(async side => {
      await openPanel(side)
      const api = layoutApi(side.shared)
      expect(api.open).toBe(true)
      api.dockTo('bottom')
      await side.world.settle()
      expect(side.panel(PANEL).mode).toBe('bottom')
      expect(side.world.storage.get('board.panel')).toContain('"dock":"bottom"')
      expect(api.roomBelow()).toBe(roomFor(side.shared.layout, VP).bottom)
      api.closeOpen()
      await side.world.settle()
      expect(side.closes).toEqual([PANEL])
      expect(api.roomBelow()).toBe(0)
    })
  })
})

describe('the viewer’s layout', () => {
  test('is read from board.panel', async () => {
    await withSide(
      async side => {
        expect(side.shared.layout).toEqual({ dock: 'left', side: 700, bottom: null, float: null })
      },
      JSON.stringify({ v: 1, dock: 'left', side: 700 }),
    )
  })
  test('a browser that refuses storage gets the default place, and changing it still works', () => {
    const world = new FakeWorld({ viewport: VP })
    world.install()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage is off')
      },
    })
    try {
      const place = new PanelPlace(() => VP)
      expect(place.layout).toEqual({ dock: 'right', side: null, bottom: null, float: null })
      place.setLayout({ ...place.layout, dock: 'float' }, true)
      expect(place.layout.dock).toBe('float')
    } finally {
      world.uninstall()
    }
  })
})
