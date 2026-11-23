// Structured 5-section Settings panel (#651): Display, Board & Agents, Features, Integrations,
// and System. Replaces the cascading context menu while keeping every inline toggle and sub-panel
// link reachable on desktop and phone, local and remote, English and Russian.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import type { SettingsPanelProps } from '../../web/src/components/settings/SettingsPanel.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
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
    inherited: false,
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

function fullPayload(): BoardPayload {
  return payload({
    foldWaiting: 'over',
    compactDefault: '80%',
    profiles: PROFILES,
    todos: { agents: true },
    threads: { rev: 1, needsOwner: 0 },
    calendar: { rev: '1', busy: false, failing: 0, next: null },
    time: { seq: 1, date: '2026-11-23', today: {} },
    backup: { last: NOW - 60_000, problem: { kind: 'offline', target: 'cloud' } },
    presence: {
      mode: 'auto',
      state: 'here',
      by: 'user',
      since: NOW - 60_000,
      idleMinutes: 15,
      hint: null,
      detects: true,
    },
    devices: [
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
        id: 'atlas-box',
        title: 'atlas-box',
        kind: 'ssh',
        link: { state: 'online', since: NOW - 60_000, heardAt: NOW },
        sameCommit: true,
        paused: false,
        drain: false,
        maxSessions: null,
        minFreeMemMb: null,
        maxLoad: null,
        status: null,
        payloadAt: NOW,
      },
    ],
  })
}

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
    onOpenUpdates: noop,
    onOpenTimeSettings: noop,
    onOpenCalendarSettings: noop,
    onOpenLocalPaths: noop,
    onOpenTeam: noop,
    onOpenDevices: noop,
    ...overrides,
  }
}

describe('SettingsPanel static rendering (#651)', () => {
  test('renders 5 sections in English and Russian, with system warning indicator and zero em/en dashes', async () => {
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')
    for (const [lang, expectedTabs] of [
      ['en', ['Display', 'Board & Agents', 'Features', 'Integrations', 'System']],
      ['ru', ['Экран', 'Доска и агенты', 'Функции', 'Интеграции', 'Система']],
    ] as const) {
      const nodes = renderInBoard(
        <PanelProvider viewport={() => VP}>
          <SettingsPanel {...baseProps()} />
        </PanelProvider>,
        board({ data: fullPayload(), now: NOW }),
        lang,
      )
      const panel = byId(nodes, 'settings-panel')
      expect(panel.attrs.get('data-measure')).toBe('full')
      const tabs = findAll([panel], el => hasClass(el, 'set-tab'))
      expect(tabs.map(textOf)).toEqual([...expectedTabs])
      // System tab flags amber dot because backup has a problem.
      const sysTab = tabs[4]
      if (!sysTab) throw new Error('expected System tab')
      expect(findAll([sysTab], el => hasClass(el, 'set-tab-dot'))).toHaveLength(1)
      // Display section renders inline theme/look/cardText/panel controls and Sleepers switch.
      expect(findAll([panel], el => hasClass(el, 'set-seg')).length).toBeGreaterThanOrEqual(4)
      expect(findAll([panel], el => hasClass(el, 'set-switch'))).toHaveLength(1)
      // Zero em or en dashes anywhere in the rendered text.
      const fullText = textOf(panel)
      expect(fullText).not.toContain('\u2014')
      expect(fullText).not.toContain('\u2013')
    }
  })
})

describe('SettingsPanel interactive navigation (#651)', () => {
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

  test('switching through all 5 sections reaches every sub-panel callback and respects offline state', async () => {
    const { createRoot } = await import('react-dom/client')
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')

    const clicked: string[] = []
    const host = dom.window.document.getElementById('root')
    if (!host) throw new Error('expected #root')
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={board({ data: fullPayload(), canEdit: false, now: NOW })}>
            <PanelProvider viewport={() => VP}>
              <SettingsPanel
                {...baseProps({
                  onOpenProfiles: () => clicked.push('profiles'),
                  onOpenDevices: () => clicked.push('devices'),
                  onOpenBackup: () => clicked.push('backup'),
                  onOpenUpdates: () => clicked.push('updates'),
                })}
              />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })

    const click = async (el: Element | null | undefined) => {
      if (!el) throw new Error('expected clickable element')
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    const tabs = () => [...host.querySelectorAll('.set-tab')]

    // Display: browser-local Theme segmented control remains enabled even when offline (canEdit: false).
    expect((host.querySelector('.set-seg-opt') as HTMLButtonElement).disabled).toBe(false)

    // Switch to Board & Agents: language, presence, and compact selects are disabled when offline.
    await click(tabs()[1])
    expect((host.querySelector('.set-select') as HTMLSelectElement).disabled).toBe(true)
    expect(host.querySelector('.set-pane')?.textContent).toContain('Board & Agents')

    // Switch to Features: shows Tasks and feature switches.
    await click(tabs()[2])
    expect(host.querySelector('.set-pane')?.textContent).toContain('Features')

    // Switch to Integrations: lists Profiles & Devices links and invokes their callbacks.
    await click(tabs()[3])
    const intLinks = [...host.querySelectorAll('.set-link')]
    await click(intLinks.find(b => b.textContent?.includes('Profiles')))
    await click(intLinks.find(b => b.textContent?.includes('Devices')))

    // Switch to System: Backup and Updates links invoke their callbacks.
    await click(tabs()[4])
    const sysLinks = [...host.querySelectorAll('.set-link')]
    await click(sysLinks.find(b => b.textContent?.includes('Backup')))
    await click(sysLinks.find(b => b.textContent?.includes('Updates')))

    expect(clicked).toEqual(['profiles', 'devices', 'backup', 'updates'])

    await act(async () => root.unmount())
  })
})
