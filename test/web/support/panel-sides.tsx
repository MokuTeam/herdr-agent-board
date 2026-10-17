// The side panels run two ways in a fake DOM (support/fake-dom.ts), for parity: the old
// web/panel.js on today's asides from web/index.html (then app.js's applyTexts), and the React
// panel's engine (components/panel) on the asides React renders, drawn again after every event
// and frame the way React would (only the attributes whose rendered value changed are written).
// Both sides take the same steps; `snapshot()` prints what a viewer could tell apart.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReactNode } from 'react'
import { translator } from '../../../src/core/i18n/translator.ts'
import type { Translator } from '../../../src/core/types.ts'
import { DockPreview } from '../../../web/src/components/panel/DockPreview.tsx'
import { LayoutMenuView } from '../../../web/src/components/panel/LayoutMenu.tsx'
import { PanelMotion } from '../../../web/src/components/panel/motion.ts'
import { type PanelKind, PanelView } from '../../../web/src/components/panel/Panel.tsx'
import { PanelPlace } from '../../../web/src/components/panel/place.ts'
import { I18nProvider } from '../../../web/src/i18n/I18nProvider.tsx'
import { type FakeElement, FakeWorld, type WorldOptions } from './fake-dom.ts'
import {
  addButtonTypes,
  applyTexts,
  byId,
  canonical,
  type Element,
  type Node,
  OLD_PAGE_ONLY,
  pageMarkup,
  parseHtml,
  reactMarkup,
  stripAttrs,
} from './markup.ts'
import { oldSource } from './old-app.ts'
import { asDom, clone, commit, first } from './react-commit.ts'

const ROOT = join(import.meta.dir, '..', '..', '..')

export const KINDS: Record<string, PanelKind> = {
  sheet: 'session',
  'cats-sheet': 'categories',
  'sched-sheet': 'schedule',
}

/** The title part of each aside's head, as web/index.html has it. */
export function titleOf(kind: PanelKind, t: Translator): ReactNode {
  if (kind === 'session')
    return (
      <>
        <span className="status-pill" id="sheet-status" />
        {/* biome-ignore lint/a11y/useHeadingContent: empty until a session opens, as in web/index.html */}
        <h2 id="sheet-name" />
        <p className="sheet-meta" id="sheet-meta" />
      </>
    )
  const key = kind === 'categories' ? 'cats' : 'sched'
  return (
    <>
      <h2>{t(`${key}.title`)}</h2>
      <p className="sheet-meta">{t(`${key}.about`)}</p>
    </>
  )
}

interface SpringLike {
  value: number
  target: number
}

/** What a side's panel says of itself. */
interface PanelLike {
  isOpen: boolean
  mode: string
  x: SpringLike
  y: SpringLike
  w: SpringLike
  h: SpringLike
  p: SpringLike
  open(): unknown
}

function isPanel(value: unknown): value is PanelLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'open' in value &&
    typeof value.open === 'function' &&
    'isOpen' in value &&
    'x' in value
  )
}

export interface KeepTarget {
  target(): FakeElement | null
  top(): number
}

export interface PanelSide {
  world: FakeWorld
  aside(id: string): FakeElement
  menu: FakeElement
  preview: FakeElement
  /** Ids in the order their owners heard onClose. */
  closes: string[]
  open(id: string): Promise<void>
  /** The close button. */
  close(id: string): Promise<void>
  /** The place button. */
  place(id: string): Promise<void>
  panel(id: string): PanelLike
  keepInSight(keep: KeepTarget): void
  roomBelow(): number
  menuOpen(): boolean
  snapshot(): string
  /** Puts the world's globals back. */
  dispose(): void
}

export interface SideOptions extends WorldOptions {
  ids: string[]
  lang?: string
  /** board.panel in localStorage before the page starts. */
  saved?: string
}

// ---------------------------------------------------------------- what a viewer could tell apart

/** A copy of the aside with only the head kept in .sheet-inner (the bodies are the panels' own). */
function shellOf(aside: Element): Element {
  const copy = parseHtml(canonical([aside]))[0]
  if (copy?.kind !== 'element') throw new Error('no aside')
  const inner = copy.children.find((c): c is Element => c.kind === 'element' && c.attrs.get('class') === 'sheet-inner')
  if (inner) inner.children = inner.children.filter(c => c.kind === 'element' && c.tag === 'header')
  return copy
}

