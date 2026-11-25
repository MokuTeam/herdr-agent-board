// A node's panels while the shared board is away (#780): Settings → Calendar and Settings → Time ask
// their master through the relay, which answers 503 node-master-offline; the panel says it in one
// plain line, never the code. An answer of the board's own (an error it words) shows as before.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { board, payload } from './support/board.tsx'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
  'matchMedia',
  'IS_REACT_ACT_ENVIRONMENT',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'devicePixelRatio',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const realFetch = globalThis.fetch

let createRoot: typeof import('react-dom/client').createRoot
let CalendarSettingsPanel: typeof import('../../web/src/components/calendar/CalendarSettingsPanel.tsx').CalendarSettingsPanel
let TimeSettingsPanel: typeof import('../../web/src/components/time/TimeSettingsPanel.tsx').TimeSettingsPanel
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let PanelProvider: typeof import('../../web/src/state/PanelProvider.tsx').PanelProvider

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  for (const k of DOM_GLOBALS) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'MutationObserver',
    'getComputedStyle',
    'matchMedia',
  ] as const)
    Object.defineProperty(g, k, { configurable: true, writable: true, value: win[k] })
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.devicePixelRatio = 1
  g.requestAnimationFrame = (f: (now: number) => void) => setTimeout(() => f(performance.now()), 16)
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ CalendarSettingsPanel } = await import('../../web/src/components/calendar/CalendarSettingsPanel.tsx'))
  ;({ TimeSettingsPanel } = await import('../../web/src/components/time/TimeSettingsPanel.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ PanelProvider } = await import('../../web/src/state/PanelProvider.tsx'))
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of DOM_GLOBALS) {
    const desc = saved.get(k)
    if (desc) Object.defineProperty(g, k, desc)
    else delete g[k]
  }
})

let root: Root | null = null
afterEach(() => {
  globalThis.fetch = realFetch
  if (root) {
    act(() => root?.unmount())
    root = null
  }
})

const OFFLINE = 'The shared board is not reachable from this computer now: try again once it is back'

/** The panel opened, every call answered with `status` and `body`; the page's text once it settled. */
async function opened(which: 'calendar' | 'time', status: number, body: unknown): Promise<string> {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  const host = dom.window.document.getElementById('root') as HTMLElement
  const ctx = board({
    data: payload({
      calendar: { rev: '1', busy: false, failing: 0, next: null },
      time: { seq: 1, date: '2026-11-25', today: {} },
    }),
  })
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={ctx}>
          <PanelProvider>
            {which === 'calendar' ? (
              <CalendarSettingsPanel open onClose={() => {}} />
            ) : (
              <TimeSettingsPanel open onClose={() => {}} />
            )}
          </PanelProvider>
        </BoardContext.Provider>
      </I18nProvider>,
    )
    await Bun.sleep(20)
  })
  return host.textContent ?? ''
}

const AWAY = { ok: false, error: 'node-master-offline', message: 'The master board is not reachable' }

test('Settings → Calendar with the shared board away: the plain line, not the code', async () => {
  const text = await opened('calendar', 503, AWAY)
  expect(text).toContain(OFFLINE)
  expect(text).not.toContain('node-master-offline')
})

test('Settings → Time with the shared board away: the plain line, not the code', async () => {
  const text = await opened('time', 503, AWAY)
  expect(text).toContain(OFFLINE)
  expect(text).not.toContain('node-master-offline')
})

test("the board's own refusal shows as it did", async () => {
  expect(await opened('calendar', 409, { ok: false, error: 'Calendar is off' })).toContain('Calendar is off')
})
