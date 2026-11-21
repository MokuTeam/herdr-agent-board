// Add a server on a real DOM (#509, components/devices/AddServer.tsx; jsdom, as secret-form.test.tsx):
// opened on a board without `nodes`, the form asks the board its view and nothing else; while a
// request is on its way the page asks the board again and the buttons wait; a plan's ceiling and
// ticks do not carry into the next plan; Cancel and the panel closing forget the passwords; a
// password the board asks for at Apply has a field there.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { NodeSetupView } from '../../src/core/node-setup.ts'
import type { board as Board } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let AddServer: typeof import('../../web/src/components/devices/AddServer.tsx').AddServer
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
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
  'HTMLInputElement',
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
  ;({ AddServer } = await import('../../web/src/components/devices/AddServer.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ board } = await import('./support/board.tsx'))
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const SECRET = 'S3cr3t-pw'
const doc = () => dom.window.document
const q = (sel: string) => doc().querySelector(sel) as HTMLInputElement
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const button = (label: string) =>
  [...doc().querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement
async function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
  await act(async () => {
    el.focus()
    setter?.call(el, value)
    for (const type of ['input', 'change']) el.dispatchEvent(new dom.window.Event(type, { bubbles: true }))
  })
}
async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy()
  await act(async () => {
    el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(20)
  })
}

const IDLE: NodeSetupView = {
  phase: 'idle',
  kind: null,
  server: null,
  device: null,
  hostKey: null,
  sudo: null,
  found: null,
  refusals: [],
  plan: null,
  run: null,
  master: [],
  bundle: null,
  login: null,
  hint: null,
  error: null,
  next: null,
}
const SERVER = { host: 'h.example.com', sshPort: 22, user: 'root', key: '' }
const planView = (id: string, mem: number, more: Partial<NodeSetupView> = {}): NodeSetupView => ({
  ...IDLE,
  phase: 'plan',
  kind: 'apply',
  server: SERVER,
  device: { id: 'server-1', port: 12430 },
  plan: {
    id,
    words: [{ key: 'node.plan.tools', params: { herdr: '0.9.5' } }],
    warnings: [],
    steps: [{ id: 'check', title: { key: 'node.step.check' }, why: { key: 'node.stepWhy.check' } }],
    ceiling: { memoryMaxMb: mem, memoryHighMb: Math.floor(mem * 0.8), swapMaxMb: 512, cpuWeight: 50, tasksMax: 3000 },
    packagesNeeded: false,
  },
  ...more,
})

interface Board2 {
  /** Every request: `GET`, or the POST's op. */
  log: string[]
  posts: Record<string, unknown>[]
  /** The view GET answers with now. */
  view: NodeSetupView
}

/** The form on a board whose answers `answer` gives (a POST's reply, after it may change the view). */
async function mount(
  first: NodeSetupView,
  answer: (b: Board2, body: Record<string, unknown>) => Promise<Response> | Response = () =>
    Response.json({ ok: true }),
) {
  const b: Board2 = { log: [], posts: [], view: first }
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      b.log.push(String(body.op))
      b.posts.push(body)
      return answer(b, body)
    }
    b.log.push('GET')
    return Response.json(b.view)
  }) as typeof fetch
  const el = doc().getElementById('root') as HTMLElement
  el.innerHTML = ''
  const root = createRoot(el)
  const draw = async (open: boolean) =>
    act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={board({})}>
            <AddServer open={open} />
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
  await draw(true)
  return { b, root, draw }
}

