// The Time panel's changes as the owner makes them (#233, components/time/TimePanel.tsx and
// EntryEditor.tsx), on a real DOM (jsdom) against the real route of a sandboxed board: an entry
// changed elsewhere while it is open is said, and Save waits for Reload (it never writes the old
// text back); a Raise the board refuses is a toast; a delete's Undo stays seven seconds; an Undo
// after paging leaves the day shown as it is. Brought over from the review of #236 (ui.test.tsx).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { openDb } from '../../src/adapters/db.ts'
import { editEntry, removeEntry } from '../../src/adapters/time-store.ts'
import { freshTarget } from '../../src/core/backup.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { timeConfig } from '../../src/core/time.ts'
import type { ToastOptions } from '../../web/src/state/board-ui.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'
import type { board as Board, payload as Payload } from './support/board.tsx'

// react-dom and the page's components load once the DOM is there (beforeAll): react-dom looks at
// the window when it loads, and typing into a field goes through what it finds then
let createRoot: typeof import('react-dom/client').createRoot
let TimePanel: typeof import('../../web/src/components/time/TimePanel.tsx').TimePanel
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let PanelProvider: typeof import('../../web/src/state/PanelProvider.tsx').PanelProvider
let board: typeof Board
let payload: typeof Payload

const TIME = {
  zone: 'America/New_York',
  clients: {
    'client-a': { projects: ['Support'], billing: [{ group: 'ref', step: 30, round: 'up' }] },
    'client-b': { projects: ['Support'] },
  },
}
const conf = timeConfig(TIME)
// a day the route takes (within a year back), in New York's middle of the day
const DAY = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
const agent = { key: 's1', name: 'One' }

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
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'MutationObserver',
  'getComputedStyle',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const realFetch = globalThis.fetch

