// The open sheet's detail of a node session reads itself again while its thread is live (#938,
// Workdesk BOARD-18): a Zenbook Codex card keeps its activity, status and column while it answers,
// so the card never asks for a read; the reply showed only on reopening and the message sent went.
// A card of this computer keeps the reads it had: no timer, no request of its own.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Item } from '../../src/core/types.ts'
import { answers, type Call, restoreFetch } from './support/fetch-answers.ts'

let createRoot: typeof import('react-dom/client').createRoot
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let useSessionDetail: typeof import('../../web/src/hooks/useSessionDetail.ts').useSessionDetail
let support: typeof import('./support/board.tsx')

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'localStorage'] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

// The page's timers that repeat, kept here and run when the test says: no test waits seconds.
let ticks: (() => void)[] = []
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.setInterval = ((run: () => void) => {
    ticks.push(run)
    return ticks.length
  }) as unknown as typeof setInterval
  g.clearInterval = ((id: number) => {
    ticks[id - 1] = () => {}
  }) as unknown as typeof clearInterval
  ;({ createRoot } = await import('react-dom/client'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ useSessionDetail } = await import('../../web/src/hooks/useSessionDetail.ts'))
  support = await import('./support/board.tsx')
})

afterEach(() => {
  restoreFetch()
  ticks = []
})

afterAll(() => {
  g.setInterval = realSetInterval
  g.clearInterval = realClearInterval
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const NOW = Date.now()

const detail = (key: string, conversation: { role: string; text: string; at: number }[]) =>
  [
    200,
    { item: { key }, conversation, queued: [], screen: '', dialog: null, checkout: false, helpers: [], workflows: [] },
  ] as [number, unknown]

/** The sheet's detail of `it`, opened; `api.load` stands for what a message sent asks. */
async function opened(it: Item) {
  const seen: { value: ReturnType<typeof useSessionDetail> | null } = { value: null }
  function Probe() {
    seen.value = useSessionDetail(it.key)
    return null
  }
  const value = support.board({ data: support.payload({ items: [it] }), ui: { open: it.key } })
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  await act(async () => {
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={value}>
          <Probe />
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  const settle = () => act(async () => await new Promise(r => setTimeout(r, 0)))
  await settle()
  return {
    root,
    settle,
    conversation: () => seen.value?.value.data?.conversation.map(t => ('text' in t ? t.text : '')) ?? [],
    load: async () => {
      await act(async () => seen.value?.load(it.key))
      await settle()
    },
    tick: async () => {
      await act(async () => {
        for (const run of ticks) run()
      })
      await settle()
    },
  }
}

const reads = (calls: Call[]) => calls.filter(c => c.url.startsWith('/api/session/')).length

test('a node session: after a message sent, its reply comes by itself and the message stays in the thread', async () => {
  const key = '@win-laptop:01a2195e-6aba-7081-a2f6-d783bb12deba'
  const it = support.item({ key, device: 'win-laptop', column: 'ext', status: 'done', activity: NOW - 3_600_000 })
  const before = [{ role: 'assistant', text: 'earlier', at: NOW - 3_600_000 }]
  const sent = { role: 'user', text: 'привет, Zenbook', at: NOW - 500 }
  const reply = { role: 'assistant', text: 'ответ с Zenbook', at: NOW }
  const calls = answers(
    detail(key, before),
    detail(key, before),
    detail(key, [...before, sent]),
    detail(key, [...before, sent, reply]),
  )
  const s = await opened(it)
  expect(s.conversation()).toEqual(['earlier'])
  // The read a message sent asks for comes before the node's transcript has it.
  await s.load()
  expect(s.conversation()).toEqual(['earlier'])
  // The card says nothing new; the sheet reads again on its own.
  await s.tick()
  expect(s.conversation()).toEqual(['earlier', 'привет, Zenbook'])
  await s.tick()
  expect(s.conversation()).toEqual(['earlier', 'привет, Zenbook', 'ответ с Zenbook'])
  expect(reads(calls)).toBe(4)
  expect(calls[0]?.url).toBe(`/api/session/${encodeURIComponent(key)}`)
  await act(async () => s.root.unmount())
})

test('a node session at rest (nothing sent, its newest turn long ago): no reads of its own', async () => {
  const key = '@win-laptop:pane-w6:p7'
  const it = support.item({ key, session: null, device: 'win-laptop' })
  const calls = answers(detail(key, [{ role: 'assistant', text: 'old', at: NOW - 3_600_000 }]))
  const s = await opened(it)
  await s.tick()
  await s.tick()
  expect(reads(calls)).toBe(1)
  await act(async () => s.root.unmount())
})

test('a card of this computer: no timer at all, the reads it had before', async () => {
  const key = 'a6c71b28-4a05-4fb3-8c99-5a79c356733d'
  const it = support.item({ key, column: 'work', status: 'working', activity: NOW })
  const calls = answers(
    detail(key, [{ role: 'user', text: 'hi', at: NOW }]),
    detail(key, [{ role: 'user', text: 'hi', at: NOW }]),
  )
  const s = await opened(it)
  expect(ticks).toEqual([])
  await s.load()
  await s.tick()
  expect(reads(calls)).toBe(2)
  await act(async () => s.root.unmount())
})
