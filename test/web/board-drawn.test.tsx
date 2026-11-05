// The board's live connection while the page is not drawn (#333, api/useBoard.ts with
// models/drawn.ts), on a real DOM (jsdom): a window covered by another one stays on show to the
// page while no animation frame comes, and the updates the stream kept bringing were all kept by
// what waits for a frame (springs, the browser's transition events), until the renderer was
// killed. Now the stream is suspended as for a hidden page, and the first frame brings it back.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { LiveBoard } from '../../web/src/api/useBoard.ts'
import { DRAWN_MISSES } from '../../web/src/models/drawn.ts'
import { payload } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let useBoard: typeof import('../../web/src/api/useBoard.ts').useBoard

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const g = globalThis as Record<string, unknown>
const win = dom.window as unknown as Record<string, unknown>
const NAMES = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'location',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'EventSource',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setInterval',
  'clearInterval',
  'fetch',
  'IS_REACT_ACT_ENVIRONMENT',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const set = (name: string, value: unknown) =>
  Object.defineProperty(g, name, { value, configurable: true, writable: true })

/** The page's event streams, newest last: the test says when one opens and what comes. */
class FakeStream {
  static all: FakeStream[] = []
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false
  readyState = 1
  constructor() {
    FakeStream.all.push(this)
  }
  addEventListener(): void {}
  close(): void {
    this.closed = true
  }
}
const open = () => FakeStream.all.filter(s => !s.closed)

/** The frames asked for and the timers running, by id: the test draws and looks. */
const frames = new Map<number, () => void>()
const looks = new Map<number, () => void>()
let ids = 0
let snapshots = 0
let n = 0
/** A board the server sends: each one apart by its refresh time. */
const board = () => JSON.stringify(payload({ lastSuccessfulRefreshAt: ++n }))
let hidden = false
let online = true

beforeAll(async () => {
  for (const k of NAMES) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'location'])
    set(k, win[k])
  Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(dom.window.navigator, 'onLine', { configurable: true, get: () => online })
  const w = dom.window as unknown as EventTarget
  set('addEventListener', w.addEventListener.bind(w))
  set('removeEventListener', w.removeEventListener.bind(w))
  set('dispatchEvent', w.dispatchEvent.bind(w))
  set('EventSource', FakeStream)
  set('requestAnimationFrame', (fn: () => void) => {
    frames.set(++ids, fn)
    return ids
  })
  set('cancelAnimationFrame', (id: number) => frames.delete(id))
  set('setInterval', (fn: () => void) => {
    looks.set(++ids, fn)
    return ids
  })
  set('clearInterval', (id: number) => looks.delete(id))
  set('fetch', async () => {
    snapshots++
    return new Response(board(), { headers: { 'content-type': 'application/json' } })
  })
  set('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useBoard } = await import('../../web/src/api/useBoard.ts'))
})

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else Reflect.deleteProperty(g, k)
  }
  dom.window.close()
})

let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  FakeStream.all = []
  frames.clear()
  looks.clear()
  snapshots = 0
  hidden = false
  online = true
})

/** The page with the board on it; `live()` is what useBoard gave last. */
async function mount(): Promise<() => LiveBoard> {
  let last: LiveBoard | null = null
  function Probe() {
    last = useBoard()
    return null
  }
  root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => root?.render(<Probe />))
  await opened()
  return () => last as unknown as LiveBoard
}
/** The stream the page opened last says it is open. */
const opened = () => act(async () => open()[0]?.onopen?.(new Event('open')))
const draw = () =>
  act(async () => {
    const due = [...frames.values()]
    frames.clear()
    for (const fn of due) fn()
  })
const look = (times = 1) =>
  act(async () => {
    for (let i = 0; i < times; i++) for (const fn of [...looks.values()]) fn()
  })
const say = () => act(async () => open()[0]?.onmessage?.(new MessageEvent('message', { data: board() })))
const fire = (type: string, target: EventTarget = window) => act(async () => void target.dispatchEvent(new Event(type)))

test('a page drawn as usual keeps its stream and takes every board it brings', async () => {
  const live = await mount()
  expect(live().connected).toBe(true)
  for (let i = 0; i < 5; i++) {
    await say()
    await draw()
    await look()
  }
  expect(FakeStream.all.length).toBe(1)
  expect(open().length).toBe(1)
  expect(live().data?.lastSuccessfulRefreshAt).toBe(n)
})

test('a frame held back past one look (a long task) keeps the stream', async () => {
  await mount()
  await look(DRAWN_MISSES - 1)
  await draw()
  await look()
  expect(FakeStream.all.length).toBe(1)
  expect(open().length).toBe(1)
})

test('on show but no frame over two looks: the stream is closed, and the first frame opens a new one', async () => {
  const live = await mount()
  await say()
  const before = live().data
  // the window is covered: the frame asked for does not come
  await look(DRAWN_MISSES)
  expect(open().length).toBe(0)
  expect(live().connected).toBe(false)
  // nothing more comes in while it is not drawn, however long it lasts; one frame asked for all along
  await look(20)
  expect(FakeStream.all.length).toBe(1)
  expect(frames.size).toBe(1)
  expect(live().data).toBe(before)
  // uncovered: the frame comes, a new stream and a fresh board
  const asked = snapshots
  await draw()
  expect(open().length).toBe(1)
  expect(FakeStream.all.length).toBe(2)
  expect(snapshots).toBe(asked + 1)
  await opened()
  await say()
  expect(live().connected).toBe(true)
  expect(live().data?.lastSuccessfulRefreshAt).toBe(n)
})

test('shown again or back online while still not drawn (pageshow, online, visibilitychange): it waits for the frame', async () => {
  await mount()
  await look(DRAWN_MISSES)
  expect(open().length).toBe(0)
  await fire('pageshow')
  online = false
  await fire('offline')
  online = true
  await fire('online')
  hidden = true
  await fire('visibilitychange', document)
  hidden = false
  await fire('visibilitychange', document)
  expect(FakeStream.all.length).toBe(1)
  await draw()
  expect(open().length).toBe(1)
  expect(FakeStream.all.length).toBe(2)
})

test('a hidden page: suspended as before; a frame that comes while it is hidden does not open it, showing it does', async () => {
  await mount()
  hidden = true
  await fire('visibilitychange', document)
  expect(open().length).toBe(0)
  // hidden pages get no frames: the watch says so, and nothing opens
  await look(DRAWN_MISSES)
  await draw()
  expect(open().length).toBe(0)
  hidden = false
  await fire('visibilitychange', document)
  expect(open().length).toBe(1)
  expect(FakeStream.all.length).toBe(2)
})

test('gone with the page: no more looks, and the frame it asked for is given back', async () => {
  await mount()
  expect(looks.size).toBe(1)
  expect(frames.size).toBe(1)
  await act(async () => root?.unmount())
  root = null
  expect(looks.size).toBe(0)
  expect(frames.size).toBe(0)
})

test('a browser without animation frames keeps its stream as before: no watch', async () => {
  const raf = Object.getOwnPropertyDescriptor(g, 'requestAnimationFrame')
  Reflect.deleteProperty(g, 'requestAnimationFrame')
  try {
    await mount()
    expect(looks.size).toBe(0)
    expect(open().length).toBe(1)
  } finally {
    if (raf) Object.defineProperty(g, 'requestAnimationFrame', raf)
  }
})
