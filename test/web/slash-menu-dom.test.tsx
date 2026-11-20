// The chat box's slash command list (#191) on a real DOM (jsdom): a leading slash reads the
// session's commands once and lists them over the box; arrows move, Tab and Enter complete, Esc
// closes the list and nothing else, a tap completes; Enter on a whole command sends it; the
// commands sent most come first; a message with no leading slash asks the server for nothing.
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
  'localStorage',
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
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null
const box = () => q('#message') as HTMLTextAreaElement | null

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

const S = '07624983-b6d4-410f-9664-28b0bc29b013'
const idle = {
  key: S,
  session: S,
  name: 'Acme',
  agent: 'claude',
  pane: 'w1:p2',
  status: 'idle',
  column: 'idle',
  sleeping: false,
} as Item

const COMMANDS = [
  { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
  { name: 'compact', description: 'Compact the conversation', hint: '[instructions]', source: 'builtin' },
  { name: 'context', description: 'Show the context window', source: 'builtin' },
  { name: 'cost', description: 'Show the cost', source: 'builtin' },
  { name: 'standup', description: 'Write the standup', source: 'user' },
]

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
      availability={sheet.sheetAvailability({ canMutate: true, canEdit: true, missing: false, turn: false }, t)}
      buttons={sheet.NO_HEAD_BUTTONS}
      changesHidden
      present
      canMutate
    />
  )
}

