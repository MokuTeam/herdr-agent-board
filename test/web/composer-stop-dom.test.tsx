// Stop as the message box's send button (#340) on a real DOM (jsdom): one press stops the turn of a
// working session whose box is empty; typed text makes it Send again and the message goes as it
// always did, by Enter or by the button, with no stop; the second click of a double click on Send,
// Enter in the empty box, a key meant for the next message, or the box set to a side question,
// stops nothing.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, useRef, useState } from 'react'
import type { Item } from '../../src/core/types.ts'
import type { ComposerControls } from '../../web/src/hooks/useComposer.ts'
import type { board as Board } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let Composer: typeof import('../../web/src/components/sheet/Composer.tsx').Composer
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let sheet: typeof import('../../web/src/models/sheet.ts')
let translator: typeof import('../../src/core/i18n/translator.ts').translator
let NO_OUTBOX: typeof import('../../web/src/hooks/useComposer.ts').NO_OUTBOX
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
  ;({ Composer } = await import('../../web/src/components/sheet/Composer.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  sheet = await import('../../web/src/models/sheet.ts')
  ;({ translator } = await import('../../src/core/i18n/translator.ts'))
  ;({ NO_OUTBOX } = await import('../../web/src/hooks/useComposer.ts'))
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
const send = () => q('#composer .send') as HTMLButtonElement | null
const box = () => q('#message') as HTMLTextAreaElement | null
const wait = (ms: number) => act(async () => void (await new Promise(r => setTimeout(r, ms))))

async function key(el: Element | null, k: string, repeat = false) {
  let prevented = false
  await act(async () => {
    const e = new dom.window.KeyboardEvent('keydown', { key: k, repeat, bubbles: true, cancelable: true })
    el?.dispatchEvent(e)
    prevented = e.defaultPrevented
  })
  return prevented
}
async function click(el: Element | null, detail = 1) {
  expect(el).toBeTruthy()
  await act(async () => {
    el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail }))
    await new Promise(r => setTimeout(r, 20))
  })
}
async function type(value: string) {
  const el = box()
  expect(el).toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(el, value)
    el?.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function enter() {
  await act(async () => {
    box()?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 20))
  })
}

const S = '07624983-b6d4-410f-9664-28b0bc29b012'
const working = {
  key: S,
  session: S,
  name: 'Acme',
  agent: 'claude',
  pane: 'w1:p2',
  status: 'working',
  column: 'work',
  sleeping: false,
} as Item

/** The sheet's message box around `it`: the box keeps its text; a message sent leaves it, as useComposer does. */
function Box({ it, messages }: { it: Item; messages: string[] }) {
  const [text, setText] = useState('')
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const composer: ComposerControls = {
    text,
    attachments: [],
    sending: false,
    messageRef,
    input: setText,
    send: () => {
      if (!text.trim()) return
      messages.push(text)
      setText('')
    },
    discard: () => setText(''),
    addFiles() {},
    removeFile() {},
    outbox: NO_OUTBOX,
  }
  const t = translator('en')
  return (
    <Composer
      composer={composer}
      item={it}
      availability={sheet.sheetAvailability({ canMutate: true, canEdit: true, missing: false, turn: true }, t)}
      buttons={sheet.NO_HEAD_BUTTONS}
      changesHidden
      present
      canMutate
    />
  )
}

async function mount(it: Item = working) {
  const posted: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posted.push(url)
    return Response.json({ ok: true })
  }) as typeof fetch
  const toasts: string[] = []
  const messages: string[] = []
  const el = dom.window.document.getElementById('root') as HTMLElement
  el.innerHTML = ''
  const root = createRoot(el)
  /** The board's data moves on: the session as herdr says it is now. */
  const draw = (now: Item) =>
    act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider
            value={board({
              data: { ...board().data, items: [now], aside: true } as ReturnType<typeof board>['data'],
              ui: { open: now.key },
              toast: text => toasts.push(text),
            })}
          >
            <Box it={now} messages={messages} />
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
  await draw(it)
  const stops = () => posted.filter(u => u === `/api/session/${encodeURIComponent(S)}/stop`)
  return { posted, stops, toasts, messages, root, draw }
}

test('an empty box while the turn runs: one press on Stop stops it, once, with the toast', async () => {
  const { stops, toasts, root } = await mount()
  expect(send()?.classList.contains('stop')).toBe(true)
  expect(send()?.getAttribute('aria-label')).toBe('Stop')
  await wait(SETTLE_MS + 30)
  await click(send())
  expect(stops()).toHaveLength(1)
  expect(toasts).toEqual(['Acme stopped'])
  await act(async () => root.unmount())
})

