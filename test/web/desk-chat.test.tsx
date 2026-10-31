// The chat beside an agent's browser shown full size (components/sheet/BrowserFold.tsx "Chat",
// hooks/useDeskChat.ts, models/desk-chat.ts): the session panel's own conversation and message box
// (SheetView), moved beside the picture and back, on the right or at the bottom as the viewer
// keeps it, its edge resizing it. The keys go where the focus is: typed in the chat's box, with
// control or not, they are the chat's and none goes to the browser, Esc there leaves the box (the
// board's own keys) and not full size; on the picture, and in the touch keyboard's field by it,
// they go to the browser as before. Drawn by react-dom into the small DOM (support/mini-dom.ts),
// with a fake WebSocket and the board's answers to its POSTs, as test/web/browser-fold.test.tsx.
// Full size without the chat, a fold without "Chat" and a phone stay as they were.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createRef, type ReactNode } from 'react'
import type { Item, ItemDesktop } from '../../src/core/types.ts'
import type { PanelPlace } from '../../web/src/components/panel/place.ts'
import type { SheetView as View } from '../../web/src/components/sheet/Sheet.tsx'
import type { useBoardKeys as UseBoardKeys } from '../../web/src/hooks/useBoardKeys.ts'
import { type ComposerControls, NO_OUTBOX } from '../../web/src/hooks/useComposer.ts'
import { emptyDetail } from '../../web/src/hooks/useSessionDetail.ts'
import type { I18nProvider as Provider } from '../../web/src/i18n/I18nProvider.tsx'
import {
  CHAT_KEY,
  CHAT_MIN,
  chatDock,
  chatKeySize,
  chatLimits,
  draggedChatSize,
  escLeavesFull,
  PICTURE_MIN,
  restoreChat,
  serializeChat,
} from '../../web/src/models/desk-chat.ts'
import { PHONE_QUERY } from '../../web/src/models/panel-motion.ts'
import type { Board } from '../../web/src/state/BoardProvider.tsx'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { layout, MiniElement, MiniEvent, type MiniNode, miniWindow } from './support/mini-dom.ts'

// ---------------------------------------------------------------- the place and the keys, as rules

describe('where it sits and how big', () => {
  test('the viewer’s place from storage, whatever cannot be read the default', () => {
    expect(restoreChat(null)).toEqual({ dock: null, side: null, bottom: null })
    expect(restoreChat('{oops')).toEqual({ dock: null, side: null, bottom: null })
    expect(restoreChat(JSON.stringify({ dock: 'left', side: -3, bottom: 'x' }))).toEqual({
      dock: null,
      side: null,
      bottom: null,
    })
    const kept = { dock: 'bottom' as const, side: 512, bottom: 300 }
    expect(restoreChat(serializeChat(kept))).toEqual(kept)
  })

  test('until the viewer picks one, as the session panel docks: at the bottom with it, else on the right', () => {
    const none = restoreChat(null)
    expect(chatDock(none, 'bottom')).toBe('bottom')
    expect(['right', 'left', 'float'].map(d => chatDock(none, d as 'right'))).toEqual(['right', 'right', 'right'])
    expect(chatDock({ ...none, dock: 'right' }, 'bottom')).toBe('right')
    expect(chatDock({ ...none, dock: 'bottom' }, 'right')).toBe('bottom')
  })

  test('its edge: towards the picture it grows, never below its least nor taking the picture’s', () => {
    const side = chatLimits('right', 1000)
    expect(side).toEqual({ min: CHAT_MIN.side, max: 1000 - PICTURE_MIN.w })
    expect(draggedChatSize('right', 420, -80, 0, side)).toBe(500)
    expect(draggedChatSize('right', 420, 400, 0, side)).toBe(CHAT_MIN.side)
    expect(draggedChatSize('right', 420, -900, 0, side)).toBe(1000 - PICTURE_MIN.w)
    const low = chatLimits('bottom', 600)
    expect(draggedChatSize('bottom', 240, 0, -60, low)).toBe(300)
    expect(chatLimits('right', 200)).toEqual({ min: CHAT_MIN.side, max: CHAT_MIN.side })
    // Keys as on a docked panel's edge: the arrow towards the picture grows it, Shift bigger steps.
    expect(chatKeySize('right', 420, 'ArrowLeft', false, side)).toBe(436)
    expect(chatKeySize('right', 420, 'ArrowRight', true, side)).toBe(356)
    expect(chatKeySize('bottom', 240, 'ArrowUp', false, low)).toBe(256)
    expect(chatKeySize('bottom', 240, 'Home', false, low)).toBe(CHAT_MIN.bottom)
    expect(chatKeySize('right', 420, 'a', false, side)).toBe(null)
  })
})

