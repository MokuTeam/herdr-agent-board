// Verified done Settings section (#680): renders inside Settings -> Features under Threads (no
// new top-level tab), reads back hand-written config.json settings unchanged, edits and clears
// every threads.verify field (model, profile single/per-device, lanes, brief default/per-lane,
// limitMin, max), shows kept-while-off note, disables when offline, and hides on remote pages.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { BoardCategory, BoardDevice, BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { VERIFY_CODE_CHECKLIST, type VerifySettingsView } from '../../src/core/work-threads.ts'
import type { SettingsPanelProps } from '../../web/src/components/settings/SettingsPanel.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { byId, findAll, hasClass, type Node } from './support/markup.ts'

const NOW = Date.now()
const VP = { w: 1440, h: 900 }
const noop = () => {}
const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))

const PROFILES: BoardProfile[] = [
  {
    id: 'default',
    title: 'Private',
    color: '#5856D6',
    colorName: 'indigo',
    dir: 'default',
    hidden: false,
    inherited: true,
    exists: true,
    hooks: true,
    sessions: 1,
    limits: null,
  },
  {
    id: 'work',
    title: 'Work',
    color: '#30B0C7',
    colorName: 'teal',
    dir: 'work',
    hidden: false,
    inherited: false,
    exists: true,
    hooks: true,
    sessions: 2,
    limits: null,
  },
]

const CATEGORIES: BoardCategory[] = [
  { id: 'atlas', title: 'Atlas', color: '#2558d9', colorName: 'blue', paths: [], configured: true, fallback: false },
  { id: 'cleo', title: 'Cleo', color: '#1f8a4c', colorName: 'green', paths: [], configured: true, fallback: false },
  { id: 'other', title: 'Other', color: '#8a8a93', colorName: 'gray', paths: [], configured: true, fallback: true },
]

const DEVICES: BoardDevice[] = [
  {
    id: 'local',
    title: 'laptop',
    kind: null,
    link: null,
    sameCommit: true,
    paused: false,
    drain: false,
    maxSessions: null,
    minFreeMemMb: null,
    maxLoad: null,
    status: null,
    payloadAt: NOW,
  },
  {
    id: 'server-1',
    title: 'Build box',
    kind: 'ssh',
    link: { state: 'online', since: NOW - 60_000, heardAt: NOW },
    sameCommit: true,
    paused: false,
    drain: false,
    maxSessions: null,
    minFreeMemMb: null,
    maxLoad: null,
    status: {
      api: 1,
      id: 'server-1',
      version: '0.1.0',
      commit: 'abc',
      platform: 'linux',
      arch: 'x64',
      cpus: 4,
      memTotalMb: 8192,
      memAvailableMb: 4096,
      load: [0.1, 0.1, 0.1],
      sessions: { awake: 0, working: 0, asleep: 0 },
      launches: 0,
      workRootFreeMb: 10000,
      profiles: [
        { id: 'default', loggedIn: true, bundle: null },
        { id: 'work', loggedIn: true, bundle: null },
      ],
      agents: ['claude'],
      at: NOW,
    },
    payloadAt: NOW,
  },
]

function baseProps(overrides: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    open: true,
    onClose: noop,
    onOpenProfiles: noop,
    onOpenWake: noop,
    onOpenPhones: noop,
    onOpenMokupilot: noop,
    onOpenAccess: noop,
    onOpenBackup: noop,
    onOpenHousekeeping: noop,
    onOpenUpdates: noop,
    onOpenTimeSettings: noop,
    onOpenCalendarSettings: noop,
    onOpenLocalPaths: noop,
    onOpenTeam: noop,
    onOpenDevices: noop,
    ...overrides,
  }
}

function makeView(overrides: Partial<VerifySettingsView['verify']['settings']> = {}, on = true): VerifySettingsView {
  return {
    threadsOn: true,
    verify: {
      on,
      settings: {
        model: null,
        profile: null,
        lanes: [],
        brief: null,
        limitMin: null,
        max: null,
        ...overrides,
      },
      defaults: { limitMin: 30, max: 2 },
    },
  }
}

