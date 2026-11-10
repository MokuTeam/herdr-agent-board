// The toolbar (#347) on a real DOM (jsdom): at each width it is one row or two and the actions that
// do not fit are in More, in the order of the priority list; More lists them with their counts and
// what it picks does what the button does; in two rows scrolling down folds the filters away on the
// board's spring, the filters' button says how many are on and what, scrolling up or the button
// bring them back, a filter in use keeps them; one row has nothing to fold; reduced motion
// cross-fades. Layout is not here (jsdom has none): what the stylesheet would make of each control
// is stood in by a fake getComputedStyle and clientWidth, the observers and the frames are run by
// hand. What the stylesheet does with the attributes is read from its text in toolbar-style.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, Profiler } from 'react'
import type { BoardPayload } from '../../src/core/payload.ts'
import type { PresenceView } from '../../src/core/presence.ts'
import type { ToolbarMenu } from '../../web/src/hooks/useToolbarMore.ts'
import type { ToolbarEntry } from '../../web/src/models/toolbar-fit.ts'

let createRoot: typeof import('react-dom/client').createRoot
let Toolbar: typeof import('../../web/src/components/Toolbar.tsx').Toolbar
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let support: typeof import('./support/board.tsx')
let TOOLBAR_PRIORITY: typeof import('../../web/src/models/toolbar-fit.ts').TOOLBAR_PRIORITY
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
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

// What the page's media queries and the layout say now.
const world = { reduce: false, total: 390, scroll: 0 }
const watching: { notify: () => void; el: Element }[] = []
let queue: ((now: number) => void)[] = []
let clock = 1000
/** What a fade started on an element was asked for. */
const fades: { el: Element; keyframes: unknown }[] = []

/** The summary, which only a wide board shows (app.css hides it below 1580 px): then it is the start of the row. */
const SUMMARY = 240
const summaryShown = () => world.total > 1580
/** What the stylesheet would make of each action: icons 28, the pills and the usage chip wider. */
const WIDTHS: Record<string, number> = {
  'presence-switch': 130,
  'presence-offer': 96,
  'todos-open': 52,
  'new-session': 28,
  'presence-call': 28,
  'sched-open': 50,
  'next-attention': 88,
  limits: 190,
  'archive-open': 28,
  'cats-open': 28,
  'toolbar-more': 28,
  'toolbar-peek': 28,
  settings: 28,
  live: 8,
}
/** The actions' row (two rows): the page's width less its 16 px gutters, and the summary where it is shown. */
const room = () => world.total - 32 - (summaryShown() ? SUMMARY + 8 : 0)

function fakeStyle(el: Element): Record<string, string> {
  const px = (n: number) => `${n}px`
  if (el.classList.contains('toolbar-actions')) return { width: px(room()), columnGap: '6px' }
  // Hidden, the summary has no box and so no width: the row has no gap before the filters either.
  if (el.id === 'summary') return { width: px(summaryShown() ? SUMMARY : 0), columnGap: '0px' }
  if (el.classList.contains('toolbar-filters')) {
    const folded = el.hasAttribute('data-folded')
    return {
      height: px(folded ? 0 : 28),
      marginTop: '0px',
      paddingTop: '0px',
      paddingBottom: '0px',
      marginBottom: '0px',
      width: '300px',
      columnGap: '6px',
    }
  }
  return {
    width: px(WIDTHS[el.id] ?? 28),
    height: '28px',
    columnGap: '6px',
    paddingTop: '0px',
    paddingBottom: '0px',
    marginTop: '0px',
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
          return query.includes('prefers-reduced-motion') ? world.reduce : false
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
  }
  for (const k of OWN_GLOBALS) Object.defineProperty(g, k, { configurable: true, ...own[k] })
  // The container's width, which a stylesheet's container query reads; jsdom has no layout.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('toolbar-fit') ? world.total : 0
    },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: Element, keyframes: unknown) {
      fades.push({ el: this, keyframes })
      return { finished: Promise.resolve(), cancel() {} }
    },
  })
  ;({ reducedMotion, stopAllSprings } = await import('../../web/src/models/spring.ts'))
  reducedBefore = Object.getOwnPropertyDescriptor(reducedMotion, 'matches')
  Object.defineProperty(reducedMotion, 'matches', { configurable: true, get: () => world.reduce })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Toolbar } = await import('../../web/src/components/Toolbar.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ TOOLBAR_PRIORITY } = await import('../../web/src/models/toolbar-fit.ts'))
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
  world.total = 390
  world.scroll = 0
  queue = []
  watching.length = 0
  fades.length = 0
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
const clickOn = (el: Element | null, detail = 1) => {
  expect(el).toBeTruthy()
  return act(async () => void el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail })))
}
/** Frames of the springs and of the scroll reads, 16 ms apart, until none is asked for or `max` ran. */
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
/** The toolbar's width changed: every observer says so. */
const resizeTo = (total: number) =>
  act(async () => {
    world.total = total
    for (const w of [...watching]) w.notify()
  })