test('typed text: Send again, and Enter or the button sends the message into the queue with no stop', async () => {
  const { stops, messages, root } = await mount()
  await type('one more thing')
  expect(send()?.classList.contains('stop')).toBe(false)
  expect(send()?.getAttribute('type')).toBe('submit')
  expect(send()?.getAttribute('aria-label')).toBe('Send')
  await enter()
  expect(messages).toEqual(['one more thing'])
  // The box is empty again: Stop, as the turn still runs.
  expect(send()?.classList.contains('stop')).toBe(true)

  await type('and this')
  await click(send())
  expect(messages).toEqual(['one more thing', 'and this'])
  expect(stops()).toEqual([])
  await act(async () => root.unmount())
})

test('a double click on Send, or a press right as it turned into Stop, sends once and stops nothing', async () => {
  const { stops, messages, root } = await mount()
  await type('a follow-up')
  // A double click: its first click sends, the box empties and the button turns into Stop under it.
  await click(send(), 1)
  await click(send(), 2)
  expect(messages).toEqual(['a follow-up'])
  // The second click of a double click stops nothing however late it comes.
  await wait(SETTLE_MS + 30)
  await click(send(), 2)
  // A quick second press, as a bounce, on a clock that does not move: still the gesture that sent.
  const realNow = Date.now
  const now = realNow()
  Date.now = () => now
  try {
    await type('another')
    await click(send(), 1)
    await click(send(), 1)
  } finally {
    Date.now = realNow
  }
  expect(messages).toEqual(['a follow-up', 'another'])
  expect(stops()).toEqual([])
  await act(async () => root.unmount())
})

test('the focus does not stay on the button: a key meant for the next message does not press Stop', async () => {
  const { stops, messages, root } = await mount()
  // Clicked to send (a click focuses the button): turned into Stop, it hands the focus to the box.
  await type('first')
  send()?.focus()
  await click(send())
  expect(messages).toEqual(['first'])
  expect(send()?.classList.contains('stop')).toBe(true)
  expect(dom.window.document.activeElement?.id).toBe('message')
  // Pressed Stop: the focus goes to the box too, where the next message is typed.
  await wait(SETTLE_MS + 30)
  send()?.focus()
  await click(send())
  expect(stops()).toHaveLength(1)
  expect(dom.window.document.activeElement?.id).toBe('message')
  await act(async () => root.unmount())
})

test('the keyboard presses Stop once; a held Enter repeats nothing', async () => {
  const { stops, root } = await mount()
  await wait(SETTLE_MS + 30)
  // Enter or Space on a focused button is a click with no count.
  await click(send(), 0)
  expect(stops()).toHaveLength(1)
  expect(await key(send(), 'Enter', true)).toBe(true)
  expect(await key(send(), 'Enter', false)).toBe(false)
  await act(async () => root.unmount())
})

test('the box set to ask a side question (/btw): its own button, not Stop', async () => {
  const { stops, root } = await mount()
  expect(send()?.classList.contains('stop')).toBe(true)
  await click(q('#aside-toggle'))
  expect(send()?.classList.contains('stop')).toBe(false)
  expect(send()?.getAttribute('type')).toBe('submit')
  await click(send())
  expect(stops()).toEqual([])
  await act(async () => root.unmount())
})

test('Enter in the empty box stops nothing and sends nothing', async () => {
  const { stops, messages, root } = await mount()
  await wait(SETTLE_MS + 30)
  await enter()
  expect(stops()).toEqual([])
  expect(messages).toEqual([])
  await act(async () => root.unmount())
})

test('the turn over: the button is Send again by itself, and a new turn makes it Stop again', async () => {
  const { stops, draw, root } = await mount()
  expect(send()?.classList.contains('stop')).toBe(true)
  await draw({ ...working, status: 'idle', column: 'idle' } as Item)
  expect(send()?.classList.contains('stop')).toBe(false)
  expect(send()?.getAttribute('type')).toBe('submit')
  // Send with an empty box waits for text, as it always did.
  expect(send()?.disabled).toBe(true)
  await draw(working)
  expect(send()?.classList.contains('stop')).toBe(true)
  expect(stops()).toEqual([])
  await act(async () => root.unmount())
})
