// Hybrid B+C header DOM interactions in jsdom (#651):
// - Scrolling down folds Row 2 (#toolbar-filters) on the board's spring and reveals #toolbar-peek
//   with the active lane label (and color square) or filter count; clicking #toolbar-peek or
//   scrolling up brings Row 2 back.
// - Focused search input keeps #toolbar-filters open while scrolling.
// - Reduced motion collapses/expands cleanly without leaving data-moving set.
// - Desktop flat lane tabs overflow cleanly into "+N more" (#lanes-more), mark #lanes-more active
//   when a hidden lane is picked, and expand back without oscillating when width grows.
// - Phone drawer button (#rail-toggle) invokes onOpenDrawer and reflects railAlert.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { BoardDevice, BoardPayload } from '../../src/core/payload.ts'
import type { SegmentPicks } from '../../web/src/hooks/useSegmentPicks.ts'

let createRoot: typeof import('react-dom/client').createRoot
let Toolbar: typeof import('../../web/src/components/Toolbar.tsx').Toolbar
let Lanes: typeof import('../../web/src/components/Lanes.tsx').Lanes
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let support: typeof import('./support/board.tsx')
let reducedMotion: typeof import('../../web/src/models/spring.ts').reducedMotion
let stopAllSprings: typeof import('../../web/src/models/spring.ts').stopAllSprings
let reducedBefore: PropertyDescriptor | undefined

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
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
  'MutationObserver',
  'localStorage',
] as const
const OWN_GLOBALS = [
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'ResizeObserver',
  'addEventListener',
  'removeEventListener',
  'scrollY',
  'innerHeight',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

const world = {
  reduce: false,
  phone: false,
  lanesWidth: 600,
  tabWidth: 90,
  scroll: 0,
  page: 100_000,
  view: 844,
}
const watching: { notify: () => void; el: Element }[] = []
let queue: ((now: number) => void)[] = []
let clock = 1000

function fakeStyle(el: Element): Record<string, string> {
  if (el.id === 'toolbar-filters') {
    const folded = el.hasAttribute('data-folded')
    return {
      height: folded ? '0px' : '36px',
      marginTop: '0px',
      paddingTop: '0px',
      paddingBottom: '0px',
      marginBottom: '0px',
    }
  }
  return {
    height: '30px',
    marginTop: '0px',
    paddingTop: '0px',
    paddingBottom: '0px',
    marginBottom: '0px',
  }
}

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, ...OWN_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT'])
    saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  const own: Record<(typeof OWN_GLOBALS)[number], PropertyDescriptor> = {
    matchMedia: {
      value: (query: string) => ({
        get matches() {
          if (query.includes('prefers-reduced-motion')) return world.reduce
          if (query.includes('max-width: 760px')) return world.phone
          return false
        },
        addEventListener() {},
        removeEventListener() {},
      }),
    },
    requestAnimationFrame: { value: (cb: (now: number) => void) => queue.push(cb) },
    cancelAnimationFrame: { value: () => {} },
    getComputedStyle: { value: fakeStyle },
    ResizeObserver: {
      value: class {
        constructor(private notify: () => void) {}
        observe(el: Element) {
          watching.push({ notify: this.notify, el })
        }
        disconnect() {
          for (let i = watching.length - 1; i >= 0; i--) if (watching[i]?.notify === this.notify) watching.splice(i, 1)
        }
      },
    },
    addEventListener: { value: dom.window.addEventListener.bind(dom.window) },
    removeEventListener: { value: dom.window.removeEventListener.bind(dom.window) },
    scrollY: { get: () => world.scroll },
    innerHeight: { get: () => world.view },
  }
  for (const k of OWN_GLOBALS) Object.defineProperty(g, k, { configurable: true, ...own[k] })
  Object.defineProperty(dom.window.document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => world.page,
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.id === 'lanes' ? world.lanesWidth : 0
    },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hidden) return 0
      return this.hasAttribute('data-id') ? world.tabWidth : 0
    },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', {
    configurable: true,
    value() {
      return { finished: Promise.resolve(), cancel() {} }
    },
  })
  ;({ reducedMotion, stopAllSprings } = await import('../../web/src/models/spring.ts'))
  reducedBefore = Object.getOwnPropertyDescriptor(reducedMotion, 'matches')
  Object.defineProperty(reducedMotion, 'matches', { configurable: true, get: () => world.reduce })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Toolbar } = await import('../../web/src/components/Toolbar.tsx'))
  ;({ Lanes } = await import('../../web/src/components/Lanes.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  support = await import('./support/board.tsx')
})

