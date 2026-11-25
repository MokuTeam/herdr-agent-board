// Settings on a node and on the head (#797): on a node each row says whose it is (this computer's
// own, or the master's), Features shows verified done and sharing in Team as the master has them,
// and Backup says the master does it; on the head's page from away Tasks shows once, in Features.
// A standalone board's page shows none of the marks.
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
  // Nothing here reaches a board.
  define('fetch', async () => new Response('{}', { status: 503 }))
})

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

afterEach(() => {
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

/** Each section's text by its tab, the panel rendered over `data`. */
async function sections(data: BoardPayload, lang = 'ru'): Promise<string[]> {
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
  const out: string[] = []
  for (const tab of [...host.querySelectorAll('.set-tab')]) {
    await act(async () => {
      tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    out.push(host.querySelector('.set-section')?.textContent ?? '')
  }
  await act(async () => root.unmount())
  host.remove()
  return out
}

const NODE: Partial<BoardPayload> = {
  compactDefault: '75%',
  backup: { last: null, problem: { kind: 'noTarget' } } as unknown as NonNullable<BoardPayload['backup']>,
  teamRev: 1,
  nodeMaster: { nodeId: 'server-1', name: 'atlas', url: null, online: true },
  masterFlags: {
    master: 'atlas',
    at: NOW,
    on: ['threads', 'team', 'todos'],
    threads: { agents: true, verify: true, share: false },
    todos: { agents: true },
  },
}

test("on a node: this computer's rows and the master's say so; verify and share show as the master has them", async () => {
  const [, boardSec = '', features = '', , system = ''] = await sections(payload(NODE))
  // Autocompact, language and turn resume are this computer's.
  expect(boardSec.split('На этом компьютере').length - 1).toBe(3)
  expect(boardSec).toContain('Автокомпакт')
  // Features: the master's, with verified done and sharing in Team.
  expect(features).toContain('На голове atlas')
  expect(features).toContain('Проверка готовности')
  expect(features).toContain('Делиться в Команде')
  // Backup is the master's: no "on" here, and no warning for this computer's own target.
  expect(system).toContain('На голове atlas')
  expect(system).not.toContain('Включено')
})

test('on a node whose master does not say verify or share (an older one): neither row, as before', async () => {
  const flags = { ...NODE.masterFlags, threads: { agents: true } } as NonNullable<BoardPayload['masterFlags']>
  const [, , features = ''] = await sections(payload({ ...NODE, masterFlags: flags }))
  expect(features).not.toContain('Проверка готовности')
  expect(features).not.toContain('Делиться в Команде')
})

test('a standalone board: no whose-it-is marks anywhere', async () => {
  const all = (await sections(payload({ compactDefault: '75%', todos: { agents: true } }))).join(' ')
  expect(all).not.toContain('На этом компьютере')
  expect(all).not.toContain('На голове')
})

test("the head's page from away, as its owner: Tasks once, in Features (#797)", async () => {
  dom.window.document.documentElement.setAttribute('data-remote', '')
  dom.window.document.documentElement.setAttribute('data-owner-admin', '')
  keepAuth('login')
  const texts = await sections(payload({ todos: { agents: true } }), 'en')
  const tasks = texts.map(s => s.split('Tasks').length - 1)
  expect(tasks.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  // Board & Agents has none; Features has it.
  expect(tasks[1]).toBe(0)
  expect(tasks[2]).toBeGreaterThan(0)
})

test("a phone's page without admin keeps Tasks in Board & Agents, as before", async () => {
  dom.window.document.documentElement.setAttribute('data-remote', '')
  keepAuth('login')
  const texts = await sections(payload({ todos: { agents: true } }), 'en')
  expect(texts[1]).toContain('Tasks')
})
