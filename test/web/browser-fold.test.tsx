// An agent's own browser in the session panel (components/sheet/BrowserFold.tsx, hooks/useDesktop.ts),
// drawn by react-dom into a small DOM (support/mini-dom.ts) so its effects run, with a fake
// WebSocket and the board's answers to its POSTs: the display's socket is open only while the fold
// is, full size comes and goes on the same socket (Esc, ×), nothing goes to the display until
// "Take control", and control is given back with the view. A session without a running browser
// has no fold.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { constants, deflateSync, inflateSync } from 'node:zlib'
import type { ReactNode } from 'react'
import { videoMessage } from '../../src/core/desktop-video.ts'
import type { Item, ItemDesktop } from '../../src/core/types.ts'
import type { PanelPlace as Place } from '../../web/src/components/panel/place.ts'
import type { BrowserFold as Fold } from '../../web/src/components/sheet/BrowserFold.tsx'
import type { useBrowserFold as UseBrowserFold } from '../../web/src/components/sheet/Sheet.tsx'
import type { listenClickAway as ClickAway } from '../../web/src/hooks/usePanelClickAway.ts'
import type { I18nProvider as Provider } from '../../web/src/i18n/I18nProvider.tsx'
import type { Board } from '../../web/src/state/BoardProvider.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { layout, MiniElement, MiniEvent, type MiniNode, miniWindow } from './support/mini-dom.ts'

/** The page's WebSocket, as the fold uses it. */
class FakeSocket {
  static made: FakeSocket[] = []
  binaryType = 'blob'
  readyState = 1
  closed = false
  sent: number[][] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e?: { code: number; reason: string }) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.made.push(this)
  }
  send(bytes: Uint8Array): void {
    this.sent.push([...bytes])
  }
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  /** Bytes from the display, and what they change drawn. */
  serve(...parts: (string | number[])[]): void {
    flush(() => {
      for (const part of parts) {
        const bytes = typeof part === 'string' ? new TextEncoder().encode(part) : Uint8Array.from(part)
        this.onmessage?.({ data: bytes.buffer })
      }
    })
  }
}

type Dom = ReturnType<typeof miniWindow>
let dom: Dom
let draw: (node: ReactNode) => void
let flush: (fn: () => void) => void
let root: { unmount(): void }
let newRoot: () => void
let BrowserFold: typeof Fold
let I18nProvider: typeof Provider
let BoardContext: React.Context<Board | null>
let boardOf: (fields: Partial<Board>) => Board
let itemOf: (fields: Partial<Item> & Pick<Item, 'key'>) => Item
let useState: typeof import('react').useState
let PanelPlace: typeof Place
let listenClickAway: typeof ClickAway
let useBrowserFold: typeof UseBrowserFold
/** What the touch keyboard's field is kept at, and how long a finger is held to press (hooks/useDesktop.ts). */
let KEYS_AT = ''
let HOLD_MS = 500
let PASTE_SETTLE_MS = 600
const saved = { WebSocket: globalThis.WebSocket, location: Reflect.get(globalThis, 'location') }

