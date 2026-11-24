// Structured 5-section Settings panel (#651): Display, Board & Agents, Features, Integrations,
// and System. Replaces the cascading context menu while keeping every inline toggle and sub-panel
// link reachable on desktop and phone, local and remote, English and Russian.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { todoModeOf } from '../../src/core/todos.ts'
import type { SettingsPanelProps } from '../../web/src/components/settings/SettingsPanel.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import type { MenuItem } from '../../web/src/models/menu-model.ts'
import { offersProfiles } from '../../web/src/models/profiles.ts'
import { keepAuth } from '../../web/src/models/remote-page.ts'
import { featuresNow, offersMokupilot, settingsMenu, threadsNow } from '../../web/src/models/settings-menu.ts'
import { offersTeam } from '../../web/src/models/team.ts'
import { isWakeView } from '../../web/src/models/wake.ts'
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
    onOpenHousekeeping: noop,
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

  afterEach(() => {
    dom.window.document.documentElement.removeAttribute('data-remote')
    dom.window.document.documentElement.removeAttribute('data-team')
    dom.window.localStorage.clear()
  })

  test('switching through all 5 sections reaches every sub-panel callback and respects offline state', async () => {
    const { createRoot } = await import('react-dom/client')
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')

    const clicked: string[] = []
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
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
                  onOpenHousekeeping: () => clicked.push('housekeeping'),
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

    // Switch to System: Backup, Updates, and Housekeeping links invoke their callbacks.
    await click(tabs()[4])
    const sysLinks = [...host.querySelectorAll('.set-link')]
    expect(sysLinks.map(b => b.querySelector('.set-lbl b')?.textContent)).toEqual([
      'Backup…',
      'Updates…',
      'Housekeeping…',
    ])
    await click(sysLinks.find(b => b.textContent?.includes('Backup')))
    await click(sysLinks.find(b => b.textContent?.includes('Updates')))
    await click(sysLinks.find(b => b.textContent?.includes('Housekeeping')))

    expect(clicked).toEqual(['profiles', 'devices', 'backup', 'updates', 'housekeeping'])

    await act(async () => root.unmount())
  })

  test('Housekeeping row shows live memory/tab status on local page and hides on remote page (#682)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')

    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host)
    const click = async (el: Element | null | undefined) => {
      if (!el) throw new Error('expected clickable element')
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    const cases = [
      { hk: undefined, lang: 'en' as const, expected: 'Memory: off · Tabs: off' },
      { hk: { memory: true, tabs: false }, lang: 'en' as const, expected: 'Memory: on · Tabs: off' },
      { hk: { memory: false, tabs: true }, lang: 'en' as const, expected: 'Memory: off · Tabs: on' },
      { hk: { memory: true, tabs: true }, lang: 'ru' as const, expected: 'Память: вкл · Вкладки: вкл' },
    ]
    for (const c of cases) {
      await act(async () => {
        root.render(
          <I18nProvider key={c.lang} lang={c.lang}>
            <BoardContext.Provider value={board({ data: payload(c.hk ? { housekeeping: c.hk } : {}), now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <SettingsPanel {...baseProps()} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
      await click([...host.querySelectorAll('.set-tab')].at(-1))
      const hkRow = [...host.querySelectorAll('.set-link')].find(el =>
        el.textContent?.includes(c.lang === 'ru' ? 'Уборка узла' : 'Housekeeping'),
      )
      expect(hkRow).toBeTruthy()
      const meta = hkRow?.querySelector('.set-link-meta')?.textContent ?? ''
      expect(meta).toBe(c.expected)
      expect(meta).not.toContain('\u2014')
      expect(meta).not.toContain('\u2013')
    }

    // Remote page: Housekeeping row is not offered.
    dom.window.document.documentElement.setAttribute('data-remote', '')
    await act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider
            value={board({ data: payload({ housekeeping: { memory: true, tabs: true } }), now: NOW })}
          >
            <PanelProvider viewport={() => VP}>
              <SettingsPanel {...baseProps()} />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
    await click([...host.querySelectorAll('.set-tab')].at(-1))
    const remoteLinks = [...host.querySelectorAll('.set-link')].map(el => el.textContent ?? '')
    expect(remoteLinks.some(t => t.includes('Housekeeping'))).toBe(false)

    await act(async () => root.unmount())
  })

  test('every entry offered by settingsMenu has its row in SettingsPanel on local and remote pages (#682)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')

    const richPayload: BoardPayload = {
      ...fullPayload(),
      wake: { enabled: false, mode: 'off', sleepers: [] } as unknown as NonNullable<BoardPayload['wake']>,
      remote: {
        on: true,
        url: 'https://board.example.test',
        error: null,
        devices: [],
        pending: [],
        pwa: { on: false, https: 443, url: null, certs: false, serve: null, error: null },
      },
      watches: true,
      decisions: { defaults: true, items: [], defaulted: [] },
      journal: { strip: null, last: null },
      threads: { rev: 1, needsOwner: 0, cases: true, verify: true },
      teamRev: 2,
      housekeeping: { memory: true, tabs: false },
    }

    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host)
    const click = async (el: Element | null | undefined) => {
      if (!el) throw new Error('expected clickable element')
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    const collectMenuLabels = (isRemote: boolean): string[] => {
      const t = translator('en')
      const feat = !isRemote ? featuresNow(richPayload) : undefined
      const entries = settingsMenu({
        t,
        theme: 'auto',
        look: 'classic',
        cardText: 'cut',
        languages: richPayload.languages,
        canEdit: true,
        dock: 'right',
        sleepers: true,
        profiles: offersProfiles(richPayload.profiles),
        fold: richPayload.foldWaiting,
        wake: isWakeView(richPayload.wake),
        phones: !!richPayload.remote,
        mokupilot: offersMokupilot(richPayload),
        access: !isRemote,
        backup: !isRemote,
        updates: !isRemote,
        housekeeping: !isRemote,
        timeSettings: !isRemote,
        calendarSettings: !isRemote,
        team: offersTeam(richPayload),
        devices: !isRemote,
        signOut: isRemote,
        presence: richPayload.presence?.mode ?? 'none',
        idleMinutes: richPayload.presence?.idleMinutes,
        todos: todoModeOf(richPayload.todos ?? null),
        threads: !isRemote ? threadsNow(richPayload).mode : undefined,
        threadsShare: !isRemote ? threadsNow(richPayload).share : undefined,
        compact: richPayload.compactDefault,
        localPaths: isRemote,
        watches: feat?.watches,
        decisions: feat?.decisions,
        decisionsDefaults: feat?.decisionsDefaults,
        journal: feat?.journal,
        threadsCases: feat?.threadsCases,
        threadsVerify: feat?.threadsVerify,
      })
      const labels: string[] = []
      for (const entry of entries) {
        if ('separator' in entry) continue
        const item = entry as MenuItem
        labels.push(item.label)
        if (item.id === 'threads' && item.submenu) {
          for (const sub of item.submenu) {
            if (!('separator' in sub) && (sub.id.startsWith('threadsCases:') || sub.id.startsWith('threadsVerify:')))
              labels.push(sub.label)
          }
        }
      }
      return labels
    }

    const collectPanelLabels = async (isRemote: boolean): Promise<Set<string>> => {
      if (isRemote) {
        dom.window.document.documentElement.setAttribute('data-remote', '')
        dom.window.document.documentElement.setAttribute('data-team', '')
        keepAuth('login')
      } else {
        dom.window.document.documentElement.removeAttribute('data-remote')
        dom.window.document.documentElement.removeAttribute('data-team')
      }
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data: richPayload, now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <SettingsPanel {...baseProps()} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
      const found = new Set<string>()
      const tabs = [...host.querySelectorAll('.set-tab')]
      for (const tab of tabs) {
        await click(tab)
        for (const b of host.querySelectorAll('.set-row .set-lbl b, .set-sub .set-chk span')) {
          const text = b.textContent?.trim()
          if (text) found.add(text)
        }
      }
      return found
    }

    for (const isRemote of [false, true]) {
      const expected = collectMenuLabels(isRemote)
      const actual = await collectPanelLabels(isRemote)
      for (const label of expected) expect(actual.has(label)).toBe(true)
    }

    await act(async () => root.unmount())
    host.remove()
  })

  test('wide desktop SettingsPanel layout keeps sidebar beside pane with no back button (#679)', async () => {
    const { SettingsPanel } = await import('../../web/src/components/settings/SettingsPanel.tsx')
    const nodes = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 900 })}>
        <SettingsPanel {...baseProps()} />
      </PanelProvider>,
      board({ data: fullPayload(), now: NOW }),
    )
    const panel = byId(nodes, 'settings-panel')
    expect(findAll([panel], el => hasClass(el, 'sheet-back'))).toHaveLength(0)
    expect(findAll([panel], el => hasClass(el, 'set-nav'))).toHaveLength(1)
    expect(findAll([panel], el => hasClass(el, 'set-pane'))).toHaveLength(1)
    const css = readFileSync(join(import.meta.dir, '..', '..', 'web', 'styles', 'settings-panel.css'), 'utf8')
    expect(css).toContain('grid-template-columns: 192px minmax(0, 1fr);')
  })
})
