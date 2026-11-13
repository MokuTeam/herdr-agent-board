// The threads panel's lane filter (#412) on a real DOM (jsdom) with the board's own menu: a button
// that opens the menu of lanes under it, every lane checked first; a pick narrows the list and the
// button says the lane; open again, that lane is checked; Escape and a click outside close it,
// the lane kept. The browser's own list, drawn in its light scheme whatever the board's theme, is
// gone from the panel.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Party, ThreadRow } from '../../src/core/work-threads.ts'
import type { board as Board, payload as Payload } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let ThreadList: typeof import('../../web/src/components/threads/ThreadsPanel.tsx').ThreadList
let ContextMenu: typeof import('../../web/src/components/menu/ContextMenu.tsx').ContextMenu
let MenuEngine: typeof import('../../web/src/components/menu/menu-engine.ts').MenuEngine
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let board: typeof Board
let payload: typeof Payload
let laneMenu: typeof import('../../web/src/models/work-threads.ts').laneMenu
let lanePicked: typeof import('../../web/src/models/work-threads.ts').lanePicked
let spring: typeof import('../../web/src/models/spring.ts')
let reducedBefore: PropertyDescriptor | undefined

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><p id="outside">text</p></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const win = dom.window as unknown as Record<string, unknown> & typeof dom.window
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
  'FocusEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const
const OWN = [
  'addEventListener',
  'removeEventListener',
  'matchMedia',
  'PointerEvent',
  'IS_REACT_ACT_ENVIRONMENT',
  'innerWidth',
  'innerHeight',
]
const saved = new Map<string, PropertyDescriptor | undefined>()

beforeAll(async () => {
  for (const k of [...DOM_GLOBALS, ...OWN]) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  // The menu listens on the window; no motion, so it opens and closes at once.
  const matchMedia = (q: string) => ({
    matches: q.includes('reduce'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })
  win.matchMedia = matchMedia as never
  // jsdom lays nothing out: the menu's scroll to its lit item does nothing here.
  ;(win.HTMLElement as typeof HTMLElement).prototype.scrollIntoView = () => {}
  const own: Record<string, unknown> = {
    addEventListener: win.addEventListener.bind(win),
    removeEventListener: win.removeEventListener.bind(win),
    matchMedia,
    PointerEvent: win.PointerEvent ?? win.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    innerWidth: 1000,
    innerHeight: 700,
  }
  for (const [k, v] of Object.entries(own))
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadList } = await import('../../web/src/components/threads/ThreadsPanel.tsx'))
  ;({ ContextMenu } = await import('../../web/src/components/menu/ContextMenu.tsx'))
  ;({ MenuEngine } = await import('../../web/src/components/menu/menu-engine.ts'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ board, payload } = await import('./support/board.tsx'))
  ;({ laneMenu, lanePicked } = await import('../../web/src/models/work-threads.ts'))
  // No motion, whatever another file's media query said when the module was first loaded.
  spring = await import('../../web/src/models/spring.ts')
  reducedBefore = Object.getOwnPropertyDescriptor(spring.reducedMotion, 'matches')
  Object.defineProperty(spring.reducedMotion, 'matches', { configurable: true, get: () => true })
  spring.stopAllSprings()
})

