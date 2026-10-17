// What upstream's page drew for a session's helpers and the sessions it works with (#40, merge
// 0d33639), for the expected side of their markup parity: helpers.js's rows and window,
// helper-model.js, and app.js's card lines, sheet strip, sessions row and thread, picked out of the
// files as that change left them (support/old-app.ts) and run against a small stand-in DOM.
import { translator } from '../../../src/core/i18n/translator.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { byClass, byId, type Element, findAll, type Node, setAttr, setHtml, setText, toggleAttr } from './markup.ts'
import { OLD_MARKDOWN, type OldFunction, oldCode, oldFunction, oldModule, oldSource } from './old-app.ts'

export const PR40 = '0d33639'

/** helper-model.js as #40 left it. */
export const OLD_HELPER_MODEL = await oldModule('web/helper-model.js', PR40)
const model = (name: string) => oldFunction(OLD_HELPER_MODEL, name)
const MODEL = {
  clock: model('clock'),
  tokens: model('tokens'),
  toneOf: model('toneOf'),
  took: model('took'),
  helperTitle: model('helperTitle'),
  groupHelpers: model('groupHelpers'),
  findHelper: model('findHelper'),
  sessionByName: model('sessionByName'),
  liveCount: model('liveCount'),
  relatedKeys: model('relatedKeys'),
}

/** helpers.js's rows and marks. */
export function oldRows() {
  const code = oldCode(
    'web/helpers.js',
    ['esc', 'svg', 'HELPER_ICONS', 'statusMark', 'timeHTML', 'kindIcon', 'helperRowHTML', 'runRowHTML'],
    MODEL,
    PR40,
  )
  return {
    HELPER_ICONS: code.get('HELPER_ICONS'),
    statusMark: oldFunction(code, 'statusMark'),
    timeHTML: oldFunction(code, 'timeHTML'),
    kindIcon: oldFunction(code, 'kindIcon'),
    helperRowHTML: oldFunction(code, 'helperRowHTML'),
    runRowHTML: oldFunction(code, 'runRowHTML'),
  }
}

/** Just enough of an element for the old code's writes, onto a parsed node. */
export class FakeElement {
  _html: unknown
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  constructor(readonly node: Element) {}
  set innerHTML(html: string) {
    setHtml(this.node, html)
  }
  set textContent(text: string) {
    setText(this.node, text)
  }
  set title(value: string) {
    setAttr(this.node, 'title', value)
  }
  set hidden(on: boolean) {
    toggleAttr(this.node, 'hidden', on)
  }
  set className(value: string) {
    setAttr(this.node, 'class', value)
  }
  setAttribute(name: string, value: string) {
    setAttr(this.node, name, value)
  }
  readonly dataset = new Proxy({} as Record<string, string>, {
    set: (_target, key, value) => {
      setAttr(this.node, `data-${String(key)}`, String(value))
      return true
    },
  })
  querySelector = () => null
}

/** Clocks that run, as tickClocks leaves them: since their data-since, up to now. */
export function tickClocks(nodes: Node[]): void {
  for (const el of findAll(nodes, e => e.attrs.has('data-since')))
    setText(el, String(MODEL.clock(Date.now() - Number(el.attrs.get('data-since')))))
}

export interface OldScene {
  lang?: string
  items: Item[]
  /** The open session's detail (state.detail). */
  detail?: { helpers?: unknown[]; workflows?: unknown[] } | null
  categories?: { id: string; title: string; color: string }[]
}

/** app.js's pieces for #40, with the scene as the page's state. */
export function oldApp(scene: OldScene) {
  const t = translator(scene.lang ?? 'en')
  const rows = oldRows()
  const state = {
    data: { items: scene.items, categories: scene.categories ?? [] },
    detail: scene.detail ?? null,
    moved: new Map(),
  }
  const strip: Element = { kind: 'element', tag: 'section', attrs: new Map(), children: [] }
  const markdown = oldFunction(OLD_MARKDOWN, 'markdown')
  const noOther = () => {
    throw new Error('not drawn by these scenes')
  }
  const code = oldCode(
    'web/app.js',
    [
      'ICON',
      'esc',
      'UPLOAD_IMAGE',
      'thumbs',
      'ago',
      'clock',
      'itemOf',
      'catOf',
      'catInfo',
      'helpersChip',
      'relationsLine',
      'relAll',
      'relationsRow',
      'linkedSessions',
      'renderHelpersStrip',
      'whoHTML',
      'linkLine',
      'peerBubble',
      'thread',
    ],
    {
      t,
      state,
      // What app.js imported from helper-model.js and helpers.js.
      findHelper: MODEL.findHelper,
      helperTitle: MODEL.helperTitle,
      liveCount: MODEL.liveCount,
      relatedKeys: MODEL.relatedKeys,
      sessionByName: MODEL.sessionByName,
      took: MODEL.took,
      ...rows,
      markdown,
      notice: noOther,
      questionsUI: { threadHTML: noOther },
      sheetHelpers: new FakeElement(strip),
      redraw: (el: FakeElement, html: string) => {
        el.innerHTML = html
      },
    },
    PR40,
  )
  const call = (name: string) => oldFunction(code, name)
  return {
    t,
    rows,
    relAll: code.get('relAll') as Set<string>,
    helpersChip: call('helpersChip'),
    relationsLine: call('relationsLine'),
    relationsRow: call('relationsRow'),
    thread: call('thread'),
    /** The strip as renderHelpersStrip leaves #sheet-helpers. */
    strip(): Element {
      strip.attrs = new Map([
        ['class', 'sheet-helpers'],
        ['id', 'sheet-helpers'],
        ['aria-labelledby', 'sheet-helpers-title'],
        ['hidden', ''],
      ])
      strip.children = []
      call('renderHelpersStrip')()
      tickClocks([strip])
      return strip
    },
  }
}

