// Renaming in place both ways in a fake DOM (support/fake-dom.ts), for parity: the old page's
// app.js startRename with web/rename.js's renameInPlace, as they were at the parity baseline, and
// the React port: the renamer of hooks/useRenameInPlace.ts, its field drawn by <RenameFieldView>
// and given its behaviour (attach) the way the layout effect gives it. Both sides rename the same
// sessions through the same steps; what went to the server, the toasts and snapshot() must be the same.
import { NAME_MAX } from '../../../src/core/launch/names.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { RenameFieldView } from '../../../web/src/components/RenameField.tsx'
import { type RenameKind, renamer } from '../../../web/src/hooks/useRenameInPlace.ts'
import type { ActResult } from '../../../web/src/hooks/useSessionActions.ts'
import { reducedMotion, Spring } from '../../../web/src/models/spring.ts'
import { box, type FakeElement, FakeWorld, type RectBox } from './fake-dom.ts'
import { canonical, type Element, parseHtml, reactMarkup } from './markup.ts'
import { oldCode, oldFunction } from './old-app.ts'
import { asDom, clone, first } from './react-commit.ts'

export const VIEWPORT = { w: 1000, h: 700 }

/** What the board knows when a rename starts. */
export interface RenameBoard {
  items: Item[]
  canEdit: boolean
  canMutate: boolean
  t: Translator
}

export interface RenameSide {
  world: FakeWorld
  /**
   * Rename `key` over the page's element `id` (the card's name, the sheet's head); `kind`
   * 'workspace': its workspace, over its name in the sheet's head (the React board's alone).
   */
  start(key: string, id: string, kind?: RenameKind): Promise<void>
  /** The open field's parts. */
  part(selector: '.rename' | '.rename-field' | '.rename-more' | '.rename-claude' | '.rename-claude input'): FakeElement
  page(id: string): FakeElement
  /** The server answers the rename on its way. */
  answer(r: ActResult & Record<string, unknown>): Promise<void>
  log: string[]
  snapshot(): string
  dispose(): Promise<void>
}

// ---------------------------------------------------------------- the page

const PAGE =
  '<div id="page"><article class="card" data-key="s1"><span class="name" id="card-name">acme</span></article>' +
  '<h2 id="sheet-name">acme</h2><p class="sheet-meta">workspace <button class="sheet-workspace" id="sheet-workspace">ws</button></p>' +
  '<span class="name" id="edge-name">far right</span><p id="outside">x</p></div>'

function rects(el: FakeElement): RectBox | null {
  if (el.id === 'card-name') return box(40, 300, 120, 18)
  if (el.id === 'sheet-name') return box(700, 40, 260, 26)
  if (el.id === 'sheet-workspace') return box(790, 72, 24, 17)
  if (el.id === 'edge-name') return box(900, 500, 60, 18)
  return null
}

/** The stylesheet's type for the names the field sits on. */
function computed(el: FakeElement): Record<string, string> {
  if (el.id === 'sheet-name')
    return { font: '600 19px / 1.25 system-ui', letterSpacing: '-0.02em', color: 'rgb(28, 28, 30)' }
  if (el.id === 'sheet-workspace')
    return { font: '400 12.5px / 1.35 system-ui', letterSpacing: 'normal', color: 'rgb(99, 99, 102)' }
  if (el.className === 'name')
    return { font: '600 13px / 1.3 system-ui', letterSpacing: '-0.01em', color: 'rgb(0, 0, 0)' }
  return {}
}

function newWorld(log: string[]): FakeWorld {
  const world = new FakeWorld({ viewport: VIEWPORT, rects, computed })
  world.install()
  const [page] = parseHtml(PAGE)
  if (page?.kind !== 'element') throw new Error('no page')
  world.mount(page)
  // What reaches the page's own listeners (the board's keys, a panel's click-away) gets noted.
  for (const type of ['keydown', 'pointerdown'])
    world.window.addEventListener(type, () => log.push(`${type} reached the page`))
  return world
}

const pageOf = (world: FakeWorld) => (id: string) => {
  const el = world.document.documentElement.querySelector(`#${id}`)
  if (!el) throw new Error(`no #${id}`)
  return el
}

function describeEl(world: FakeWorld, el: FakeElement | null): string {
  if (!el) return 'none'
  if (el.node === world.body) return 'body'
  return `${el.node.tag}${el.id ? `#${el.id}` : ''}.${el.className.split(' ').filter(Boolean).sort().join('.')}`
}

