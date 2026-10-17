// The terminal window both ways, for parity: upstream's web/terminal.js as it was at the
// terminal's merge (initTerminal with its own modal-focus.js, spring.js, term-keys.js and
// term-model.js) on a fake <body>, and the React port — hooks/useTerminal.ts's engine on the rows
// and the field, components/terminal/Terminal.tsx drawing the rest from its view — on another.
// Both get the same board, the same server (its answers to the POSTs, the streams it opened and
// what they send) and the same steps; after each step the two must read the same: the window,
// the rows, what was posted, the toasts and what was handed to the page.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { translator } from '../../../src/core/i18n/translator.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { terminalApi } from '../../../web/src/api/terminal.ts'
import { TerminalView } from '../../../web/src/components/terminal/Terminal.tsx'
import { type TerminalEngine, type TermRefs, terminalEngine } from '../../../web/src/hooks/useTerminal.ts'
import { I18nProvider } from '../../../web/src/i18n/I18nProvider.tsx'
import { type FocusDocument, type FocusElement, modalFocusManager } from '../../../web/src/models/modal-focus.ts'
import type { TermTarget } from '../../../web/src/models/terminal.ts'
import { type EventFields, type FakeElement, FakeWorld } from './fake-dom.ts'
import {
  addButtonTypes,
  canonical,
  type Element,
  find,
  findAll,
  hasClass,
  type Node,
  parseHtml,
  reactMarkup,
} from './markup.ts'
import { oldSource } from './old-app.ts'

/** Upstream's merge of the terminal (PR #36). */
export const TERMINAL_MERGE = '1a1b270'
const OLD_FILES = ['terminal.js', 'modal-focus.js', 'spring.js', 'term-keys.js', 'term-model.js']

/** What the board knows: its sessions, the shells it opened, whether herdr's data is fresh. */
export interface TermScene {
  items: Item[]
  shells: string[]
  canMutate: boolean
  token: string
  lang: string
}

type Reply = { status: number; body: Record<string, unknown> } | 'timeout' | 'offline' | 'hold'

/** A stream the server opened; a test sends its events. */
export class FakeStream {
  static CLOSED = 2
  readyState = 1
  closed = false
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  close(): void {
    this.readyState = 2
    this.closed = true
  }
}

/** The server: its answers by `<target>/<op>`, what was posted, the streams. */
export class TermServer {
  readonly posts: string[] = []
  readonly streams: FakeStream[] = []
  replies: Record<string, Reply> = {}
  private held: (() => void)[] = []

  /** Every POST held so far gets its answer now. */
  release(): void {
    for (const go of this.held.splice(0)) go()
  }

  async fetch(url: string, init?: { body?: unknown }): Promise<unknown> {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    this.posts.push(`${url} ${JSON.stringify(body)}`)
    const m = /^\/api\/term\/[^/]+\/(agent|shell)\/(\w+)$/.exec(url)
    let reply = this.replies[`${m?.[1]}/${m?.[2]}`] ?? { status: 200, body: { ok: true } }
    if (reply === 'hold') {
      await new Promise<void>(resolve => this.held.push(resolve))
      reply = { status: 200, body: { ok: true } }
    }
    if (reply === 'timeout') throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
    if (reply === 'offline') throw new TypeError('Failed to fetch')
    const { status, body: answer } = reply
    return { ok: status < 400, status, json: async () => answer }
  }
}

/** A click on what the user sees, both sides: by what the element is. */
export type Click =
  | 'close'
  | 'scrim'
  | 'target-agent'
  | 'target-shell'
  | 'herdr'
  | 'close-shell'
  | 'state'
  | 'paste-yes'
  | 'paste-no'
  | 'screen'
  | 'link'
  | `key:${string}`