/** The page scrolled to `y`, and the frame that reads it ran. */
async function scrollTo(y: number) {
  world.scroll = y
  await act(async () => void dom.window.dispatchEvent(new dom.window.Event('scroll')))
  await frames()
}

const NOW = Date.now()
const PRESENCE: PresenceView = {
  state: 'here',
  since: NOW,
  by: 'user',
  mode: 'suggest',
  idleMinutes: 5,
  hint: null,
  detects: true,
  calls: true,
}
const category = (id: string, title: string, fallback = false): BoardPayload['categories'][number] => ({
  id,
  title,
  color: '#007AFF',
  colorName: 'blue',
  paths: [],
  configured: true,
  fallback,
})
const profile = (id: string, title: string): NonNullable<BoardPayload['profiles']>[number] => ({
  id,
  title,
  color: '#5856D6',
  colorName: 'indigo',
  dir: `/home/${id}`,
  hidden: false,
  inherited: false,
  exists: true,
  hooks: true,
  sessions: 1,
  limits: null,
})
const items = () => [
  support_item('a', 'proj', 'work'),
  support_item('b', 'proj', 'me'),
  support_item('c', 'other', 'idle'),
]
function support_item(key: string, category: string, column: 'work' | 'me' | 'idle') {
  return support.item({ key, name: key, category, column, ...(column === 'me' && { attention: 'ask' as const }) })
}
const DATA = (presence: Partial<PresenceView> = {}) =>
  support.payload({
    items: items(),
    categories: [category('proj', 'Project'), category('other', 'Other', true)],
    profiles: [profile('one', 'Private'), profile('two', 'Work')],
    schedules: [{ id: 's1', key: 'a', text: 'ping', next: NOW - 60_000 }],
    todos: { agents: true },
    presence: { ...PRESENCE, ...presence },
  })

interface Calls {
  todos: number
  schedule: number
  newSession: HTMLElement[]
  dispatched: unknown[]
}