beforeAll(async () => {
  dom = miniWindow(800)
  Reflect.set(globalThis, 'WebSocket', FakeSocket)
  Reflect.set(globalThis, 'location', { protocol: 'http:', host: 'board.test' })
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  ;({ useState } = await import('react'))
  ;({ BrowserFold } = await import('../../web/src/components/sheet/BrowserFold.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ PanelPlace } = await import('../../web/src/components/panel/place.ts'))
  ;({ listenClickAway } = await import('../../web/src/hooks/usePanelClickAway.ts'))
  ;({ useBrowserFold } = await import('../../web/src/components/sheet/Sheet.tsx'))
  KEYS_AT = Reflect.get(await import('../../web/src/hooks/useDesktop.ts'), 'KEYS_AT') ?? ''
  HOLD_MS = Reflect.get(await import('../../web/src/hooks/useDesktop.ts'), 'HOLD_MS') ?? 500
  PASTE_SETTLE_MS = Reflect.get(await import('../../web/src/models/desk-input.ts'), 'PASTE_SETTLE_MS') ?? 600
  const support = await import('./support/board.tsx')
  boardOf = fields => support.board({ data: support.payload({ fsToken: 'tok' }), ...fields })
  itemOf = support.item
  flush = flushSync
  newRoot = () => {
    const container = dom.document.body.appendChild(dom.document.createElement('div'))
    const r = createRoot(container as unknown as HTMLElement)
    root = r
    draw = node => flushSync(() => r.render(node))
  }
})

beforeEach(() => newRoot())

afterEach(() => {
  layout.rect = () => ({ left: 0, top: 0, width: 0, height: 0 })
  flush(() => root.unmount())
  for (const c of [...dom.document.body.childNodes]) dom.document.body.removeChild(c)
  restoreFetch()
  FakeSocket.made = []
})

afterAll(async () => {
  await new Promise(done => setTimeout(done, 20))
  dom.uninstall()
  Reflect.set(globalThis, 'WebSocket', saved.WebSocket)
  Reflect.set(globalThis, 'location', saved.location)
})

const KEY = 'a b%'
const desktop = (fields: Partial<ItemDesktop> = {}): ItemDesktop => ({
  running: true,
  profile: null,
  control: 'agent',
  asks: false,
  ...fields,
})
const toasts: string[] = []

/** The fold in the panel as the sheet has it: its own open state; `shown`: the panel is open. */
function Harness({
  item,
  shown,
  initial,
  askedAbove,
  reveal,
}: {
  item: Item
  shown: boolean
  initial: boolean
  askedAbove?: boolean | undefined
  reveal?: number | undefined
}) {
  const [open, setOpen] = useState(initial)
  return <BrowserFold item={item} open={open && shown} onOpen={setOpen} askedAbove={askedAbove} reveal={reveal} />
}

function render(
  fields: {
    desktop?: ItemDesktop
    shown?: boolean
    open?: boolean
    question?: string
    lang?: string
    askedAbove?: boolean
    reveal?: number
  } = {},
) {
  const item = itemOf({
    key: KEY,
    name: 'Alpha',
    ...(fields.desktop && { desktop: fields.desktop }),
    ...(fields.question && { question: fields.question }),
  })
  const value = boardOf({ toast: text => toasts.push(text) })
  // Rendered again in a test, the same fold takes the new fields.
  draw(
    <I18nProvider lang={fields.lang ?? 'en'}>
      <BoardContext.Provider value={value}>
        <Harness
          item={item}
          shown={fields.shown ?? true}
          initial={fields.open ?? false}
          askedAbove={fields.askedAbove}
          reveal={fields.reveal}
        />
      </BoardContext.Provider>
    </I18nProvider>,
  )
}

const all = (node: MiniNode): MiniElement[] =>
  node.childNodes.flatMap(c => (c instanceof MiniElement ? [c, ...all(c)] : []))
const find = (match: (el: MiniElement) => boolean, under: MiniNode = dom.document.body) => all(under).find(match)
const desk = (name: string, under?: MiniNode) => find(el => el.getAttribute('data-desk') === name, under)
const byClass = (name: string) => find(el => el.className.split(' ').includes(name))
const canvas = () => find(el => el.localName === 'canvas')
const click = (el: MiniElement | undefined) => {
  if (!el) throw new Error('nothing to click')
  flush(() => el.dispatchEvent(new MiniEvent('click')))
}
const key = (el: MiniNode | undefined, fields: Record<string, unknown>, type = 'keydown') => {
  const e = Object.assign(new MiniEvent(type), fields)
  flush(() => (el as MiniElement).dispatchEvent(e))
  return e
}
const settle = () => new Promise(done => setTimeout(done, 15))
/** The next frame (the test's page draws none: a moment), when the moves and wheel steps that wait go (models/desk-input.ts InputQueue). */
const frame = () => new Promise(done => setTimeout(done, 25))
const within = (el: MiniNode | undefined, parent: MiniNode | undefined) => !!el && !!parent?.contains(el)

/** The display's hello: RFB 3.8, no password, a 4 × 2 screen (or `width` × `height`). */
function handshake(socket: FakeSocket | undefined, width = 4, height = 2) {
  if (!socket) throw new Error('no socket')
  const size = [width >> 8, width & 255, height >> 8, height & 255]
  socket.serve('RFB 003.008\n', [1, 1], [0, 0, 0, 0], [...size, ...new Array(16).fill(0), 0, 0, 0, 1, 120])
  socket.sent.length = 0
}

test('no running browser: no fold and no socket', () => {
  render()
  expect(all(dom.document.body).filter(el => el.localName === 'section')).toEqual([])
  render({ desktop: desktop({ running: false }), open: true })
  expect(desk('fold')).toBeUndefined()
  expect(FakeSocket.made).toEqual([])
})

test('the socket is open only while the fold is: folded, by ×, and with the panel closed', () => {
  render({ desktop: desktop({ profile: 'github' }) })
  const fold = desk('fold')
  expect(fold?.getAttribute('aria-expanded')).toBe('false')
  expect(fold?.textContent).toBe('Browsergithub')
  expect(FakeSocket.made).toEqual([])
  expect(canvas()).toBeUndefined()

  click(fold)
  expect(FakeSocket.made).toHaveLength(1)
  const [first] = FakeSocket.made
  expect(first?.url).toBe('ws://board.test/api/desktop/a%20b%25/vnc?t=tok')
  expect(first?.binaryType).toBe('arraybuffer')
  expect(within(canvas(), byClass('desk-host'))).toBe(true)
  expect(byClass('desk-status')?.textContent).toBe('Connecting to its browser…')
  handshake(first)
  expect(byClass('desk-status')).toBeUndefined()
  // Only the picture is asked for.
  first?.serve([0, 0, 0, 0])
  expect(first?.sent).toEqual([[3, 1, 0, 0, 0, 0, 0, 4, 0, 2]])

  click(desk('close'))
  expect(first?.closed).toBe(true)
  expect(canvas()).toBeUndefined()
  expect(desk('fold')?.getAttribute('aria-expanded')).toBe('false')

  // The fold opened again: a new socket; the panel closed: it closes.
  click(desk('fold'))
  expect(FakeSocket.made).toHaveLength(2)
  render({ desktop: desktop(), shown: false })
  expect(FakeSocket.made[1]?.closed).toBe(true)
  expect(FakeSocket.made).toHaveLength(2)
})

test('what the agent asks the owner to do there: at its browser folded, open and full size, in both languages, while it asks', () => {
  const ask = 'Sign in to GitHub as acme-bot'
  const asks = (under: MiniNode = dom.document.body) =>
    all(under)
      .filter(el => el.className === 'desk-asks')
      .map(el => el.textContent)
  render({ desktop: desktop({ ask }) })
  expect(asks()).toEqual([`The agent asks you: ${ask}`])
  expect(byClass('desk-asks')?.getAttribute('role')).toBe('status')
  click(desk('fold'))
  expect(asks()).toEqual([`The agent asks you: ${ask}`])
  click(desk('full'))
  expect(asks(byClass('desk-full'))).toEqual([`The agent asks you: ${ask}`])
  // asked no more: gone, and the card's question is not the browser's
  render({ desktop: desktop(), question: 'Which branch?' })
  expect(asks()).toEqual([])
  // a board before the field: the card's question while the card asks for the browser
  render({ desktop: desktop({ asks: true }), question: ask })
  expect(asks(byClass('desk-full'))).toEqual([`The agent asks you: ${ask}`])
  // in Russian
  flush(() => root.unmount())
  newRoot()
  render({ desktop: desktop({ ask }), lang: 'ru' })
  expect(asks()).toEqual([`Агент просит вас: ${ask}`])
})

test('the panel’s "needs you" saying the ask already: the fold does not, folded or open; full size still does; asked to, it comes into view', () => {
  const ask = 'Sign in to GitHub as acme-bot'
  const asks = (under: MiniNode = dom.document.body) => all(under).filter(el => el.className === 'desk-asks').length
  const seen: unknown[] = []
  const was = MiniElement.prototype.scrollIntoView
  MiniElement.prototype.scrollIntoView = function (this: MiniElement, options?: unknown) {
    seen.push([this.localName, this.className, options])
  }
  try {
    render({ desktop: desktop({ asks: true, ask }), askedAbove: true })
    expect(asks()).toBe(0)
    click(desk('fold'))
    expect(asks()).toBe(0)
    click(desk('full'))
    expect(asks(byClass('desk-full'))).toBe(1)
    expect(asks()).toBe(1)
    // not asked to come into view yet; then asked: the fold's section, nearest
    expect(seen).toEqual([])
    render({ desktop: desktop({ asks: true, ask }), askedAbove: true, reveal: 1 })
    expect(seen).toEqual([['section', 'desk open', { block: 'nearest', behavior: 'smooth' }]])
    // without the panel's block (a form in its place): the fold says it, as before
    render({ desktop: desktop({ asks: true, ask }), askedAbove: false, reveal: 1 })
    expect(asks()).toBe(2)
    expect(seen).toHaveLength(1)
  } finally {
    MiniElement.prototype.scrollIntoView = was
  }
})

test('it says why it could not show, and tries again', () => {
  render({ desktop: desktop(), open: true })
  const [first] = FakeSocket.made
  flush(() => first?.onclose?.())
  expect(byClass('desk-status')?.textContent).toBe('Its browser did not answerRetry')
  click(desk('retry'))
  expect(first?.closed).toBe(true)
  expect(FakeSocket.made).toHaveLength(2)
  // A server that asks for a password.
  FakeSocket.made[1]?.serve('RFB 003.008\n', [1, 2])
  expect(byClass('desk-status')?.textContent).toBe('Could not show its browser: its display asks for a passwordRetry')
  expect(FakeSocket.made[1]?.closed).toBe(true)
})

test('only watched until Take control; then keys and pastes go to it, with the warning; Give back stops them', async () => {
  render({ desktop: desktop(), open: true })
  const [socket] = FakeSocket.made
  handshake(socket)
  const typed = key(canvas(), { key: 'a', code: 'KeyA' })
  expect(socket?.sent).toEqual([])
  expect(typed.defaultPrevented).toBe(false)
  expect(byClass('desk-who')?.textContent).toBe('The agent has control')
  expect(byClass('desk-warn')).toBeUndefined()

  const calls = answers([200, { ok: true, control: 'owner' }], [200, { ok: true, control: 'agent' }])
  click(desk('control'))
  await settle()
  expect(sent(calls)).toEqual([['/api/desktop/a%20b%25/control', 'POST', '1', { to: 'owner' }]])
  expect(desk('control')?.textContent).toBe('Give back')
  expect(byClass('desk-who')?.textContent).toBe('You have control')
  expect(byClass('desk-warn')?.textContent).toBe('The agent can see what you type into its browser.')
  expect(dom.document.activeElement).toBe(canvas() as MiniElement)

  const down = key(canvas(), { key: 'a', code: 'KeyA' })
  expect(down.defaultPrevented).toBe(true)
  // The board's own keys do not hear it.
  expect(down.stopped).toBe(true)
  key(canvas(), { key: 'a', code: 'KeyA' }, 'keyup')
  expect(socket?.sent).toEqual([
    [4, 1, 0, 0, 0, 0, 0, 0x61],
    [4, 0, 0, 0, 0, 0, 0, 0x61],
  ])
  // A paste: Ctrl goes up on the display, then the text is typed.
  socket?.sent.splice(0)
  key(canvas(), { key: 'Control', code: 'ControlLeft', ctrlKey: true })
  const v = key(canvas(), { key: 'v', code: 'KeyV', ctrlKey: true })
  expect(v.defaultPrevented).toBe(false)
  key(canvas(), { clipboardData: { getData: () => 'hi' } }, 'paste')
  expect(socket?.sent.map(m => `${m[1]}:${m[7]}`)).toEqual(['1:227', '0:227', '1:104', '0:104', '1:105', '0:105'])

  click(desk('control'))
  await settle()
  expect(sent(calls)[1]).toEqual(['/api/desktop/a%20b%25/control', 'POST', '1', { to: 'agent' }])
  expect(byClass('desk-warn')).toBeUndefined()
  socket?.sent.splice(0)
  key(canvas(), { key: 'b', code: 'KeyB' })
  expect(socket?.sent).toEqual([])
})

test('who has control follows the board; a refused hand-over says why', async () => {
  render({ desktop: desktop({ control: 'owner' }), open: true })
  expect(byClass('desk-who')?.textContent).toBe('You have control')
  expect(desk('control')?.textContent).toBe('Give back')
  handshake(FakeSocket.made[0])
  render({ desktop: desktop({ control: 'agent' }), open: true })
  expect(byClass('desk-who')?.textContent).toBe('The agent has control')
  answers([409, { ok: false, error: 'No browser here' }])
  toasts.length = 0
  click(desk('control'))
  await settle()
  expect(toasts).toEqual(['No browser here'])
  expect(desk('control')?.textContent).toBe('Take control')
})

test('full size over the board on the same socket: Esc or × brings it back, × on the fold closes it', () => {
  render({ desktop: desktop(), open: true })
  const [socket] = FakeSocket.made
  const foldHost = () => byClass('desk-host')
  click(desk('full'))
  const full = () => byClass('desk-full')
  expect(full()?.getAttribute('role')).toBe('dialog')
  expect(full()?.getAttribute('aria-label')).toBe('Browser · Alpha')
  expect(within(canvas(), full())).toBe(true)
  expect(byClass('desk-status')?.textContent).toBe('Shown full size')

  const esc = Object.assign(new MiniEvent('keydown'), { key: 'Escape' })
  flush(() => dom.window.dispatchEvent(esc))
  expect(full()).toBeUndefined()
  expect(esc.defaultPrevented).toBe(true)
  expect(within(canvas(), foldHost())).toBe(true)
  expect(socket?.closed).toBe(false)

  click(desk('full'))
  click(desk('close', full()))
  expect(full()).toBeUndefined()
  expect(desk('fold')?.getAttribute('aria-expanded')).toBe('true')
  expect(within(canvas(), foldHost())).toBe(true)

  click(desk('full'))
  const fold = find(el => el.localName === 'section')
  click(desk('close', fold))
  expect(full()).toBeUndefined()
  expect(socket?.closed).toBe(true)
  expect(FakeSocket.made).toHaveLength(1)
})

test('the link’s meter in the picture’s corner, folded and full size: round trip, frames a second, VNC and its quality; gone with the view', () => {
  render({ desktop: desktop(), open: true })
  const [socket] = FakeSocket.made
  const meter = () => byClass('desk-meter')
  // not live yet: there, but empty (and hidden)
  expect(meter()?.textContent ?? '').toBe('')
  handshake(socket)
  // no WebCodecs here: the VNC picture, said so
  expect(meter()?.textContent).toBe('– ms · 0 fps · vnc q6')
  expect(meter()?.getAttribute('aria-hidden')).toBe('true')
  expect(meter()?.getAttribute('title')).toBe(
    'Round trip to the server · frames a second · how the picture comes: h264 video, or VNC with its JPEG quality (0–9)',
  )
  expect(meter()?.parentNode).toBe(canvas()?.parentNode)
  click(desk('full'))
  expect(within(meter(), byClass('desk-full'))).toBe(true)
  expect(meter()?.parentNode).toBe(canvas()?.parentNode)
  click(desk('close', byClass('desk-full')))
  expect(meter()?.parentNode).toBe(canvas()?.parentNode)
  click(
    desk(
      'close',
      find(el => el.localName === 'section'),
    ),
  )
  expect(meter()).toBeUndefined()
})

test('control taken here and the view left: it is given back', async () => {
  render({ desktop: desktop(), open: true })
  handshake(FakeSocket.made[0])
  const calls = answers([200, { ok: true, control: 'owner' }], [200, { ok: true, control: 'agent' }])
  click(desk('control'))
  await settle()
  click(desk('close'))
  await settle()
  expect(sent(calls).map(c => c[3])).toEqual([{ to: 'owner' }, { to: 'agent' }])
})

test('taken here, then the board gives it back (the view dropped, another tab, a restart): the page follows and sends nothing', async () => {
  render({ desktop: desktop(), open: true })
  const [socket] = FakeSocket.made
  handshake(socket)
  answers([200, { ok: true, control: 'owner' }])
  click(desk('control'))
  await settle()
  render({ desktop: desktop({ control: 'owner' }), open: true })
  render({ desktop: desktop({ control: 'agent' }), open: true })
  expect(byClass('desk-who')?.textContent).toBe('The agent has control')
  expect(desk('control')?.textContent).toBe('Take control')
  socket?.sent.splice(0)
  key(canvas(), { key: 'x', code: 'KeyX' })
  expect(socket?.sent).toEqual([])
})

test('Take control only once the view is connected; Give back always', async () => {
  render({ desktop: desktop(), open: true })
  expect(desk('control')?.hasAttribute('disabled')).toBe(true)
  const calls = answers([200, { ok: true, control: 'owner' }])
  click(desk('control'))
  await settle()
  expect(sent(calls)).toEqual([])
  handshake(FakeSocket.made[0])
  expect(desk('control')?.hasAttribute('disabled')).toBe(false)
  // the owner has it from before and the view is not connected yet: Give back still works
  flush(() => root.unmount())
  newRoot()
  render({ desktop: desktop({ control: 'owner' }), open: true })
  expect(desk('control')?.hasAttribute('disabled')).toBe(false)
})

// ---------------------------------------------------------------- in the session panel

/** The session panel as the place has it: open until it closes itself (Sheet's onClose: the board's `open` goes). */
const panel = {
  isOpen: true,
  gesturing: false,
  closed: () => {},
  close() {
    this.isOpen = false
    this.closed()
  },
  reflow() {},
  cancel() {},
  setDock() {},
  resetSize() {},
  setOver() {},
}

/** The fold in the panel's aside, the panel shown until it closes, the fold open from the card's "Open its browser". */
function InPanel({ item }: { item: Item }) {
  const [shown, setShown] = useState(true)
  const [open, setOpen] = useState(true)
  panel.closed = () => setShown(false)
  return (
    <aside className={shown ? 'sheet open' : 'sheet'}>
      <BrowserFold item={item} open={open && shown} onOpen={setOpen} />
    </aside>
  )
}

function renderInPanel(fields: { desktop: ItemDesktop }) {
  const item = itemOf({ key: KEY, name: 'Alpha', desktop: fields.desktop })
  draw(
    <I18nProvider lang="en">
      <BoardContext.Provider value={boardOf({ toast: text => toasts.push(text) })}>
        <InPanel item={item} />
      </BoardContext.Provider>
    </I18nProvider>,
  )
}

/** The page's listeners on the window (the click-away's) are the small DOM's window's. */
function onWindow<T>(fn: () => T): T {
  const was = { add: globalThis.addEventListener, remove: globalThis.removeEventListener }
  Reflect.set(globalThis, 'addEventListener', dom.window.addEventListener.bind(dom.window))
  Reflect.set(globalThis, 'removeEventListener', dom.window.removeEventListener.bind(dom.window))
  try {
    return fn()
  } finally {
    Reflect.set(globalThis, 'addEventListener', was.add)
    Reflect.set(globalThis, 'removeEventListener', was.remove)
  }
}

/** A tap (or a click, `pointerType` 'mouse') where (x, y) is: the press, the let go, the click the browser sends. */
function tap(el: MiniElement | undefined, x = 10, y = 10, pointerType = 'touch') {
  if (!el) throw new Error('nothing to tap')
  const at = { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType }
  flush(() => el.dispatchEvent(Object.assign(new MiniEvent('pointerdown'), at, { buttons: 1 })))
  flush(() => el.dispatchEvent(Object.assign(new MiniEvent('pointerup'), at, { buttons: 0 })))
  flush(() => el.dispatchEvent(Object.assign(new MiniEvent('click'), at)))
}

/** The display (4 × 2) drawn 400 × 200 at the window's corner: (250, 150) is its point (2, 1). */
const screenAt = () => {
  layout.rect = el => ({ left: 0, top: 0, width: el.localName === 'canvas' ? 400 : 0, height: 200 })
}

test('control taken full size: a tap on its browser goes to it, and the panel, full size and control stay', async () => {
  const place = new PanelPlace(() => ({ w: 1024, h: 768 }))
  panel.isOpen = true
  place.panels.push(panel)
  const stop = onWindow(() => listenClickAway(place))
  try {
    renderInPanel({ desktop: desktop({ asks: true }) })
    const [socket] = FakeSocket.made
    handshake(socket)
    const full = () => byClass('desk-full')
    tap(desk('full'))
    const calls = answers([200, { ok: true, control: 'owner' }], [200, { ok: true, control: 'agent' }])
    tap(desk('control', full()))
    await settle()
    // the board's word follows (and the card asks no more: the agent went on)
    renderInPanel({ desktop: desktop({ control: 'owner' }) })
    expect(byClass('desk-who')?.textContent).toBe('You have control')

    screenAt()
    socket?.sent.splice(0)
    tap(canvas(), 250, 150)
    expect(panel.isOpen).toBe(true)
    expect(within(canvas(), full())).toBe(true)
    expect(byClass('desk-who')?.textContent).toBe('You have control')
    expect(socket?.closed).toBe(false)
    // the press and the let go at (2, 1), and nothing handed back
    expect(socket?.sent).toEqual([
      [5, 1, 0, 2, 0, 1],
      [5, 0, 0, 2, 0, 1],
    ])
    expect(sent(calls).map(c => c[3])).toEqual([{ to: 'owner' }])
    // full size's own bar and its warning keep it too
    tap(full())
    tap(byClass('desk-warn'))
    expect(panel.isOpen).toBe(true)
    expect(full()).toBeDefined()

    // the board beside the panel closes it as before, and control goes back with the view
    const board = dom.document.body.appendChild(dom.document.createElement('main'))
    board.setAttribute('class', 'board')
    tap(desk('close', full()))
    tap(board as MiniElement)
    await settle()
    expect(panel.isOpen).toBe(false)
    expect(socket?.closed).toBe(true)
    expect(sent(calls).map(c => c[3])).toEqual([{ to: 'owner' }, { to: 'agent' }])
  } finally {
    onWindow(stop)
    place.panels.splice(0)
  }
})

test('the session opened again keeps its browser open while the owner has it; folded as before otherwise', () => {
  type Ui = { open: string | null; opened: number; browser: boolean }
  let got: [boolean, (open: boolean) => void] = [false, () => {}]
  function Probe({ ui, owner }: { ui: Ui; owner: boolean }) {
    got = useBrowserFold(ui, owner)
    return null
  }
  const at = (ui: Ui, owner = false) => {
    draw(<Probe ui={ui} owner={owner} />)
    return got[0]
  }
  // opened from the card's mark: open; opened again (its card clicked) with the agent at it: folded
  expect(at({ open: 'a', opened: 1, browser: true })).toBe(true)
  expect(at({ open: 'a', opened: 2, browser: false })).toBe(false)
  // unfolded by hand, the owner takes it: opened again, it stays open
  flush(() => got[1](true))
  expect(at({ open: 'a', opened: 2, browser: false }, true)).toBe(true)
  expect(at({ open: 'a', opened: 3, browser: false }, true)).toBe(true)
  // another session: folded; asked for: open
  expect(at({ open: 'b', opened: 4, browser: false }, true)).toBe(false)
  expect(at({ open: 'b', opened: 5, browser: true })).toBe(true)
  // the panel closed (control went back with it), then opened again: folded
  at({ open: null, opened: 5, browser: true }, true)
  expect(at({ open: 'b', opened: 6, browser: false }, true)).toBe(false)
})

// ---------------------------------------------------------------- a mouse, a finger

/** Control taken in the fold, the display (4 × 2, or `width` × `height`) drawn 400 × 200; its socket, nothing sent yet. */
async function controlled(width = 4, height = 2) {
  render({ desktop: desktop(), open: true })
  const [socket] = FakeSocket.made
  handshake(socket, width, height)
  const calls = answers([200, { ok: true, control: 'owner' }], [200, { ok: true, control: 'agent' }])
  click(desk('control'))
  await settle()
  screenAt()
  socket?.sent.splice(0)
  return { socket, calls }
}

const fire = (el: MiniNode | undefined, type: string, fields: Record<string, unknown> = {}) => {
  const e = Object.assign(new MiniEvent(type), fields)
  flush(() => (el as MiniElement).dispatchEvent(e))
  return e
}

test('a mouse with control goes as it always did: the picture has the keys, no field; press, move, let go, wheel, keys', async () => {
  const { socket } = await controlled()
  const at = { clientX: 250, clientY: 150, button: 0, pointerId: 1, pointerType: 'mouse' }
  const down = fire(canvas(), 'pointerdown', { ...at, buttons: 1 })
  expect(down.defaultPrevented).toBe(true)
  expect(dom.document.activeElement).toBe(canvas() as MiniElement)
  fire(canvas(), 'pointermove', { ...at, clientX: 150, buttons: 1 })
  fire(canvas(), 'pointerup', { ...at, clientX: 150, buttons: 0 })
  fire(canvas(), 'click', { ...at, clientX: 150 })
  fire(canvas(), 'wheel', { clientX: 150, clientY: 150, deltaY: 120, deltaMode: 0 })
  key(canvas(), { key: 'a', code: 'KeyA' })
  key(canvas(), { key: 'a', code: 'KeyA' }, 'keyup')
  expect(socket?.sent).toEqual([
    [5, 1, 0, 2, 0, 1],
    [5, 1, 0, 1, 0, 1],
    [5, 0, 0, 1, 0, 1],
    [5, 16, 0, 1, 0, 1],
    [5, 0, 0, 1, 0, 1],
    [5, 16, 0, 1, 0, 1],
    [5, 0, 0, 1, 0, 1],
    [4, 1, 0, 0, 0, 0, 0, 0x61],
    [4, 0, 0, 0, 0, 0, 0, 0x61],
  ])
  expect(byClass('desk-keys')).toBeUndefined()
  expect(dom.document.activeElement).toBe(canvas() as MiniElement)
})

test('a tap with control brings up the screen’s keyboard: a field by the picture whose text and keys go to the display; given back, it goes', async () => {
  const { socket } = await controlled()
  tap(canvas(), 250, 150)
  const field = () => byClass('desk-keys')
  expect(field()?.localName).toBe('textarea')
  expect(field()?.parentNode).toBe(canvas()?.parentNode)
  expect(dom.document.activeElement).toBe(field() as MiniElement)
  const attrs = ['autocapitalize', 'autocorrect', 'autocomplete', 'spellcheck', 'tabindex', 'aria-label']
  expect(attrs.map(a => field()?.getAttribute(a))).toEqual(['off', 'off', 'off', 'false', '-1', 'Browser'])
  // the tap itself: a click on the display
  expect(socket?.sent).toEqual([
    [5, 1, 0, 2, 0, 1],
    [5, 0, 0, 2, 0, 1],
  ])
  socket?.sent.splice(0)
  const value = (text: string) => Reflect.set(field() as object, 'value', text)
  // a letter comes as text: its key goes nowhere (and the board's keys do not hear it)…
  const letter = key(field(), { key: 'h', code: 'KeyH' })
  expect([letter.defaultPrevented, letter.stopped]).toEqual([false, true])
  // …and what the field has new goes as keys; the field is kept as it was
  value(`${KEYS_AT}hé`)
  fire(field(), 'input')
  expect(socket?.sent).toEqual([
    [4, 1, 0, 0, 0, 0, 0, 0x68],
    [4, 0, 0, 0, 0, 0, 0, 0x68],
    [4, 1, 0, 0, 0, 0, 0, 0xe9],
    [4, 0, 0, 0, 0, 0, 0, 0xe9],
  ])
  expect(Reflect.get(field() as object, 'value')).toBe(KEYS_AT)
  // a Backspace that took from the field; Return as a key, kept out of the field
  socket?.sent.splice(0)
  value(KEYS_AT.slice(1))
  fire(field(), 'input')
  const enter = key(field(), { key: 'Enter', code: 'Enter' })
  key(field(), { key: 'Enter', code: 'Enter' }, 'keyup')
  expect(enter.defaultPrevented).toBe(true)
  expect(socket?.sent).toEqual([
    [4, 1, 0, 0, 0, 0, 0xff, 0x08],
    [4, 0, 0, 0, 0, 0, 0xff, 0x08],
    [4, 1, 0, 0, 0, 0, 0xff, 0x0d],
    [4, 0, 0, 0, 0, 0, 0xff, 0x0d],
  ])
  // an input method's word: once it is done
  socket?.sent.splice(0)
  value(`${KEYS_AT}に`)
  fire(field(), 'input', { isComposing: true })
  expect(socket?.sent).toEqual([])
  fire(field(), 'compositionend')
  expect(socket?.sent).toEqual([
    [4, 1, 0, 0, 1, 0, 0x30, 0x6b],
    [4, 0, 0, 0, 1, 0, 0x30, 0x6b],
  ])
  // full size: the field goes with the picture
  click(desk('full'))
  tap(canvas(), 250, 150)
  expect(field()?.parentNode).toBe(canvas()?.parentNode)
  expect(within(field(), byClass('desk-full'))).toBe(true)
  // given back: the keyboard goes, and what it types goes nowhere
  click(desk('control', byClass('desk-full')))
  await settle()
  expect(dom.document.activeElement).not.toBe(field() as MiniElement)
  socket?.sent.splice(0)
  value(`${KEYS_AT}x`)
  fire(field(), 'input')
  key(field(), { key: 'Enter', code: 'Enter' })
  // watched only, a tap brings it up no more and goes nowhere
  tap(canvas(), 250, 150)
  expect(dom.document.activeElement).not.toBe(field() as MiniElement)
  expect(socket?.sent).toEqual([])
})

// ---------------------------------------------------------------- a finger as on a tablet's remote desktop
// An 800 × 400 display drawn 400 × 200: a page px is two of the display's, (x, y) its (2x, 2y).

/** A finger (`id`) on the picture at (x, y): put down, moved, lifted, or taken by the system. */
const finger = (type: string, id: number, x: number, y: number, fields: Record<string, unknown> = {}) =>
  fire(canvas(), type, {
    clientX: x,
    clientY: y,
    pointerId: id,
    pointerType: 'touch',
    button: 0,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
    ...fields,
  })
/** The display's pointer at (x, y) with these buttons, as its message. */
const pointerAt = (mask: number, x: number, y: number) => [5, mask, x >> 8, x & 255, y >> 8, y & 255]
/** A wheel step (8 up, 16 down, 32 left, 64 right) at (x, y): the button pressed and let go. */
const step = (bit: number, x: number, y: number) => [pointerAt(bit, x, y), pointerAt(0, x, y)]
const holdOn = () => new Promise(done => setTimeout(done, HOLD_MS + 40))

test('a mouse held still and dragged goes as it always did, the button down at once, its moves in a frame as their last; a pen over the picture moves its pointer', async () => {
  const { socket } = await controlled(800, 400)
  const mouse = { button: 0, pointerId: 1, pointerType: 'mouse' }
  fire(canvas(), 'pointerdown', { ...mouse, clientX: 100, clientY: 50, buttons: 1 })
  await holdOn()
  fire(canvas(), 'pointermove', { ...mouse, clientX: 100, clientY: 150, buttons: 1 })
  fire(canvas(), 'pointermove', { ...mouse, clientX: 200, clientY: 150, buttons: 1 })
  fire(canvas(), 'pointerup', { ...mouse, clientX: 200, clientY: 150, buttons: 0 })
  fire(canvas(), 'pointerdown', { ...mouse, button: 2, clientX: 200, clientY: 150, buttons: 2 })
  fire(canvas(), 'pointerup', { ...mouse, button: 2, clientX: 200, clientY: 150, buttons: 0 })
  fire(canvas(), 'wheel', { clientX: 200, clientY: 150, deltaY: -50, deltaMode: 0 })
  fire(canvas(), 'pointermove', { clientX: 210, clientY: 160, pointerId: 2, pointerType: 'pen', buttons: 0 })
  // the wheel's step and the pen's move wait for the frame
  await frame()
  expect(socket?.sent).toEqual([
    pointerAt(1, 200, 100),
    // the two moves in one frame: the last, before the let go
    pointerAt(1, 400, 300),
    pointerAt(0, 400, 300),
    pointerAt(4, 400, 300),
    pointerAt(0, 400, 300),
    ...step(8, 400, 300),
    pointerAt(0, 420, 320),
  ])
  expect(canvas()?.hasAttribute('data-held')).toBe(false)
  expect(canvas()?.style.transform ?? '').toBe('')
  expect(dom.document.activeElement).toBe(canvas() as MiniElement)
})

test('watched only, a finger’s swipe goes nowhere: the board’s page has it to scroll', () => {
  render({ desktop: desktop(), open: true })
  const [socket] = FakeSocket.made
  handshake(socket, 800, 400)
  screenAt()
  const down = finger('pointerdown', 1, 200, 150)
  finger('pointermove', 1, 200, 50)
  finger('pointerup', 1, 200, 50)
  expect(down.defaultPrevented).toBe(false)
  expect(socket?.sent).toEqual([])
  expect(byClass('desk-keys')).toBeUndefined()
})

test('a finger’s swipe with control scrolls the display’s page by its wheel as far as the finger went, a step its 120 px, where it began: no click, no keyboard', async () => {
  const { socket } = await controlled(800, 400)
  const down = finger('pointerdown', 1, 200, 150)
  expect(down.defaultPrevented).toBe(true)
  // a few px is still a tap
  finger('pointermove', 1, 203, 144)
  expect(socket?.sent).toEqual([])
  // up 120 px, the display's 240: two steps down (the page follows the finger), at (400, 300);
  // a little to the side on the way, but begun up it scrolls up and down only
  finger('pointermove', 1, 203, 100)
  finger('pointermove', 1, 210, 30)
  finger('pointerup', 1, 210, 30)
  fire(canvas(), 'click', { clientX: 210, clientY: 30 })
  expect(socket?.sent).toEqual([...step(16, 400, 300), ...step(16, 400, 300)])
  expect(byClass('desk-keys')).toBeUndefined()

  // down: the wheel up; to the left: right (button 7), to the right: left (button 6)
  socket?.sent.splice(0)
  finger('pointerdown', 2, 100, 100)
  finger('pointermove', 2, 100, 160)
  finger('pointerup', 2, 100, 160)
  finger('pointerdown', 3, 300, 100)
  finger('pointermove', 3, 240, 100)
  finger('pointermove', 3, 180, 102)
  finger('pointerup', 3, 180, 102)
  finger('pointerdown', 4, 300, 100)
  finger('pointermove', 4, 360, 100)
  finger('pointerup', 4, 360, 100)
  expect(socket?.sent).toEqual([
    ...step(8, 200, 200),
    ...step(64, 600, 200),
    ...step(64, 600, 200),
    ...step(32, 600, 200),
  ])
  expect(byClass('desk-keys')).toBeUndefined()
})

test('a slow swipe goes as far as a quick one: what a step has not gone yet is kept, there and back; half a step is none', async () => {
  const { socket } = await controlled(800, 400)
  // up 120 px a px at a time: the display's 240, two steps, as in one go
  finger('pointerdown', 1, 100, 180)
  for (let y = 179; y >= 60; y--) finger('pointermove', 1, 100, y)
  await frame()
  expect(socket?.sent).toEqual([...step(16, 200, 360), ...step(16, 200, 360)])
  // and back down 60 px: one step up
  for (let y = 61; y <= 120; y++) finger('pointermove', 1, 100, y)
  finger('pointerup', 1, 100, 120)
  expect(socket?.sent).toEqual([...step(16, 200, 360), ...step(16, 200, 360), ...step(8, 200, 360)])

  // 30 px, the display's 60: half a step, none (and no end of steps back and forth); a px more, one
  socket?.sent.splice(0)
  finger('pointerdown', 2, 100, 100)
  finger('pointermove', 2, 100, 130)
  await frame()
  expect(socket?.sent).toEqual([])
  finger('pointermove', 2, 100, 131)
  finger('pointerup', 2, 100, 131)
  expect(socket?.sent).toEqual(step(8, 200, 200))
})

test('two fingers’ swipe scrolls it too, from their middle where they went down; a finger lifted on the way, the other goes on', async () => {
  const { socket } = await controlled(800, 400)
  finger('pointerdown', 1, 150, 180)
  finger('pointerdown', 2, 250, 180)
  // side by side, up together, one heard before the other: 60 px, the display's 120, a step
  finger('pointermove', 1, 150, 170)
  finger('pointermove', 2, 250, 170)
  finger('pointermove', 1, 150, 150)
  finger('pointermove', 2, 250, 150)
  finger('pointermove', 1, 150, 120)
  finger('pointermove', 2, 250, 120)
  await frame()
  expect(socket?.sent).toEqual(step(16, 400, 360))
  // one lifted: the other's 120 px more, two steps
  finger('pointerup', 2, 250, 120)
  finger('pointermove', 1, 150, 0)
  finger('pointerup', 1, 150, 0)
  expect(socket?.sent).toEqual([...step(16, 400, 360), ...step(16, 400, 360), ...step(16, 400, 360)])
  expect(canvas()?.style.transform ?? '').toBe('')
  expect(byClass('desk-keys')).toBeUndefined()
})

test('a finger held still a moment presses the button where it is: what it moves then drags, let go the button is up; taken by the system, too', async () => {
  const { socket } = await controlled(800, 400)
  finger('pointerdown', 1, 100, 50)
  // a finger's tremble: still held
  finger('pointermove', 1, 104, 53)
  expect(socket?.sent).toEqual([])
  await holdOn()
  expect(socket?.sent).toEqual([pointerAt(1, 200, 100)])
  expect(canvas()?.hasAttribute('data-held')).toBe(true)
  finger('pointermove', 1, 150, 50)
  finger('pointermove', 1, 200, 75)
  finger('pointerup', 1, 200, 75)
  // its two moves in one frame: the last, before the let go
  expect(socket?.sent).toEqual([pointerAt(1, 200, 100), pointerAt(1, 400, 150), pointerAt(0, 400, 150)])
  expect(canvas()?.hasAttribute('data-held')).toBe(false)
  // the screen's keyboard, as after a tap
  expect(dom.document.activeElement).toBe(byClass('desk-keys') as MiniElement)

  socket?.sent.splice(0)
  finger('pointerdown', 2, 100, 50)
  await holdOn()
  finger('pointermove', 2, 120, 50)
  finger('pointercancel', 2, 120, 50)
  expect(socket?.sent).toEqual([pointerAt(1, 200, 100), pointerAt(1, 240, 100), pointerAt(0, 240, 100)])
  expect(canvas()?.hasAttribute('data-held')).toBe(false)
})

test('a tap soon after one near it clicks where that one did, so the display sees a double click; farther or later, where it is', async () => {
  const { socket } = await controlled(800, 400)
  tap(canvas(), 250, 150)
  tap(canvas(), 258, 155)
  expect(socket?.sent).toEqual([
    pointerAt(1, 500, 300),
    pointerAt(0, 500, 300),
    pointerAt(1, 500, 300),
    pointerAt(0, 500, 300),
  ])
  socket?.sent.splice(0)
  tap(canvas(), 300, 150)
  const later = { timeStamp: Date.now() + 1000 }
  finger('pointerdown', 1, 304, 152, later)
  finger('pointerup', 1, 304, 152, later)
  expect(socket?.sent).toEqual([
    pointerAt(1, 600, 300),
    pointerAt(0, 600, 300),
    pointerAt(1, 608, 304),
    pointerAt(0, 608, 304),
  ])
})

/** The picture's box as the page has it (400 × 200 at the corner), zoomed by its transform (from its top left corner). */
const zoomedAt = () => {
  layout.rect = el => {
    if (el.localName !== 'canvas') return { left: 0, top: 0, width: 0, height: 200 }
    const m = /^translate\((-?[\d.]+)%, (-?[\d.]+)%\) scale\(([\d.]+)\)$/.exec(el.style.transform ?? '')
    const [fx, fy, z] = m ? [Number(m[1]) / 100, Number(m[2]) / 100, Number(m[3])] : [0, 0, 1]
    return { left: fx * 400, top: fy * 200, width: 400 * z, height: 200 * z }
  }
}
/** Two fingers down at x `from` (y 100), moved to each pair of `to` in turn; lifted at `lift`'s. */
const pinch = (from: [number, number], to: [number, number][]) => {
  finger('pointerdown', 1, from[0], 100)
  finger('pointerdown', 2, from[1], 100)
  for (const [a, b] of to) {
    finger('pointermove', 1, a, 100)
    finger('pointermove', 2, b, 100)
  }
}
const lift = (a: number, b: number) => {
  finger('pointerup', 1, a, 100)
  finger('pointerup', 2, b, 100)
}

test('a pinch zooms the picture in the board, not on the display: a tap then clicks what shows under it; pinched back, or given back, it fits', async () => {
  const { socket } = await controlled(800, 400)
  zoomedAt()
  // apart twice as far, about their middle (200, 100): twice as large, that point where it was
  pinch(
    [150, 250],
    [
      [130, 270],
      [100, 300],
    ],
  )
  lift(100, 300)
  expect(canvas()?.style.transform).toBe('translate(-50%, -50%) scale(2)')
  expect(canvas()?.style.transformOrigin).toBe('0 0')
  expect(socket?.sent).toEqual([])
  // (250, 150) shows the display's (450, 250) now, not (500, 300)
  tap(canvas(), 250, 150)
  expect(socket?.sent).toEqual([pointerAt(1, 450, 250), pointerAt(0, 450, 250)])

  // closer again: as it fits
  pinch(
    [150, 250],
    [
      [170, 230],
      [190, 210],
    ],
  )
  lift(190, 210)
  expect([canvas()?.style.transform, canvas()?.style.transformOrigin]).toEqual(['', ''])
  // let go of only a little larger: as it fits too
  pinch([50, 350], [[39, 361]])
  expect(canvas()?.style.transform).toMatch(/scale\(1\.07/)
  lift(39, 361)
  expect(canvas()?.style.transform).toBe('')

  // zoomed, then given back: as it fits
  pinch([150, 250], [[100, 300]])
  lift(100, 300)
  expect(canvas()?.style.transform).toBe('translate(-50%, -50%) scale(2)')
  click(desk('control'))
  await settle()
  expect(canvas()?.style.transform).toBe('')
  expect(byClass('desk-who')?.textContent).toBe('The agent has control')
})

test('a swipe on the picture zoomed in goes as far as the finger at that zoom: a page px is the display’s own then', async () => {
  const { socket } = await controlled(800, 400)
  zoomedAt()
  pinch(
    [150, 250],
    [
      [130, 270],
      [100, 300],
    ],
  )
  lift(100, 300)
  expect(canvas()?.style.transform).toBe('translate(-50%, -50%) scale(2)')
  // up 120 px, the display's 120 now: one step down, where it began ((250, 150) shows (450, 250))
  finger('pointerdown', 1, 250, 150)
  finger('pointermove', 1, 250, 90)
  finger('pointermove', 1, 250, 30)
  finger('pointerup', 1, 250, 30)
  expect(socket?.sent).toEqual(step(16, 450, 250))
})

// ---------------------------------------------------------------- the keyboard's language, the clipboard both ways

const CLIP = { caps: 1 << 24, request: 1 << 25, peek: 1 << 26, notify: 1 << 27, provide: 1 << 28, text: 1 }
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
/** The display's extended cut text: its flags and what follows them. */
const serverClip = (flags: number, ...body: number[]) => [
  3,
  0,
  0,
  0,
  ...be32(-(4 + body.length)),
  ...be32(flags),
  ...body,
]
/** The display's server does the extended clipboard and fences (it said so); what the page answered taken. */
function clipboardOn(socket: FakeSocket | undefined) {
  const all = CLIP.caps | CLIP.text | CLIP.request | CLIP.peek | CLIP.notify | CLIP.provide
  socket?.serve(serverClip(all, ...be32(1 << 20)), [248, 0, 0, 0, 0x80, 0, 0, 0, 0])
  socket?.sent.splice(0)
}
/** What the page sent, read: a key, the pointer, or the clipboard (its flags; a provide's text). */
function said(m: number[]): string {
  if (m[0] === 4)
    return `${m[1] ? 'down' : 'up'} ${((m[4] ?? 0) * 2 ** 24 + ((m[5] ?? 0) << 16) + ((m[6] ?? 0) << 8) + (m[7] ?? 0)).toString(16)}`
  if (m[0] === 248) return `fence ${String.fromCharCode(m[9] ?? 0, m[10] ?? 0)}`
  if (m[0] !== 6) return `message ${m[0]}`
  const flags = new DataView(Uint8Array.from(m).buffer).getUint32(8)
  const names = Object.entries(CLIP)
    .filter(([, bit]) => flags & bit)
    .map(([name]) => name)
  if (!(flags & CLIP.provide)) return `clipboard ${names.join(' ')}`
  const out = inflateSync(Uint8Array.from(m.slice(12)), { finishFlush: constants.Z_SYNC_FLUSH })
  return `clipboard provide ${new TextDecoder().decode(out.subarray(4)).replace(/\0$/, '')}`
}
const typedKeys = (text: string) =>
  [...text].flatMap(ch => {
    const cp = ch.codePointAt(0) ?? 0
    const k = (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? cp : 0x01000000 + cp
    return [`down ${k.toString(16)}`, `up ${k.toString(16)}`]
  })
const CTRL_V = ['down ffe3', 'down 76', 'up 76', 'up ffe3']
/** The page's clipboard as a browser gives it, for `body`; gone after. */
async function withClipboard(clip: Partial<Clipboard>, body: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true })
  try {
    await body()
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
}
/** The field's text typed: what it has new after what it is kept at. */
const typeIn = (field: MiniElement | undefined, text: string) => {
  Reflect.set(field as object, 'value', `${KEYS_AT}${text}`)
  fire(field, 'input')
}

test('the touch keyboard’s field has no language of its own: not the board’s, which the screen’s keyboard may keep to, so the one the owner picks (its globe key) stays', async () => {
  const { socket } = await controlled()
  clipboardOn(socket)
  tap(canvas(), 250, 150)
  expect(byClass('desk-keys')?.getAttribute('lang')).toBe('')
})

test('Russian and Latin typed in the touch keyboard’s field go to the display as keys, as before (and accents and «»—№ now too)', async () => {
  const { socket } = await controlled()
  clipboardOn(socket)
  tap(canvas(), 250, 150)
  const field = byClass('desk-keys')
  socket?.sent.splice(0)
  typeIn(field, 'Привет, мир! Ёё')
  typeIn(field, 'github.com/a?b=1')
  typeIn(field, '«café» — №5')
  expect(socket?.sent.map(said)).toEqual([
    ...typedKeys('Привет, мир! Ёё'),
    ...typedKeys('github.com/a?b=1'),
    ...typedKeys('«café» — №5'),
  ])
})

test('a character the display’s keyboard has no key for (Greek, an emoji) goes by its clipboard: announced, Ctrl+V, its text as the server asks; what is typed after it waits for the server’s turn', async () => {
  const { socket } = await controlled()
  clipboardOn(socket)
  tap(canvas(), 250, 150)
  const field = byClass('desk-keys')
  socket?.sent.splice(0)
  typeIn(field, 'λ')
  expect(socket?.sent.map(said)).toEqual(['clipboard notify text', ...CTRL_V])
  typeIn(field, 'x')
  expect(socket?.sent).toHaveLength(5)
  // the display pastes: its server asks for the text
  socket?.serve(serverClip(CLIP.request | CLIP.text))
  expect(socket?.sent.slice(5).map(said)).toEqual(['clipboard provide λ', 'fence ss'])
  // its turn came: then the rest
  const fence = socket?.sent.at(-1) as number[]
  socket?.serve([248, 0, 0, 0, 0, 0, 0, 0, 4, ...fence.slice(9)])
  await new Promise(r => setTimeout(r, PASTE_SETTLE_MS + 60))
  expect(socket?.sent.slice(7).map(said)).toEqual(typedKeys('x'))
})

test('Ctrl+V (or Cmd+V) on the picture: the field takes the paste, its text goes to the display, the picture has the keys again', async () => {
  const { socket } = await controlled()
  clipboardOn(socket)
  expect(dom.document.activeElement).toBe(canvas() as MiniElement)
  key(canvas(), { key: 'Control', code: 'ControlLeft', ctrlKey: true })
  const v = key(canvas(), { key: 'v', code: 'KeyV', ctrlKey: true })
  // the browser pastes: into the field now
  expect(v.defaultPrevented).toBe(false)
  const field = byClass('desk-keys')
  expect(dom.document.activeElement).toBe(field as MiniElement)
  const paste = fire(field, 'paste', { clipboardData: { getData: () => 'hi мир' } })
  expect(paste.defaultPrevented).toBe(true)
  expect(dom.document.activeElement).toBe(canvas() as MiniElement)
  // Control up first, then the text as keys
  expect(socket?.sent.map(said)).toEqual(['down ffe3', 'up ffe3', ...typedKeys('hi мир')])
  // Cmd+V too
  socket?.sent.splice(0)
  key(canvas(), { key: 'v', code: 'KeyV', metaKey: true })
  expect(dom.document.activeElement).toBe(field as MiniElement)
  fire(field, 'paste', { clipboardData: { getData: () => 'ok' } })
  expect(socket?.sent.map(said)).toEqual(typedKeys('ok'))
})

test('a long paste (over 200 characters) goes by the display’s clipboard as one, its text whole', async () => {
  const { socket } = await controlled()
  clipboardOn(socket)
  tap(canvas(), 250, 150)
  socket?.sent.splice(0)
  const long = `${'Съешь же ещё этих мягких булок. '.repeat(8)}end`
  fire(byClass('desk-keys'), 'paste', { clipboardData: { getData: () => long } })
  expect(socket?.sent.map(said)).toEqual(['clipboard notify text', ...CTRL_V])
  socket?.serve(serverClip(CLIP.request | CLIP.text))
  expect(said(socket?.sent.at(-2) as number[])).toBe(`clipboard provide ${long}`)
})

test('copied in its browser while the owner has it: asked for, offered on the picture, copied to the owner’s clipboard on a tap; watched, nothing asked or offered', async () => {
  const { socket } = await controlled()
  clipboardOn(socket)
  socket?.serve(serverClip(CLIP.notify | CLIP.text))
  expect(socket?.sent.map(said)).toEqual(['clipboard request text'])
  expect(byClass('desk-copied')).toBeUndefined()
  const text = new TextEncoder().encode('Скопировано ✓\0')
  const z = [...deflateSync(Uint8Array.from([...be32(text.length), ...text]))]
  socket?.serve(serverClip(CLIP.provide | CLIP.text, ...z))
  const notice = () => byClass('desk-copied')
  expect(notice()?.textContent).toBe('Copied in its browser — tap to copy it to yours')
  expect(notice()?.parentNode).toBe(byClass('desk-view'))
  const written: string[] = []
  toasts.length = 0
  await withClipboard({ writeText: async t => void written.push(t) }, async () => {
    click(notice())
    await settle()
  })
  expect(written).toEqual(['Скопировано ✓'])
  expect(notice()).toBeUndefined()
  expect(toasts).toEqual(['Copied to your clipboard'])
  // given back: what is copied there is not asked for, nor offered
  click(desk('control'))
  await settle()
  socket?.sent.splice(0)
  socket?.serve(serverClip(CLIP.notify | CLIP.text))
  socket?.serve(serverClip(CLIP.provide | CLIP.text, ...z))
  expect(socket?.sent.map(said).filter(m => m.startsWith('clipboard request'))).toEqual([])
  expect(notice()).toBeUndefined()
})

test('the offer in Russian', async () => {
  flush(() => root.unmount())
  newRoot()
  render({ desktop: desktop(), open: true, lang: 'ru' })
  const [socket] = FakeSocket.made
  handshake(socket)
  answers([200, { ok: true, control: 'owner' }])
  click(desk('control'))
  await settle()
  clipboardOn(socket)
  socket?.serve(serverClip(CLIP.notify | CLIP.text))
  const text = new TextEncoder().encode('x\0')
  socket?.serve(serverClip(CLIP.provide | CLIP.text, ...deflateSync(Uint8Array.from([...be32(text.length), ...text]))))
  expect(byClass('desk-copied')?.textContent).toBe('Скопировано в его браузере — нажмите, чтобы скопировать к себе')
})

test('"Paste" with control where the page can read the owner’s clipboard: its text typed into the display (a password as keys, never on its clipboard), the button taking no focus; watched or without it, no button', async () => {
  await withClipboard({ readText: async () => 'S3cret-pass!' }, async () => {
    const { socket } = await controlled()
    clipboardOn(socket)
    tap(canvas(), 250, 150)
    const field = byClass('desk-keys')
    socket?.sent.splice(0)
    const button = desk('paste')
    expect(button?.textContent).toBe('Paste')
    expect(fire(button, 'pointerdown').defaultPrevented).toBe(true)
    click(button)
    await settle()
    expect(socket?.sent.map(said)).toEqual(typedKeys('S3cret-pass!'))
    expect(dom.document.activeElement).toBe(field as MiniElement)
    click(desk('control'))
    await settle()
    expect(desk('paste')).toBeUndefined()
  })
  // a page that cannot read it (no https): no button
  flush(() => root.unmount())
  newRoot()
  await controlled()
  expect(desk('paste')).toBeUndefined()
})

test('a paste anywhere else on the page (the chat’s composer beside it) never reaches the display, and the display’s paste and copy leave it as it was', async () => {
  const { socket } = await controlled()
  clipboardOn(socket)
  const composer = dom.document.body.appendChild(dom.document.createElement('textarea'))
  Reflect.set(composer, 'value', 'my message')
  composer.focus()
  const e = fire(composer, 'paste', { clipboardData: { getData: () => 'for the chat' } })
  expect(e.defaultPrevented).toBe(false)
  key(composer, { key: 'v', code: 'KeyV', ctrlKey: true })
  expect(socket?.sent).toEqual([])
  expect(dom.document.activeElement).toBe(composer)
  // the display's offer taken: the composer keeps its text
  socket?.serve(serverClip(CLIP.notify | CLIP.text))
  expect(Reflect.get(composer, 'value')).toBe('my message')
})

// ---------------------------------------------------------------- the panel's "needs you"

const ASK = 'Sign in to GitHub as acme-bot'
/** The panel under its head (SheetView) for `it`, its fold's own open state; the scrolls into view it asked for. */
async function sheetView(it: Item) {
  const { SheetView } = await import('../../web/src/components/sheet/Sheet.tsx')
  const { emptyDetail } = await import('../../web/src/hooks/useSessionDetail.ts')
  const { composerOf } = await import('./support/sheet-scene.tsx')
  function Panel() {
    const [open, setOpen] = useState(false)
    return (
      <SheetView
        open={KEY}
        item={it}
        detail={emptyDetail(KEY)}
        composer={composerOf({ open: KEY })}
        browser={{ open, onOpen: setOpen }}
      />
    )
  }
  const base = boardOf({})
  const value = boardOf({ data: base.data && { ...base.data, items: [it] } })
  draw(
    <I18nProvider lang="en">
      <BoardContext.Provider value={value}>
        <Panel />
      </BoardContext.Provider>
    </I18nProvider>,
  )
  const asked = byClass('asked')
  return { buttons: () => all(asked as MiniElement).filter(el => el.localName === 'button'), asked }
}

/** Calls to scrollIntoView while `body` runs: the class of what was brought into view. */
async function scrolls(body: (seen: string[]) => Promise<void>) {
  const seen: string[] = []
  const was = MiniElement.prototype.scrollIntoView
  MiniElement.prototype.scrollIntoView = function (this: MiniElement) {
    seen.push(this.className)
  }
  try {
    await body(seen)
  } finally {
    MiniElement.prototype.scrollIntoView = was
  }
}

const askingItem = () =>
  itemOf({
    key: KEY,
    name: 'Alpha',
    status: 'working',
    column: 'me',
    attention: 'ask',
    question: ASK,
    desktop: desktop({ asks: true, ask: ASK }),
  })

test('"Open its browser" in the panel’s "needs you", first beside "No reply needed": it unfolds the fold and brings it into view', async () => {
  await scrolls(async seen => {
    const { buttons, asked } = await sheetView(askingItem())
    expect(buttons().map(b => [b.className, b.textContent])).toEqual([
      ['button desk-ask', 'Open its browser'],
      ['button asked-dismiss', 'No reply needed'],
    ])
    expect(byClass('asked-actions')?.parentNode).toBe(asked)
    // folded, and the fold does not say the ask again
    expect(desk('fold')?.getAttribute('aria-expanded')).toBe('false')
    expect(byClass('desk-asks')).toBeUndefined()
    click(desk('open'))
    expect(desk('fold')?.getAttribute('aria-expanded')).toBe('true')
    expect(seen).toEqual(['desk open'])
    expect(FakeSocket.made).toHaveLength(1)
  })
})

test('a board ask that is not the browser’s: the panel’s "needs you" as before, no such button, nothing brought into view', async () => {
  await scrolls(async seen => {
    const { buttons } = await sheetView({ ...askingItem(), question: 'Which branch?', desktop: desktop() })
    expect(buttons().map(b => [b.className, b.textContent])).toEqual([['button asked-dismiss', 'No reply needed']])
    expect(byClass('asked-actions')).toBeUndefined()
    expect(byClass('asked')?.textContent).toBe('ASKSWhich branch?No reply needed')
    expect(seen).toEqual([])
  })
})

describe('the picture as H.264 video, where the page decodes it (WebCodecs)', () => {
  const KEY = [...[0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0xda], ...[0, 0, 0, 1, 0x68, 0xce], ...[0, 0, 0, 1, 0x65, 0x88]]
  const keyFrame = (seq: number) => [...videoMessage(seq, { key: true, data: Uint8Array.from(KEY) })]
  type Decoder = { state: string; init: VideoDecoderInit; chunks: { type: string; timestamp: number }[] }
  let decoders: Decoder[] = []
  /** WebCodecs as the page has it, the decoder the test's own; `supported`: what it says of the codec. */
  function install(supported = true) {
    decoders = []
    class Decoder {
      state = 'unconfigured'
      chunks: { type: string; timestamp: number }[] = []
      constructor(readonly init: VideoDecoderInit) {
        decoders.push(this)
      }
      configure() {
        this.state = 'configured'
      }
      decode(c: { type: string; timestamp: number }) {
        this.chunks.push({ type: c.type, timestamp: c.timestamp })
      }
      close() {
        this.state = 'closed'
      }
      static isConfigSupported = async (config: VideoDecoderConfig) => ({ supported, config })
    }
    class Chunk {
      constructor(init: object) {
        Object.assign(this, init)
      }
    }
    Reflect.set(globalThis, 'VideoDecoder', Decoder)
    Reflect.set(globalThis, 'EncodedVideoChunk', Chunk)
  }
  /** A frame out of the decoder (its chunk numbered `seq`): the page draws it. */
  const decoded = (seq: number) => {
    const frame = { timestamp: seq, displayWidth: 4, displayHeight: 2, close() {} }
    flush(() => decoders.at(-1)?.init.output(frame as unknown as VideoFrame))
  }
  /** The VNC handshake (RFB 3.8, a 4 × 2 display), then its fence and its word that it can send continuous updates. */
  const vncHello = (socket: FakeSocket | undefined) => {
    socket?.serve('RFB 003.008\n', [1, 1], [0, 0, 0, 0], [0, 4, 0, 2, ...new Array(16).fill(0), 0, 0, 0, 1, 120])
    socket?.serve([248, 0, 0, 0, 0x80, 0, 0, 0, 1, 0, 150])
  }
  /** Whether the VNC was asked for the picture (an update request, continuous updates). */
  const askedPicture = (socket: FakeSocket | undefined) => !!socket?.sent.some(m => m[0] === 3 || m[0] === 150)
  const texts = (socket: FakeSocket | undefined) => socket?.sent.map(m => m.join('')) ?? []
  const logged = (calls: ReturnType<typeof answers>) =>
    sent(calls)
      .filter(c => c[0] === '/api/log')
      .map(c => (c[3] as { text: string }).text)

  beforeEach(() => install())
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'VideoDecoder')
    Reflect.deleteProperty(globalThis, 'EncodedVideoChunk')
  })

  test('a second socket for the video; the VNC asks for no picture; the first frame drawn: the corner says h264, the board’s log the codec', async () => {
    const calls = answers()
    render({ desktop: desktop(), open: true })
    expect(FakeSocket.made).toHaveLength(2)
    const [vnc, video] = FakeSocket.made
    expect(vnc?.url).toBe('ws://board.test/api/desktop/a%20b%25/vnc?t=tok')
    expect(video?.url).toBe('ws://board.test/api/desktop/a%20b%25/video?t=tok')
    expect(video?.binaryType).toBe('arraybuffer')
    vncHello(vnc)
    // its pixel format, its encodings, its fence answered: nothing that asks for a picture
    expect(vnc?.sent.slice(3).map(m => m[0])).toEqual([0, 2, 248])
    expect(askedPicture(vnc)).toBe(false)
    const meter = () => byClass('desk-meter')?.textContent
    expect(meter()).toBe('– ms · 0 fps')
    video?.serve(keyFrame(1))
    await settle()
    expect(decoders).toHaveLength(1)
    expect(decoders[0]?.chunks).toEqual([{ type: 'key', timestamp: 1 }])
    decoded(1)
    expect(meter()).toBe('– ms · 0 fps · h264')
    // the frame answered on the video's socket
    expect(texts(video)).toEqual(['a1'])
    await settle()
    expect(logged(calls)).toEqual(['browser view a b%: h264 avc1.42C028'])
    expect(askedPicture(vnc)).toBe(false)
  })

  test('the video closed (no ffmpeg, its encoder ended): the VNC picture at once, all of it then as it changes; the corner says vnc, the board’s log why', async () => {
    const calls = answers()
    render({ desktop: desktop(), open: true })
    const [vnc, video] = FakeSocket.made
    vncHello(vnc)
    vnc?.sent.splice(0)
    flush(() => video?.onclose?.({ code: 4011, reason: 'video ended' }))
    expect(vnc?.sent).toEqual([
      [3, 0, 0, 0, 0, 0, 0, 4, 0, 2],
      [150, 1, 0, 0, 0, 0, 0, 4, 0, 2],
    ])
    expect(video?.closed).toBe(true)
    expect(byClass('desk-meter')?.textContent).toBe('– ms · 0 fps · vnc q6')
    await settle()
    expect(logged(calls)).toEqual(['browser view a b%: VNC picture (its video closed (4011 video ended))'])
    // the VNC's updates draw and count from now on; nothing more of the video
    expect(video?.onmessage).toBeNull()
  })

  test('a codec the browser does not decode: the VNC picture, said so in the board’s log', async () => {
    install(false)
    const calls = answers()
    render({ desktop: desktop(), open: true })
    const [vnc, video] = FakeSocket.made
    vncHello(vnc)
    video?.serve(keyFrame(1))
    await settle()
    expect(decoders).toEqual([])
    expect(askedPicture(vnc)).toBe(true)
    expect(video?.closed).toBe(true)
    await settle()
    expect(logged(calls)).toEqual(['browser view a b%: VNC picture (the browser does not decode avc1.42C028)'])
  })

  test('input and control as before: with control the mouse and keys go on the VNC socket, the video’s socket has its answers only', async () => {
    const { socket } = await controlled()
    const video = FakeSocket.made[1]
    expect(askedPicture(socket)).toBe(false)
    const at = { clientX: 250, clientY: 150, button: 0, pointerId: 1, pointerType: 'mouse' }
    fire(canvas(), 'pointerdown', { ...at, buttons: 1 })
    fire(canvas(), 'pointerup', { ...at, buttons: 0 })
    key(canvas(), { key: 'a', code: 'KeyA' })
    key(canvas(), { key: 'a', code: 'KeyA' }, 'keyup')
    expect(socket?.sent).toEqual([
      [5, 1, 0, 2, 0, 1],
      [5, 0, 0, 2, 0, 1],
      [4, 1, 0, 0, 0, 0, 0, 0x61],
      [4, 0, 0, 0, 0, 0, 0, 0x61],
    ])
    expect(video?.sent).toEqual([])
    expect(byClass('desk-who')?.textContent).toBe('You have control')
  })

  test('a page out of sight: its video closes (the board’s encoder with it) and opens again with it; the VNC and control stay', async () => {
    render({ desktop: desktop(), open: true })
    const [vnc, video] = FakeSocket.made
    vncHello(vnc)
    try {
      Reflect.set(dom.document, 'hidden', true)
      flush(() => dom.document.dispatchEvent(new MiniEvent('visibilitychange')))
      expect(video?.closed).toBe(true)
      expect(vnc?.closed).toBe(false)
      expect(FakeSocket.made).toHaveLength(2)
      Reflect.set(dom.document, 'hidden', false)
      flush(() => dom.document.dispatchEvent(new MiniEvent('visibilitychange')))
      expect(FakeSocket.made).toHaveLength(3)
      expect(FakeSocket.made[2]?.url).toBe('ws://board.test/api/desktop/a%20b%25/video?t=tok')
      // hidden, no VNC picture meanwhile: the video comes back
      expect(askedPicture(vnc)).toBe(false)
    } finally {
      Reflect.deleteProperty(dom.document, 'hidden')
    }
  })

  test('the view closed: both sockets closed, the decoder let go', async () => {
    render({ desktop: desktop(), open: true })
    const [vnc, video] = FakeSocket.made
    vncHello(vnc)
    video?.serve(keyFrame(1))
    await settle()
    click(desk('close'))
    expect(vnc?.closed).toBe(true)
    expect(video?.closed).toBe(true)
    expect(decoders[0]?.state).toBe('closed')
  })
})