// ---------------------------------------------------------------- in the page

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
let SheetView: typeof View
let useBoardKeys: typeof UseBoardKeys
let I18nProvider: typeof Provider
let BoardContext: React.Context<Board | null>
let PanelContext: React.Context<PanelPlace | null>
let boardOf: (items: Item[]) => Board
let itemOf: (fields: Partial<Item> & Pick<Item, 'key'>) => Item
let useState: typeof import('react').useState
let KEYS_AT = ''
let createRootOf: (el: MiniElement) => { render(node: ReactNode): void; unmount(): void }
const saved = {
  WebSocket: globalThis.WebSocket,
  location: Reflect.get(globalThis, 'location'),
  add: globalThis.addEventListener,
  remove: globalThis.removeEventListener,
  matchMedia: Reflect.get(globalThis, 'matchMedia'),
  localStorage: Reflect.get(globalThis, 'localStorage'),
  HTMLInputElement: Reflect.get(globalThis, 'HTMLInputElement'),
}
/** The board's Escape closing the panel (its keys, hooks/useBoardKeys.ts). */
let panelClosed = 0
/** localStorage, as the page's. */
const stored = new Map<string, string>()

beforeAll(async () => {
  dom = miniWindow(800)
  // Where react-dom finds no input event (the small DOM has none) it watches a field typed in the
  // old way: give the field the calls it makes, which do nothing here.
  for (const name of ['attachEvent', 'detachEvent'])
    Object.defineProperty(MiniElement.prototype, name, { value() {}, configurable: true })
  // The board's keys look the panel up by its id, and ask whether a search field has the focus.
  Reflect.set(dom.document, 'getElementById', (id: string) => byId(id) ?? null)
  Reflect.set(globalThis, 'HTMLInputElement', class {})
  // …and asks the window what is selected as a key goes down in a field: nothing.
  Reflect.set(dom.window, 'getSelection', () => ({
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    rangeCount: 0,
  }))
  Reflect.set(globalThis, 'WebSocket', FakeSocket)
  Reflect.set(globalThis, 'location', { protocol: 'http:', host: 'board.test' })
  // The page's own listeners on the window (the board's keys) are the small DOM's window's.
  Reflect.set(globalThis, 'addEventListener', dom.window.addEventListener.bind(dom.window))
  Reflect.set(globalThis, 'removeEventListener', dom.window.removeEventListener.bind(dom.window))
  Reflect.set(globalThis, 'localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  })
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  createRootOf = el => createRoot(el as unknown as HTMLElement)
  ;({ useState } = await import('react'))
  ;({ SheetView } = await import('../../web/src/components/sheet/Sheet.tsx'))
  ;({ useBoardKeys } = await import('../../web/src/hooks/useBoardKeys.ts'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ PanelContext } = await import('../../web/src/state/PanelProvider.tsx'))
  KEYS_AT = Reflect.get(await import('../../web/src/hooks/useDesktop.ts'), 'KEYS_AT') ?? ''
  const support = await import('./support/board.tsx')
  boardOf = items => support.board({ data: support.payload({ fsToken: 'tok', items }), ui: { open: KEY } })
  itemOf = support.item
  flush = flushSync
})

beforeEach(() => {
  const container = dom.document.body.appendChild(dom.document.createElement('div'))
  const r = createRootOf(container)
  root = r
  draw = node => flush(() => r.render(node))
  panelClosed = 0
  stored.clear()
})

afterEach(() => {
  layout.rect = () => ({ left: 0, top: 0, width: 0, height: 0 })
  flush(() => root.unmount())
  for (const c of [...dom.document.body.childNodes]) dom.document.body.removeChild(c)
  restoreFetch()
  FakeSocket.made = []
  Reflect.set(globalThis, 'matchMedia', saved.matchMedia)
})

afterAll(async () => {
  await new Promise(done => setTimeout(done, 20))
  for (const name of ['attachEvent', 'detachEvent']) Reflect.deleteProperty(MiniElement.prototype, name)
  Reflect.deleteProperty(dom.document, 'getElementById')
  Reflect.set(globalThis, 'HTMLInputElement', saved.HTMLInputElement)
  Reflect.deleteProperty(dom.window, 'getSelection')
  dom.uninstall()
  Reflect.set(globalThis, 'WebSocket', saved.WebSocket)
  Reflect.set(globalThis, 'location', saved.location)
  Reflect.set(globalThis, 'addEventListener', saved.add)
  Reflect.set(globalThis, 'removeEventListener', saved.remove)
  Reflect.set(globalThis, 'localStorage', saved.localStorage)
})

const KEY = 'a b%'
const desktop = (fields: Partial<ItemDesktop> = {}): ItemDesktop => ({
  running: true,
  profile: null,
  control: 'agent',
  asks: false,
  ...fields,
})

/** The message box's controls as the sheet has them (hooks/useComposer.ts), a text kept. */
function composerOf(): ComposerControls {
  return {
    text: '',
    attachments: [],
    sending: false,
    messageRef: createRef(),
    input() {},
    send() {},
    discard() {},
    addFiles() {},
    removeFile() {},
    outbox: NO_OUTBOX,
  }
}

/** The session panel as Sheet.tsx draws it: the fold open, where the chat's parts are kept, the board's keys. */
function InSheet({ item, chat }: { item: Item; chat: boolean }) {
  const [open, setOpen] = useState(true)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [composer] = useState(composerOf)
  useBoardKeys({
    openNextAttention() {},
    newSession() {},
    panelOpen: () => true,
    closePanel: () => void panelClosed++,
    sessionPanelOpen: () => true,
  })
  return (
    <aside className="sheet open" id="sheet" data-dock="right">
      <div className="sheet-inner">
        <SheetView
          open={item.key}
          item={item}
          detail={emptyDetail(item.key)}
          composer={composer}
          browser={{ open, onOpen: setOpen, ...(chat && { chatHost: host, onChatHost: setHost }) }}
        />
      </div>
    </aside>
  )
}

function render(fields: { control?: 'agent' | 'owner'; chat?: boolean; panel?: Partial<PanelPlace> | null } = {}) {
  const item = itemOf({ key: KEY, name: 'Alpha', desktop: desktop({ control: fields.control ?? 'agent' }) })
  const sheet = <InSheet item={item} chat={fields.chat ?? true} />
  draw(
    <I18nProvider lang="en">
      <BoardContext.Provider value={boardOf([item])}>
        {fields.panel ? (
          <PanelContext.Provider value={fields.panel as PanelPlace}>{sheet}</PanelContext.Provider>
        ) : (
          sheet
        )}
      </BoardContext.Provider>
    </I18nProvider>,
  )
}

const all = (node: MiniNode): MiniElement[] =>
  node.childNodes.flatMap(c => (c instanceof MiniElement ? [c, ...all(c)] : []))
const find = (match: (el: MiniElement) => boolean, under: MiniNode = dom.document.body) => all(under).find(match)
const desk = (name: string, under?: MiniNode) => find(el => el.getAttribute('data-desk') === name, under)
const byClass = (name: string, under?: MiniNode) => find(el => el.className.split(' ').includes(name), under)
const byId = (id: string) => find(el => el.id === id)
const canvas = () => find(el => el.localName === 'canvas')
const full = () => byClass('desk-full')
const sheet = () => byId('sheet')
const within = (el: MiniNode | undefined, parent: MiniNode | undefined) => !!el && !!parent?.contains(el)
const click = (el: MiniElement | undefined) => {
  if (!el) throw new Error('nothing to click')
  flush(() => el.dispatchEvent(new MiniEvent('click')))
}
const fire = (el: MiniNode | undefined, type: string, fields: Record<string, unknown> = {}) => {
  if (!el) throw new Error(`nothing to ${type}`)
  const e = Object.assign(new MiniEvent(type), fields)
  flush(() => (el as MiniElement).dispatchEvent(e))
  return e
}
const key = (el: MiniNode | undefined, fields: Record<string, unknown>, type = 'keydown') => fire(el, type, fields)
/** The focus to `el`, with the focusin a browser sends (react-dom follows the field typed in by it). */
const focus = (el: MiniElement | undefined) => {
  el?.focus()
  fire(el, 'focusin')
}
const settle = () => new Promise(done => setTimeout(done, 15))

function handshake(socket: FakeSocket | undefined) {
  if (!socket) throw new Error('no socket')
  socket.serve('RFB 003.008\n', [1, 1], [0, 0, 0, 0], [0, 4, 0, 2, ...new Array(16).fill(0), 0, 0, 0, 1, 120])
  socket.sent.length = 0
}

/** Full size with control taken, the display (4 × 2) drawn 400 × 200 at the window's corner. */
async function fullWithControl() {
  render()
  const [socket] = FakeSocket.made
  handshake(socket)
  answers([200, { ok: true, control: 'owner' }], [200, { ok: true, control: 'agent' }])
  click(desk('full'))
  click(desk('control', full()))
  await settle()
  layout.rect = el => ({ left: 0, top: 0, width: el.localName === 'canvas' ? 400 : 0, height: 200 })
  socket?.sent.splice(0)
  if (!socket) throw new Error('no socket')
  return socket
}

describe('"Chat" full size', () => {
  test('the panel’s own conversation and message box go beside the picture, and back', () => {
    render()
    const message = () => byId('message')
    const body = () => byId('sheet-body')
    expect(within(message(), sheet())).toBe(true)
    click(desk('full'))
    expect(desk('chat', full())?.getAttribute('aria-pressed')).toBe('false')
    expect(byClass('desk-chat')).toBeUndefined()

    click(desk('chat', full()))
    expect(desk('chat', full())?.getAttribute('aria-pressed')).toBe('true')
    expect(full()?.className).toBe('desk-full chat chat-right')
    const host = byClass('desk-chat-host')
    expect(within(message(), host)).toBe(true)
    expect(within(body(), host)).toBe(true)
    // Moved, not drawn twice: one message box, one conversation on the page.
    expect(all(dom.document.body).filter(el => el.id === 'message')).toHaveLength(1)
    expect(all(dom.document.body).filter(el => el.id === 'sheet-body')).toHaveLength(1)
    // The picture keeps its place in full size.
    expect(within(canvas(), byClass('desk-host', full()))).toBe(true)

    click(desk('chat', full()))
    expect(byClass('desk-chat')).toBeUndefined()
    expect(within(message(), sheet())).toBe(true)
    // Opened again and full size left: back in the panel.
    click(desk('chat', full()))
    click(desk('close', full()))
    expect(full()).toBeUndefined()
    expect(within(message(), sheet())).toBe(true)
    // Full size again: without the chat until asked.
    click(desk('full'))
    expect(byClass('desk-chat')).toBeUndefined()
    expect(desk('chat', full())?.getAttribute('aria-pressed')).toBe('false')
  })

  test('with control, what is typed in the chat’s box is the chat’s: nothing goes to its browser, Esc leaves the box and not full size', async () => {
    const socket = await fullWithControl()
    click(desk('chat', full()))
    const box = byId('message')
    if (!box) throw new Error('no message box')
    focus(box)
    for (const k of ['h', 'i', ' ', 'Enter', 'Backspace', 'ArrowLeft']) {
      const down = key(box, { key: k, code: k })
      key(box, { key: k, code: k }, 'keyup')
      expect([k, down.stopped]).toEqual([k, false])
    }
    key(box, { clipboardData: { getData: () => 'pasted', files: [] } }, 'paste')
    expect(socket.sent).toEqual([])
    // Esc in the box: the board's keys leave the box; full size, the panel and control stay.
    const esc = key(box, { key: 'Escape', code: 'Escape' })
    expect(esc.defaultPrevented).toBe(false)
    expect(full()).toBeDefined()
    expect(dom.document.activeElement).not.toBe(box)
    expect(panelClosed).toBe(0)
    expect(byClass('desk-who')?.textContent).toBe('You have control')
    expect(socket.sent).toEqual([])
    // Out of the box, Esc brings full size back as before (and the board does not close the panel).
    const again = key(dom.document.body, { key: 'Escape', code: 'Escape' })
    expect(again.defaultPrevented).toBe(true)
    expect(full()).toBeUndefined()
    expect(panelClosed).toBe(0)
  })

  test('a menu the chat opened takes its Esc: full size stays', async () => {
    // The board's menus hear the keys before the page (components/menu/menu-engine.ts, from the start).
    let menuOpen = true
    const menu = (e: MiniEvent & { key?: string }) => {
      if (menuOpen && e.key === 'Escape') {
        e.preventDefault()
        menuOpen = false
      }
    }
    dom.window.addEventListener('keydown', menu, true)
    try {
      await fullWithControl()
      click(desk('chat', full()))
      const more = byId('sheet-more')
      focus(more)
      key(more, { key: 'Escape', code: 'Escape' })
      expect(menuOpen).toBe(false)
      expect(full()).toBeDefined()
      // The next Esc, with no menu: full size goes, as before.
      key(more, { key: 'Escape', code: 'Escape' })
      expect(full()).toBeUndefined()
    } finally {
      dom.window.removeEventListener('keydown', menu, true)
    }
  })

  test('with the chat open, the picture still takes the keys when it has the focus, the touch keyboard’s field too', async () => {
    const socket = await fullWithControl()
    click(desk('chat', full()))
    focus(byId('message'))
    // A mouse on the picture: it has the keys.
    const at = { clientX: 250, clientY: 150, button: 0, pointerId: 1, pointerType: 'mouse' }
    fire(canvas(), 'pointerdown', { ...at, buttons: 1 })
    fire(canvas(), 'pointerup', { ...at, buttons: 0 })
    expect(dom.document.activeElement).toBe(canvas() as MiniElement)
    socket.sent.splice(0)
    key(canvas(), { key: 'a', code: 'KeyA' })
    key(canvas(), { key: 'a', code: 'KeyA' }, 'keyup')
    expect(socket.sent).toEqual([
      [4, 1, 0, 0, 0, 0, 0, 0x61],
      [4, 0, 0, 0, 0, 0, 0, 0x61],
    ])
    // A finger's tap: the field by the picture has them, its text goes as keys.
    const touch = { ...at, pointerType: 'touch' }
    fire(canvas(), 'pointerdown', { ...touch, buttons: 1 })
    fire(canvas(), 'pointerup', { ...touch, buttons: 0 })
    fire(canvas(), 'click', touch)
    const field = byClass('desk-keys')
    expect(dom.document.activeElement).toBe(field as MiniElement)
    socket.sent.splice(0)
    Reflect.set(field as object, 'value', `${KEYS_AT}x`)
    fire(field, 'input')
    expect(socket.sent).toEqual([
      [4, 1, 0, 0, 0, 0, 0, 0x78],
      [4, 0, 0, 0, 0, 0, 0, 0x78],
    ])
    // Esc on the picture leaves full size, as before.
    key(canvas(), { key: 'Escape', code: 'Escape' })
    expect(full()).toBeUndefined()
  })

  test('the place: as the panel docks until picked, flipped by its button and kept; its edge resizes it, kept too', async () => {
    render({ panel: { layout: { dock: 'bottom', side: null, bottom: null, float: null } } })
    click(desk('full'))
    click(desk('chat', full()))
    expect(full()?.className).toBe('desk-full chat chat-bottom')
    expect(desk('chat-dock', full())?.getAttribute('aria-label')).toBe('Chat on the right')
    click(desk('chat-dock', full()))
    expect(full()?.className).toBe('desk-full chat chat-right')
    expect(JSON.parse(stored.get(CHAT_KEY) ?? '{}')).toMatchObject({ dock: 'right' })

    // Its edge: the chat 400 wide beside a picture 576 wide; dragged 100 towards the picture.
    layout.rect = el =>
      el.className === 'desk-chat'
        ? { left: 600, top: 40, width: 400, height: 700 }
        : el.className === 'desk-view'
          ? { left: 12, top: 40, width: 576, height: 700 }
          : { left: 0, top: 0, width: 0, height: 0 }
    const edge = byClass('desk-chat-edge')
    expect(edge?.getAttribute('role')).toBe('separator')
    const at = { button: 0, pointerId: 3, clientY: 300 }
    fire(edge, 'pointerdown', { ...at, clientX: 600 })
    fire(edge, 'pointermove', { ...at, clientX: 550 })
    // A move is drawn on the next frame, as react-dom draws a pointer's moves.
    await settle()
    expect(full()?.style['--chat-size']).toBe('450px')
    fire(edge, 'pointermove', { ...at, clientX: 500 })
    fire(edge, 'pointerup', { ...at, clientX: 500 })
    expect(full()?.style['--chat-size']).toBe('500px')
    expect(JSON.parse(stored.get(CHAT_KEY) ?? '{}')).toMatchObject({ dock: 'right', side: 500 })
    // Never taking the picture's least.
    fire(edge, 'pointerdown', { ...at, clientX: 600 })
    fire(edge, 'pointerup', { ...at, clientX: -400 })
    expect(full()?.style['--chat-size']).toBe(`${400 + 576 - PICTURE_MIN.w}px`)
    // Keys, then a double-click for the default size.
    key(edge, { key: 'ArrowRight', shiftKey: true })
    expect(full()?.style['--chat-size']).toBe('336px')
    fire(edge, 'dblclick')
    expect(full()?.style['--chat-size']).toBeUndefined()

    // Next time: where the viewer left it.
    stored.set(CHAT_KEY, serializeChat({ dock: 'bottom', side: 500, bottom: 260 }))
    click(desk('close', full()))
    flush(() => root.unmount())
    const again = createRootOf(dom.document.body.appendChild(dom.document.createElement('div')))
    root = again
    draw = node => flush(() => again.render(node))
    render()
    click(desk('full'))
    click(desk('chat', full()))
    expect(full()?.className).toBe('desk-full chat chat-bottom')
    expect(full()?.style['--chat-size']).toBe('260px')
  })
})

describe('everywhere else as it was', () => {
  test('full size without the chat: the view as before, no pane, Esc and × as before', () => {
    render()
    click(desk('full'))
    expect(full()?.className).toBe('desk-full')
    expect(full()?.style['--chat-size']).toBeUndefined()
    expect(byClass('desk-chat')).toBeUndefined()
    expect(desk('chat-dock')).toBeUndefined()
    expect(within(canvas(), byClass('desk-host', full()))).toBe(true)
    expect(within(byId('message'), sheet())).toBe(true)
    key(dom.document.body, { key: 'Escape' })
    expect(full()).toBeUndefined()
  })

  test('a fold whose panel hands no conversation over has no "Chat"; nor has the fold', () => {
    render({ chat: false })
    expect(desk('chat')).toBeUndefined()
    click(desk('full'))
    expect(desk('chat')).toBeUndefined()
  })

  test('a phone (760 px and narrower) has no "Chat": no room beside the picture', () => {
    Reflect.set(globalThis, 'matchMedia', (query: string) => ({
      matches: query === PHONE_QUERY,
      addEventListener() {},
      removeEventListener() {},
    }))
    render()
    click(desk('full'))
    expect(full()).toBeDefined()
    expect(desk('chat')).toBeUndefined()
  })

  test('Esc: only a field of the chat that takes typing keeps it; the picture, its keys’ field, the bar and the chat’s buttons do not', () => {
    const doc = dom.document
    const chat = doc.createElement('div')
    const box = chat.appendChild(doc.createElement('textarea'))
    const search = chat.appendChild(doc.createElement('input'))
    const tick = chat.appendChild(doc.createElement('input'))
    tick.setAttribute('type', 'checkbox')
    const button = chat.appendChild(doc.createElement('button'))
    const keys = doc.createElement('textarea')
    const as = (el: MiniElement) => el as unknown as Element
    expect(escLeavesFull(as(box), as(chat))).toBe(false)
    expect(escLeavesFull(as(search), as(chat))).toBe(false)
    expect(escLeavesFull(as(tick), as(chat))).toBe(true)
    expect(escLeavesFull(as(button), as(chat))).toBe(true)
    expect(escLeavesFull(as(keys), as(chat))).toBe(true)
    expect(escLeavesFull(as(box), null)).toBe(true)
    expect(escLeavesFull(null, as(chat))).toBe(true)
  })
})