const CLICKS: Record<string, (el: Element) => boolean> = {
  close: el => hasClass(el, 'term-x'),
  scrim: el => hasClass(el, 'ql-scrim'),
  'target-agent': el => el.attrs.get('data-target') === 'agent',
  'target-shell': el => el.attrs.get('data-target') === 'shell',
  herdr: el => hasClass(el, 'term-herdr'),
  'close-shell': el => hasClass(el, 'term-close'),
  state: el => el.attrs.has('data-do'),
  'paste-yes': el => el.attrs.get('data-paste') === 'yes',
  'paste-no': el => el.attrs.get('data-paste') === 'no',
  screen: el => hasClass(el, 'term-scroll'),
  link: el => hasClass(el, 'tlink'),
}
const clickMatch = (what: Click) =>
  what.startsWith('key:')
    ? (el: Element) => el.attrs.get('data-key') === what.slice(4)
    : (CLICKS[what] ?? (() => false))

/** A browser would not click it: gray, or out of sight. */
function unclickable(nodes: Node[], el: Element): boolean {
  if (el.attrs.has('disabled')) return true
  const hidden = findAll(nodes, e => e.attrs.has('hidden'))
  return hidden.some(h => h === el || findAll(h.children, e => e === el).length > 0)
}

export interface TermSide {
  world: FakeWorld
  server: TermServer
  scene: TermScene
  toasts: string[]
  /** What the window handed to the page: wake, go to the session, open a link. */
  log: string[]
  open(key: string, target?: TermTarget): Promise<void>
  /** The board changed (new data, a shell opened elsewhere, the session gone). */
  board(change: Partial<TermScene>): Promise<void>
  /** An event of the latest stream (or the `index`-th). */
  message(msg: unknown, index?: number): Promise<void>
  streamError(closed: boolean, index?: number): Promise<void>
  click(what: Click): Promise<void>
  /** A key in the field the keys arrive in. */
  key(fields: EventFields & { code?: string }): Promise<void>
  /** A key with the focus elsewhere in the window. */
  windowKey(fields: EventFields & { code?: string }): Promise<void>
  /** beforeinput on the field. */
  input(inputType: string, data?: string): Promise<void>
  paste(text: string): Promise<void>
  /** Time goes by (timers, the spring). */
  wait(ms: number): Promise<void>
  /** The window as it reads now, its rows apart. */
  snapshot(): string
  isOpen(): boolean
  dispose(): Promise<void>
}

const STYLED = ['ql', 'ql-win', 'ql-scrim', 'term-screen']

/** The window as both sides compare it: no spring styles, no caret, nothing inside what is hidden. */
function tidy(nodes: Node[]): Node[] {
  return nodes.flatMap((n): Node[] => {
    if (n.kind === 'text') return [n]
    if (hasClass(n, 'tcaret') || hasClass(n, 'term-probe')) return []
    const attrs = new Map(n.attrs)
    if (STYLED.some(c => hasClass(n, c))) attrs.delete('style')
    const keep = !attrs.has('hidden') && n.tag !== 'textarea'
    return [{ kind: 'element', tag: n.tag, attrs, children: keep ? tidy(n.children) : [] }]
  })
}

/** Rows apart: the window without them, then the rows. */
function readOut(root: Element): string {
  const copy = tidy([root])
  // React's buttons say type="button"; the old window's said nothing, outside any form the same.
  addButtonTypes(copy)
  const lines = findAll(copy, el => hasClass(el, 'term-lines'))[0]
  const rows = lines ? lines.children : []
  if (lines) lines.children = []
  return `${canonical(copy)}\n--- rows\n${canonical(rows, { spaces: true })}`
}

