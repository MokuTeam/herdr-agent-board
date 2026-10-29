// The Time panel's changes as the owner makes them (#233, components/time/TimePanel.tsx and
// EntryEditor.tsx), on a real DOM (jsdom) against the real route of a sandboxed board: an entry
// changed elsewhere while it is open is said, and Save waits for Reload (it never writes the old
// text back); a Raise the board refuses is a toast; a delete's Undo stays seven seconds; an Undo
// after paging leaves the day shown as it is. Brought over from the review of #236 (ui.test.tsx).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { openDb } from '../../src/adapters/db.ts'
import { editEntry } from '../../src/adapters/time-store.ts'
import { freshTarget } from '../../src/core/backup.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { timeConfig } from '../../src/core/time.ts'
import { TimePanel } from '../../web/src/components/time/TimePanel.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import type { ToastOptions } from '../../web/src/state/board-ui.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'
import { board, payload } from './support/board.tsx'

const TIME = {
  zone: 'America/New_York',
  clients: { 'client-a': { projects: ['Support'], billing: [{ group: 'ref', step: 30, round: 'up' }] } },
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

beforeAll(() => {
  const win = dom.window as unknown as Record<string, unknown>
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
    JSON.stringify({ targets: { folder: { ...freshTarget(), tested: Date.now() } } }),
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
        entries: { description: string; stop: string; rev: number }[]
      }
    ).entries
  /** A change by an agent's `board time`, straight into the database. */
  const byAgent = (id: string, ch: Parameters<typeof editEntry>[3]) => {
    const db = openDb({ path: join(state, 'board.db') })
    if (!db || !conf) throw new Error('no database')
    editEntry(db, conf, id, ch, agent, { force: true })
    db.close()
  }
  return { post, stored, byAgent }
}

const toasts: { text: string; error?: boolean | undefined; o?: ToastOptions | undefined }[] = []
function view(seq: number) {
  const data = payload({
    time: { seq, date: DAY, today: {} },
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
          <TimePanel open={true} onClose={() => {}} client={null} onClient={() => {}} />
        </PanelProvider>
      </BoardContext.Provider>
    </I18nProvider>
  )
}

async function mount(seq = 1): Promise<Root> {
  // a container of its own for each test
  const el = dom.window.document.createElement('div')
  dom.window.document.body.append(el)
  const root = createRoot(el)
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
  act(() => root.unmount())
}, 90_000)