describe('Verified done section in SettingsPanel (#680)', () => {
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
    'KeyboardEvent',
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

  afterEach(() => {
    restoreFetch()
    dom.window.document.documentElement.removeAttribute('data-remote')
  })

  afterAll(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d)
      else delete g[k]
    }
  })

  async function mountSettings(data: BoardPayload, canEdit = true) {
    const { createRoot } = await import('react-dom/client')
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')
    const host = dom.window.document.getElementById('root')
    if (!host) throw new Error('expected #root')
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <I18nProvider lang={data.lang}>
          <BoardContext.Provider value={board({ data, canEdit, now: NOW })}>
            <PanelProvider viewport={() => VP}>
              <SettingsPanel {...baseProps()} />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
    return { host, unmount: () => act(async () => root.unmount()) }
  }

  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('expected clickable element')
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }

  const changeSelect = async (el: HTMLSelectElement | null | undefined, value: string) => {
    if (!el) throw new Error('expected select element')
    await act(async () => {
      el.value = value
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
  }

  const typeInput = async (el: HTMLInputElement | null | undefined, value: string) => {
    if (!el) throw new Error('expected input element')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(el, value)
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
  }

  test('keeps 5 top-level sections, zero em/en dashes, and hides Verified done when remote', async () => {
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')
    for (const lang of ['en', 'ru'] as const) {
      const nodes = renderInBoard(
        <PanelProvider viewport={() => VP}>
          <SettingsPanel {...baseProps()} />
        </PanelProvider>,
        board({
          data: payload({
            lang,
            profiles: PROFILES,
            categories: CATEGORIES,
            threads: { rev: 1, needsOwner: 0, verify: true },
          }),
          now: NOW,
        }),
        lang,
      )
      const panel = byId(nodes, 'settings-panel')
      const tabs = findAll([panel], el => hasClass(el, 'set-tab'))
      expect(tabs).toHaveLength(5)
      const fullText = textOf(panel)
      expect(fullText).not.toContain('\u2014')
      expect(fullText).not.toContain('\u2013')
    }

    // Remote page hides Features completely (no Verified done).
    dom.window.document.documentElement.setAttribute('data-remote', '1')
    const { host, unmount } = await mountSettings(
      payload({ profiles: PROFILES, categories: CATEGORIES, threads: { rev: 1, needsOwner: 0, verify: true } }),
    )
    expect([...host.querySelectorAll('.set-tab')]).toHaveLength(4)
    expect(host.querySelector('.set-verify-row')).toBeNull()
    await unmount()
  })

  test('opens Verified done section, loads hand-written settings unchanged, and edits + clears every field', async () => {
    const handView = makeView({
      model: 'claude-opus-5-5',
      profile: { local: 'work', 'server-1': 'default' },
      lanes: ['atlas'],
      brief: { atlas: VERIFY_CODE_CHECKLIST, '*': 'docs/agents/verify-checklist.md' },
      limitMin: 45,
      max: 3,
    })
    const afterView = makeView({
      model: 'sonnet',
      profile: { local: 'work', 'server-1': 'default' },
      lanes: ['atlas'],
      brief: { atlas: VERIFY_CODE_CHECKLIST, '*': 'docs/agents/verify-checklist.md' },
      limitMin: 45,
      max: 3,
    })

    const calls = answers(
      [200, handView],
      [200, { ok: true }],
      [200, afterView],
      [200, { ok: true }],
      [200, makeView({ ...afterView.verify.settings, lanes: ['atlas', 'cleo'] })],
      [200, { ok: true }],
      [200, makeView({ ...afterView.verify.settings, lanes: [] })],
      [200, { ok: true }],
      [200, makeView({ ...afterView.verify.settings, lanes: [], limitMin: 60 })],
      [200, { ok: true }],
      [200, makeView({ ...afterView.verify.settings, lanes: [], limitMin: 60, max: null })],
      [200, { ok: true }],
      [
        200,
        makeView({ ...afterView.verify.settings, lanes: [], limitMin: 60, max: null, brief: VERIFY_CODE_CHECKLIST }),
      ],
    )

    const { host, unmount } = await mountSettings(
      payload({
        profiles: PROFILES,
        categories: CATEGORIES,
        devices: DEVICES,
        threads: { rev: 1, needsOwner: 0, verify: true },
      }),
    )

    // Go to Features tab.
    await click(host.querySelectorAll('.set-tab')[2])
    expect(host.querySelector('#set-verify-section')).toBeNull()

    // Click Configure button.
    await click(host.querySelector('.set-verify-btn'))
    await act(async () => {
      await Bun.sleep(10)
    })

    const sec = host.querySelector('#set-verify-section')
    if (!sec) throw new Error('expected #set-verify-section')
    expect(sec.textContent).not.toContain('\u2014')
    expect(sec.textContent).not.toContain('\u2013')

    // Hand-written values rendered back unchanged:
    const modelSel = sec.querySelector('select[aria-label="Model"]') as HTMLSelectElement
    expect(modelSel.value).toBe('__custom__')
    const customModelInput = sec.querySelector('input[aria-label="Model (Custom...)"]') as HTMLInputElement
    expect(customModelInput.value).toBe('claude-opus-5-5')

    // Per-device profile selects rendered for local and server-1:
    expect((sec.querySelector('select[aria-label*="local"]') as HTMLSelectElement).value).toBe('work')
    expect((sec.querySelector('select[aria-label*="server-1"]') as HTMLSelectElement).value).toBe('default')

    // Atlas lane checked, Cleo unchecked:
    const laneCheckboxes = [...sec.querySelectorAll('.set-verify-lane input[type="checkbox"]')] as HTMLInputElement[]
    expect(laneCheckboxes.map(c => c.checked)).toEqual([true, false, false])

    // Per-lane brief and custom default brief rendered:
    expect((sec.querySelector('select[aria-label="Checklist"]') as HTMLSelectElement).value).toBe('__custom__')
    expect((sec.querySelector('select[aria-label="Checklist (atlas)"]') as HTMLSelectElement).value).toBe(
      VERIFY_CODE_CHECKLIST,
    )

    // Limit and max rendered:
    const limitInput = sec.querySelector('input[aria-label="Time limit (minutes)"]') as HTMLInputElement
    const maxInput = sec.querySelector('input[aria-label="Max running at once"]') as HTMLInputElement
    expect(limitInput.value).toBe('45')
    expect(maxInput.value).toBe('3')

    // Edit Model -> sonnet
    await changeSelect(modelSel, 'sonnet')
    await act(async () => {
      await Bun.sleep(10)
    })

    // Toggle Cleo lane on, then Clear lanes
    await click(laneCheckboxes[1])
    await act(async () => {
      await Bun.sleep(10)
    })
    const clearButtons = [...sec.querySelectorAll('.set-clear')]
    // First clear button after lanes is the Lanes Clear button (model has no clear when sonnet is selected).
    await click(clearButtons[0])
    await act(async () => {
      await Bun.sleep(10)
    })

    // Edit limitMin -> 60 on Enter, then Clear max
    await typeInput(limitInput, '60')
    await act(async () => {
      limitInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Bun.sleep(10)
    })
    const maxClear = maxInput.parentElement?.querySelector('.set-clear')
    await click(maxClear)
    await act(async () => {
      await Bun.sleep(10)
    })

    // Remove per-lane brief override:
    await click(sec.querySelector('.set-verify-remove'))
    await act(async () => {
      await Bun.sleep(10)
    })

    expect(sent(calls)).toEqual([
      ['/api/threads-settings', undefined, undefined, undefined],
      ['/api/threads-settings', 'POST', '1', { verifySettings: { model: 'sonnet' } }],
      ['/api/threads-settings', undefined, undefined, undefined],
      ['/api/threads-settings', 'POST', '1', { verifySettings: { lanes: ['atlas', 'cleo'] } }],
      ['/api/threads-settings', undefined, undefined, undefined],
      ['/api/threads-settings', 'POST', '1', { verifySettings: { lanes: [] } }],
      ['/api/threads-settings', undefined, undefined, undefined],
      ['/api/threads-settings', 'POST', '1', { verifySettings: { limitMin: 60 } }],
      ['/api/threads-settings', undefined, undefined, undefined],
      ['/api/threads-settings', 'POST', '1', { verifySettings: { max: null } }],
      ['/api/threads-settings', undefined, undefined, undefined],
      ['/api/threads-settings', 'POST', '1', { verifySettings: { brief: 'docs/agents/verify-checklist.md' } }],
      ['/api/threads-settings', undefined, undefined, undefined],
    ])

    await unmount()
  })

  test('without nodes shows single profile select; off keeps note; offline disables controls; Russian renders', async () => {
    const offView = makeView({ model: 'opus', profile: 'work' }, false)
    answers([200, offView], [200, offView])

    const { host, unmount } = await mountSettings(
      payload({
        lang: 'ru',
        profiles: PROFILES,
        categories: CATEGORIES,
        threads: { rev: 1, needsOwner: 0 },
      }),
      false,
    )

    await click(host.querySelectorAll('.set-tab')[2])
    await click(host.querySelector('.set-verify-btn'))
    await act(async () => {
      await Bun.sleep(10)
    })

    const sec = host.querySelector('#set-verify-section')
    if (!sec) throw new Error('expected #set-verify-section')
    expect(sec.querySelector('.set-verify-kept')?.textContent).toContain('Проверка готовности выключена')
    expect(sec.querySelector('select[aria-label="Профиль для не-Claude воркеров"]')).not.toBeNull()
    expect(sec.querySelector('select[aria-label*="server-1"]')).toBeNull()
    // Offline disables inputs and switch.
    expect((host.querySelector('.set-verify-row .set-switch') as HTMLButtonElement).disabled).toBe(true)
    expect((sec.querySelector('select[aria-label="Модель"]') as HTMLSelectElement).disabled).toBe(true)

    await unmount()
  })
})