afterAll(() => {
  if (reducedBefore) Object.defineProperty(reducedMotion, 'matches', reducedBefore)
  else Reflect.deleteProperty(reducedMotion, 'matches')
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

beforeEach(() => {
  stopAllSprings()
  world.reduce = false
  world.phone = false
  world.lanesWidth = 600
  world.tabWidth = 90
  world.scroll = 0
  world.page = 100_000
  world.view = 844
  queue = []
  watching.length = 0
  dom.window.document.body.innerHTML = '<div id="root"></div>'
})

const mounted: (() => Promise<void>)[] = []
afterEach(async () => {
  await frames()
  for (const unmount of mounted.splice(0)) await unmount()
  stopAllSprings()
})

const q = (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null
const need = (sel: string) => {
  const el = q(sel)
  expect(el).toBeTruthy()
  return el as HTMLElement
}

async function frames(max = 200) {
  for (let i = 0; i < max && queue.length; i++) {
    const run = queue
    queue = []
    clock += 16
    await act(async () => {
      for (const cb of run) cb(clock)
    })
  }
}

async function scrollTo(y: number) {
  world.scroll = y
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event('scroll'))
  })
  await frames()
}

async function resizeLanes(width: number) {
  world.lanesWidth = width
  await act(async () => {
    for (const w of [...watching]) if (w.el.id === 'lanes') w.notify()
  })
  await frames()
}

function sampleData(): BoardPayload {
  return support.payload({
    categories: [
      { id: 'core', title: 'Core', color: '#2563EB', colorName: 'blue', paths: [], configured: true, fallback: false },
      { id: 'web', title: 'Web', color: '#16A34A', colorName: 'green', paths: [], configured: true, fallback: false },
      { id: 'ops', title: 'Ops', color: '#D97706', colorName: 'orange', paths: [], configured: true, fallback: false },
      {
        id: 'docs',
        title: 'Docs',
        color: '#7C3AED',
        colorName: 'purple',
        paths: [],
        configured: true,
        fallback: false,
      },
      { id: 'other', title: 'Other', color: '#71717A', colorName: 'gray', paths: [], configured: true, fallback: true },
    ],
    items: [
      support.item({ key: 'a', name: 'atlas-core', column: 'work', category: 'core' }),
      support.item({ key: 'b', name: 'atlas-web', column: 'me', category: 'web' }),
      support.item({ key: 'c', name: 'atlas-ops', column: 'ext', category: 'ops' }),
      support.item({ key: 'd', name: 'atlas-docs', column: 'done', category: 'docs' }),
      support.item({ key: 'e', name: 'atlas-other', column: 'idle', category: 'other' }),
    ],
  })
}

async function mountToolbar(
  opts: {
    filter?: string[]
    query?: string
    device?: string
    devices?: BoardDevice[]
    onOpenDrawer?: () => void
    railAlert?: boolean
  } = {},
) {
  const host = need('#root')
  const root = createRoot(host)
  const val = support.board({
    data: { ...sampleData(), ...(opts.devices && { devices: opts.devices }) },
    ui: { filter: opts.filter ?? [], query: opts.query ?? '', ...(opts.device && { device: opts.device }) },
  })
  await act(async () => {
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={val}>
          <Toolbar
            limitsAnchor={{ current: null }}
            {...(opts.onOpenDrawer && { onOpenDrawer: opts.onOpenDrawer })}
            {...(opts.railAlert !== undefined && { railAlert: opts.railAlert })}
          />
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  mounted.push(() => act(async () => root.unmount()))
  await frames()
}

test('scrolling down folds the lane strip and reveals #toolbar-peek with active lane; clicking peek or scrolling up restores it', async () => {
  await mountToolbar({ filter: ['core', 'web'] })
  const filters = need('#toolbar-filters')
  const peek = need('#toolbar-peek')

  expect(filters.hasAttribute('data-folded')).toBe(false)
  expect(peek.hidden).toBe(true)

  // Scroll down past the fold threshold
  await scrollTo(120)
  expect(filters.hasAttribute('data-folded')).toBe(true)
  expect(peek.hidden).toBe(false)
  expect(peek.classList.contains('on')).toBe(true)
  expect(peek.textContent).toContain('Core +1')
  expect(peek.querySelector('.lane-dot')).toBeTruthy()

  // Clicking #toolbar-peek brings the lane strip back
  await act(async () => {
    peek.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }))
  })
  await frames()
  expect(filters.hasAttribute('data-folded')).toBe(false)
  expect(peek.hidden).toBe(true)

  // Fold again, then scroll back up to reopen
  await scrollTo(360)
  expect(filters.hasAttribute('data-folded')).toBe(true)
  await scrollTo(200)
  expect(filters.hasAttribute('data-folded')).toBe(false)
})

