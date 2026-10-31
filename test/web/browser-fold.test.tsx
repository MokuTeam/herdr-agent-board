// An agent's own browser in the session panel (components/sheet/BrowserFold.tsx, hooks/useDesktop.ts),
// drawn by react-dom into a small DOM (support/mini-dom.ts) so its effects run, with a fake
// WebSocket and the board's answers to its POSTs: the display's socket is open only while the fold
// is, full size comes and goes on the same socket (Esc, ×), nothing goes to the display until
// "Take control", and control is given back with the view. A session without a running browser
// has no fold.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
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
  onclose: (() => void) | null = null
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
function Harness({ item, shown, initial }: { item: Item; shown: boolean; initial: boolean }) {
  const [open, setOpen] = useState(initial)
  return <BrowserFold item={item} open={open && shown} onOpen={setOpen} />
}

function render(fields: { desktop?: ItemDesktop; shown?: boolean; open?: boolean } = {}) {
  const item = itemOf({ key: KEY, name: 'Alpha', ...(fields.desktop && { desktop: fields.desktop }) })
  const value = boardOf({ toast: text => toasts.push(text) })
  // Rendered again in a test, the same fold takes the new fields.
  draw(
    <I18nProvider lang="en">
      <BoardContext.Provider value={value}>
        <Harness item={item} shown={fields.shown ?? true} initial={fields.open ?? false} />
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
const within = (el: MiniNode | undefined, parent: MiniNode | undefined) => !!el && !!parent?.contains(el)

/** The display's hello: RFB 3.8, no password, a 4 × 2 screen. */
function handshake(socket: FakeSocket | undefined) {
  if (!socket) throw new Error('no socket')
  socket.serve('RFB 003.008\n', [1, 1], [0, 0, 0, 0], [0, 4, 0, 2, ...new Array(16).fill(0), 0, 0, 0, 1, 120])
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