/** What react-dom's fallback watches a focused field with (IE's onpropertychange), by element. */
const watching = new WeakMap<object, (e: { propertyName: string }) => void>()

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  // react-dom loaded before this file's DOM (another file's) watches fields as IE did: jsdom has
  // no attachEvent, so it gets one that setValue fires
  const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto.attachEvent = function (this: object, name: string, fn: (e: { propertyName: string }) => void) {
    if (name === 'onpropertychange') watching.set(this, fn)
  }
  proto.detachEvent = function (this: object) {
    watching.delete(this)
  }
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  for (const k of [
    ...DOM_GLOBALS,
    'IS_REACT_ACT_ENVIRONMENT',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'ResizeObserver',
    'matchMedia',
    'devicePixelRatio',
  ]) {
    saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  }
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  Object.defineProperty(g, 'matchMedia', { value: win.matchMedia, configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  // a frame's time, as a browser hands it: the springs step by it and come to rest
  g.requestAnimationFrame = (f: (now: number) => void) => setTimeout(() => f(performance.now()), 16)
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  g.devicePixelRatio = 1
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TimePanel } = await import('../../web/src/components/time/TimePanel.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ PanelProvider } = await import('../../web/src/state/PanelProvider.tsx'))
  ;({ board, payload } = await import('./support/board.tsx'))
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterAll(async () => {
  // the panels' springs settle first: their frames run on the clock this file put in
  await new Promise(r => setTimeout(r, 1500))
  globalThis.fetch = realFetch
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = async (ms = 400) => {
  await act(async () => {
    await sleep(ms)
  })
}
const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement & { value: string }
const qa = (sel: string) => [...dom.window.document.querySelectorAll(sel)] as HTMLElement[]
const click = async (el: Element | null) => {
  expect(el).toBeTruthy()
  await act(async () => {
    el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
/**
 * A value typed into a field, as a person's typing reaches React: focused, its own value setter,
 * then the events, and what the input event's fallback watches (onpropertychange, keys, selection
 * change), which react-dom takes when it was loaded elsewhere before this file's DOM was there.
 */
const setValue = async (el: HTMLElement | null, value: string) => {
  expect(el).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  await act(async () => {
    el?.focus()
    el?.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
    setter?.call(el, value)
    if (el) watching.get(el)?.({ propertyName: 'value', target: el, srcElement: el } as { propertyName: string })
    for (const type of ['input', 'change']) el?.dispatchEvent(new dom.window.Event(type, { bubbles: true }))
    for (const type of ['keydown', 'keyup']) el?.dispatchEvent(new dom.window.KeyboardEvent(type, { bubbles: true }))
    dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'))
  })
}
const submit = async () => {
  await act(async () => {
    q('.time-editor').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

async function setup() {
  const box = await sandbox()
  const folder = join(box.dir, 'Sync')
  mkdirSync(folder)
  const state = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board')
  mkdirSync(join(state, 'backup'), { recursive: true })
  writeFileSync(
    join(state, 'backup', 'backup-key.json'),
    JSON.stringify(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 })),
  )
  writeFileSync(
    join(state, 'backup', 'status.json'),
    JSON.stringify({ targets: { folder: { ...freshTarget(), tested: Date.now(), where: folder } } }),
  )
  const { url } = await serveBoard(box, { language: 'en', time: TIME, backup: { folder } })
  globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof u === 'string' && u.startsWith('/') ? url + u : u, init)) as typeof fetch
  const post = async (body: Record<string, unknown>) =>
    (await (
      await realFetch(`${url}/api/time`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
      })
    ).json()) as { entry: { id: string; rev: number; stop: string; description: string } }
  const stored = async () =>
    (
      (await (await realFetch(`${url}/api/time?date=${DAY}`)).json()) as {
        entries: { description: string; stop: string; rev: number; client: string }[]
      }
    ).entries
  /** A change by an agent's `board time`, straight into the database. */
  const byAgent = (id: string, ch: Parameters<typeof editEntry>[3]) => {
    const db = openDb({ path: join(state, 'board.db') })
    if (!db || !conf) throw new Error('no database')
    editEntry(db, conf, id, ch, agent, { force: true })
    db.close()
  }
  const removedByAgent = (id: string) => {
    const db = openDb({ path: join(state, 'board.db') })
    if (!db) throw new Error('no database')
    removeEntry(db, id, agent, { force: true })
    db.close()
  }
  const entry = () =>
    post({
      op: 'add',
      client: 'client-a',
      project: 'Support',
      description: 'Case 10001 X: work',
      start: `${DAY}T13:00:00Z`,
      stop: `${DAY}T14:30:00Z`,
    })
  return { post, stored, byAgent, removedByAgent, entry }
}

const toasts: { text: string; error?: boolean | undefined; o?: ToastOptions | undefined }[] = []
function view(seq: number, client: string | null = null, today = DAY) {
  const data = payload({
    time: { seq, date: today, today: {} },
    categories: [
      {
        id: 'client-a',
        title: 'Client A',
        color: '#007AFF',
        colorName: 'blue',
        paths: [],
        configured: true,
        fallback: false,
      },
    ],
  } as Parameters<typeof payload>[0])
  const b = board({ data, toast: (text, error, o) => toasts.push({ text, error, o }) })
  return (
    <I18nProvider lang="en">
      <BoardContext.Provider value={b}>
        <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
          <TimePanel open={true} onClose={() => {}} client={client} onClient={() => {}} />
        </PanelProvider>
      </BoardContext.Provider>
    </I18nProvider>
  )
}

/** The roots a test mounted: each unmounted after it, failed or not, so none is left for the next. */
const mounted = new Set<Root>()
afterEach(() => {
  for (const root of mounted) act(() => root.unmount())
  mounted.clear()
  for (const el of [...dom.window.document.body.children]) if (el.id !== 'root') el.remove()
})

async function mount(seq = 1): Promise<Root> {
  // a container of its own for each test
  const el = dom.window.document.createElement('div')
  dom.window.document.body.append(el)
  const root = createRoot(el)
  mounted.add(root)
  await act(async () => root.render(view(seq)))
  await settle()
  return root
}

test('an entry changed elsewhere while it is open: said, Save waits for Reload, and the agent’s change stays', async () => {
  const s = await setup()
  const made = await s.post({
    op: 'add',
    client: 'client-a',
    project: 'Support',
    description: 'Case 10001 X: work',
    start: `${DAY}T13:00:00Z`,
    stop: `${DAY}T14:30:00Z`,
  })
  const root = await mount(1)
  await click(q('.time-open'))
  expect(q('.time-editor textarea').value).toBe('Case 10001 X: work')
  // an agent corrects it; the board's seq moves and the panel reads the day again
  s.byAgent(made.entry.id, { description: 'Case 10001 X: CORRECTED BY AGENT' })
  await act(async () => root.render(view(2)))
  await settle()
  expect(q('.time-stale')).toBeTruthy()
  const save = qa('.time-editor button[type=submit]')[0] as HTMLButtonElement
  expect(save.disabled).toBe(true)
  await submit()
  await settle()
  expect((await s.stored())[0]?.description).toBe('Case 10001 X: CORRECTED BY AGENT')
  // Reload: the entry as it is now; a trim then keeps the agent's words
  await click(qa('.time-stale button')[0] ?? null)
  expect(q('.time-editor textarea').value).toBe('Case 10001 X: CORRECTED BY AGENT')
  await click(qa('.time-editor .time-steps button')[0] ?? null)
  await submit()
  await settle(600)
  const [after] = await s.stored()
  expect(after?.description).toBe('Case 10001 X: CORRECTED BY AGENT')
  expect(after?.stop).toBe(`${DAY}T14:15:00Z`)
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('a Raise the board refuses is a toast, and nothing changes', async () => {
  const s = await setup()
  toasts.length = 0
  // 40 minutes in a 30-minute step rounded up: billed an hour, 20 minutes to raise
  const made = await s.post({
    op: 'add',
    client: 'client-a',
    project: 'Support',
    description: 'Case 10001 X: work',
    start: `${DAY}T13:00:00Z`,
    stop: `${DAY}T13:40:00Z`,
  })
  const root = await mount(1)
  // the agent changes it after the panel's read, before the panel hears of it
  s.byAgent(made.entry.id, { description: 'Case 10001 X: changed' })
  await click(q('.time-raise'))
  await settle(600)
  expect((await s.stored())[0]?.stop).toBe(`${DAY}T13:40:00Z`)
  expect(toasts.filter(x => x.error).map(x => x.text)).toEqual([
    'Changed elsewhere since it was read: Reload it, then change it again.',
  ])
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('a delete’s Undo stays seven seconds; after paging, Undo leaves the day shown as it is and says where the entry is', async () => {
  const s = await setup()
  toasts.length = 0
  await s.post({
    op: 'add',
    client: 'client-a',
    project: 'Support',
    description: 'Case 10001 X: work',
    start: `${DAY}T13:00:00Z`,
    stop: `${DAY}T14:30:00Z`,
  })
  const root = await mount(1)
  await click(q('.time-open'))
  await click(q('.time-delete'))
  await settle(500)
  const undo = toasts.find(x => x.o?.action)
  expect(undo?.o?.ms).toBeGreaterThanOrEqual(7000)
  await click(q('button[aria-label="Previous day"]'))
  await settle(400)
  const header = q('.time-date').textContent
  await act(async () => {
    undo?.o?.action?.run()
    await sleep(600)
  })
  expect(q('.time-date').textContent).toBe(header)
  expect(qa('.time-entry').length).toBe(0)
  expect((await s.stored()).length).toBe(1)
  expect(toasts.some(x => x.text.startsWith('Saved on '))).toBe(true)
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('an entry open here that is removed elsewhere closes with a word, not silently', async () => {
  const s = await setup()
  toasts.length = 0
  const made = await s.entry()
  const root = await mount(1)
  await click(q('.time-open'))
  await setValue(q('.time-editor textarea'), 'Case 10001 X: typed here')
  s.removedByAgent(made.entry.id)
  await act(async () => root.render(view(2)))
  await settle()
  expect(q('.time-editor')).toBeNull()
  expect(toasts.filter(x => x.error).map(x => x.text)).toEqual([
    'The entry open here was removed or moved elsewhere: what was typed is not saved.',
  ])
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('a change refused as changed since shows Reload at once, before the board says the day moved', async () => {
  const s = await setup()
  const made = await s.entry()
  const root = await mount(1)
  await click(q('.time-open'))
  // the agent changes it; the panel has not heard (no new seq)
  s.byAgent(made.entry.id, { description: 'Case 10001 X: CORRECTED BY AGENT' })
  await click(qa('.time-editor .time-steps button')[0] ?? null)
  await submit()
  await settle(600)
  expect(q('.time-stale')).toBeTruthy()
  expect(qa('.time-stale button').length).toBe(1)
  expect((await s.stored())[0]?.description).toBe('Case 10001 X: CORRECTED BY AGENT')
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('a change saved in part (the edit in, the move refused) is not called a change from elsewhere, and the typed date stays', async () => {
  const s = await setup()
  const made = await s.entry()
  const root = await mount(1)
  await click(q('.time-open'))
  await setValue(q('.time-editor textarea'), 'Case 10001 X: worded better')
  // a date the board refuses to move to: over a year back
  await setValue(q('.time-editor input[type=date]'), '2024-01-01')
  await submit()
  await settle(600)
  const [after] = await s.stored()
  expect(after?.description).toBe('Case 10001 X: worded better')
  expect(after?.rev).toBe(made.entry.rev + 1)
  expect(q('.time-stale')).toBeNull()
  expect(q('.time-editor p.access-problem[role=alert]')?.textContent).toMatch(/a year back/)
  expect(q('.time-editor input[type=date]').value).toBe('2024-01-01')
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

/** Two entries of client A (two cases, two lines) and one of client B. */
async function three(s: Awaited<ReturnType<typeof setup>>) {
  await s.entry()
  await s.post({
    op: 'add',
    client: 'client-a',
    project: 'Support',
    description: 'Case 10002 Z: second',
    start: `${DAY}T16:00:00Z`,
    stop: `${DAY}T16:30:00Z`,
  })
  await s.post({
    op: 'add',
    client: 'client-b',
    project: 'Support',
    description: 'Case 20001 Y: other',
    start: `${DAY}T17:00:00Z`,
    stop: `${DAY}T17:30:00Z`,
  })
}
const openOn = (description: string) => click(qa('.time-open').find(b => b.textContent?.includes(description)) ?? null)
const TYPED = 'Case 10001 X: typed text I care about'

test('a tap on another entry, or Add entry, leaves the typed text for when the first opens again', async () => {
  const s = await setup()
  await three(s)
  const root = await mount(1)
  await openOn('Case 10001 X: work')
  await setValue(q('.time-editor textarea'), TYPED)
  await openOn('Case 10002 Z: second')
  expect(q('.time-editor textarea').value).toBe('Case 10002 Z: second')
  await openOn('Case 10001 X: work')
  expect(q('.time-editor textarea').value).toBe(TYPED)
  // Add entry, then back: the same
  await click(qa('.time-add button').find(b => b.textContent === 'Add entry') ?? null)
  await openOn('Case 10001 X: work')
  expect(q('.time-editor textarea').value).toBe(TYPED)
  // Cancel is done with it
  await click(qa('.time-editor button').find(b => b.textContent === 'Cancel') ?? null)
  await openOn('Case 10001 X: work')
  expect(q('.time-editor textarea').value).toBe('Case 10001 X: work')
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('the day changed (the arrows, or past midnight) leaves the typed text for the entry’s next opening', async () => {
  const s = await setup()
  await three(s)
  const root = await mount(1)
  await openOn('Case 10001 X: work')
  await setValue(q('.time-editor textarea'), TYPED)
  await click(q('button[aria-label="Next day"]'))
  await settle(300)
  await click(q('button[aria-label="Previous day"]'))
  await settle(300)
  expect(q('.time-editor')).toBeNull()
  await openOn('Case 10001 X: work')
  expect(q('.time-editor textarea').value).toBe(TYPED)
  // the board's day rolls over while the panel shows it: the panel follows, the draft stays
  const next = new Date(Date.parse(`${DAY}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  await act(async () => root.render(view(2, null, next)))
  await settle(300)
  await click(q('button[aria-label="Previous day"]'))
  await settle(300)
  await openOn('Case 10001 X: work')
  expect(q('.time-editor textarea').value).toBe(TYPED)
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('another client chosen closes the editor (no hidden one left open), its typed text kept', async () => {
  const s = await setup()
  await three(s)
  const root = await mount(1)
  await openOn('Case 10001 X: work')
  await setValue(q('.time-editor textarea'), TYPED)
  await act(async () => root.render(view(1, 'client-b')))
  await settle()
  expect(q('.time-editor')).toBeNull()
  // back to all: nothing open by itself; the entry opens on what was typed
  await act(async () => root.render(view(1, null)))
  await settle()
  expect(q('.time-editor')).toBeNull()
  await openOn('Case 10001 X: work')
  expect(q('.time-editor textarea').value).toBe(TYPED)
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

const addButton = () => qa('.time-add button').find(b => b.textContent === 'Add entry') ?? null
const submitAdd = async () => {
  await act(async () => {
    q('.time-add .time-editor').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

test('a new entry’s kept draft comes back only where the form offers its client; another client starts afresh', async () => {
  const s = await setup()
  await three(s)
  const root = await mount(1)
  await click(addButton())
  expect(q('.time-add select').value).toBe('client-a')
  await setValue(q('.time-add textarea'), 'Case 30001 N: a new entry')
  // the chip on client B: the form offers B alone, so the draft for A waits
  await act(async () => root.render(view(1, 'client-b')))
  await settle()
  await click(addButton())
  expect(q('.time-add select').value).toBe('client-b')
  expect(q('.time-add textarea').value).toBe('')
  // back on all clients: the draft, its client A with it
  await act(async () => root.render(view(1, null)))
  await settle()
  await click(addButton())
  expect([q('.time-add select').value, q('.time-add textarea').value]).toEqual([
    'client-a',
    'Case 30001 N: a new entry',
  ])
  await submitAdd()
  await settle(600)
  expect((await s.stored()).find(e => e.description === 'Case 30001 N: a new entry')?.client).toBe('client-a')
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('a new entry’s draft is kept per day: another day’s form neither shows it nor wipes it', async () => {
  const s = await setup()
  await three(s)
  const root = await mount(1)
  await click(addButton())
  await setValue(q('.time-add textarea'), 'Case 30001 N: typed on the day')
  await click(q('button[aria-label="Previous day"]'))
  await settle(300)
  await click(addButton())
  expect(q('.time-add textarea').value).toBe('')
  await click(qa('.time-add .time-editor button').find(b => b.textContent === 'Cancel') ?? null)
  await click(q('button[aria-label="Next day"]'))
  await settle(300)
  await click(addButton())
  expect(q('.time-add textarea').value).toBe('Case 30001 N: typed on the day')
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)

test('a change saved in part, left and opened again: its draft against the entry as saved, no word of elsewhere', async () => {
  const s = await setup()
  await three(s)
  const root = await mount(1)
  await openOn('Case 10001 X: work')
  await setValue(q('.time-editor textarea'), 'Case 10001 X: edited')
  await setValue(q('.time-editor input[type=date]'), '2024-01-01')
  await submit()
  await settle(700)
  expect((await s.stored()).map(e => e.description)).toContain('Case 10001 X: edited')
  await openOn('Case 10002 Z: second')
  await act(async () => root.render(view(2)))
  await settle()
  await openOn('Case 10001 X: edited')
  expect(q('.time-editor textarea').value).toBe('Case 10001 X: edited')
  expect(q('.time-editor input[type=date]').value).toBe('2024-01-01')
  expect(q('.time-stale')).toBeNull()
  expect((qa('.time-editor button[type=submit]')[0] as HTMLButtonElement).disabled).toBe(false)
  mounted.delete(root)
  act(() => root.unmount())
}, 90_000)