function describe(el: FakeElement | null): string {
  if (!el) return 'none'
  const n = el.node
  const attrs = ['id', 'class', 'data-dock', 'data-layout', 'data-close', 'data-reset', 'data-edge']
    .filter(a => n.attrs.has(a))
    .map(a => `[${a}=${n.attrs.get(a)}]`)
  return `${n.tag}${attrs.join('')}`
}

const numbers = (p: PanelLike) => [p.x, p.y, p.w, p.h, p.p].map(s => `${s.value}/${s.target}`).join(' ')

function snapshotOf(side: Omit<PanelSide, 'snapshot' | 'dispose'>, ids: string[], old: boolean): string {
  const nodes: Node[] = [...ids.map(id => shellOf(side.aside(id).node)), side.menu.node, side.preview.node].map(
    n => parseHtml(canonical([n]))[0] ?? n,
  )
  if (old) {
    stripAttrs(nodes, OLD_PAGE_ONLY)
    addButtonTypes(nodes)
  }
  const w = side.world
  return [
    canonical(nodes),
    `html: ${w.html.attrs.get('style') ?? ''}`,
    `body: ${w.body.attrs.get('class') ?? ''} | ${w.body.attrs.get('style') ?? ''}`,
    `saved: ${w.storage.get('board.panel') ?? ''}`,
    `scrolls: ${JSON.stringify(w.scrolls)}`,
    `focus: ${describe(w.document.activeElement)}`,
    `closes: ${side.closes.join(',')}`,
    `menu: ${side.menuOpen()} room below: ${side.roomBelow()}`,
    `captures: ${[...w.captures].map(([id, el]) => `${id}:${describe(el)}`).join(',')}`,
    `animations: ${w.animations.map(a => `${describe(a.el)} ${JSON.stringify([a.keyframes, a.options])}`).join(', ')}`,
    ...ids.map(id => {
      const p = side.panel(id)
      return `${id}: open ${p.isOpen} mode ${p.mode} ${numbers(p)}`
    }),
  ].join('\n')
}

// ---------------------------------------------------------------- the old page

