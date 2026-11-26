// Settings → This computer / The whole board (#887): on a node's own page a switch at the top, This
// computer by default and as before (no call to the master's settings); The whole board reads the
// master's payload through /api/master/board, shows its values without this computer's marks, writes
// /api/master/settings, offers Owner services, and says which panels stay on one computer. A board
// without nodes, and a node's page from away, have no switch.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { BoardPayload } from '../../src/core/payload.ts'
import type { SettingsPanelProps } from '../../web/src/components/settings/SettingsPanel.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { keepAuth } from '../../web/src/models/remote-page.ts'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload } from './support/board.tsx'

const NOW = Date.now()
const VP = { w: 1440, h: 900 }
const noop = () => {}
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const KEYS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'localStorage',
]
const OWN = [
  'devicePixelRatio',
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'addEventListener',
  'removeEventListener',
  'matchMedia',
  'fetch',
]
const saved = new Map<string, PropertyDescriptor | undefined>()
let calls: { url: string; method: string; body: unknown }[] = []
let answer: (url: string, method: string) => Response = () => new Response('{}', { status: 503 })

beforeAll(() => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...KEYS, ...OWN, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of KEYS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  const define = (k: string, value: unknown) =>
    Object.defineProperty(g, k, { value, configurable: true, writable: true })
  define(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  define('devicePixelRatio', 1)
  define('requestAnimationFrame', () => 0)
  define('cancelAnimationFrame', () => {})
  define('addEventListener', dom.window.addEventListener.bind(dom.window))
  define('removeEventListener', dom.window.removeEventListener.bind(dom.window))
  define('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  // The board this page asks: what each test sets.
  define('fetch', async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return answer(String(url), init?.method ?? 'GET')
  })
})

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

afterEach(() => {
  calls = []
  answer = () => new Response('{}', { status: 503 })
  dom.window.document.documentElement.removeAttribute('data-remote')
  dom.window.document.documentElement.removeAttribute('data-owner-admin')
  dom.window.document.body.innerHTML = ''
})

const props = (): SettingsPanelProps => ({
  open: true,
  onClose: noop,
  onOpenProfiles: noop,
  onOpenWake: noop,
  onOpenPhones: noop,
  onOpenMokupilot: noop,
  onOpenAccess: noop,
  onOpenBackup: noop,
  onOpenUpdates: noop,
  onOpenHousekeeping: noop,
  onOpenTimeSettings: noop,
  onOpenCalendarSettings: noop,
  onOpenLocalPaths: noop,
  onOpenTeam: noop,
  onOpenDevices: noop,
})

interface Shown {
  host: HTMLElement
  click(el: Element | null | undefined): Promise<void>
  tab(i: number): Promise<string>
  done(): Promise<void>
}

async function show(data: BoardPayload, lang = 'en'): Promise<Shown> {
  const { createRoot } = await import('react-dom/client')
  const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <I18nProvider lang={lang}>
        <BoardContext.Provider value={board({ data, now: NOW })}>
          <PanelProvider viewport={() => VP}>
            <SettingsPanel {...props()} />
          </PanelProvider>
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click')
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }
  return {
    host,
    click,
    async tab(i) {
      await click(host.querySelectorAll('.set-tab')[i])
      return host.querySelector('.set-section')?.textContent ?? ''
    },
    async done() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

const NODE: Partial<BoardPayload> = {
  compactDefault: '75%',
  teamRev: 1,
  nodeMaster: { nodeId: 'server-1', name: 'atlas', url: null, online: true },
  masterFlags: { master: 'atlas', at: NOW, on: ['todos'], todos: { agents: true } },
  remote: { on: true } as unknown as NonNullable<BoardPayload['remote']>,
}
const MASTER = payload({ compactDefault: '300k', foldWaiting: 'push', todos: { agents: true } })

const switchOf = (host: HTMLElement) => host.querySelector('.set-scope-switch')
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find(b => b.textContent === text)

test("a node's page: This computer by default, as before, with no call to the master's settings", async () => {
  const s = await show(payload(NODE))
  expect(switchOf(s.host)?.textContent).toContain('This computer')
  expect(button(s.host, 'This computer')?.getAttribute('aria-pressed')).toBe('true')
  const boardSec = await s.tab(1)
  expect(boardSec).toContain('On this computer')
  const integrations = await s.tab(3)
  expect(integrations).toContain('Phones…')
  expect(integrations).not.toContain('Owner services')
  expect(calls.filter(c => c.url.startsWith('/api/master/'))).toEqual([])
  await s.done()
})

test("The whole board: the master's values, its writes up the relay, Owner services, and what stays on one computer", async () => {
  answer = (url, method) =>
    url === '/api/master/board' && method === 'GET'
      ? new Response(JSON.stringify(MASTER), { status: 200 })
      : url === '/api/master/settings' && method === 'POST'
        ? new Response('{"ok":true}', { status: 200 })
        : new Response('{}', { status: 503 })
  const s = await show(payload(NODE))
  await s.click(button(s.host, 'The whole board'))
  expect(calls.some(c => c.url === '/api/master/board')).toBe(true)
  expect(switchOf(s.host)?.textContent).toContain('The settings of the master atlas')
  const boardSec = await s.tab(1)
  expect(boardSec).not.toContain('On this computer')
  const compact = s.host.querySelector<HTMLSelectElement>('select[aria-label="Auto-compact"]')
  expect(compact?.value).toBe('300k')
  // A change goes to the master's settings, never this board's.
  await act(async () => {
    if (!compact) return
    compact.value = '50%'
    compact.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  expect(calls.find(c => c.method === 'POST')).toEqual({
    url: '/api/master/settings',
    method: 'POST',
    body: { compactAt: '50%' },
  })
  expect(calls.some(c => c.url === '/api/settings')).toBe(false)
  const integrations = await s.tab(3)
  expect(integrations).toContain('Owner services')
  expect(integrations).not.toContain('Phones…')
  expect(integrations).not.toContain('Profiles…')
  expect(integrations).toContain('belong to one computer')
  expect(integrations).toContain('not reachable from a node yet')
  const system = await s.tab(4)
  expect(system).not.toContain('Backup…')
  expect(system).toContain('belong to one computer')
  // Back to This computer: this board's own rows again.
  await s.click(button(s.host, 'This computer'))
  expect(await s.tab(1)).toContain('On this computer')
  await s.done()
})

test('The whole board while the master is away: the panel says so, and shows none of its rows', async () => {
  answer = () =>
    new Response(JSON.stringify({ ok: false, error: 'node-master-offline', message: 'away' }), { status: 503 })
  const s = await show(payload(NODE))
  await s.click(button(s.host, 'The whole board'))
  expect(switchOf(s.host)?.querySelector('[role="alert"]')).not.toBeNull()
  expect(await s.tab(1)).toBe('')
  await s.done()
})

test('a board without nodes, and a node page from away: no switch', async () => {
  const standalone = await show(payload({ compactDefault: '75%' }))
  expect(switchOf(standalone.host)).toBeNull()
  await standalone.done()
  dom.window.document.documentElement.setAttribute('data-remote', '')
  keepAuth('login')
  const away = await show(payload(NODE))
  expect(switchOf(away.host)).toBeNull()
  await away.done()
  expect(calls.filter(c => c.url.startsWith('/api/master/'))).toEqual([])
})
