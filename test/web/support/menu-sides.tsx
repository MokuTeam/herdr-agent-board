// The context menu both ways in a fake DOM (support/fake-dom.ts), for parity: the old page's
// menu.js — initMenu as it was at the parity baseline, with its own menu-model.js — and the React
// port: components/menu/menu-engine.ts on the levels <MenuLayer> draws, drawn again after every
// event and frame the way React would (support/react-commit.ts). Both sides take the same steps;
// snapshot() prints what a viewer, or a screen reader, could tell apart.
import { MenuLayer } from '../../../web/src/components/menu/ContextMenu.tsx'
import { MenuEngine, type MenuSource } from '../../../web/src/components/menu/menu-engine.ts'
import type { MenuEntry } from '../../../web/src/models/menu-model.ts'
import { reducedMotion, Spring } from '../../../web/src/models/spring.ts'
import { box, type FakeElement, FakeWorld, type RectBox } from './fake-dom.ts'
import { canonical, type Element, parseHtml, reactMarkup } from './markup.ts'
import { oldCode, oldFunction } from './old-app.ts'
import { asDom, clone, commit, first } from './react-commit.ts'

export const VIEWPORT = { w: 1000, h: 700 }

export interface MenuOpenStep {
  x: number
  y: number
  source?: MenuSource
  label?: string
  /** The page's element the focus goes back to (by id); what has the focus by default. */
  origin?: string
}

