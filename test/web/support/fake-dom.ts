// A small fake DOM over support/markup.ts trees, enough to run the side panel's motion code (the
// old web/panel.js and the React panel's engine) without a browser: elements whose attributes,
// classes, data and inline style write straight into the tree (so `canonical()` prints the page as
// that code left it), events with capture and bubbling, pointer capture, focus, and a clock that
// drives requestAnimationFrame and timers frame by frame. A world installs its globals while it
// runs and puts the old ones back after.
import { type Element as MElement, type Node as MNode, parseHtml, serializeNodes } from './markup.ts'

type Handler = (event: FakeEvent) => void
interface Listener {
  fn: Handler
  capture: boolean
}

const captureOf = (options: unknown): boolean =>
  options === true || (typeof options === 'object' && options !== null && 'capture' in options && !!options.capture)

export class FakeTarget {
  readonly listeners = new Map<string, Listener[]>()

  addEventListener(type: string, fn: Handler, options?: unknown): void {
    const list = this.listeners.get(type) ?? []
    const capture = captureOf(options)
    if (!list.some(l => l.fn === fn && l.capture === capture)) list.push({ fn, capture })
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: Handler, options?: unknown): void {
    const capture = captureOf(options)
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter(l => !(l.fn === fn && l.capture === capture)),
    )
  }

  /** Calls this target's listeners for one phase of `event`. */
  call(event: FakeEvent, phase: 'capture' | 'target' | 'bubble'): void {
    for (const l of [...(this.listeners.get(event.type) ?? [])]) {
      if (phase === 'capture' && !l.capture) continue
      if (phase === 'bubble' && l.capture) continue
      event.currentTarget = this
      l.fn(event)
      if (event.immediateStopped) return
    }
  }
}

export interface EventFields {
  clientX?: number
  clientY?: number
  pointerId?: number
  pointerType?: string
  button?: number
  key?: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isPrimary?: boolean
  /** An input method is composing (its own Enter and Esc). */
  isComposing?: boolean
  keyCode?: number
  /** focusout's: where the focus goes. */
  relatedTarget?: unknown
}

export class FakeEvent {
  currentTarget: unknown = null
  defaultPrevented = false
  stopped = false
  immediateStopped = false
  readonly clientX: number
  readonly clientY: number
  readonly pointerId: number
  readonly pointerType: string
  readonly button: number
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly isPrimary: boolean
  readonly isComposing: boolean
  readonly keyCode: number
  readonly relatedTarget: unknown

  constructor(
    readonly type: string,
    readonly target: unknown,
    readonly timeStamp: number,
    fields: EventFields,
    private readonly path: unknown[],
  ) {
    this.clientX = fields.clientX ?? 0
    this.clientY = fields.clientY ?? 0
    this.pointerId = fields.pointerId ?? 1
    this.pointerType = fields.pointerType ?? 'mouse'
    this.button = fields.button ?? 0
    this.key = fields.key ?? ''
    this.shiftKey = fields.shiftKey ?? false
    this.altKey = fields.altKey ?? false
    this.ctrlKey = fields.ctrlKey ?? false
    this.metaKey = fields.metaKey ?? false
    this.isPrimary = fields.isPrimary ?? true
    this.isComposing = fields.isComposing ?? false
    this.keyCode = fields.keyCode ?? 0
    this.relatedTarget = fields.relatedTarget ?? null
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }
  stopPropagation(): void {
    this.stopped = true
  }
  stopImmediatePropagation(): void {
    this.stopped = true
    this.immediateStopped = true
  }
  composedPath(): unknown[] {
    return [...this.path].reverse()
  }
}

// ---------------------------------------------------------------- selectors (simple ones, `:not(simple)`, descendants)

interface Simple {
  tag: string | null
  id: string | null
  classes: string[]
  attrs: { name: string; value: string | null }[]
  not: Simple[]
}