test('focus inside the lane strip keeps it open while scrolling', async () => {
  await mountToolbar()
  const filters = need('#toolbar-filters')
  const firstTab = need('#lanes button[data-id="all"]')
  firstTab.focus()
  await scrollTo(200)
  expect(filters.hasAttribute('data-folded')).toBe(false)
})

test('reduced motion folds and unfolds cleanly without leaving data-moving set', async () => {
  world.reduce = true
  await mountToolbar()
  const filters = need('#toolbar-filters')
  await scrollTo(180)
  expect(filters.hasAttribute('data-folded')).toBe(true)
  expect(filters.hasAttribute('data-moving')).toBe(false)
  await scrollTo(0)
  expect(filters.hasAttribute('data-folded')).toBe(false)
  expect(filters.hasAttribute('data-moving')).toBe(false)
})

test('desktop lane tabs overflow into "+N more" when narrow, highlight when hidden lane is active, and expand back cleanly on resize', async () => {
  const options = [
    { id: 'all', title: 'All', n: 5 },
    { id: 'core', title: 'Core', n: 1, color: '#2563EB' },
    { id: 'web', title: 'Web', n: 1, color: '#16A34A' },
    { id: 'ops', title: 'Ops', n: 1, color: '#D97706' },
    { id: 'docs', title: 'Docs', n: 1, color: '#7C3AED' },
    { id: 'other', title: 'Other', n: 1, color: '#71717A' },
  ]
  const opened: string[] = []
  const picks: SegmentPicks = {
    expanded: null,
    open(of) {
      opened.push(of)
    },
  }
  world.lanesWidth = 340 // fits ~2 tabs + "+4 more" (90*2 + 2 + 86 = 268 <= 340; 3 tabs = 360 > 340)
  const host = need('#root')
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={support.board()}>
          <Lanes options={options} picked={['docs']} onPick={() => {}} picks={picks} />
        </BoardContext.Provider>
      </I18nProvider>,
    )
  })
  mounted.push(() => act(async () => root.unmount()))
  await frames()

  const more = need('#lanes-more')
  expect(more.textContent).toContain('+4 more')
  // Active hidden lane ('docs') marks "+4 more" active
  expect(more.classList.contains('on')).toBe(true)

  // Clicking "+4 more" opens the lanes picker menu
  await act(async () => {
    more.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }))
  })
  expect(opened).toEqual(['lanes'])

  // Resizing wider shows all 6 tabs again and removes "+N more" without oscillation
  await resizeLanes(700)
  expect(q('#lanes-more')).toBeNull()
  const hidden = [...dom.window.document.querySelectorAll('#lanes button[data-id]')].filter(
    b => (b as HTMLElement).hidden,
  )
  expect(hidden).toHaveLength(0)

  // Shrinking back down re-applies overflow accurately (offsetWidth measured unhidden)
  await resizeLanes(340)
  expect(need('#lanes-more').textContent).toContain('+4 more')
})

test('phone drawer button (#rail-toggle) fires onOpenDrawer and shows alert dot when railAlert is true', async () => {
  let opens = 0
  await mountToolbar({ onOpenDrawer: () => opens++, railAlert: true })
  const toggle = need('#rail-toggle')
  expect(toggle.querySelector('.tb-menu-dot')).toBeTruthy()
  await act(async () => {
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  expect(opens).toBe(1)
})

test('toolbar filter peek normalises "local" device title to the device id (#758)', async () => {
  const dev = (id: string, title: string, extra: Partial<BoardDevice> = {}): BoardDevice => ({
    id,
    title,
    kind: id === 'local' ? null : 'ssh',
    link: null,
    status: null,
    sameCommit: true,
    payloadAt: 1000,
    paused: false,
    drain: false,
    maxSessions: null,
    minFreeMemMb: null,
    maxLoad: null,
    ...extra,
  })
  await mountToolbar({
    device: 'local',
    devices: [dev('local', 'Local', { selfId: 'server-2' }), dev('laptop', 'LOCAL')],
  })
  await scrollTo(120)
  const peek = need('#toolbar-peek')
  expect(peek.getAttribute('title')).toContain('server-2')
  expect(peek.getAttribute('title')).not.toMatch(/Local/i)
})
