// A small DOM that react-dom/client renders into, for a component whose effects matter (the
// markup-parity tests render on the server, where no effect runs; support/fake-dom.ts is for the
// old page's markup trees). Nodes with children, attributes and inline styles, innerHTML parsed
// into nodes (support/markup.ts), events that go down and bubble up, focus. What layout gives
// (scrollHeight, the window's height) is the test's to say.
import { type Node as MNode, parseHtml } from './markup.ts'

type Listener = { fn: (event: MiniEvent) => void; capture: boolean }

export class MiniEvent {
  target: MiniTarget | null = null
  currentTarget: MiniTarget | null = null
  eventPhase = 0
  defaultPrevented = false
  stopped = false
  readonly timeStamp = Date.now()
  readonly isTrusted = true
  constructor(
    readonly type: string,
    readonly bubbles = true,
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true
  }
  stopPropagation(): void {
    this.stopped = true
  }
}

export class MiniTarget {
  private readonly listeners = new Map<string, Listener[]>()
  parentNode: MiniNode | null = null

  addEventListener(type: string, fn: (event: MiniEvent) => void, options?: unknown): void {
    const capture = options === true || (typeof options === 'object' && !!(options as { capture?: boolean })?.capture)
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, capture }])
  }

  removeEventListener(type: string, fn: (event: MiniEvent) => void, options?: unknown): void {
    const capture = options === true || (typeof options === 'object' && !!(options as { capture?: boolean })?.capture)
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(l => l.fn !== fn || l.capture !== capture),
    )
  }

  /** Down from the top with capture listeners, then up from here if it bubbles. */
  dispatchEvent(event: MiniEvent): boolean {
    const path: MiniTarget[] = []
    for (let at: MiniTarget | null = this; at; at = at.parentNode) path.push(at)
    event.target = this
    const call = (at: MiniTarget, capture: boolean) => {
      event.currentTarget = at
      for (const l of [...(at.listeners.get(event.type) ?? [])]) if (l.capture === capture) l.fn(event)
    }
    for (const at of [...path].reverse()) if (!event.stopped) call(at, true)
    for (const at of event.bubbles ? path : [this]) if (!event.stopped) call(at, false)
    return !event.defaultPrevented
  }
}

export class MiniNode extends MiniTarget {
  childNodes: MiniNode[] = []
  constructor(
    readonly ownerDocument: MiniDocument | null,
    readonly nodeType: number,
    readonly nodeName: string,
  ) {
    super()
  }
  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null
  }
  get lastChild(): MiniNode | null {
    return this.childNodes.at(-1) ?? null
  }
  get nextSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }
  get parentElement(): MiniElement | null {
    return this.parentNode instanceof MiniElement ? this.parentNode : null
  }
  get textContent(): string {
    return this.childNodes.map(c => c.textContent).join('')
  }
  set textContent(text: string) {
    this.replace(text ? [new MiniText(this.ownerDocument, text)] : [])
  }
  appendChild<T extends MiniNode>(child: T): T {
    return this.insertBefore(child, null)
  }
  insertBefore<T extends MiniNode>(child: T, before: MiniNode | null): T {
    child.parentNode?.removeChild(child)
    const at = before ? this.childNodes.indexOf(before) : -1
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child)
    child.parentNode = this
    return child
  }
  removeChild<T extends MiniNode>(child: T): T {
    this.childNodes = this.childNodes.filter(c => c !== child)
    child.parentNode = null
    return child
  }
  contains(other: MiniNode | null): boolean {
    for (let at = other; at; at = at.parentNode) if (at === this) return true
    return false
  }
  protected replace(children: MiniNode[]): void {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    for (const c of children) this.appendChild(c)
  }
}

export class MiniText extends MiniNode {
  constructor(
    doc: MiniDocument | null,
    public nodeValue: string,
  ) {
    super(doc, 3, '#text')
  }
  override get textContent(): string {
    return this.nodeValue
  }
  override set textContent(text: string) {
    this.nodeValue = text
  }
}

/** What layout says of an element: the test sets it. */
export const layout = { scrollHeight: (_el: MiniElement): number => 0 }

export class MiniElement extends MiniNode {
  readonly attributes = new Map<string, string>()
  readonly style: Record<string, string> = {}
  readonly tagName: string
  readonly localName: string
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  constructor(doc: MiniDocument | null, tag: string) {
    super(doc, 1, tag.toUpperCase())
    this.tagName = tag.toUpperCase()
    this.localName = tag
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value))
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }
  get id(): string {
    return this.getAttribute('id') ?? ''
  }
  get className(): string {
    return this.getAttribute('class') ?? ''
  }
  /** Read back as its text only. */
  get innerHTML(): string {
    return this.textContent
  }
  set innerHTML(html: string) {
    this.replace(parseHtml(html).map(n => fromMarkup(this.ownerDocument, n)))
  }
  get scrollHeight(): number {
    return layout.scrollHeight(this)
  }
  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }
  blur(): void {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body
  }
  scrollIntoView(): void {}
  /** The elements under it that match one of `selector`'s parts: `tag`, `[attr]` or `tag[attr]`. */
  querySelectorAll(selector: string): MiniElement[] {
    const parts = selector.split(',').map(s => /^\s*([a-z]*)(?:\[([a-z-]+)\])?\s*$/.exec(s))
    const out: MiniElement[] = []
    const walk = (node: MiniNode) => {
      for (const c of node.childNodes) {
        if (!(c instanceof MiniElement)) continue
        if (parts.some(m => m && (!m[1] || m[1] === c.localName) && (!m[2] || c.hasAttribute(m[2])))) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
}

function fromMarkup(doc: MiniDocument | null, node: MNode): MiniNode {
  if (node.kind === 'text') return new MiniText(doc, node.text)
  const el = new MiniElement(doc, node.tag)
  for (const [name, value] of node.attrs) el.setAttribute(name, value)
  for (const child of node.children) el.appendChild(fromMarkup(doc, child))
  return el
}

export class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement
  readonly body: MiniElement
  activeElement: MiniElement
  defaultView: unknown = null
  constructor() {
    super(null, 9, '#document')
    this.documentElement = this.appendChild(new MiniElement(this, 'html'))
    this.body = this.documentElement.appendChild(new MiniElement(this, 'body'))
    this.activeElement = this.body
  }
  createElement(tag: string): MiniElement {
    return new MiniElement(this, tag)
  }
  createElementNS(_ns: string, tag: string): MiniElement {
    return new MiniElement(this, tag)
  }
  createTextNode(text: string): MiniText {
    return new MiniText(this, text)
  }
}

/** A window over a fresh document, `innerHeight` px tall, installed as the globals until `uninstall`. */
export function miniWindow(innerHeight: number) {
  const document = new MiniDocument()
  const win = Object.assign(new MiniTarget(), {
    document,
    innerHeight,
    event: undefined,
    HTMLIFrameElement: class {},
  })
  document.defaultView = win
  const saved = { window: Reflect.get(globalThis, 'window'), document: Reflect.get(globalThis, 'document') }
  Reflect.set(globalThis, 'window', win)
  Reflect.set(globalThis, 'document', document)
  return {
    window: win,
    document,
    /** The window becomes `height` px tall. */
    resize(height: number) {
      win.innerHeight = height
      win.dispatchEvent(new MiniEvent('resize', false))
    },
    uninstall() {
      Reflect.set(globalThis, 'window', saved.window)
      Reflect.set(globalThis, 'document', saved.document)
    },
  }
}
