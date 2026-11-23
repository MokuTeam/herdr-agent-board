// Settings panel switch for Continue after restart (#633): default on, false when disabled,
// posts { turnResume: boolean } to /api/settings, disabled when offline, English & Russian with no em/en dashes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { STRINGS } from '../../src/core/i18n/strings.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { chooseTurnResume } from '../../web/src/hooks/useSettingsMenu.ts'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'

afterEach(restoreFetch)

const VP = { w: 1440, h: 900 }
const noop = () => {}

function props() {
  return {
    open: true,
    onClose: noop,
    onOpenProfiles: noop,
    onOpenWake: noop,
    onOpenPhones: noop,
    onOpenMokupilot: noop,
    onOpenAccess: noop,
    onOpenBackup: noop,
    onOpenUpdates: noop,
    onOpenTimeSettings: noop,
    onOpenCalendarSettings: noop,
    onOpenLocalPaths: noop,
    onOpenTeam: noop,
    onOpenDevices: noop,
  }
}

test('turnResume i18n keys exist in English and Russian without em/en dashes', () => {
  for (const lang of ['en', 'ru'] as const) {
    for (const key of ['set.turnResume', 'set.turnResume.note', 'err.turnResume']) {
      const val = STRINGS[lang][key]
      expect(typeof val).toBe('string')
      expect(String(val).length).toBeGreaterThan(0)
      expect(String(val)).not.toContain('\u2014')
      expect(String(val)).not.toContain('\u2013')
    }
  }
})

test('chooseTurnResume posts { turnResume } or toasts when offline', async () => {
  const calls = answers([200, { ok: true }], [200, { ok: true }])
  const toasts: [string, boolean | undefined][] = []
  const t = ((k: string) => String(STRINGS.en[k] ?? k)) as unknown as Parameters<typeof chooseTurnResume>[1]['t']

  await chooseTurnResume(false, {
    t,
    canEdit: true,
    save: body => fetch('/api/settings', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
    toast: (msg, err) => toasts.push([msg, err]),
  })
  await chooseTurnResume(true, {
    t,
    canEdit: true,
    save: body => fetch('/api/settings', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
    toast: (msg, err) => toasts.push([msg, err]),
  })
  expect(sent(calls).map(c => c[3])).toEqual([{ turnResume: false }, { turnResume: true }])
  expect(toasts).toEqual([])

  await chooseTurnResume(false, {
    t,
    canEdit: false,
    save: async () => ({ ok: true }),
    toast: (msg, err) => toasts.push([msg, err]),
  })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]?.[1]).toBe(true)
})

describe('SettingsPanel Board & Agents Continue after restart switch (#633)', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
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
  ] as const
  const OWN = [
    'devicePixelRatio',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'addEventListener',
    'removeEventListener',
    'matchMedia',
  ] as const
  const saved = new Map<string, PropertyDescriptor | undefined>()

  beforeAll(() => {
    const win = dom.window as unknown as Record<string, unknown>
    for (const k of [...KEYS, ...OWN, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
    for (const k of KEYS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
    g.IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(g, 'devicePixelRatio', { value: 1, configurable: true, writable: true })
    Object.defineProperty(g, 'ResizeObserver', {
      value: class {
        observe() {}
        disconnect() {}
      },
      configurable: true,
    })
    Object.defineProperty(g, 'requestAnimationFrame', { value: () => 0, configurable: true })
    Object.defineProperty(g, 'cancelAnimationFrame', { value: () => {}, configurable: true })
    Object.defineProperty(g, 'addEventListener', {
      value: dom.window.addEventListener.bind(dom.window),
      configurable: true,
    })
    Object.defineProperty(g, 'removeEventListener', {
      value: dom.window.removeEventListener.bind(dom.window),
      configurable: true,
    })
    Object.defineProperty(g, 'matchMedia', {
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      configurable: true,
    })
  })

  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d)
      else delete g[k]
    }
  })

  test('renders switch in Board & Agents, reflects payload.turnResume, respects canEdit, and posts toggle', async () => {
    const { createRoot } = await import('react-dom/client')
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')

    const host = dom.window.document.getElementById('root')
    if (!host) throw new Error('expected #root')
    const root = createRoot(host)

    const renderPanel = async (data: BoardPayload, canEdit = true) => {
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data, canEdit })}>
              <PanelProvider viewport={() => VP}>
                <SettingsPanel {...props()} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
    }

    const click = async (el: Element | null | undefined) => {
      if (!el) throw new Error('expected element')
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    await renderPanel(payload({}))
    await click([...host.querySelectorAll('.set-tab')][1])
    const sw = () =>
      host.querySelector('button[role="switch"][aria-label="Continue after restart"]') as HTMLButtonElement
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(sw().disabled).toBe(false)

    const calls = answers([200, { ok: true }])
    await click(sw())
    await Bun.sleep(10)
    expect(sent(calls)).toEqual([['/api/settings', 'POST', '1', { turnResume: false }]])

    await renderPanel(payload({ turnResume: false }), false)
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(sw().disabled).toBe(true)

    await act(async () => root.unmount())
  })
})
