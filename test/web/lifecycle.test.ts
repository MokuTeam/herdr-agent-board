import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  anyLayerOpen,
  type BoardStream,
  boardConnection,
  type DialogLayer,
  dialogHistory,
  type HistoryLike,
  PAGE_LAYERS,
  type PageLayer,
  pageLayers,
  topLayer,
} from '../../web/src/models/lifecycle.ts'
import { oldSource } from './support/old-app.ts'

type FakeStream = BoardStream & { closed: boolean }

const stream = (): FakeStream => ({
  closed: false,
  onopen: null,
  onerror: null,
  onmessage: null,
  close() {
    this.closed = true
  },
})
const message = (value: unknown) => new MessageEvent('message', { data: JSON.stringify(value) })
const event = (type: string) => new Event(type)

test('return/reconnect closes old streams and ignores delayed GET/events from old generations', async () => {
  const streams: FakeStream[] = []
  const requests: ((value: unknown) => void)[] = []
  const received: unknown[] = []
  const states: boolean[] = []
  const connection = boardConnection({
    source() {
      const s = stream()
      streams.push(s)
      return s
    },
    snapshot: () => new Promise(resolve => requests.push(resolve)),
    data: d => received.push(d.tag),
    connected: v => states.push(v),
  })
  connection.resume()
  connection.resume()
  assert.equal(streams[0]?.closed, true)
  requests[0]?.({ items: [], tag: 'old' })
  streams[0]?.onmessage?.(message({ items: [], tag: 'old-event' }))
  streams[1]?.onmessage?.(message({ items: [], tag: 'new' }))
  requests[1]?.({ items: [], tag: 'late-get' })
  await Promise.resolve()
  assert.deepEqual(received, ['new'])
  connection.suspend()
  assert.equal(states.at(-1), false)
  connection.resume()
  requests[2]?.({ items: [], tag: 'returned' })
  await Promise.resolve()
  assert.deepEqual(received, ['new', 'returned'])
})

test('a page left mid-request: the aborted snapshot and a failed one are no unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => void unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    let fail = false
    const states: boolean[] = []
    const connection = boardConnection({
      source: stream,
      snapshot: signal =>
        new Promise((_, reject) => {
          if (fail) return reject(new TypeError('Failed to fetch'))
          signal.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')))
        }),
      data: () => {},
      connected: v => states.push(v),
    })
    connection.resume()
    connection.suspend() // hidden, offline or leaving: the request is aborted
    fail = true
    connection.resume() // and one that fails on its own
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [])
    assert.equal(states.at(-1), false)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

type FakeHistory = HistoryLike & { state: Record<string, unknown> | null }

test('Back closes top dialog only; manual close consumes its entry and rapid reopening is preserved', () => {
  let layers: string[] = []
  let backs = 0
  let pushes = 0
  const history: FakeHistory = {
    state: { other: 1 },
    pushState(s) {
      this.state = s
      pushes++
    },
    replaceState(s) {
      this.state = s
    },
    back() {
      backs++
    },
  }
  const controller = dialogHistory({
    history,
    mobile: () => true,
    isOpen: () => layers.length > 0,
    closeTop: () => layers.pop(),
  })
  layers.push('session')
  controller.sync()
  layers.push('preview')
  controller.sync()
  assert.equal(pushes, 1)
  history.state = { other: 1 }
  controller.pop()
  assert.deepEqual(layers, ['session'])
  assert.equal(pushes, 2)
  layers = []
  controller.sync()
  assert.equal(backs, 1)
  layers = ['new-session']
  controller.sync()
  history.state = { other: 1 }
  controller.pop()
  assert.deepEqual(layers, ['new-session'])
  assert.equal(pushes, 3)
  assert.equal(history.state.other, 1)
})

test('wide desktop does not add dialog history entries', () => {
  let pushes = 0
  const history: FakeHistory = {
    state: null,
    pushState() {
      pushes++
    },
    replaceState() {},
    back() {},
  }
  const controller = dialogHistory({ history, mobile: () => false, isOpen: () => true, closeTop() {} })
  controller.sync()
  assert.equal(pushes, 0)
})

test('late GET after an SSE failure stays read-only until the stream reconnects', async () => {
  let current: FakeStream | undefined
  let resolveSnapshot: ((value: unknown) => void) | undefined
  const states: boolean[] = []
  const connection = boardConnection({
    source() {
      current = stream()
      return current
    },
    snapshot: () =>
      new Promise(resolve => {
        resolveSnapshot = resolve
      }),
    data() {},
    connected: value => states.push(value),
  })
  connection.resume()
  current?.onerror?.(event('error'))
  resolveSnapshot?.({ items: [] })
  await Promise.resolve()
  assert.equal(states.at(-1), false)
  current?.onopen?.(event('open'))
  assert.equal(states.at(-1), true)
})