const settle = async (world: FakeWorld) => {
  for (let i = 0; i < 6; i++) {
    await world.flush()
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** The world's globals, and the browser's own the terminal uses: EventSource, fetch, the clock. */
function install(world: FakeWorld, server: TermServer): () => void {
  world.install()
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const set = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  set(
    'EventSource',
    class extends FakeStream {
      constructor(url: string) {
        super(url)
        server.streams.push(this)
      }
    },
  )
  set('fetch', (url: unknown, init?: { body?: unknown }) => server.fetch(String(url), init))
  set('performance', { now: () => world.now })
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    world.uninstall()
  }
}

function baseSide(scene: TermScene, phone: boolean) {
  const world = new FakeWorld({ viewport: { w: 1280, h: 860 }, phone })
  const server = new TermServer()
  const uninstall = install(world, server)
  const toasts: string[] = []
  const log: string[] = []
  const t: Translator = translator(scene.lang)
  const toast = (text: string, error = false) => void toasts.push(`${error ? '!' : ''}${text}`)
  const item = (key: string) => scene.items.find(i => i.key === key)
  return { world, server, uninstall, toasts, log, t, toast, item }
}

/** Upstream's terminal.js at the terminal's merge, loaded fresh (its modules hold the world's globals). */
async function oldInit(): Promise<(deps: Record<string, unknown>) => Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-term-'))
  try {
    for (const file of OLD_FILES) writeFileSync(join(dir, file), oldSource(`web/${file}`, TERMINAL_MERGE))
    const mod: unknown = await import(pathToFileURL(join(dir, 'terminal.js')).href)
    const init = typeof mod === 'object' && mod !== null && 'initTerminal' in mod ? mod.initTerminal : null
    if (typeof init !== 'function') throw new Error('no initTerminal in upstream terminal.js')
    return deps => Reflect.apply(init, undefined, [deps])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const fnOf = (api: Record<string, unknown>, name: string) => {
  const fn = api[name]
  if (typeof fn !== 'function') throw new Error(`no ${name}`)
  return (...args: unknown[]) => Reflect.apply(fn, api, args)
}

/** The old window: initTerminal of upstream's terminal.js on a fake <body>. */
export async function oldTerminal(scene: TermScene, { phone = false } = {}): Promise<TermSide> {
  const base = baseSide(scene, phone)
  const { world, server, toasts, log } = base
  const init = await oldInit()
  const api = init({
    t: () => base.t,
    toast: base.toast,
    canMutate: () => scene.canMutate,
    item: base.item,
    token: () => scene.token,
    shells: () => scene.shells,
    wake: async (key: string) => void log.push(`wake ${key}`),
    focusAgent: (key: string) => void log.push(`focusAgent ${key}`),
    openUrl: (href: string) => void log.push(`openUrl ${href}`),
  })
  const root = world.body.children.filter((n): n is Element => n.kind === 'element').at(-1)
  if (!root) throw new Error('no terminal root')
  const el = (match: (e: Element) => boolean) => world.wrap(find([root], match))
  const input = el(e => hasClass(e, 'term-input'))
  return sideOf({
    world,
    server,
    scene,
    toasts,
    log,
    uninstall: base.uninstall,
    input,
    open: (key, target) => fnOf(api, 'open')(key, null, target),
    sync: () => fnOf(api, 'sync')(),
    isOpen: () => !!fnOf(api, 'isOpen')(),
    click: async what => {
      const found = findAll([root], clickMatch(what))[0]
      if (!found || unclickable([root], found)) return
      await world.fire(world.wrap(found), 'click')
    },
    after: () => {},
    read: () => readOut(root),
  })
}

/** The React window: the engine on fake elements, drawn by <TerminalView> from its view. */
export async function newTerminal(scene: TermScene, { phone = false } = {}): Promise<TermSide> {
  const base = baseSide(scene, phone)
  const { world, server, toasts, log, t } = base
  let engine: TerminalEngine | null = null
  const draw = () => {
    const view = engine?.view.get()
    if (!view) throw new Error('no engine')
    const key = view.key
    return reactMarkup(
      <I18nProvider lang={scene.lang}>
        <TerminalView
          view={view}
          item={key ? (base.item(key) ?? null) : null}
          canMutate={scene.canMutate}
          hasShell={!!key && scene.shells.includes(key)}
          coarse={false}
          narrow={phone}
        />
      </I18nProvider>,
    )
  }
  // The window's elements as React first drew them: the engine's rows and field live in these.
  const first = parseHtml(renderFirst(scene.lang, phone))
  const rootNode = first.find((n): n is Element => n.kind === 'element')
  if (!rootNode) throw new Error('no terminal root')
  world.mount(rootNode)
  const el = (match: (e: Element) => boolean): FakeElement => world.wrap(find([rootNode], match))
  // The fake DOM stands in for the browser's: the engine reads only what it has.
  const dom = <T,>(fake: unknown): T => fake as T
  const refs: TermRefs = {
    layer: { current: dom(el(e => hasClass(e, 'term'))) },
    win: { current: dom(el(e => hasClass(e, 'ql-win'))) },
    scrim: { current: dom(el(e => hasClass(e, 'ql-scrim'))) },
    screen: { current: dom(el(e => hasClass(e, 'term-screen'))) },
    scroller: { current: dom(el(e => hasClass(e, 'term-scroll'))) },
    lines: { current: dom(el(e => hasClass(e, 'term-lines'))) },
    input: { current: dom(el(e => hasClass(e, 'term-input'))) },
  }
  const focusScope = modalFocusManager(dom<FocusDocument>(world.document))(
    dom<FocusElement>(el(e => hasClass(e, 'term'))),
    dom<FocusElement>(el(e => hasClass(e, 'ql-win'))),
  )
  const made = terminalEngine({
    refs,
    focus: () => focusScope,
    api: terminalApi(() => t),
    t: () => t,
    toast: base.toast,
    canMutate: () => scene.canMutate,
    item: base.item,
    token: () => scene.token,
    shells: () => scene.shells,
    wake: async key => void log.push(`wake ${key}`),
    focusAgent: key => void log.push(`focusAgent ${key}`),
    openUrl: href => void log.push(`openUrl ${href}`),
    storage: {
      get: (key, fallback) => world.storage.get(key) ?? fallback,
      set: (key, value) => void world.storage.set(key, value),
    },
    coarse: () => false,
  })
  engine = made
  const unmount = made.mount()
  const lines = el(e => hasClass(e, 'term-lines'))
  const handlers: Record<string, () => void> = {
    close: made.clickClose,
    scrim: made.clickClose,
    'target-agent': () => made.pickTarget('agent'),
    'target-shell': () => made.pickTarget('shell'),
    herdr: () => void made.toHerdr(),
    'close-shell': () => void made.closeShell(),
    'paste-yes': () => made.settlePaste(true),
    'paste-no': () => made.settlePaste(false),
  }
  return sideOf({
    world,
    server,
    scene,
    toasts,
    log,
    uninstall: () => {
      unmount()
      made.stop()
      base.uninstall()
    },
    input: el(e => hasClass(e, 'term-input')),
    open: (key, target) => made.open(key, null, target),
    sync: () => made.boardChanged(),
    isOpen: made.isOpen,
    click: async what => {
      const drawn = draw()
      const found = findAll(drawn, clickMatch(what))[0]
      if (what === 'link') {
        // A link is a row's own: the engine drew it in the rows.
        const link = findAll([lines.node], clickMatch(what))[0]
        if (link) made.clickScreen({ target: world.wrap(link), preventDefault() {} })
        return
      }
      if (!found || unclickable(drawn, found)) return
      if (what === 'screen') made.clickScreen({ target: lines, preventDefault() {} })
      else if (what === 'state') made.stateDo(stateDoOf(found.attrs.get('data-do')))
      else if (what.startsWith('key:')) made.sendKey(what.slice(4))
      else handlers[what]?.()
    },
    // The layout effect after each draw: one that just opened grows.
    after: () => made.grow(),
    read: () => {
      const drawn = draw()
      const root = drawn.find((n): n is Element => n.kind === 'element')
      if (!root) throw new Error('nothing drawn')
      // The rows are the engine's: React leaves .term-lines to it.
      const own = findAll([root], e => hasClass(e, 'term-lines'))[0]
      if (own) own.children = lines.node.children
      return readOut(root)
    },
  })
}

const stateDoOf = (what: string | undefined): 'start' | 'retry' | 'wake' =>
  what === 'wake' ? 'wake' : what === 'retry' ? 'retry' : 'start'

/** The window as React draws it before anything opened (what the engine's refs point into). */
function renderFirst(lang: string, phone: boolean): string {
  const nodes = reactMarkup(
    <I18nProvider lang={lang}>
      <TerminalView
        view={{
          hidden: true,
          key: null,
          label: null,
          target: 'shell',
          status: 'idle',
          error: '',
          missing: false,
          typing: false,
          waitingSend: false,
          slowNote: false,
          armed: false,
          hasLines: false,
          paste: null,
        }}
        item={null}
        canMutate={false}
        hasShell={false}
        coarse={false}
        narrow={phone}
      />
    </I18nProvider>,
  )
  return nodes.map(n => serialize(n)).join('')
}

function serialize(n: Node): string {
  if (n.kind === 'text') return n.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('')
  return `<${n.tag}${attrs}>${n.children.map(serialize).join('')}</${n.tag}>`
}

interface SideParts {
  world: FakeWorld
  server: TermServer
  scene: TermScene
  toasts: string[]
  log: string[]
  uninstall(): void
  input: FakeElement
  open(key: string, target?: TermTarget): void
  sync(): void
  isOpen(): boolean
  click(what: Click): Promise<void>
  /** After a step: what React's layout effect does. */
  after(): void
  read(): string
}

/** The steps, the same for both sides; the browser's focus and blur events where it would send them. */
function sideOf(p: SideParts): TermSide {
  const { world, server, input } = p
  let focused = false
  const step = async () => {
    p.after()
    await settle(world)
    // The browser says when the field got or lost the focus; the fake one only moves it.
    for (let i = 0; i < 3; i++) {
      const now = world.document.activeElement === input
      if (now === focused) break
      focused = now
      await world.fire(input, now ? 'focus' : 'blur')
      p.after()
      await settle(world)
    }
  }
  const stream = (index?: number) => {
    const s = index === undefined ? server.streams.at(-1) : server.streams[index]
    if (!s) throw new Error('no stream')
    return s
  }
  return {
    world,
    server,
    scene: p.scene,
    toasts: p.toasts,
    log: p.log,
    async open(key, target) {
      p.open(key, target)
      await step()
    },
    async board(change) {
      Object.assign(p.scene, change)
      p.sync()
      await step()
    },
    async message(msg, index) {
      stream(index).onmessage?.({ data: JSON.stringify(msg) })
      await step()
    },
    async streamError(closed, index) {
      const s = stream(index)
      if (closed) s.readyState = 2
      s.onerror?.()
      await step()
    },
    async click(what) {
      await p.click(what)
      await step()
    },
    async key(fields) {
      const { code, ...rest } = fields
      await world.fire(input, 'keydown', { ...rest, extra: { code: code ?? '', getModifierState: () => false } })
      await step()
    },
    async windowKey(fields) {
      const { code, ...rest } = fields
      await world.fire(world.window, 'keydown', { ...rest, extra: { code: code ?? '' } })
      await step()
    },
    async input(inputType, data) {
      await world.fire(input, 'beforeinput', { extra: { inputType, data: data ?? null } })
      await step()
    },
    async paste(text) {
      await world.fire(input, 'paste', { extra: { clipboardData: { getData: () => text } } })
      await step()
    },
    async wait(ms) {
      for (let at = 0; at < ms; at += 16) await world.tick(16)
      await step()
    },
    snapshot: p.read,
    isOpen: p.isOpen,
    async dispose() {
      // The springs share one frame loop: none may be left waiting on this world's frames.
      try {
        await world.settle()
      } finally {
        p.uninstall()
      }
    },
  }
}