const SIMPLE = /(:not\([^)]*\)|[#.]?[\w-]+|\[[\w-]+(?:="[^"]*")?\])/g

function parseSimple(text: string): Simple {
  const simple: Simple = { tag: null, id: null, classes: [], attrs: [], not: [] }
  for (const [part] of text.trim().matchAll(SIMPLE)) {
    if (part.startsWith(':not(')) simple.not.push(parseSimple(part.slice(5, -1)))
    else if (part.startsWith('#')) simple.id = part.slice(1)
    else if (part.startsWith('.')) simple.classes.push(part.slice(1))
    else if (part.startsWith('[')) {
      const [name = '', value] = part.slice(1, -1).split('=')
      simple.attrs.push({ name, value: value === undefined ? null : value.slice(1, -1) })
    } else simple.tag = part.toLowerCase()
  }
  return simple
}

function matchesSimple(node: MElement, s: Simple): boolean {
  const classes = (node.attrs.get('class') ?? '').split(/\s+/)
  return (
    (s.tag === null || node.tag === s.tag) &&
    (s.id === null || node.attrs.get('id') === s.id) &&
    s.classes.every(c => classes.includes(c)) &&
    s.attrs.every(a => node.attrs.has(a.name) && (a.value === null || node.attrs.get(a.name) === a.value)) &&
    s.not.every(n => !matchesSimple(node, n))
  )
}

type ParentOf = (node: MElement) => MElement | undefined

/** `a b`: the last part on the node, each one before it on an ancestor further up. */
function matchesSelector(node: MElement, selector: string, parentOf: ParentOf): boolean {
  return selector.split(',').some(text => {
    const parts = text.trim().split(/\s+/).map(parseSimple)
    const last = parts.pop()
    if (!last || !matchesSimple(node, last)) return false
    let at = parentOf(node)
    for (const part of parts.reverse()) {
      while (at && !matchesSimple(at, part)) at = parentOf(at)
      if (!at) return false
      at = parentOf(at)
    }
    return true
  })
}

const textOf = (nodes: MNode[]): string => nodes.map(n => (n.kind === 'text' ? n.text : textOf(n.children))).join('')

/** A text node, for `lastChild` and the like. */
export class FakeText {
  constructor(readonly node: { kind: 'text'; text: string }) {}
  get textContent(): string {
    return this.node.text
  }
  set textContent(text: string) {
    this.node.text = text
  }
}

// ---------------------------------------------------------------- elements

const kebab = (name: string) => (name.startsWith('--') ? name : name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`))
const camelData = (attr: string) => attr.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
const dataAttr = (key: string) => `data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`

/** An inline style that writes through to the element's `style` attribute, in the order properties were set. */
function styleOf(node: MElement): Record<string, unknown> {
  const props = new Map<string, string>()
  for (const decl of (node.attrs.get('style') ?? '').split(';')) {
    const [name, ...value] = decl.split(':')
    if (name?.trim()) props.set(name.trim(), value.join(':').trim())
  }
  const write = () => {
    if (props.size) node.attrs.set('style', [...props].map(([k, v]) => `${k}: ${v}`).join('; '))
    else node.attrs.delete('style')
  }
  const set = (name: string, value: string) => {
    if (value === '') props.delete(name)
    else props.set(name, value)
    write()
  }
  const methods: Record<string, unknown> = {
    setProperty: (name: string, value: string) => set(name, String(value)),
    getPropertyValue: (name: string) => props.get(name) ?? '',
    removeProperty: (name: string) => set(name, ''),
  }
  return new Proxy(methods, {
    get: (target, key) =>
      typeof key === 'string' && !(key in target) ? (props.get(kebab(key)) ?? '') : target[String(key)],
    set: (_target, key, value) => {
      set(kebab(String(key)), String(value))
      return true
    },
  })
}

export interface RectBox {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  x: number
  y: number
}

export const box = (left: number, top: number, width: number, height: number): RectBox => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
})

export class FakeElement extends FakeTarget {
  readonly style: Record<string, unknown>
  readonly dataset: Record<string, string | undefined>
  readonly classList: {
    add(...names: string[]): void
    remove(...names: string[]): void
    contains(name: string): boolean
    toggle(name: string, force?: boolean): boolean
  }

  constructor(
    readonly world: FakeWorld,
    readonly node: MElement,
  ) {
    super()
    this.style = styleOf(node)
    const classes = () => (node.attrs.get('class') ?? '').split(/\s+/).filter(Boolean)
    const setClasses = (names: string[]) => node.attrs.set('class', names.join(' '))
    this.classList = {
      add: (...names) => setClasses([...classes(), ...names.filter(n => !classes().includes(n))]),
      remove: (...names) => setClasses(classes().filter(n => !names.includes(n))),
      contains: name => classes().includes(name),
      toggle: (name, force) => {
        const on = force ?? !classes().includes(name)
        if (on) setClasses([...classes().filter(n => n !== name), name])
        else setClasses(classes().filter(n => n !== name))
        return on
      },
    }
    this.dataset = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: (_t, key) => node.attrs.get(dataAttr(String(key))),
        set: (_t, key, value) => {
          node.attrs.set(dataAttr(String(key)), String(value))
          return true
        },
        deleteProperty: (_t, key) => {
          node.attrs.delete(dataAttr(String(key)))
          return true
        },
        ownKeys: () => [...node.attrs.keys()].filter(a => a.startsWith('data-')).map(camelData),
      },
    )
  }

  get tagName(): string {
    return this.node.tag.toUpperCase()
  }
  get id(): string {
    return this.node.attrs.get('id') ?? ''
  }
  set id(value: string) {
    this.node.attrs.set('id', value)
  }
  get className(): string {
    return this.node.attrs.get('class') ?? ''
  }
  set className(value: string) {
    this.node.attrs.set('class', value)
  }
  get hidden(): boolean {
    return this.node.attrs.has('hidden')
  }
  set hidden(on: boolean) {
    if (on) this.node.attrs.set('hidden', '')
    else this.node.attrs.delete('hidden')
  }
  get tabIndex(): number {
    const own = this.node.attrs.get('tabindex')
    return own === undefined ? (['button', 'a', 'input', 'textarea'].includes(this.node.tag) ? 0 : -1) : Number(own)
  }
  set tabIndex(value: number) {
    this.node.attrs.set('tabindex', String(value))
  }
  getAttribute(name: string): string | null {
    return this.node.attrs.get(name) ?? null
  }
  setAttribute(name: string, value: unknown): void {
    this.node.attrs.set(name, String(value))
  }
  removeAttribute(name: string): void {
    this.node.attrs.delete(name)
  }
  hasAttribute(name: string): boolean {
    return this.node.attrs.has(name)
  }
  get innerHTML(): string {
    return serializeNodes(this.node.children)
  }
  set innerHTML(html: string) {
    this.node.children = parseHtml(html)
    this.world.index(this.node)
  }
  get textContent(): string {
    return textOf(this.node.children)
  }
  set textContent(text: string) {
    this.node.children = text ? [{ kind: 'text', text }] : []
  }
  replaceChildren(): void {
    this.node.children = []
  }
  get firstElementChild(): FakeElement | null {
    const first = this.node.children.find(n => n.kind === 'element')
    return first?.kind === 'element' ? this.world.wrap(first) : null
  }
  get lastChild(): FakeElement | FakeText | null {
    const last = this.node.children.at(-1)
    if (!last) return null
    return last.kind === 'element' ? this.world.wrap(last) : new FakeText(last)
  }
  get title(): string {
    return this.node.attrs.get('title') ?? ''
  }
  set title(value: string) {
    this.node.attrs.set('title', value)
  }
  get disabled(): boolean {
    return this.node.attrs.has('disabled')
  }
  set disabled(on: boolean) {
    if (on) this.node.attrs.set('disabled', '')
    else this.node.attrs.delete('disabled')
  }
  /** A field's value, kept as its attribute (where React's server markup has it). */
  get value(): string {
    return this.node.attrs.get('value') ?? ''
  }
  set value(text: string) {
    this.node.attrs.set('value', String(text))
  }
  /** A checkbox's state, kept as its attribute. */
  get checked(): boolean {
    return this.node.attrs.has('checked')
  }
  set checked(on: boolean) {
    if (on) this.node.attrs.set('checked', '')
    else this.node.attrs.delete('checked')
  }
  /** A field's text selected. */
  select(): void {
    this.world.selected.push(this)
  }
  get readOnly(): boolean {
    return this.node.attrs.has('readonly')
  }
  set readOnly(on: boolean) {
    if (on) this.node.attrs.set('readonly', '')
    else this.node.attrs.delete('readonly')
  }
  readonly isContentEditable = false
  /** Takes the element out of where it is (as the DOM's append, prepend and after do before they insert). */
  private take(child: FakeElement): void {
    const parent = this.world.parents.get(child.node)
    if (parent) parent.children = parent.children.filter(n => n !== child.node)
  }
  private insert(at: number, children: FakeElement[]): void {
    for (const [i, child] of children.entries()) {
      this.take(child)
      this.node.children.splice(Math.min(at + i, this.node.children.length), 0, child.node)
      this.world.parents.set(child.node, this.node)
    }
  }
  append(...children: FakeElement[]): void {
    for (const child of children) this.insert(Number.MAX_SAFE_INTEGER, [child])
  }
  prepend(...children: FakeElement[]): void {
    this.insert(0, children)
  }
  after(...nodes: FakeElement[]): void {
    const parent = this.parentElement
    if (!parent) return
    for (const node of nodes) this.take(node)
    parent.insert(parent.node.children.indexOf(this.node) + 1, nodes)
  }
  remove(): void {
    this.take(this)
  }
  get children(): FakeElement[] {
    return this.node.children.filter((n): n is MElement => n.kind === 'element').map(n => this.world.wrap(n))
  }
  get nextElementSibling(): FakeElement | null {
    const parent = this.world.parents.get(this.node)
    if (!parent) return null
    const siblings = parent.children.filter((n): n is MElement => n.kind === 'element')
    const next = siblings[siblings.indexOf(this.node) + 1]
    return next ? this.world.wrap(next) : null
  }
  get parentElement(): FakeElement | null {
    const parent = this.world.parents.get(this.node)
    return parent ? this.world.wrap(parent) : null
  }
  /** In the page: each one up is still among its parent's children (innerHTML drops the old ones). */
  get isConnected(): boolean {
    let node: MElement | undefined = this.node
    while (node && node !== this.world.html) {
      const parent: MElement | undefined = this.world.parents.get(node)
      if (!parent?.children.includes(node)) return false
      node = parent
    }
    return node === this.world.html
  }
  matches(selector: string): boolean {
    return matchesSelector(this.node, selector, n => this.world.parents.get(n))
  }
  closest(selector: string): FakeElement | null {
    for (let el: FakeElement | null = this; el; el = el.parentElement) if (el.matches(selector)) return el
    return null
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = []
    const walk = (nodes: MNode[]) => {
      for (const n of nodes) {
        if (n.kind !== 'element') continue
        if (matchesSelector(n, selector, p => this.world.parents.get(p))) found.push(this.world.wrap(n))
        walk(n.children)
      }
    }
    walk(this.node.children)
    return found
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  contains(other: unknown): boolean {
    for (let el = other instanceof FakeElement ? other : null; el; el = el.parentElement) if (el === this) return true
    return false
  }
  setPointerCapture(id: number): void {
    this.world.captures.set(id, this)
  }
  releasePointerCapture(id: number): void {
    if (this.world.captures.get(id) === this) this.world.captures.delete(id)
  }
  hasPointerCapture(id: number): boolean {
    return this.world.captures.get(id) === this
  }
  getBoundingClientRect(): RectBox {
    return this.world.rectOf(this)
  }
  getClientRects(): RectBox[] {
    return [this.getBoundingClientRect()]
  }
  get offsetWidth(): number {
    return this.getBoundingClientRect().width
  }
  get offsetHeight(): number {
    return this.getBoundingClientRect().height
  }
  scrollIntoView(options?: unknown): void {
    this.world.intoView.push({ el: this, options })
  }
  /** <html>'s is the window without its scrollbar. */
  get clientWidth(): number {
    return this.node === this.world.html ? this.world.viewport.w : this.getBoundingClientRect().width
  }
  get clientHeight(): number {
    return this.node === this.world.html ? this.world.viewport.h : this.getBoundingClientRect().height
  }
  /** A click by code (`button.click()`): the event goes through the page at once. */
  click(): void {
    void this.world.fire(this, 'click')
  }
  focus(): void {
    this.world.document.activeElement = this
  }
  blur(): void {
    if (this.world.document.activeElement === this) this.world.document.activeElement = this.world.document.body
  }
  animate(keyframes: unknown, options: unknown): void {
    this.world.animations.push({ el: this, keyframes, options })
  }
}

export class FakeDocument extends FakeTarget {
  activeElement: FakeElement | null = null
  constructor(private readonly world: FakeWorld) {
    super()
  }
  get documentElement(): FakeElement {
    return this.world.wrap(this.world.html)
  }
  get body(): FakeElement {
    return this.world.wrap(this.world.body)
  }
  createElement(tag: string): FakeElement {
    return this.world.wrap({ kind: 'element', tag, attrs: new Map(), children: [] })
  }
  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector)
  }
  getElementById(id: string): FakeElement | null {
    return this.documentElement.querySelectorAll('*').find(el => el.id === id) ?? null
  }
}

class FakeMediaQuery extends FakeTarget {
  constructor(public matches: boolean) {
    super()
  }
}

// ---------------------------------------------------------------- the world

export interface FakeSelection {
  isCollapsed: boolean
  rangeCount: number
  getRangeAt(index: number): { intersectsNode(node: unknown): boolean }
  removeAllRanges(): void
}

export interface WorldOptions {
  viewport: { w: number; h: number }
  phone?: boolean
  dpr?: number
  /** Element rectangles (the panel's own come from its inline style). */
  rects?: (el: FakeElement) => RectBox | null
  /** getComputedStyle(el): the stylesheet's values the code reads (paddings); none by default. */
  computed?: (el: FakeElement) => Record<string, string>
}

const GLOBALS = [
  'document',
  'window',
  'Node',
  'Element',
  'HTMLElement',
  'addEventListener',
  'removeEventListener',
  'matchMedia',
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'localStorage',
  'devicePixelRatio',
  'getSelection',
  'scrollBy',
  'getComputedStyle',
  'CSS',
] as const

export class FakeWorld {
  readonly parents = new WeakMap<MElement, MElement>()
  private readonly wrapped = new WeakMap<MElement, FakeElement>()
  readonly html: MElement = { kind: 'element', tag: 'html', attrs: new Map(), children: [] }
  readonly body: MElement = { kind: 'element', tag: 'body', attrs: new Map(), children: [] }
  readonly document: FakeDocument
  readonly window = new FakeTarget()
  readonly captures = new Map<number, FakeElement>()
  readonly animations: { el: FakeElement; keyframes: unknown; options: unknown }[] = []
  readonly scrolls: [number, number][] = []
  readonly intoView: { el: FakeElement; options: unknown }[] = []
  /** Fields whose text was selected (select()), in order. */
  readonly selected: FakeElement[] = []
  /** What getSelection() gives: nothing selected unless a test says. */
  selection: FakeSelection = {
    isCollapsed: true,
    rangeCount: 0,
    getRangeAt: () => ({ intersectsNode: () => false }),
    removeAllRanges() {},
  }
  readonly storage = new Map<string, string>()
  readonly phone: FakeMediaQuery
  viewport: { w: number; h: number }
  now = 1000
  /** After every event and frame, once its microtasks ran (where React would have drawn). */
  afterFlush: (() => void) | null = null
  private frames = new Map<number, (t: number) => void>()
  private timers = new Map<number, { at: number; fn: () => void }>()
  private lastId = 0
  private saved = new Map<string, PropertyDescriptor | undefined>()

  constructor(private readonly options: WorldOptions) {
    this.viewport = options.viewport
    this.phone = new FakeMediaQuery(options.phone ?? false)
    this.html.children.push(this.body)
    this.parents.set(this.body, this.html)
    this.document = new FakeDocument(this)
    this.document.activeElement = this.document.body
  }

  wrap(node: MElement): FakeElement {
    let el = this.wrapped.get(node)
    if (!el) {
      el = new FakeElement(this, node)
      this.wrapped.set(node, el)
    }
    return el
  }

  /** Records the parents of a subtree, so `closest` and `contains` can walk up it. */
  index(node: MElement): void {
    for (const child of node.children) {
      if (child.kind !== 'element') continue
      this.parents.set(child, node)
      this.index(child)
    }
  }

  /** Puts a parsed subtree into <body>. */
  mount(node: MElement): FakeElement {
    this.index(node)
    this.wrap(this.body).append(this.wrap(node))
    return this.wrap(node)
  }

  rectOf(el: FakeElement): RectBox {
    const own = this.options.rects?.(el)
    if (own) return own
    // A panel or preview placed by its inline style: translate3d(x, y, 0), width, height.
    const transform = String(el.style.transform ?? '')
    const m = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px/.exec(transform)
    const width = Number.parseFloat(String(el.style.width ?? '')) || 0
    const height = Number.parseFloat(String(el.style.height ?? '')) || 0
    return box(m ? Number(m[1]) : 0, m ? Number(m[2]) : 0, width, height)
  }

  private globals(): Record<(typeof GLOBALS)[number], unknown> {
    return {
      document: this.document,
      window: this.window,
      Node: FakeElement,
      Element: FakeElement,
      HTMLElement: FakeElement,
      addEventListener: (type: string, fn: Handler, options?: unknown) =>
        this.window.addEventListener(type, fn, options),
      removeEventListener: (type: string, fn: Handler, options?: unknown) =>
        this.window.removeEventListener(type, fn, options),
      matchMedia: (query: string) => (query === '(max-width: 760px)' ? this.phone : new FakeMediaQuery(false)),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      requestAnimationFrame: (fn: (t: number) => void) => {
        const id = ++this.lastId
        this.frames.set(id, fn)
        return id
      },
      cancelAnimationFrame: (id: number) => this.frames.delete(id),
      setTimeout: (fn: () => void, ms = 0) => {
        const id = ++this.lastId
        this.timers.set(id, { at: this.now + ms, fn })
        return id
      },
      clearTimeout: (id: number | undefined) => {
        if (id !== undefined) this.timers.delete(id)
      },
      localStorage: {
        getItem: (key: string) => this.storage.get(key) ?? null,
        setItem: (key: string, value: string) => this.storage.set(key, String(value)),
        removeItem: (key: string) => this.storage.delete(key),
      },
      devicePixelRatio: this.options.dpr ?? 1,
      getSelection: () => this.selection,
      scrollBy: (x: number, y: number) => this.scrolls.push([x, y]),
      getComputedStyle: (el: FakeElement) => ({
        paddingTop: '0px',
        paddingBottom: '0px',
        ...this.options.computed?.(el),
      }),
      // Selectors here quote what they escape: only quotes and backslashes need it.
      CSS: { escape: (s: string) => String(s).replace(/["\\]/g, c => `\\${c}`) },
    }
  }

  install(): void {
    for (const [name, value] of Object.entries(this.globals())) {
      this.saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    }
  }

  uninstall(): void {
    for (const [name, descriptor] of this.saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    this.saved.clear()
  }

  /** Lets queued microtasks (the room's queueMicrotask) run, as the browser does after every event. */
  async flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    this.afterFlush?.()
  }

  /** `ms` later: timers due, then one animation frame. */
  async tick(ms = 16): Promise<void> {
    this.now += ms
    let fired = false
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.now) continue
      this.timers.delete(id)
      timer.fn()
      fired = true
    }
    // A timer's microtasks run before the frame, as in the browser (React draws what it changed).
    if (fired) await this.flush()
    const frames = [...this.frames.values()]
    this.frames.clear()
    for (const fn of frames) fn(this.now)
    await this.flush()
  }

  get animating(): boolean {
    return this.frames.size > 0
  }

  /** Frames until nothing moves. */
  async settle(limit = 2000): Promise<void> {
    for (let i = 0; this.animating; i++) {
      if (i > limit) throw new Error('still moving')
      await this.tick()
    }
  }

  /** Dispatches an event on `target` (an element, the document or the window), capturing down and bubbling up. */
  async fire(
    target: FakeElement | FakeDocument | FakeTarget,
    type: string,
    fields: EventFields = {},
  ): Promise<FakeEvent> {
    // Window, document, the element's ancestors and the element; a media query is on its own.
    const path: FakeTarget[] = [this.window]
    if (target instanceof FakeElement) {
      const chain: FakeTarget[] = []
      for (let el: FakeElement | null = target; el; el = el.parentElement) chain.unshift(el)
      if (target.isConnected) path.push(this.document)
      else path.length = 0
      path.push(...chain)
    } else if (target === this.document) path.push(this.document)
    else if (target !== this.window) path.splice(0, 1, target)
    const event = new FakeEvent(type, target, this.now, fields, path)
    const at = path.length - 1
    for (let i = 0; i < at && !event.stopped; i++) path[i]?.call(event, 'capture')
    if (!event.stopped) {
      path[at]?.call(event, 'capture')
      if (!event.immediateStopped) path[at]?.call(event, 'bubble')
    }
    for (let i = at - 1; i >= 0 && !event.stopped; i--) path[i]?.call(event, 'bubble')
    await this.flush()
    return event
  }

  /** A pointer event where the pointer is, or to the element that captured it. */
  async pointer(type: string, at: FakeElement, fields: EventFields): Promise<FakeEvent> {
    const id = fields.pointerId ?? 1
    const event = await this.fire(this.captures.get(id) ?? at, type, fields)
    if (type === 'pointerup' || type === 'pointercancel') this.captures.delete(id)
    return event
  }
}