/** The window's markup as initHelpers builds its root, hidden until opened. */
function windowRoot(icons: unknown): Element {
  const source = oldSource('web/helpers.js', PR40)
  const tpl = /root\.innerHTML = `([\s\S]*?)`\n/.exec(source)?.[1]
  if (!tpl) throw new Error('no window markup in helpers.js')
  const html = new Function('HELPER_ICONS', `return \`${tpl}\``)(icons)
  const root: Element = { kind: 'element', tag: 'div', attrs: new Map([['class', 'ql helpers']]), children: [] }
  setHtml(root, String(html))
  return root
}

export interface OldWindowScene extends OldScene {
  /** The session whose helpers it shows (s.key). */
  key: string
  /** s.stack */
  stack: ({ id: string } | { list: true; run: string | null })[]
  /** s.data: the helper as read, with its conversation. */
  data?: { helper: object; conversation: readonly unknown[] } | null
  /** What a read that failed said, before anything was read. */
  error?: string
}

/**
 * The window as helpers.js leaves it for the scene: opened (labels), then what show() draws for
 * the top of the stack — the list, a helper while it loads or after a failed read — or, with
 * `data`, what render(true) draws of it.
 */
export function oldWindow(scene: OldWindowScene): Element {
  const app = oldApp(scene)
  const { t } = app
  const tr: Translator = t
  const root = windowRoot(app.rows.HELPER_ICONS)
  const pick = (sel: string): Element =>
    sel.startsWith('#') ? byId([root], sel.slice(1)) : byClass([root], sel.slice(1))
  const fakes = new Map<string, FakeElement>()
  const $ = (sel: string) => {
    const known = fakes.get(sel)
    if (known) return known
    const made = new FakeElement(pick(sel))
    fakes.set(sel, made)
    return made
  }
  const body = $('.helper-body')
  const s = { key: scene.key, stack: scene.stack, data: scene.data ?? null, pinned: true }
  const items = new Map(scene.items.map(i => [i.key, i]))
  const code = oldCode(
    'web/helpers.js',
    [
      { name: 'labels', indent: '  ' },
      { name: 'head', indent: '  ' },
      { name: 'setBody', indent: '  ' },
      { name: 'setFoot', indent: '  ' },
      { name: 'rowHTML', indent: '  ' },
      { name: 'showList', indent: '  ' },
      { name: 'render', indent: '  ' },
    ],
    {
      ...MODEL,
      ...app.rows,
      esc: (v: unknown) =>
        String(v ?? '').replace(
          /[&<>"']/g,
          c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
        ),
      tr: (key: string, vars?: Record<string, string | number>) => tr(key, vars),
      t: () => tr,
      $,
      body,
      s,
      item: (key: string) => items.get(key),
      detail: (key: string) => (key === scene.key ? (scene.detail ?? null) : null),
      renderThread: (conv: unknown[], ctx: { key: string }) => app.thread(conv, items.get(ctx.key) ?? {}, ctx),
      upgrade: () => {},
      redraw: (el: FakeElement, html: string) => {
        el.innerHTML = html
        el._html = html
      },
      CSS: { escape: (v: string) => v },
      requestAnimationFrame: () => 0,
      reducedMotion: { matches: true },
    },
    PR40,
  )
  const call = (name: string): OldFunction => oldFunction(code, name)
  toggleAttr(root, 'hidden', false)
  call('labels')()
  // show(): the back button, then the list or what the sheet knows of the helper.
  $('.helper-back').hidden = s.stack.length < 2
  const top = s.stack.at(-1)
  if (top && 'list' in top) call('showList')(top)
  else if (top) {
    const known = (scene.detail?.helpers ?? []).find(h => (h as { id?: string }).id === top.id)
    call('head')(known ?? { id: top.id, kind: 'agent', status: '' })
    body.className = 'ql-body helper-body'
    call('setBody')(`<div class="ql-wait">${tr('loading')}</div>`)
    call('setFoot')('')
    // A read that failed before anything was read (load()).
    const icons = app.rows.HELPER_ICONS as Record<string, string>
    if (scene.error) call('setBody')(`<div class="ql-empty">${icons.stack}<p>${scene.error}</p></div>`)
    if (s.data) call('render')(true)
  }
  tickClocks([root])
  return root
}