test('a board the page cannot read is not taken, and the page is not connected until one it can read comes', async () => {
  let current: FakeStream | undefined
  let resolveSnapshot: ((value: unknown) => void) | undefined
  const received: unknown[] = []
  const states: boolean[] = []
  const connection = boardConnection({
    source() {
      current = stream()
      return current
    },
    snapshot: () =>
      new Promise(resolve => {
        resolveSnapshot = resolve
      }),
    readable: value => value.ok === true,
    data: d => received.push(d.tag),
    connected: value => states.push(value),
  })
  connection.resume()
  current?.onopen?.(event('open'))
  resolveSnapshot?.({ items: [], tag: 'unreadable snapshot' })
  await Promise.resolve()
  assert.deepEqual(received, [])
  assert.equal(states.at(-1), false)
  current?.onmessage?.(message({ items: [], ok: true, tag: 'good' }))
  assert.equal(states.at(-1), true)
  // The page shows the board it read last, and says it no longer follows the board.
  current?.onmessage?.(message({ items: [], tag: 'unreadable event' }))
  assert.deepEqual(received, ['good'])
  assert.equal(states.at(-1), false)
  current?.onmessage?.(message({ items: [], ok: true, tag: 'good again' }))
  assert.deepEqual(received, ['good', 'good again'])
  assert.equal(states.at(-1), true)
})

test('reload consumes an abandoned dialog sentinel without closing a newly opened panel', () => {
  let backs = 0
  let pushes = 0
  let open = false
  let closed = 0
  const history: FakeHistory = {
    state: { agentBoardDialog: true },
    back() {
      backs++
    },
    pushState(state) {
      this.state = state
      pushes++
    },
    replaceState(state) {
      this.state = state
    },
  }
  const controller = dialogHistory({
    history,
    mobile: () => true,
    isOpen: () => open,
    closeTop() {
      closed++
      open = false
    },
  })
  assert.equal(backs, 1)
  open = true
  controller.sync()
  history.state = null
  controller.pop()
  assert.equal(closed, 0)
  assert.equal(open, true)
  assert.equal(pushes, 1)
})

test('Back closes the topmost open layer of those the page lists, topmost first', () => {
  const closed: string[] = []
  const layer = (name: string, open: boolean) => ({ open, close: () => closed.push(name) })
  const layers = [layer('menu', false), layer('limits', true), layer('panel', true)]
  assert.equal(anyLayerOpen(layers), true)
  topLayer(layers)?.close()
  assert.deepEqual(closed, ['limits'])
  assert.equal(anyLayerOpen([layer('menu', false)]), false)
  assert.equal(topLayer([layer('menu', false)]), undefined)
})

test("the page's layers close in upstream's order: the terminal window before the helpers window", () => {
  // dialogBack's closeTop in web/app.js at the merge of #41, the newest change that added a layer.
  const closeTop = oldSource('web/app.js', 'a496257')
    .split('\n')
    .find(line => line.startsWith('  closeTop:'))
  const OLD: Record<string, PageLayer> = {
    menu: 'menu',
    launchUI: 'launch',
    files: 'files',
    termUI: 'terminal',
    helpersUI: 'helpers',
    limitsOpen: 'limits',
    setupNote: 'setup',
    panels: 'panels',
  }
  const upstream = [...(closeTop ?? '').matchAll(/(\w+)(?:\??\.isOpen\(\)|\(\)) \?|(panels)\.find/g)].map(
    m => OLD[m[1] ?? m[2] ?? ''],
  )
  assert.deepEqual(PAGE_LAYERS, upstream)
  // Both windows open: Back closes the terminal first, then the helpers window.
  const closed: string[] = []
  const shown = new Set<PageLayer>(['terminal', 'helpers', 'panels'])
  const layer = (name: PageLayer): DialogLayer => ({
    open: shown.has(name),
    close: () => {
      closed.push(name)
      shown.delete(name)
    },
  })
  const layers = () =>
    pageLayers({
      menu: layer('menu'),
      launch: layer('launch'),
      files: layer('files'),
      terminal: layer('terminal'),
      helpers: layer('helpers'),
      limits: layer('limits'),
      setup: layer('setup'),
      panels: layer('panels'),
    })
  topLayer(layers())?.close()
  topLayer(layers())?.close()
  assert.deepEqual(closed, ['terminal', 'helpers'])
})
