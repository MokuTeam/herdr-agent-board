// The categories panel as the old page ran it, in a fake DOM (support/fake-dom.ts): #cats-sheet of
// web/index.html, its texts filled (applyTexts), and web/app.js's own categories code as it was at
// the parity baseline (support/old-app.ts) — renderCats with catRowOf and updateCatRow, renderDraft,
// createDraft, the reorder (rowSpring, endCatDrag) and the listeners on #cat-new, #cat-draft and
// #cats-list. Its server calls (editCats) are kept, not sent. By hand: syncAvailability's part for
// the panel (app.js:183).
import { translator } from '../../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../../src/core/payload.ts'
import { rubberband, Spring, velocityOf } from '../../../web/src/models/spring.ts'
import { type FakeElement, FakeWorld, type WorldOptions } from './fake-dom.ts'
import {
  addButtonTypes,
  applyTexts,
  byId,
  type Element,
  findAll,
  type Node,
  OLD_PAGE_ONLY,
  pageMarkup,
  stripAttrs,
  toggleAttr,
} from './markup.ts'
import { oldCode, oldFunction, type Wanted } from './old-app.ts'

export interface OldCategoriesScene {
  lang?: string
  data: BoardPayload
  /** state.moved: cards the user dropped in another lane. */
  moved?: Map<string, string>
  canEdit?: boolean
}

const LISTENERS = [
  "$('#cat-new').addEventListener('click'",
  "$('#cat-draft').addEventListener('input'",
  "$('#cat-draft').addEventListener('keydown'",
  "$('#cat-draft').addEventListener('click'",
  "catsList.addEventListener('click'",
  "catsList.addEventListener('keydown'",
  "catsList.addEventListener('focusout'",
  "catsList.addEventListener('pointerdown'",
  "catsList.addEventListener('pointermove'",
  "catsList.addEventListener('pointerup'",
  "catsList.addEventListener('pointercancel'",
]

const PICKED: Wanted[] = [
  'esc',
  'q',
  'catOf',
  'TRANSLIT',
  'slug',
  'GRIP',
  'TRASH',
  'catRowOf',
  'updateCatRow',
  'renderCats',
  'renderDraft',
  'createDraft',
  'rowSpring',
  'endCatDrag',
  ...LISTENERS.map(statement => ({ statement })),
]

/** A copy of a subtree, for printing it apart from the live one. */
const copy = (node: Node): Node =>
  node.kind === 'text' ? { ...node } : { ...node, attrs: new Map(node.attrs), children: node.children.map(copy) }

export class OldCategories {
  readonly world: FakeWorld
  readonly aside: FakeElement
  readonly list: FakeElement
  /** What editCats was asked to send. */
  readonly posts: unknown[] = []
  readonly toasts: [string, boolean][] = []
  /** openCats(id) calls. */
  readonly opened: string[] = []
  renders = 0
  readonly state: { data: BoardPayload; moved: Map<string, string> }
  private readonly code: Map<string, unknown>

  constructor(
    readonly scene: OldCategoriesScene,
    options: Partial<WorldOptions> = {},
  ) {
    const t = translator(scene.lang ?? 'en')
    this.world = new FakeWorld({ viewport: { w: 1200, h: 800 }, ...options })
    this.world.install()
    const page = pageMarkup()
    applyTexts(page, t)
    this.aside = this.world.mount(byId(page, 'cats-sheet'))
    const list = this.aside.querySelector('#cats-list')
    if (!list) throw new Error('no #cats-list')
    this.list = list
    this.state = { data: structuredClone(scene.data), moved: scene.moved ?? new Map() }
    const document = this.world.document
    this.code = oldCode(
      'web/app.js',
      PICKED,
      {
        t,
        state: this.state,
        document,
        $: (selector: string) => document.querySelector(selector),
        catsPanel: { isOpen: true },
        catsList: list,
        catRows: new Map(),
        catDraft: null,
        catDrag: null,
        editCats: async (body: unknown) => {
          this.posts.push(body)
          return true
        },
        toast: (text: string, error = false) => void this.toasts.push([text, error]),
        openCats: (id: string) => void this.opened.push(id),
        render: () => void this.renders++,
        Spring,
        rubberband,
        velocityOf,
      },
      { baseline: true },
    )
  }

  /** renderCats() and renderDraft(), as render() and opening the panel draw them. */
  draw(): void {
    oldFunction(this.code, 'renderCats')()
    oldFunction(this.code, 'renderDraft')()
  }

  /** The panel's body and footer as a viewer could tell them apart (buttons typed as React types them). */
  body(): Node[] {
    const inner = this.aside.querySelector('.sheet-inner')
    if (!inner) throw new Error('no .sheet-inner')
    const nodes = inner.node.children.filter((n): n is Element => n.kind === 'element' && n.tag !== 'header').map(copy)
    if (this.scene.canEdit === false)
      for (const el of findAll(
        nodes,
        el =>
          (el.tag === 'button' && !el.attrs.has('data-close') && !el.attrs.has('data-layout')) || el.tag === 'input',
      ))
        toggleAttr(el, 'disabled', true)
    // A field's value is its attribute here, as in React's server markup; an empty one React writes too.
    for (const el of findAll(nodes, el => el.tag === 'input' && !el.attrs.has('value'))) el.attrs.set('value', '')
    stripAttrs(nodes, OLD_PAGE_ONLY)
    addButtonTypes(nodes)
    return nodes
  }

  /** The element `selector` names in the panel. */
  el(selector: string): FakeElement {
    const found = this.aside.querySelector(selector)
    if (!found) throw new Error(`no ${selector}`)
    return found
  }

  async dispose(): Promise<void> {
    try {
      await this.world.settle()
    } finally {
      this.world.uninstall()
    }
  }
}