function snapshotOf(world: FakeWorld, log: string[]): string {
  const boxes = world
    .wrap(world.body)
    .children.filter(el => el.className === 'rename')
    .map(el => parseHtml(canonical([el.node]))[0] ?? el.node)
  const field = world.wrap(world.body).querySelector('.rename-field')
  return [
    canonical(boxes),
    `field value: ${field ? JSON.stringify(field.value) : 'none'} disabled: ${field?.disabled ?? 'none'}`,
    `renaming: ${world
      .wrap(world.body)
      .querySelectorAll('.renaming')
      .map(el => el.id)
      .join(',')}`,
    `focus: ${describeEl(world, world.document.activeElement)}`,
    `selected: ${world.selected.map(el => describeEl(world, el)).join(', ')}`,
    `log: ${log.join(' | ')}`,
  ].join('\n')
}

/** What went to the server; its answers wait until the step gives them. */
class Server {
  private waiting: ((r: ActResult) => void)[] = []
  constructor(private readonly log: string[]) {}
  act = (key: string, action: string, body: unknown): Promise<ActResult> => {
    this.log.push(`act ${key} ${action} ${JSON.stringify(body)}`)
    return new Promise(resolve => this.waiting.push(resolve))
  }
  answer(r: ActResult): void {
    for (const resolve of this.waiting.splice(0)) resolve(r)
  }
}

// ---------------------------------------------------------------- the old page

export function oldRenameSide(board: RenameBoard): RenameSide {
  const log: string[] = []
  const world = newWorld(log)
  const server = new Server(log)
  const page = pageOf(world)
  const rename = oldCode('web/rename.js', ['esc', 'renameInPlace'], {
    NAME_MAX,
    reducedMotion,
    Spring,
    current: null, // the module's `let current`
    innerWidth: VIEWPORT.w,
  })
  const start = oldFunction(
    oldCode('web/app.js', ['inTurn', 'startRename'], {
      itemOf: (key: string) => board.items.find(i => i.key === key),
      canEdit: () => board.canEdit,
      canMutate: () => board.canMutate,
      toast: (text: string, error = false) => log.push(`toast ${error ? 'error ' : ''}${text}`),
      t: board.t,
      act: server.act,
      renameInPlace: oldFunction(rename, 'renameInPlace'),
    }),
    'startRename',
  )
  return {
    world,
    log,
    page,
    async start(key, id) {
      start(key, page(id))
      await world.flush()
    },
    part(selector) {
      const el = world.wrap(world.body).querySelector(selector)
      if (!el) throw new Error(`no ${selector}`)
      return el
    },
    async answer(r) {
      server.answer(r)
      await world.flush()
    },
    snapshot: () => snapshotOf(world, log),
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

export function reactRenameSide(board: RenameBoard): RenameSide {
  const log: string[] = []
  const world = newWorld(log)
  const server = new Server(log)
  const page = pageOf(world)
  const rename = renamer({
    item: key => board.items.find(i => i.key === key),
    canEdit: () => board.canEdit,
    canMutate: () => board.canMutate,
    t: () => board.t,
    toast: (text, error = false) => log.push(`toast ${error ? 'error ' : ''}${text}`),
    act: server.act,
    viewportWidth: () => VIEWPORT.w,
  })
  // React's part: the field drawn when there is one (a new one per rename), its layout effect.
  let drawn: { id: number; el: FakeElement; markup: Element; detach: () => void } | null = null
  world.afterFlush = () => {
    const view = rename.view.get()
    if (drawn && drawn.id !== view?.id) {
      drawn.el.remove()
      drawn.detach()
      drawn = null
    }
    if (!view || drawn) return
    const markup = first(reactMarkup(<RenameFieldView view={view} t={board.t} />))
    const el = world.mount(clone(markup))
    const part = (selector: string) => el.querySelector(selector)
    const [field, more, check] = [part('.rename-field'), part('.rename-more'), part('.rename-claude input')]
    if (!field || !more) throw new Error('no field')
    drawn = { id: view.id, el, markup, detach: () => {} }
    drawn.detach = rename.attach({
      box: asDom(el),
      field: inputOf(field),
      more: asDom(more),
      check: check ? inputOf(check) : null,
    })
  }
  return {
    world,
    log,
    page,
    async start(key, id, kind) {
      rename.start(key, asDom(page(id)), kind)
      await world.flush()
    },
    part(selector) {
      const el = world.wrap(world.body).querySelector(selector)
      if (!el) throw new Error(`no ${selector}`)
      return el
    },
    async answer(r) {
      server.answer(r)
      await world.flush()
    },
    snapshot: () => snapshotOf(world, log),
    async dispose() {
      try {
        await world.settle()
      } finally {
        world.uninstall()
      }
    },
  }
}

const isInput = (el: unknown): el is HTMLInputElement =>
  typeof el === 'object' && el !== null && 'value' in el && 'checked' in el && 'select' in el

const inputOf = (el: FakeElement): HTMLInputElement => {
  const dom: unknown = asDom(el)
  if (!isInput(dom)) throw new Error('no field')
  return dom
}