test('opened on a board without nodes, the form asks its view and nothing else; a Look on its way is followed and its buttons wait', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => {
    release = r
  })
  const { b, root } = await mount(IDLE, async (s, body) => {
    if (body.op === 'look') {
      s.view = { ...IDLE, phase: 'looking', kind: 'apply', server: SERVER }
      await gate
      s.view = planView('p1', 4000)
    }
    return Response.json({ ok: true })
  })
  expect(b.log).toEqual([])
  await click(button('Add a server…'))
  await act(() => sleep(20))
  expect(b.log).toEqual(['GET'])
  await setValue(q('input[name="node-host"]'), 'h.example.com')
  await click(button('Look'))
  await act(() => sleep(1300))
  // the board's own words for what it does, and a second click is not possible
  expect(button('Looking…')?.disabled).toBe(true)
  expect(b.log.filter(l => l === 'GET').length).toBeGreaterThanOrEqual(3)
  await act(async () => {
    release()
    await sleep(60)
  })
  expect(doc().querySelector('.devices-add')?.getAttribute('data-phase')).toBe('plan')
  expect(b.log.filter(l => l === 'look')).toHaveLength(1)
  root.unmount()
})

test("a plan's ceiling and ticks stay with it: the next plan starts from its own figures", async () => {
  const { b, root } = await mount(planView('p1', 1500), (s, body) => {
    if (body.op === 'cancel') s.view = IDLE
    if (body.op === 'look') s.view = planView('p2', 4000)
    return Response.json({ ok: true })
  })
  await click(button('Add a server…'))
  await act(() => sleep(20))
  await setValue(q('input[name="node-memoryMaxMb"]'), '800')
  await click(button('Cancel'))
  await setValue(q('input[name="node-host"]'), 'h.example.com')
  await click(button('Look'))
  await act(() => sleep(30))
  expect(q('input[name="node-memoryMaxMb"]').value).toBe('4000')
  await click(button('Apply'))
  expect(b.posts.at(-1)).toEqual({ op: 'apply', plan: 'p2', packages: false })
  root.unmount()
})

test('Cancel forgets the password: the next Look logs in with the keys alone', async () => {
  const { b, root } = await mount(IDLE, (s, body) => {
    if (body.op === 'look') s.view = planView('p1', 4000)
    if (body.op === 'cancel') s.view = IDLE
    return Response.json({ ok: true })
  })
  await click(button('Add a server…'))
  await act(() => sleep(20))
  await setValue(q('input[name="node-host"]'), 'h.example.com')
  await setValue(q('input[name="node-password"]'), SECRET)
  await click(button('Look'))
  await act(() => sleep(30))
  expect(b.posts[0]).toMatchObject({ op: 'look', password: SECRET })
  await click(button('Cancel'))
  await click(button('Look'))
  expect(b.posts.at(-1)).toEqual({ op: 'look', host: 'h.example.com', user: 'root' })
  expect(doc().body.innerHTML).not.toContain(SECRET)
  root.unmount()
})

test('a password the board asks for at Apply gets a field in the plan; Apply sends it', async () => {
  const { b, root } = await mount(planView('p1', 4000), (_s, body) =>
    body.op === 'apply' && !body.password
      ? Response.json(
          { ok: false, hint: 'loginPassword', need: 'password', error: 'Type the password' },
          { status: 409 },
        )
      : Response.json({ ok: true }),
  )
  await click(button('Add a server…'))
  await act(() => sleep(20))
  expect(q('input[name="node-password"]')).toBeNull()
  await click(button('Apply'))
  await act(() => sleep(30))
  const field = q('input[name="node-password"]')
  expect(field).not.toBeNull()
  expect(doc().activeElement).toBe(field)
  await setValue(field, SECRET)
  await click(button('Apply'))
  expect(b.posts.at(-1)).toMatchObject({ op: 'apply', plan: 'p1', password: SECRET })
  root.unmount()
})

test('the panel closed: nothing more is asked, and the form opens anew', async () => {
  const { b, root, draw } = await mount({ ...IDLE, phase: 'applying', kind: 'apply', server: SERVER })
  await click(button('Add a server…'))
  // while the board runs, the form asks every second
  await act(() => sleep(1300))
  expect(b.log.filter(l => l === 'GET').length).toBeGreaterThanOrEqual(2)
  await draw(false)
  const asked = b.log.length
  await act(() => sleep(1300))
  expect(b.log.length).toBe(asked)
  expect(button('Add a server…')).toBeTruthy()
  root.unmount()
})