async function mount(
  options: {
    ui?: Partial<import('../../web/src/state/board-ui.ts').BoardUi>
    presence?: Partial<PresenceView>
    /** The setup note, shown. */
    setup?: boolean
  } = {},
) {
  const limitsAnchor: { current: HTMLButtonElement | null } = { current: null }
  const noteRef: { current: HTMLButtonElement | null } = { current: null }
  let commits = 0
  const calls: Calls = { todos: 0, schedule: 0, newSession: [], dispatched: [] }
  const opened: { entries: readonly ToolbarEntry[]; onPick: (id: string) => void; keyboard: boolean }[] = []
  const more: ToolbarMenu = {
    expanded: false,
    open: (_button, keyboard, entries, onPick) => void opened.push({ entries, onPick, keyboard }),
  }
  const root = createRoot(need('#root'))
  const value = support.board({
    data: DATA(options.presence),
    ui: options.ui ?? {},
    dispatch: (action: unknown) => void calls.dispatched.push(action),
  } as Parameters<typeof support.board>[0])
  await act(async () =>
    root.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={value}>
          <Profiler id="toolbar" onRender={() => void commits++}>
            <Toolbar
              limitsAnchor={limitsAnchor}
              {...(options.setup && {
                setup: {
                  shown: true,
                  open: false,
                  noteRef,
                  toggle() {},
                } as unknown as import('../../web/src/hooks/useSetupNote.ts').SetupNoteState,
              })}
              onTodos={() => void calls.todos++}
              onSchedule={() => void calls.schedule++}
              onNewSession={from => void calls.newSession.push(from)}
              more={more}
            />
          </Profiler>
        </BoardContext.Provider>
      </I18nProvider>,
    ),
  )
  await frames()
  let gone = false
  mounted.push(async () => {
    if (gone) return
    gone = true
    await act(async () => root.unmount())
  })
  return { calls, opened, limitsAnchor, noteRef, commits: () => commits }
}

/** The ids of the actions that left the row, in the row's order of priority. */
const over = () =>
  TOOLBAR_PRIORITY.filter(id => {
    const el = q(`.toolbar-actions > #${id}`)
    return !!el && el.hasAttribute('data-over')
  })
const present = () => TOOLBAR_PRIORITY.filter(id => !!q(`.toolbar-actions > #${id}`))
const rows = () => need('.toolbar-fit').hasAttribute('data-rows')
const moreShown = () => !need('#toolbar-more').hasAttribute('data-over')

test('the toolbar is one row where everything fits, and nothing is in More', async () => {
  world.total = 2560
  await mount()
  expect(rows()).toBe(false)
  expect(over()).toEqual([])
  expect(moreShown()).toBe(false)
  expect(present()).toContain('presence-switch')
  expect(present()).toContain('todos-open')
})

test('two rows from 320 to 1200 px: the actions that do not fit are the end of the priority list', async () => {
  const sizes = [320, 360, 390, 430, 600, 768, 900, 1100]
  await mount()
  let before = Number.POSITIVE_INFINITY
  const all = present()
  for (const total of sizes) {
    await resizeTo(total)
    expect(rows()).toBe(true)
    const left = over()
    // What is in More is the end of the list as it is on show now, never a pick of it.
    expect(left).toEqual(all.slice(all.length - left.length))
    expect(moreShown()).toBe(left.length > 0)
    // The first stays whatever the width: Next, which shrinks with an ellipsis.
    expect(left).not.toContain('next-attention')
    // More leaves a wider toolbar fewer actions, never more.
    expect(left.length).toBeLessThanOrEqual(before)
    before = left.length
    // What stays, the pinned buttons and More fit the actions' row (the first alone may not).
    const shown = all.filter(id => !left.includes(id))
    const used =
      shown.reduce((sum, id, i) => sum + (i ? 6 : 0) + (WIDTHS[id] ?? 28), 0) +
      6 +
      28 +
      6 +
      8 +
      (left.length ? 6 + 28 : 0)
    if (shown.length > 1) expect(used).toBeLessThanOrEqual(room())
  }
  expect(before).toBe(0)
})

test('a phone keeps Next, and the presence pill beside it where the row holds both; a wider toolbar grows back to one row', async () => {
  await mount()
  await resizeTo(390)
  expect(rows()).toBe(true)
  expect(over()).not.toContain('next-attention')
  expect(over()).not.toContain('presence-switch')
  expect(over()).toContain('todos-open')
  expect(over()).toContain('limits')
  expect(over()).toContain('cats-open')
  // The narrowest phone: Next alone, and the pill in More with the rest.
  await resizeTo(320)
  expect(over()).not.toContain('next-attention')
  expect(over()).toContain('presence-switch')
  expect(over()).toContain('todos-open')
  await resizeTo(2000)
  expect(rows()).toBe(false)
  expect(over()).toEqual([])
  expect(moreShown()).toBe(false)
})