afterAll(() => {
  if (reducedBefore) Object.defineProperty(spring.reducedMotion, 'matches', reducedBefore)
  else delete (spring.reducedMotion as { matches?: boolean }).matches
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const NOW = Date.parse('2026-11-12T14:00:00Z')
const master: Party = { kind: 'session', key: 's1', name: 'master' }
function row(key: string, lane: string): ThreadRow {
  return {
    key,
    id: `${key}-id`,
    lane,
    title: `Title of ${key}`,
    summary: '',
    status: 'doing',
    waitingOn: '',
    proposed: null,
    assignee: null,
    parent: null,
    scope: 'local',
    createdBy: master,
    createdAt: NOW,
    updatedAt: NOW,
    doneAt: null,
    rev: 1,
    parentKey: null,
    children: { done: 0, all: 0 },
  }
}
const ROWS = [row('atlas-1', 'atlas'), row('atlas-2', 'atlas'), row('ben-1', 'ben')]

const doc = () => dom.window.document
const q = (sel: string) => doc().querySelector(sel) as HTMLElement | null
const button = () => q('.wt-lane') as HTMLButtonElement
const shown = () => [...doc().querySelectorAll('.wt-row')].map(r => r.getAttribute('data-thread'))
const menuLines = () =>
  [...doc().querySelectorAll('.menu .menu-item, .menu .menu-sep')].map(e =>
    e.classList.contains('menu-sep')
      ? '---'
      : `${e.querySelector('.mi-label')?.textContent}${e.getAttribute('aria-checked') === 'true' ? ' ✓' : ''}`,
  )
async function key(k: string, el: EventTarget = doc().activeElement ?? doc().body) {
  await act(async () => {
    el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}
const settle = () => act(async () => void (await new Promise(r => setTimeout(r, 30))))

test('the model: every lane first, then the lanes, the one shown checked; a pick is its lane', () => {
  const t = (l: string) => l.toUpperCase()
  expect(laneMenu(['atlas', 'ben'], null, t, 'All lanes')).toEqual([
    { id: 'lane:', label: 'All lanes', checked: true },
    { separator: true },
    { id: 'lane:atlas', label: 'ATLAS', checked: false },
    { id: 'lane:ben', label: 'BEN', checked: false },
  ])
  expect(laneMenu(['atlas'], 'atlas', t, 'All')[2]).toEqual({ id: 'lane:atlas', label: 'ATLAS', checked: true })
  expect(lanePicked('lane:')).toBeNull()
  expect(lanePicked('lane:atlas')).toBe('atlas')
  expect(lanePicked('theme:dark')).toBeUndefined()
})

test('the board’s menu opens under the button, filters, keeps the lane; Escape and a click outside close it', async () => {
  const engine = new MenuEngine()
  // The page's keys and presses outside, as hooks/useContextMenus.ts starts them.
  const stop = engine.start()
  const data = payload({
    categories: [
      {
        id: 'atlas',
        title: 'Atlas',
        color: '#007aff',
        colorName: 'blue',
        paths: [],
        configured: true,
        fallback: false,
      },
    ],
  })
  const root = createRoot(doc().getElementById('root') as HTMLElement)
  await act(async () => {
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={board({ data })}>
          <ThreadList rows={ROWS} selected={null} onOpen={() => {}} menu={engine} />
          <ContextMenu engine={engine} />
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  try {
    // No native list in the panel any more: a menu button with the select's name.
    expect(q('.wt-filter select')).toBeNull()
    expect(button().getAttribute('aria-label')).toBe('Lane: All lanes')
    expect(button().getAttribute('aria-haspopup')).toBe('menu')
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(button().textContent).toBe('All lanes')
    expect(shown()).toEqual(['atlas-1', 'atlas-2', 'ben-1'])

    // From the keyboard, as a select: an arrow opens it, the first item lit; arrows and Enter pick.
    button().focus()
    await key('ArrowDown', button())
    await settle()
    expect(engine.isOpen()).toBe(true)
    expect(button().getAttribute('aria-expanded')).toBe('true')
    expect(menuLines()).toEqual(['All lanes ✓', '---', 'Atlas', 'ben'])
    await key('ArrowDown')
    await key('Enter')
    await settle()
    expect(engine.isOpen()).toBe(false)
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(shown()).toEqual(['atlas-1', 'atlas-2'])
    expect(button().textContent).toBe('Atlas')
    expect(button().getAttribute('aria-label')).toBe('Lane: Atlas')
    // The focus is back on the button.
    expect(doc().activeElement).toBe(button())

    // Open again: the lane is checked. Escape closes it, the lane kept.
    await act(async () => button().click())
    await settle()
    expect(menuLines()).toEqual(['All lanes', '---', 'Atlas ✓', 'ben'])
    await key('Escape')
    await settle()
    expect(engine.isOpen()).toBe(false)
    expect(shown()).toEqual(['atlas-1', 'atlas-2'])

    // A click outside closes it too, nothing picked.
    await act(async () => button().click())
    await settle()
    expect(engine.isOpen()).toBe(true)
    await act(async () => {
      const outside = q('#outside') as HTMLElement
      outside.dispatchEvent(
        new (g.PointerEvent as typeof MouseEvent)('pointerdown', { bubbles: true, cancelable: true }),
      )
      outside.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await settle()
    expect(engine.isOpen()).toBe(false)
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(button().textContent).toBe('Atlas')

    // Every lane again.
    await act(async () => button().click())
    await settle()
    await key('Home')
    await key('Enter')
    await settle()
    expect(button().textContent).toBe('All lanes')
    expect(shown()).toEqual(['atlas-1', 'atlas-2', 'ben-1'])
  } finally {
    await act(async () => root.unmount())
    stop()
  }
})
