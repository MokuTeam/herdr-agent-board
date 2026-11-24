// Settings inner-page navigation (#679): header back control left of title, section & scroll
// position preservation, Esc and browser Back stepping back to Settings before closing on both
// wide desktop and phone, and unchanged behavior for panels opened outside Settings.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import { Panel } from '../../web/src/components/panel/Panel.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { stopAllSprings } from '../../web/src/models/spring.ts'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { byId, findAll, hasClass, type Element as MarkupElement, type Node } from './support/markup.ts'

const NOW = Date.now()
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

function appPayload(): BoardPayload {
  return payload({
    foldWaiting: 'over',
    compactDefault: '80%',
    profiles: PROFILES,
    todos: { agents: true },
    threads: { rev: 1, needsOwner: 0 },
    calendar: { rev: '1', busy: false, failing: 0, next: null },
    time: { seq: 1, date: '2026-11-23', today: {} },
    backup: { last: NOW - 60_000, problem: null },
    teamRev: 1,
    housekeeping: { memory: true, tabs: false },
  })
}

describe('PanelHead back control (#679)', () => {
  test('renders back button left of title when back prop is provided and omits it otherwise', () => {
    const withBack = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 900 })}>
        <Panel
          id="time-settings-sheet"
          kind="timeSettings"
          open={true}
          onClose={() => {}}
          back={{ label: 'Settings', ariaLabel: 'Back to Settings', onBack: () => {} }}
          title={<h2>Time tracking</h2>}
        />
      </PanelProvider>,
      board(),
    )
    const aside = byId(withBack, 'time-settings-sheet')
    const head = findAll([aside], el => hasClass(el, 'sheet-head'))[0]
    if (!head) throw new Error('expected .sheet-head')
    const kids = head.children.filter((c): c is MarkupElement => c.kind === 'element')
    expect(kids.map(k => k.attrs.get('class'))).toEqual(['sheet-back', 'sheet-title', 'sheet-tools'])
    const backBtn = kids[0]
    expect(backBtn?.attrs.get('aria-label')).toBe('Back to Settings')
    expect(backBtn ? textOf(backBtn) : '').toBe('Settings')
    expect(backBtn ? findAll([backBtn], el => el.tag === 'svg') : []).toHaveLength(1)

    const withoutBack = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 900 })}>
        <Panel id="time-settings-sheet" kind="timeSettings" open={true} onClose={() => {}} title={<h2>Time</h2>} />
      </PanelProvider>,
      board(),
    )
    expect(findAll(withoutBack, el => hasClass(el, 'sheet-back'))).toHaveLength(0)
  })
})