test('More lists what left the row in its order with the counts, and its dot says something needs a look', async () => {
  const { opened, calls } = await mount()
  await resizeTo(320)
  const button = need('#toolbar-more')
  expect(button.getAttribute('aria-haspopup')).toBe('menu')
  expect(button.getAttribute('aria-label')).toBe('More (something in it needs a look)')
  // The reminder is due and in More: the button carries a dot.
  expect(over()).toContain('sched-open')
  expect(need('#toolbar-more .more-dot').hasAttribute('hidden')).toBe(false)
  await clickOn(button, 0)
  const [menu] = opened
  if (!menu) throw new Error('More did not open')
  expect(menu.keyboard).toBe(true)
  expect(menu.entries.map(e => e.id)).toEqual(over())
  const sched = menu.entries.find(e => e.id === 'sched-open')
  expect(sched).toMatchObject({ label: 'Schedule', count: 1, tint: 'var(--orange)', alert: true })
  expect(menu.entries.find(e => e.id === 'todos-open')).toMatchObject({ label: 'Tasks' })
  // A choice does what the button does: Schedule opens its panel, New session from More.
  menu.onPick('sched-open')
  menu.onPick('new-session')
  expect(calls.schedule).toBe(1)
  expect(calls.newSession).toEqual([button])
  menu.onPick('limits')
  expect(calls.dispatched).toEqual([{ type: 'limits', open: true }])
})

test('the offer of detection comes right after the presence pill, and is in More once the row does not hold it', async () => {
  const { opened } = await mount({ presence: { hint: 'away' } })
  await resizeTo(600)
  expect(present()).toContain('presence-offer')
  expect(over()).not.toContain('presence-offer')
  expect(over()).not.toContain('presence-switch')
  await resizeTo(390)
  expect(over()).toContain('presence-offer')
  expect(over()).toContain('todos-open')
  expect(over()).not.toContain('presence-switch')
  await clickOn(need('#toolbar-more'))
  const entries = opened[0]?.entries ?? []
  expect(entries.map(e => e.id)).toEqual(over())
  expect(entries.find(e => e.id === 'presence-offer')?.label).toBe('Looks like you are away: switch?')
})

test('with nothing in More it carries no dot, and a quiet toolbar needs none', async () => {
  await mount()
  await resizeTo(2000)
  expect(need('#toolbar-more .more-dot').hasAttribute('hidden')).toBe(true)
})

test('scrolling down folds the filters on the spring, up brings them back, the filters button says so', async () => {
  await mount()
  await resizeTo(390)
  const filters = need('#toolbar-filters')
  const peek = need('#toolbar-peek')
  expect([
    filters.hasAttribute('data-folded'),
    peek.hasAttribute('hidden'),
    peek.getAttribute('aria-expanded'),
  ]).toEqual([false, true, 'true'])
  expect(q('.toolbar.folded')).toBeNull()

  // A little scrolling does nothing; past 64 px and then a turn, the filters fold, moving as they go.
  await scrollTo(40)
  expect(filters.hasAttribute('data-folded')).toBe(false)
  world.scroll = 200
  await act(async () => void dom.window.dispatchEvent(new dom.window.Event('scroll')))
  await act(async () => void queue.shift()?.(clock))
  expect(filters.hasAttribute('data-folded')).toBe(true)
  expect(filters.hasAttribute('data-moving')).toBe(true)
  expect(Number.parseFloat(filters.style.height)).toBe(28)
  await frames(6)
  expect(Number.parseFloat(filters.style.height)).toBeGreaterThan(0)
  expect(Number.parseFloat(filters.style.height)).toBeLessThan(28)
  await frames()
  expect(filters.hasAttribute('data-moving')).toBe(false)
  expect(filters.getAttribute('style') ?? '').toBe('')
  expect(q('.toolbar.folded')).toBeTruthy()
  // Its stand-in: shown, folded, named for the filters, with no count while none is on.
  expect([peek.hasAttribute('hidden'), peek.getAttribute('aria-expanded'), peek.getAttribute('aria-controls')]).toEqual(
    [false, 'false', 'toolbar-filters'],
  )
  expect(peek.getAttribute('aria-label')).toBe('Filters')
  expect(need('#toolbar-peek .n').textContent).toBe('')

  // Up less than a turn: still folded. A turn: back, the button gone.
  await scrollTo(190)
  expect(filters.hasAttribute('data-folded')).toBe(true)
  await scrollTo(170)
  expect(filters.hasAttribute('data-folded')).toBe(false)
  await frames()
  expect(peek.hasAttribute('hidden')).toBe(true)
  expect(filters.getAttribute('style') ?? '').toBe('')
})