async function mount(it: Item = idle) {
  const asked: string[] = []
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url))
    if (String(url).endsWith('/commands')) return Response.json({ commands: COMMANDS })
    return Response.json({ ok: true })
  }) as typeof fetch
  const messages: string[] = []
  const el = dom.window.document.getElementById('root') as HTMLElement
  el.innerHTML = ''
  const root = createRoot(el)
  await act(async () => {
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider
          value={board({
            data: { ...board().data, items: [it] } as ReturnType<typeof board>['data'],
            ui: { open: it.key },
          })}
        >
          <Box it={it} messages={messages} />
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  const commandReads = () => asked.filter(u => u.endsWith('/commands'))
  await act(async () => box()?.focus())
  return { asked, commandReads, messages, root }
}

const rows = () =>
  [...dom.window.document.querySelectorAll('#slash-menu [role="option"]')].map(
    r => r.querySelector('.slash-name')?.textContent,
  )
const lit = () => dom.window.document.querySelector('#slash-menu [aria-selected="true"] .slash-name')?.textContent
const settle = () => act(async () => void (await new Promise(r => setTimeout(r, 20))))

test('a leading slash lists the commands over the box; typing filters; Tab completes with a space', async () => {
  dom.window.localStorage.clear()
  const { commandReads, root } = await mount()
  await type('/')
  await settle()
  expect(commandReads()).toEqual([`/api/session/${encodeURIComponent(S)}/commands`])
  expect(rows()).toEqual(['/clear', '/compact', '/context', '/cost', '/standup'])
  expect(box()?.getAttribute('aria-controls')).toBe('slash-menu')
  expect(box()?.getAttribute('aria-activedescendant')).toBe('slash-option-0')
  await type('/co')
  // "clear" stays: its description has "co" (conversation), after the names that do.
  expect(rows()).toEqual(['/compact', '/context', '/cost', '/clear'])
  expect(lit()).toBe('/compact')
  expect(await key(box(), 'ArrowDown')).toBe(true)
  expect(lit()).toBe('/context')
  await key(box(), 'ArrowUp')
  await key(box(), 'ArrowUp')
  expect(lit()).toBe('/clear')
  await key(box(), 'Tab')
  expect(box()?.value).toBe('/clear ')
  expect(rows()).toEqual([])
  // Typed again: read once a minute, not on every slash.
  await type('/')
  await settle()
  expect(commandReads()).toHaveLength(1)
  await act(async () => root.unmount())
})

test('Enter completes a partial name, then sends; on a whole name it sends at once', async () => {
  const { messages, root } = await mount()
  await type('/comp')
  await settle()
  await enter()
  expect(box()?.value).toBe('/compact ')
  expect(messages).toEqual([])
  // The argument's hint while it is still to be typed.
  expect(dom.window.document.querySelector('.slash-hint')?.textContent).toBe('/compact [instructions]')
  await enter()
  expect(messages).toEqual(['/compact '])
  await type('/cost')
  await enter()
  expect(messages).toEqual(['/compact ', '/cost'])
  await act(async () => root.unmount())
})

test('Esc closes the list and nothing more: the board does not see it, the text stays', async () => {
  const { root } = await mount()
  const seen: string[] = []
  const onKey = (e: KeyboardEvent) => seen.push(e.key)
  dom.window.addEventListener('keydown', onKey)
  await type('/st')
  await settle()
  expect(rows()).toEqual(['/standup', '/cost'])
  expect(await key(box(), 'Escape')).toBe(true)
  expect(rows()).toEqual([])
  expect(box()?.value).toBe('/st')
  expect(seen).toEqual([])
  // Closed: Escape goes to the board again, Enter sends as before.
  await key(box(), 'Escape')
  expect(seen).toEqual(['Escape'])
  // Typing on opens it again.
  await type('/sta')
  expect(rows()).toEqual(['/standup'])
  dom.window.removeEventListener('keydown', onKey)
  await act(async () => root.unmount())
})

test('after Esc, the next slash opens the list again', async () => {
  const { messages, root } = await mount()
  await type('/')
  await settle()
  await key(box(), 'Escape')
  expect(rows()).toEqual([])
  await type('')
  await type('hello')
  await enter()
  expect(messages).toEqual(['hello'])
  await type('/')
  expect(rows()).toHaveLength(COMMANDS.length)
  await act(async () => root.unmount())
})

test('a row found by its description alone: Enter sends what was typed', async () => {
  const { messages, root } = await mount()
  await type('/window')
  await settle()
  expect(rows()).toEqual(['/context'])
  await enter()
  expect(messages).toEqual(['/window'])
  await act(async () => root.unmount())
})

test('a press on the list outside its rows leaves the focus in the box', async () => {
  const { root } = await mount()
  await type('/')
  await settle()
  const keys = dom.window.document.querySelector('.slash-keys') as HTMLElement
  const down = new dom.window.Event('pointerdown', { bubbles: true, cancelable: true })
  const mouse = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  await act(async () => {
    keys.dispatchEvent(down)
    keys.dispatchEvent(mouse)
  })
  expect([down.defaultPrevented, mouse.defaultPrevented]).toEqual([true, true])
  await act(async () => root.unmount())
})

test('a tap on a row completes the box and keeps the focus there', async () => {
  const { root } = await mount()
  box()?.focus()
  await type('/')
  await settle()
  const row = dom.window.document.querySelectorAll('#slash-menu [role="option"]')[4] as HTMLElement
  const down = new dom.window.Event('pointerdown', { bubbles: true, cancelable: true })
  await act(async () => void row.dispatchEvent(down))
  expect(down.defaultPrevented).toBe(true)
  await click(row)
  expect(box()?.value).toBe('/standup ')
  expect(dom.window.document.activeElement).toBe(box())
  await act(async () => root.unmount())
})

test('the commands sent most from this browser come first', async () => {
  dom.window.localStorage.clear()
  const { messages, root } = await mount()
  for (let i = 0; i < 2; i++) {
    await type('/standup')
    await settle()
    await enter()
  }
  expect(messages).toEqual(['/standup', '/standup'])
  await type('/')
  await settle()
  expect(rows()?.[0]).toBe('/standup')
  expect(JSON.parse(dom.window.localStorage.getItem('agent-board:slash-uses') ?? '{}')).toEqual({ standup: 2 })
  await act(async () => root.unmount())
})

test('the list shows only while the box has the focus: a draft from before opens nothing until then', async () => {
  const { commandReads, root } = await mount()
  await act(async () => box()?.blur())
  await type('/co')
  await settle()
  expect(rows()).toEqual([])
  expect(commandReads()).toEqual([])
  await act(async () => box()?.focus())
  await settle()
  expect(rows()).toEqual(['/compact', '/context', '/cost', '/clear'])
  await act(async () => box()?.blur())
  expect(rows()).toEqual([])
  await act(async () => root.unmount())
})

test('a message with no leading slash asks for nothing and sends as before', async () => {
  const { commandReads, messages, root } = await mount()
  await type('please check /tmp and the build')
  await settle()
  await enter()
  expect(messages).toEqual(['please check /tmp and the build'])
  expect(commandReads()).toEqual([])
  expect(dom.window.document.querySelector('.slash-menu, .slash-hint')).toBeNull()
  await act(async () => root.unmount())
})

test('an agent with no commands: a slash shows no list and Enter sends', async () => {
  const { messages, root } = await mount({ ...idle, agent: 'agy' } as Item)
  globalThis.fetch = (async () => Response.json({ commands: [] })) as unknown as typeof fetch
  await type('/x')
  await settle()
  expect(rows()).toEqual([])
  await enter()
  expect(messages).toEqual(['/x'])
  await act(async () => root.unmount())
})