describe('App Settings inner navigation (#679)', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const g = globalThis as Record<string, unknown>
  const KEYS = [
    'window',
    'document',
    'navigator',
    'location',
    'innerWidth',
    'innerHeight',
    'scrollX',
    'scrollY',
    'getComputedStyle',
    'HTMLElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Event',
    'CustomEvent',
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
    'scrollBy',
    'getSelection',
    'fetch',
    'history',
  ] as const
  const saved = new Map<string, PropertyDescriptor | undefined>()

  let mobileMode = false
  let rafId = 0
  const rafQueue = new Map<number, (now: number) => void>()
  let rafNow = 0
  const settleSprings = async () => {
    for (let i = 0; i < 80 && rafQueue.size > 0; i++) {
      rafNow += 16
      const batch = [...rafQueue.values()]
      rafQueue.clear()
      await act(async () => {
        for (const cb of batch) cb(rafNow)
      })
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  let historyCalls = { push: 0, back: 0, state: null as unknown }
  const fakeHistory = {
    get state() {
      return historyCalls.state
    },
    pushState(s: unknown) {
      historyCalls.state = s
      historyCalls.push++
    },
    replaceState(s: unknown) {
      historyCalls.state = s
    },
    back() {
      historyCalls.back++
      historyCalls.state = null
      setTimeout(() => {
        dom.window.dispatchEvent(new dom.window.Event('popstate'))
      }, 0)
    },
  }

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
    Object.defineProperty(g, 'requestAnimationFrame', {
      value: (cb: (now: number) => void) => {
        const id = ++rafId
        rafQueue.set(id, cb)
        return id
      },
      configurable: true,
    })
    Object.defineProperty(g, 'cancelAnimationFrame', {
      value: (id: number) => {
        rafQueue.delete(id)
      },
      configurable: true,
    })
    Object.defineProperty(g, 'addEventListener', {
      value: dom.window.addEventListener.bind(dom.window),
      configurable: true,
    })
    Object.defineProperty(g, 'removeEventListener', {
      value: dom.window.removeEventListener.bind(dom.window),
      configurable: true,
    })
    Object.defineProperty(g, 'matchMedia', {
      value: (query: string) => ({
        matches: query.includes('max-width: 760px') ? mobileMode : false,
        addEventListener() {},
        removeEventListener() {},
      }),
      configurable: true,
    })
    Object.defineProperty(g, 'scrollBy', { value: () => {}, configurable: true })
    Object.defineProperty(g, 'getSelection', { value: () => null, configurable: true })
    Object.defineProperty(g, 'history', { value: fakeHistory, configurable: true })
    Object.defineProperty(g, 'fetch', {
      value: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
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
    stopAllSprings()
    rafQueue.clear()
    mobileMode = false
    historyCalls = { push: 0, back: 0, state: null }
    dom.window.localStorage.clear()
  })

  test('desktop (1600px): back button, scroll/section preservation, Esc x2, browser Back, and non-Settings openers', async () => {
    const { createRoot } = await import('react-dom/client')
    const { App } = await import('../../web/src/App.tsx')

    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host)

    const renderApp = async (lang = 'en', vp = { w: 1600, h: 900 }) => {
      await act(async () => {
        root.render(
          <I18nProvider key={lang} lang={lang}>
            <BoardContext.Provider value={board({ data: appPayload(), now: NOW })}>
              <PanelProvider viewport={() => vp}>
                <App />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
    }

    const click = async (el: Element | null | undefined) => {
      if (!el) throw new Error('expected clickable element')
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await settleSprings()
    }

    const pressKey = async (key: string) => {
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
      })
      await settleSprings()
    }

    const popState = async () => {
      historyCalls.state = null
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event('popstate'))
      })
      await settleSprings()
    }

    const isOpen = (id: string) => host.querySelector(`#${id}`)?.classList.contains('open') ?? false

    await renderApp('en')

    // 1. Open Settings via ',' shortcut: zero desktop history entries pushed.
    await pressKey(',')
    expect(isOpen('settings-panel')).toBe(true)
    expect(historyCalls.push).toBe(0)

    // Switch to Integrations, scroll down, open Time tracking.
    const tabs = () => [...host.querySelectorAll('#settings-panel .set-tab')]
    await click(tabs()[3])
    const pane = host.querySelector('#settings-panel .set-pane') as HTMLElement
    pane.scrollTop = 180
    const timeRow = [...host.querySelectorAll('#settings-panel .set-link')].find(el =>
      el.textContent?.includes('Time tracking'),
    )
    await click(timeRow)

    expect(isOpen('time-settings-sheet')).toBe(true)
    expect(isOpen('settings-panel')).toBe(false)
    // Sentinel armed on desktop while inner Settings page is open.
    expect(historyCalls.push).toBe(1)

    const backBtn = host.querySelector('#time-settings-sheet .sheet-head .sheet-back') as HTMLButtonElement | null
    expect(backBtn).toBeTruthy()
    expect(backBtn?.textContent).toBe('Settings')
    expect(backBtn?.getAttribute('aria-label')).toBe('Back to Settings')
    // Back button is left of title in .sheet-head.
    const headKids = [...(host.querySelector('#time-settings-sheet .sheet-head')?.children ?? [])].map(
      el => el.className,
    )
    expect(headKids).toEqual(['sheet-back', 'sheet-title', 'sheet-tools'])

    // 2. Click back button -> returns to Settings, keeps Integrations section & scrollTop = 180, cleans up sentinel.
    await click(backBtn)
    expect(isOpen('time-settings-sheet')).toBe(false)
    expect(isOpen('settings-panel')).toBe(true)
    expect(tabs()[3]?.classList.contains('on')).toBe(true)
    expect((host.querySelector('#settings-panel .set-pane') as HTMLElement).scrollTop).toBe(180)
    expect(historyCalls.back).toBe(1)

    // 3. Open Housekeeping from System -> first Esc returns to Settings, second Esc closes Settings.
    await click(tabs()[4])
    const hkRow = [...host.querySelectorAll('#settings-panel .set-link')].find(el =>
      el.textContent?.includes('Housekeeping'),
    )
    await click(hkRow)
    expect(isOpen('housekeeping-sheet')).toBe(true)
    expect(host.querySelector('#housekeeping-sheet .sheet-back')?.textContent).toBe('Settings')

    await pressKey('Escape')
    expect(isOpen('housekeeping-sheet')).toBe(false)
    expect(isOpen('settings-panel')).toBe(true)
    expect(tabs()[4]?.classList.contains('on')).toBe(true)

    await pressKey('Escape')
    expect(isOpen('settings-panel')).toBe(false)

    // 4. Re-open Settings -> Integrations -> Time tracking -> browser Back steps back to Settings list.
    await pressKey(',')
    await click(tabs()[3])
    ;(host.querySelector('#settings-panel .set-pane') as HTMLElement).scrollTop = 140
    await click(
      [...host.querySelectorAll('#settings-panel .set-link')].find(el => el.textContent?.includes('Time tracking')),
    )
    expect(isOpen('time-settings-sheet')).toBe(true)

    await popState()
    expect(isOpen('time-settings-sheet')).toBe(false)
    expect(isOpen('settings-panel')).toBe(true)
    expect(tabs()[3]?.classList.contains('on')).toBe(true)
    expect((host.querySelector('#settings-panel .set-pane') as HTMLElement).scrollTop).toBe(140)

    // 5. Clicking close (x) on an inner page closes Settings flow without reopening Settings list.
    await click(
      [...host.querySelectorAll('#settings-panel .set-link')].find(el => el.textContent?.includes('Time tracking')),
    )
    expect(isOpen('time-settings-sheet')).toBe(true)
    await click(host.querySelector('#time-settings-sheet [data-close]'))
    expect(isOpen('time-settings-sheet')).toBe(false)
    expect(isOpen('settings-panel')).toBe(false)

    // 6. Opening Team directly from NavRail (outside Settings) shows NO back button and single Esc closes it.
    const teamNav = host.querySelector('#nav-rail #team-open')
    await click(teamNav)
    expect(isOpen('team-sheet')).toBe(true)
    expect(host.querySelector('#team-sheet .sheet-back')).toBeNull()
    await pressKey('Escape')
    expect(isOpen('team-sheet')).toBe(false)
    expect(isOpen('settings-panel')).toBe(false)

    // 7. Russian label for back control.
    await renderApp('ru')
    await pressKey(',')
    await click(tabs()[3])
    await click(
      [...host.querySelectorAll('#settings-panel .set-link')].find(el => el.textContent?.includes('Учёт времени')),
    )
    const ruBack = host.querySelector('#time-settings-sheet .sheet-back')
    expect(ruBack?.textContent).toBe('Настройки')
    expect(ruBack?.getAttribute('aria-label')).toBe('Назад в настройки')
    await click(ruBack)
    await pressKey('Escape')

    await act(async () => root.unmount())
    host.remove()
  })

  test('phone (390px): browser Back steps from inner page to Settings list, second Back closes Settings', async () => {
    const { createRoot } = await import('react-dom/client')
    const { App } = await import('../../web/src/App.tsx')

    mobileMode = true
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={board({ data: appPayload(), now: NOW })}>
            <PanelProvider viewport={() => ({ w: 390, h: 844 })}>
              <App />
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
      await settleSprings()
    }
    const popState = async () => {
      historyCalls.state = null
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event('popstate'))
      })
      await settleSprings()
    }
    const isOpen = (id: string) => host.querySelector(`#${id}`)?.classList.contains('open') ?? false

    // Open Settings from NavRail, navigate to Integrations -> Time tracking.
    await click(host.querySelector('#nav-rail #settings'))
    expect(isOpen('settings-panel')).toBe(true)
    await click(host.querySelectorAll('#settings-panel .set-tab')[3])
    await click(
      [...host.querySelectorAll('#settings-panel .set-link')].find(el => el.textContent?.includes('Time tracking')),
    )
    expect(isOpen('time-settings-sheet')).toBe(true)
    expect(isOpen('settings-panel')).toBe(false)

    // First Back -> returns to Settings list.
    await popState()
    expect(isOpen('time-settings-sheet')).toBe(false)
    expect(isOpen('settings-panel')).toBe(true)

    // Second Back -> closes Settings.
    await popState()
    expect(isOpen('settings-panel')).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })
})