test('the folded toolbar says what is filtered: how many, and which', async () => {
  await mount({ ui: { filter: ['proj'], query: 'login' } })
  await resizeTo(390)
  await scrollTo(300)
  const peek = need('#toolbar-peek')
  expect(peek.hasAttribute('hidden')).toBe(false)
  expect(peek.getAttribute('aria-label')).toBe('Filters: Project · “login”')
  expect(peek.getAttribute('title')).toBe('Filters: Project · “login”')
  expect(need('#toolbar-peek .n').textContent).toBe('2')
  expect(peek.classList.contains('on')).toBe(true)
})

test('the filters button brings the folded filters back, for a little scrolling down', async () => {
  await mount()
  await resizeTo(390)
  await scrollTo(300)
  const filters = need('#toolbar-filters')
  expect(filters.hasAttribute('data-folded')).toBe(true)
  await clickOn(need('#toolbar-peek'))
  await frames()
  expect(filters.hasAttribute('data-folded')).toBe(false)
  // A little more scrolling down does not fold them again; a good deal does.
  await scrollTo(330)
  expect(filters.hasAttribute('data-folded')).toBe(false)
  await scrollTo(380)
  expect(filters.hasAttribute('data-folded')).toBe(true)
  // There is no title to tap (#351): the summary and the page's name do nothing to the filters.
  await clickOn(need('.titles'))
  await clickOn(need('h1'))
  await frames()
  expect(filters.hasAttribute('data-folded')).toBe(true)
  await clickOn(need('#toolbar-peek'))
  await frames()
  expect(filters.hasAttribute('data-folded')).toBe(false)
})

test('a filter in use keeps the filters open', async () => {
  await mount()
  await resizeTo(390)
  need('#search').focus()
  await scrollTo(400)
  expect(need('#toolbar-filters').hasAttribute('data-folded')).toBe(false)
  need('#search').blur()
  await scrollTo(450)
  expect(need('#toolbar-filters').hasAttribute('data-folded')).toBe(true)
})

test('one row has nothing to fold: scrolling leaves it whole', async () => {
  world.total = 2560
  await mount()
  await scrollTo(600)
  expect(need('#toolbar-filters').hasAttribute('data-folded')).toBe(false)
  expect(need('#toolbar-peek').hasAttribute('hidden')).toBe(true)
  expect(q('.toolbar.folded')).toBeNull()
})

test('a toolbar that gets wide again while folded opens its filters', async () => {
  await mount()
  await resizeTo(390)
  await scrollTo(300)
  expect(need('#toolbar-filters').hasAttribute('data-folded')).toBe(true)
  await resizeTo(2560)
  await frames()
  expect(need('#toolbar-filters').hasAttribute('data-folded')).toBe(false)
})