export interface MenuSide {
  world: FakeWorld
  open(items: MenuEntry[], options: MenuOpenStep): Promise<void>
  close(): Promise<void>
  isOpen(): boolean
  /** The menus in <body>, in the order they are there. */
  levels(): FakeElement[]
  /** The page's own element by id. */
  page(id: string): FakeElement
  /** What steps note (an event prevented, a pick), for the snapshot. */
  log: string[]
  snapshot(): string
  /** Puts the world's globals back (after its springs came to rest). */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------- the page, and what the stylesheet would make of it

const PAGE = '<div id="page"><button id="opener">More</button><p id="outside">text</p><input id="field"></div>'
const WIDTH = 220
const PAD = 5
const heights: Record<string, number> = { 'menu-item': 24, 'menu-sep': 11, 'menu-note': 30 }
const heightOf = (el: FakeElement) => heights[el.className.split(' ')[0] ?? ''] ?? 0

/** A menu's box: where its inline style put it, its height from its rows; its items in it. */
function rects(el: FakeElement): RectBox | null {
  const cls = el.className.split(' ')
  if (cls.includes('menu')) {
    const rows = el.children.reduce((sum, child) => sum + heightOf(child), 0)
    return box(
      Number.parseFloat(String(el.style.left)) || 0,
      Number.parseFloat(String(el.style.top)) || 0,
      WIDTH,
      rows + 2 * PAD,
    )
  }
  if (cls.includes('menu-item')) {
    const menu = el.parentElement
    const r = menu && rects(menu)
    if (!menu || !r) return null
    const before = menu.children.slice(0, menu.children.indexOf(el))
    const top = r.top + PAD + before.reduce((sum, child) => sum + heightOf(child), 0)
    return box(r.left + PAD, top, WIDTH - 2 * PAD, heightOf(el))
  }
  if (el.id === 'opener') return box(100, 100, 80, 30)
  return null
}

function newWorld(): FakeWorld {
  const world = new FakeWorld({ viewport: VIEWPORT, rects })
  world.install()
  const [page] = parseHtml(PAGE)
  if (page?.kind !== 'element') throw new Error('no page')
  world.mount(page)
  return world
}

function describeEl(world: FakeWorld, el: FakeElement | null): string {
  if (!el) return 'none'
  if (el.node === world.body) return 'body'
  const menus = levelsOf(world)
  if (menus.includes(el)) return `menu ${menus.indexOf(el)}`
  return `${el.node.tag}#${el.id}`
}

const levelsOf = (world: FakeWorld): FakeElement[] =>
  world.wrap(world.body).children.filter(el => el.className.split(' ').includes('menu'))

function snapshotOf(world: FakeWorld, log: string[], open: boolean): string {
  const menus = levelsOf(world).map(el => parseHtml(canonical([el.node]))[0] ?? el.node)
  return [
    canonical(menus),
    `open: ${open}`,
    `focus: ${describeEl(world, world.document.activeElement)}`,
    `scrolled into view: ${world.intoView.map(s => `${s.el.id} ${JSON.stringify(s.options)}`).join(', ')}`,
    `log: ${log.join(' | ')}`,
  ].join('\n')
}

// ---------------------------------------------------------------- the old page

/** web/menu-model.js at the parity baseline, its functions by name. */
function baselineModel(): Record<string, unknown> {
  const names = [
    'placeMenu',
    'placeSubmenu',
    'usable',
    'nextIndex',
    'firstIndex',
    'lastIndex',
    'typeahead',
    'shareReasons',
  ]
  return Object.fromEntries(oldCode('web/menu-model.js', names, {}))
}

/** initMenu of web/menu.js as it was at the baseline; `onChange` hears what the page's would (app.js). */
export function oldMenuSide(onChange: () => void = () => {}): MenuSide {
  const world = newWorld()
  const log: string[] = []
  const model = baselineModel()
  const code = oldCode('web/menu.js', ['esc', 'CHECK', 'CHEV', 'initMenu'], {
    firstIndex: model.firstIndex,
    lastIndex: model.lastIndex,
    nextIndex: model.nextIndex,
    placeMenu: model.placeMenu,
    placeSubmenu: model.placeSubmenu,
    shareReasons: model.shareReasons,
    typeahead: model.typeahead,
    reducedMotion,
    Spring,
    performance: { now: () => world.now },
    innerHeight: VIEWPORT.h,
  })
  const menu: unknown = oldFunction(
    code,
    'initMenu',
  )({
    onChange: () => {
      log.push('changed')
      onChange()
    },
  })
  const call = (name: string, ...args: unknown[]): unknown => {
    if (typeof menu !== 'object' || menu === null || !(name in menu)) throw new Error(`no ${name}`)
    const fn: unknown = Reflect.get(menu, name)
    if (typeof fn !== 'function') throw new Error(`no ${name}`)
    return Reflect.apply(fn, menu, args)
  }
  const page = (id: string) => {
    const el = world.document.documentElement.querySelector(`#${id}`)
    if (!el) throw new Error(`no #${id}`)
    return el
  }
  return {
    world,
    log,
    page,
    async open(items, { x, y, source, label, origin }) {
      call('open', items, {
        x,
        y,
        source,
        label,
        origin: origin ? page(origin) : null,
        onPick: (id: string) => log.push(`picked ${id}`),
      })
      await world.flush()
    },
    async close() {
      call('close')
      await world.flush()
    },
    isOpen: () => !!call('isOpen'),
    levels: () => levelsOf(world),
    snapshot: () => snapshotOf(world, log, !!call('isOpen')),
    async dispose() {
      try {
        await world.settle()
      } finally {
        world.uninstall()
      }
    },
  }
}

// ---------------------------------------------------------------- the React port

export function reactMenuSide(): MenuSide & { engine: MenuEngine } {
  const world = newWorld()
  const log: string[] = []
  const engine = new MenuEngine({
    onChange: () => log.push('changed'),
    viewport: () => ({ width: VIEWPORT.w, height: VIEWPORT.h }),
    now: () => world.now,
  })
  const stop = engine.start()
  const drawn = new Map<string, { el: FakeElement; markup: Element; detach: () => void }>()
  // What React does after a change: levels gone leave <body>, the others are drawn again, new ones
  // go in at the end and get their layout effect (attach).
  const draw = () => {
    const { layers } = engine.view.get()
    const ids = new Set(layers.map(l => l.id))
    for (const [id, d] of drawn)
      if (!ids.has(id)) {
        d.el.remove()
        d.detach()
        drawn.delete(id)
      }
    const added: [string, FakeElement][] = []
    for (const layer of layers) {
      const next = first(reactMarkup(<MenuLayer layer={layer} />))
      const d = drawn.get(layer.id)
      if (d) {
        commit(world, d.el.node, d.markup, next)
        d.markup = next
      } else {
        const el = world.mount(clone(next))
        drawn.set(layer.id, { el, markup: next, detach: () => {} })
        added.push([layer.id, el])
      }
    }
    for (const [id, el] of added) {
      const d = drawn.get(id)
      if (d) d.detach = engine.attach(id, asDom(el))
    }
  }
  world.afterFlush = () => {
    for (let i = 0; i < 4; i++) {
      const before = engine.view.get()
      draw()
      if (engine.view.get() === before) return
    }
  }
  const page = (id: string) => {
    const el = world.document.documentElement.querySelector(`#${id}`)
    if (!el) throw new Error(`no #${id}`)
    return el
  }
  return {
    engine,
    world,
    log,
    page,
    async open(items, { x, y, source, label, origin }) {
      engine.open(items, {
        x,
        y,
        ...(source && { source }),
        ...(label !== undefined && { label }),
        origin: origin ? asDom(page(origin)) : null,
        onPick: id => log.push(`picked ${id}`),
      })
      await world.flush()
    },
    async close() {
      engine.close()
      await world.flush()
    },
    isOpen: () => engine.isOpen(),
    levels: () => levelsOf(world),
    snapshot: () => snapshotOf(world, log, engine.isOpen()),
    async dispose() {
      try {
        await world.settle()
      } finally {
        stop()
        world.uninstall()
      }
    },
  }
}
