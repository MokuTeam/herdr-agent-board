// Settings → Board & Agents, Agent starts (#815): this computer's limits on the starts its sessions
// make, from the payload's `spawnLimits`; each change posts { spawnLimits } to /api/settings. A board
// before them sends none: no rows. English and Russian, with no em or en dashes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { STRINGS } from '../../src/core/i18n/strings.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { SPAWN_DEFAULTS } from '../../src/core/spawn-limits.ts'
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
    onOpenHousekeeping: noop,
    onOpenTimeSettings: noop,
    onOpenCalendarSettings: noop,
    onOpenLocalPaths: noop,
    onOpenTeam: noop,
    onOpenDevices: noop,
  }
}

test('agent starts: every text in English and Russian, without em or en dashes', () => {
  const keys = Object.keys(STRINGS.en).filter(
    k => k.startsWith('set.spawn') || k.startsWith('spawn.') || k === 'err.spawnLimits',
  )
  expect(keys.length).toBeGreaterThanOrEqual(11)
  for (const lang of ['en', 'ru'] as const)
    for (const key of keys) {
      const val = STRINGS[lang][key]
      expect(val).toBeDefined()
      for (const s of Array.isArray(val) ? val : [String(val)]) {
        expect(s.length).toBeGreaterThan(0)
        expect(s).not.toContain('\u2014')
        expect(s).not.toContain('\u2013')
      }
    }
})

describe('SettingsPanel Board & Agents: agent starts (#815)', () => {
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

  test('the switch and the three limits, as the payload has them; a change posts it; none from an older board', async () => {
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
    const sw = () => host.querySelector('button[role="switch"][aria-label="Agent starts"]') as HTMLButtonElement | null
    const select = (label: string) => host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement | null

    // A board before the limits: no rows.
    await renderPanel(payload({}))
    await click([...host.querySelectorAll('.set-tab')][1])
    expect(sw()).toBeNull()

    await renderPanel(payload({ spawnLimits: { ...SPAWN_DEFAULTS, depth: 4 } }))
    expect(sw()?.getAttribute('aria-checked')).toBe('true')
    expect(select('Running at once, per session')?.value).toBe('10')
    // A value config.json holds that Settings does not offer is shown, chosen.
    expect(select('Levels of starts below yours')?.value).toBe('4')
    expect([...(select('Starts per session in an hour')?.options ?? [])].map(o => o.text)).toEqual([
      '10',
      '30',
      '60',
      '120',
      'No limit',
    ])

    const calls = answers([200, { ok: true }], [200, { ok: true }])
    const children = select('Running at once, per session')
    if (!children) throw new Error('expected the select')
    await act(async () => {
      children.value = '0'
      children.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    await click(sw())
    await Bun.sleep(10)
    expect(sent(calls)).toEqual([
      ['/api/settings', 'POST', '1', { spawnLimits: { children: 0 } }],
      ['/api/settings', 'POST', '1', { spawnLimits: { agents: false } }],
    ])

    // Off: the numbers are not shown; offline: the switch cannot be used.
    await renderPanel(payload({ spawnLimits: { ...SPAWN_DEFAULTS, agents: false } }), false)
    expect(sw()?.getAttribute('aria-checked')).toBe('false')
    expect(sw()?.disabled).toBe(true)
    expect(select('Running at once, per session')).toBeNull()

    await act(async () => root.unmount())
  })
})