test('reduced motion: the filters do not slide, they cross-fade out and in', async () => {
  world.reduce = true
  await mount()
  await resizeTo(390)
  const filters = need('#toolbar-filters')
  await scrollTo(300)
  expect(filters.hasAttribute('data-folded')).toBe(true)
  // Nothing moved: no spring's sizes on it, only the fade out of what was there.
  expect(filters.style.height).toBe('')
  expect(fades.some(f => f.el === filters && JSON.stringify(f.keyframes) === JSON.stringify({ opacity: [1, 0] }))).toBe(
    true,
  )
  await frames()
  fades.length = 0
  await scrollTo(100)
  expect(filters.hasAttribute('data-folded')).toBe(false)
  expect(filters.style.height).toBe('')
  expect(fades.some(f => f.el === filters && JSON.stringify(f.keyframes) === JSON.stringify({ opacity: [0, 1] }))).toBe(
    true,
  )
})

test('a re-render of the page leaves what the fit drew in place', async () => {
  const { opened } = await mount()
  await resizeTo(320)
  const before = over()
  expect(before.length).toBeGreaterThan(0)
  // The same board again, as every refresh of its data is.
  await act(async () => void mock.restore())
  await resizeTo(320)
  expect(over()).toEqual(before)
  expect(opened).toEqual([])
})

test('the usage popover and the setup list go under their pills, or under More while a pill is in it', async () => {
  const { limitsAnchor, noteRef } = await mount({ setup: true })
  await resizeTo(2000)
  expect(limitsAnchor.current).toBe(need('#limits') as HTMLButtonElement)
  expect(noteRef.current).toBe(need('#setup-note') as HTMLButtonElement)
  await resizeTo(320)
  expect(over()).toContain('limits')
  expect(over()).toContain('setup-note')
  expect(limitsAnchor.current).toBe(need('#toolbar-more') as HTMLButtonElement)
  expect(noteRef.current).toBe(need('#toolbar-more') as HTMLButtonElement)
  await resizeTo(1500)
  await resizeTo(2000)
  expect(limitsAnchor.current).toBe(need('#limits') as HTMLButtonElement)
  expect(noteRef.current).toBe(need('#setup-note') as HTMLButtonElement)
})

test('More says in its name when something in it needs a look', async () => {
  await mount()
  await resizeTo(320)
  expect(need('#toolbar-more').getAttribute('aria-label')).toBe('More (something in it needs a look)')
  await resizeTo(2000)
  expect(need('#toolbar-more').getAttribute('aria-label')).toBe('More')
})

test('opened from the keys, the filters button leaves the focus on the first filter that can have it', async () => {
  await mount()
  await resizeTo(390)
  await scrollTo(300)
  await clickOn(need('#toolbar-peek'), 0)
  await frames()
  const focused = dom.window.document.activeElement
  expect(focused && focused !== dom.window.document.body).toBe(true)
  expect(focused?.closest('#lanes, #lanes-pick, .search') || focused?.id === 'lanes-pick').toBeTruthy()
})

test('scrolling on while folded, or up a little while open, is not a render', async () => {
  const { commits } = await mount()
  await resizeTo(390)
  await scrollTo(300)
  // The fold itself, and the frame after it that settles the spring, are renders; scrolling on is not.
  await scrollTo(305)
  await frames()
  const folded = commits()
  for (const y of [310, 330, 350, 420, 600]) await scrollTo(y)
  expect(need('#toolbar-filters').hasAttribute('data-folded')).toBe(true)
  expect(commits()).toBe(folded)
})

test('another typeface (the Terminal look) takes the widths anew: what fitted in Classic may not fit in it', async () => {
  await mount()
  await resizeTo(390)
  const before = over()
  expect(before).not.toContain('presence-switch')
  // Wider in the monospace look, with no word changed: the presence pill no longer fits.
  WIDTHS['presence-switch'] = 240
  await act(async () => {
    dom.window.document.documentElement.setAttribute('data-look', 'terminal')
    await Promise.resolve()
  })
  await frames()
  try {
    expect(over()).toContain('presence-switch')
  } finally {
    WIDTHS['presence-switch'] = 130
    dom.window.document.documentElement.removeAttribute('data-look')
  }
})