/** A fresh copy of web/panel.js (its module state is per page), importing the moved models. */
async function importOldPanel(): Promise<Record<string, unknown>> {
  const models = join(ROOT, 'web', 'src', 'models')
  const moved: Record<string, string> = {
    './panel-layout.js': join(models, 'panel-layout.ts'),
    './spring.js': join(models, 'spring.ts'),
  }
  const source = oldSource('web/panel.js').replace(/from '(\.\/[^']+)'/g, (_, rel: string) => {
    const path = moved[rel] ?? join(ROOT, 'web', ...rel.split('/'))
    return `from '${pathToFileURL(path).href}'`
  })
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-panel-'))
  try {
    const file = join(dir, 'panel.js')
    writeFileSync(file, source)
    const mod: unknown = await import(pathToFileURL(file).href)
    if (typeof mod !== 'object' || mod === null) throw new Error('panel.js did not load')
    return Object.fromEntries(Object.entries(mod))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function call(fn: unknown, ...args: unknown[]): unknown {
  if (typeof fn !== 'function') throw new Error('not a function')
  return Reflect.apply(fn, undefined, args)
}

export async function oldSide(options: SideOptions): Promise<PanelSide> {
  const t = translator(options.lang ?? 'en')
  const world = new FakeWorld(options)
  if (options.saved !== undefined) world.storage.set('board.panel', options.saved)
  world.install()
  const page = pageMarkup()
  const asides = new Map(options.ids.map(id => [id, world.mount(byId(page, id))]))
  const mod = await importOldPanel()
  const closes: string[] = []
  const panels = new Map<string, PanelLike>()
  for (const [id, el] of asides) {
    if (typeof mod.Panel !== 'function') throw new Error('no Panel')
    const panel: unknown = Reflect.construct(mod.Panel, [el, { onClose: () => closes.push(id), text: t }])
    if (!isPanel(panel)) throw new Error('not a panel')
    panels.set(id, panel)
  }
  applyTexts([world.body], t) // app.js applyTexts() runs after the panels are made
  const bodyChild = (cls: string) => {
    const el = world.wrap(world.body).querySelector(`.${cls}`)
    if (!el) throw new Error(`no .${cls}`)
    return el
  }
  const aside = (id: string) => {
    const el = asides.get(id)
    if (!el) throw new Error(`no ${id}`)
    return el
  }
  const panel = (id: string) => {
    const p = panels.get(id)
    if (!p) throw new Error(`no ${id}`)
    return p
  }
  const button = (id: string, selector: string) => {
    const el = aside(id).querySelector(selector)
    if (!el) throw new Error(`no ${selector}`)
    return el
  }
  const side = {
    world,
    aside,
    menu: bodyChild('layout-menu'),
    preview: bodyChild('dock-preview'),
    closes,
    async open(id: string) {
      panel(id).open()
      await world.flush()
    },
    async close(id: string) {
      await world.fire(button(id, '[data-close]'), 'click')
    },
    async place(id: string) {
      await world.fire(button(id, '[data-layout]'), 'click')
    },
    panel,
    keepInSight: (keep: KeepTarget) => void call(mod.keepInSight, keep),
    roomBelow: () => Number(call(mod.roomBelow)),
    menuOpen: () => !!call(mod.menuOpen),
  }
  return { ...side, snapshot: () => snapshotOf(side, options.ids, true), dispose: () => world.uninstall() }
}

// ---------------------------------------------------------------- the React panel

/** The React side, with the shared place its panels are in. */
export interface ReactSide extends PanelSide {
  shared: PanelPlace
}

export async function newSide(options: SideOptions): Promise<ReactSide> {
  const lang = options.lang ?? 'en'
  const t = translator(lang)
  const world = new FakeWorld(options)
  if (options.saved !== undefined) world.storage.set('board.panel', options.saved)
  world.install()
  const place = new PanelPlace()
  const closes: string[] = []
  const inI18n = (node: ReactNode) => first(reactMarkup(<I18nProvider lang={lang}>{node}</I18nProvider>))
  const views = options.ids.map(id => {
    const kind = KINDS[id] ?? 'categories'
    const motion = new PanelMotion(place)
    motion.onClose = () => closes.push(id)
    const draw = () => {
      const { shown, chrome } = motion.state.get()
      const menuOpen = place.state.get().menu.expanded === motion
      return inI18n(
        <PanelView id={id} kind={kind} title={titleOf(kind, t)} shown={shown} chrome={chrome} menuOpen={menuOpen} />,
      )
    }
    const drawn = draw()
    const el = world.mount(clone(drawn))
    return { id, motion, draw, drawn, el }
  })
  const drawMenu = () => inI18n(<LayoutMenuView checked={place.state.get().menu.checked} />)
  let menuDrawn = drawMenu()
  const menu = world.mount(clone(menuDrawn))
  const preview = world.mount(clone(inI18n(<DockPreview place={place} />)))
  // React's effects: the panels take their elements, then the place its window, then (after the
  // first draw) the preview and the menu theirs.
  for (const v of views) v.motion.attach(asDom(v.el))
  place.attach()
  place.preview.attach(asDom(preview))
  place.menu.attach(asDom(menu))
  world.afterFlush = () => {
    for (const v of views) {
      const next = v.draw()
      commit(world, v.el.node, v.drawn, next)
      v.drawn = next
    }
    const next = drawMenu()
    commit(world, menu.node, menuDrawn, next)
    menuDrawn = next
  }
  const view = (id: string) => {
    const v = views.find(x => x.id === id)
    if (!v) throw new Error(`no ${id}`)
    return v
  }
  const side = {
    world,
    aside: (id: string) => view(id).el,
    menu,
    preview,
    closes,
    async open(id: string) {
      view(id).motion.open()
      await world.flush()
    },
    async close(id: string) {
      view(id).motion.close() // the close button's onClick
      await world.flush()
    },
    async place(id: string) {
      const button = view(id).el.querySelector('[data-layout]')
      if (!button) throw new Error('no place button')
      place.menu.toggle(view(id).motion, asDom(button)) // the place button's onClick
      await world.flush()
    },
    panel: (id: string) => view(id).motion,
    // The old page kept one card in sight for every panel (the open session's); here each panel is
    // about that card (the scenes open one panel at a time), and the place knows the board's top.
    keepInSight(keep: KeepTarget) {
      for (const v of views)
        v.motion.about = () => {
          const el = keep.target()
          return el ? asDom(el) : null
        }
      place.boardTop = keep.top
    },
    roomBelow: () => place.roomBelow(),
    menuOpen: () => place.menu.isOpen(),
  }
  return {
    ...side,
    shared: place,
    snapshot: () => snapshotOf(side, options.ids, false),
    dispose: () => world.uninstall(),
  }
}
