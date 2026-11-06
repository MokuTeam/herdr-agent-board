// Stop and Send now (#330) on a real DOM (jsdom): the first press arms Stop and says so, a double
// click or a press too soon stops nothing, Escape takes it back, the second press stops once and the
// card under it opens nothing; Send now asks once, says "Sending now…", and offers itself again when
// the server says no.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { QueuedPrompt } from '../../src/core/queue.ts'
import type { Item } from '../../src/core/types.ts'
import type { board as Board } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let StopButton: typeof import('../../web/src/components/StopButton.tsx').StopButton
let Waiting: typeof import('../../web/src/components/sheet/Thread.tsx').Waiting
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let board: typeof Board
let SETTLE_MS = 0

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const realFetch = globalThis.fetch

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ StopButton } = await import('../../web/src/components/StopButton.tsx'))
  ;({ Waiting } = await import('../../web/src/components/sheet/Thread.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ board } = await import('./support/board.tsx'))
  ;({ SETTLE_MS } = await import('../../web/src/models/stop-guard.ts'))
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null
async function click(el: Element | null, detail = 1) {
  expect(el).toBeTruthy()
  await act(async () => {
    el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail }))
    await new Promise(r => setTimeout(r, 20))
  })
}
async function key(el: Element | null, k: string) {
  await act(async () => {
    el?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

const S = '07624983-b6d4-410f-9664-28b0bc29b012'
const item = {
  key: S,
  session: S,
  name: 'Acme',
  agent: 'claude',
  pane: 'w1:p2',
  status: 'working',
  column: 'work',
  sleeping: false,
} as Item

async function mount(node: React.ReactNode, reply: (url: string, body: Record<string, unknown>) => Response) {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    sent.push({ url, body })
    return reply(url, body)
  }) as typeof fetch
  const toasts: string[] = []
  const opened: string[] = []
  const el = dom.window.document.getElementById('root') as HTMLElement
  el.innerHTML = ''
  const root = createRoot(el)
  await act(async () => {
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider
          value={board({
            data: { ...board().data, items: [item] } as ReturnType<typeof board>['data'],
            toast: text => toasts.push(text),
          })}
        >
          {/* The card under it: a click that reaches it would open the session. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a stand-in for the card */}
          <div className="card" onClick={() => opened.push('card')}>
            {node}
          </div>
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  return { sent, toasts, opened, root }
}

test('Stop: armed by a first press, not by a double click; Escape takes it back; the second press stops once', async () => {
  const { sent, toasts, opened, root } = await mount(<StopButton item={item} />, () => Response.json({ ok: true }))
  const stop = () => q('.stop-turn')
  expect(stop()?.getAttribute('aria-label')).toBe('Stop')
  expect(stop()?.textContent).toBe('')

  // A double click: its first click arms, its second (detail 2) is the same gesture.
  await click(stop(), 1)
  await click(stop(), 2)
  expect(stop()?.classList.contains('armed')).toBe(true)
  expect(stop()?.textContent).toBe('Stop?')
  expect(stop()?.getAttribute('title')).toBe('Press again to stop the turn')
  expect(sent).toEqual([])

  // Escape takes it back.
  await key(stop(), 'Escape')
  expect(stop()?.classList.contains('armed')).toBe(false)

  // Armed again; a press too soon does nothing, one a moment later stops, once.
  await click(stop())
  await click(stop())
  expect(sent).toEqual([])
  await act(async () => {
    await new Promise(r => setTimeout(r, SETTLE_MS + 30))
  })
  await click(stop())
  expect(sent.map(s => s.url)).toEqual([`/api/session/${encodeURIComponent(S)}/stop`])
  expect(stop()?.classList.contains('armed')).toBe(false)
  expect(toasts).toEqual(['Acme stopped'])
  // None of it opened the card.
  expect(opened).toEqual([])
  await act(async () => root.unmount())
})

test('Stop that did not stop: the server says so, and the toast is that', async () => {
  const { toasts, root } = await mount(<StopButton item={item} />, () =>
    Response.json({ ok: false, error: 'Acme did not stop: it is still working 6 s after Esc' }, { status: 409 }),
  )
  await click(q('.stop-turn'))
  await act(async () => {
    await new Promise(r => setTimeout(r, SETTLE_MS + 30))
  })
  await click(q('.stop-turn'))
  expect(toasts).toEqual(['Acme did not stop: it is still working 6 s after Esc'])
  await act(async () => root.unmount())
})

const QUEUED: QueuedPrompt[] = [{ text: 'also check the logs', at: 1000 }]

test('Send now: one request with the message, "Sending now…" while it goes in', async () => {
  const onSendNow = async (text: string) => {
    sentTexts.push(text)
    return { ok: true }
  }
  const sentTexts: string[] = []
  const { root } = await mount(<Waiting queued={QUEUED} own={[]} onSendNow={onSendNow} />, () => Response.json({}))
  expect(q('.msg.waiting .when')?.textContent).toBe('QueuedSend now')
  await click(q('.send-now'))
  expect(sentTexts).toEqual(['also check the logs'])
  expect(q('.msg.waiting')?.classList.contains('sending-now')).toBe(true)
  expect(q('.msg.waiting .when')?.textContent).toBe('Sending now…')
  expect(q('.send-now')).toBeNull()
  await act(async () => root.unmount())
})

test('Send now refused or with nothing left to send: back to "Queued", Send now offered again', async () => {
  for (const reply of [{ ok: false }, { ok: true, already: true }]) {
    const { root } = await mount(<Waiting queued={QUEUED} own={[]} onSendNow={async () => reply} />, () =>
      Response.json({}),
    )
    await click(q('.send-now'))
    expect(q('.msg.waiting')?.classList.contains('sending-now')).toBe(false)
    expect(q('.msg.waiting .when')?.textContent).toBe('QueuedSend now')
    await act(async () => root.unmount())
  }
})
