// The compact session sheet (#345) on a real DOM (jsdom): the head's chevron folds and opens its
// fold on the spring, and a second tap midway turns it back from where it is; the choice is kept
// per width class and comes back; a phone starts compact; the helpers' strip folds into their count,
// which opens their list; the open question is cut to two lines and opens on a tap; the action row
// opens from the footer line; a flow outside the sheet that needs the fold has it opened without
// the choice changing; reduced motion draws no movement, and a cross-fade instead. Layout is not
// here (jsdom has none): the sizes the stylesheet would give each state are stood in by a fake
// getComputedStyle, and the frames are stepped by hand. What the stylesheet does with the folded
// states is read from its text in sheet-compact.test.tsx.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, StrictMode, useState } from 'react'
import type { PublicHelper } from '../../src/core/helpers.ts'
import type { Item } from '../../src/core/types.ts'
import type { SessionDetail } from '../../web/src/api/client.ts'
import type { DetailSnapshot } from '../../web/src/hooks/useSessionDetail.ts'

let createRoot: typeof import('react-dom/client').createRoot
let SheetHead: typeof import('../../web/src/components/sheet/SheetHead.tsx').SheetHead
let SheetView: typeof import('../../web/src/components/sheet/Sheet.tsx').SheetView
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let useSheetDensity: typeof import('../../web/src/hooks/useSheetDensity.ts').useSheetDensity
let emptyDetail: typeof import('../../web/src/hooks/useSessionDetail.ts').emptyDetail
let support: typeof import('./support/board.tsx')
let sheetScene: typeof import('./support/sheet-scene.tsx')
let DENSITY_KEYS: typeof import('../../web/src/models/sheet-density.ts').DENSITY_KEYS
let revealSheetDetails: typeof import('../../web/src/models/sheet-reveal.ts').revealSheetDetails
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
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

// What the page's media queries say now.
const media = { phone: false, reduce: false }
// What a ResizeObserver watches: its callbacks are run by hand too (the browser also reports an element
// that left the page, at 0 by 0).
const watching: { notify: () => void; el: Element }[] = []
// The frames the springs ask for, run by hand.
let queue: ((now: number) => void)[] = []
let clock = 1000

/** The sizes the stylesheet gives each state of a part that folds: [folded, open]. */
const SIZES: Record<string, [number, number]> = {
  'sheet-details': [0, 120],
  'sheet-helpers': [0, 60],
  'sheet-actions': [0, 36],
  'asked-clip': [36, 90],
}
function fakeStyle(el: Element): Record<string, string> {
  const key = Object.keys(SIZES).find(k => el.id === k || el.classList.contains(k))
  const [folded, open] = key ? (SIZES[key] as [number, number]) : [0, 0]
  const px = (n: number) => `${n}px`
  return {
    height: px(el.hasAttribute('data-folded') ? folded : open),
    paddingTop: '0px',
    paddingBottom: '0px',
    marginTop: '0px',
    marginBottom: '0px',
    width: '300px',
    columnGap: '6px',
  }
}

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, ...OWN_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT'])
    saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  const own: Record<(typeof OWN_GLOBALS)[number], unknown> = {
    matchMedia: (query: string) => ({
      get matches() {
        if (query.includes('prefers-reduced-motion')) return media.reduce
        return query.includes('max-width: 760px') ? media.phone : false
      },
      addEventListener() {},
      removeEventListener() {},
    }),
    requestAnimationFrame: (cb: (now: number) => void) => queue.push(cb),
    cancelAnimationFrame: () => {},
    getComputedStyle: fakeStyle,
    ResizeObserver: class {
      constructor(private notify: () => void) {}
      observe(el: Element) {
        watching.push({ notify: this.notify, el })
      }
      disconnect() {
        for (let i = watching.length - 1; i >= 0; i--) if (watching[i]?.notify === this.notify) watching.splice(i, 1)
      }
    },
  }
  for (const k of OWN_GLOBALS)
    Object.defineProperty(g, k, { value: own[k], configurable: true, writable: true })
    // models/spring.ts took the reduced-motion query when it loaded, maybe for another test file: the page's
    // answer here is this file's.
  ;({ reducedMotion, stopAllSprings } = await import('../../web/src/models/spring.ts'))
  reducedBefore = Object.getOwnPropertyDescriptor(reducedMotion, 'matches')
  Object.defineProperty(reducedMotion, 'matches', { configurable: true, get: () => media.reduce })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SheetHead } = await import('../../web/src/components/sheet/SheetHead.tsx'))
  ;({ SheetView } = await import('../../web/src/components/sheet/Sheet.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ useSheetDensity } = await import('../../web/src/hooks/useSheetDensity.ts'))
  ;({ emptyDetail } = await import('../../web/src/hooks/useSessionDetail.ts'))
  ;({ DENSITY_KEYS } = await import('../../web/src/models/sheet-density.ts'))
  ;({ revealSheetDetails } = await import('../../web/src/models/sheet-reveal.ts'))
  support = await import('./support/board.tsx')
  sheetScene = await import('./support/sheet-scene.tsx')
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
  // The springs' frame loop is shared by every test file of the run: one left running by another
  // would hold it, and none of these would move.
  stopAllSprings()
  media.phone = false
  media.reduce = false
  queue = []
  watching.length = 0
  dom.window.localStorage.clear()
  dom.window.document.body.innerHTML = '<div id="root"></div>'
})

// A spring left running here would hold the loop for the tests after it, and a sheet left mounted keeps
// listening for the asks of other files' tests.
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
/** Frames of the springs, 16 ms apart, until none is asked for or `max` ran. */
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
const height = (el: HTMLElement) => Number.parseFloat(el.style.height)
const bare = (el: HTMLElement) => el.getAttribute('style') ?? ''

const session = (key: string, question: string): Item =>
  ({
    key,
    session: key,
    name: `Session ${key}`,
    pane: `p-${key}`,
    workspace: 'web',
    cwd: '/work',
    status: 'idle',
    column: 'me',
    attention: 'ask',
    question,
    autoName: key,
    category: 'other',
    categorySet: true,
    sleeping: false,
  }) as Item
const asking = session('a', 'Keep the name in the report? Bill the fix, and in which code?')

const HELPER = {
  id: 'h1',
  kind: 'agent',
  type: 'general',
  name: 'h1',
  description: 'check the ledger',
  color: '',
  model: '',
  background: false,
  parent: null,
  toolUseId: null,
  workflow: null,
  phase: '',
  status: 'running',
  startedAt: 1,
  endedAt: null,
  activity: 1,
  prompt: '',
  from: '',
  now: null,
  after: '',
  waiting: 0,
  tokens: null,
  result: '',
} as PublicHelper

/** A detail read for the session, with its helpers. */
const withHelpers = (it: Item): DetailSnapshot => ({
  key: it.key,
  status: 'ready',
  error: '',
  at: 1,
  data: {
    item: it,
    conversation: [],
    screen: '',
    dialog: null,
    checkout: false,
    helpers: [HELPER],
    workflows: [],
  } as unknown as SessionDetail,
})

interface Calls {
  helpers: number
  dismissed: number
}

/** The sheet's head and what is under it, wired as Sheet.tsx wires them to the density. */
function Sheet({ it, detail, calls }: { it: Item; detail: DetailSnapshot; calls: Calls }) {
  const density = useSheetDensity(it.key)
  const [actionsOpen, setActionsOpen] = useState(false)
  return (
    <>
      <SheetHead
        item={it}
        missing={false}
        card={{ disabled: false, open: false }}
        fold={{
          compact: density.compact,
          onToggle: density.toggle,
          helpers: { count: 2, running: true, label: 'Helpers: 2 at work', onOpen: () => void calls.helpers++ },
        }}
      />
      <SheetView
        open={it.key}
        item={it}
        detail={detail}
        composer={sheetScene.composerOf({ open: it.key })}
        compact={density.compact}
        actionsOpen={actionsOpen}
        onActionsToggle={() => setActionsOpen(was => !was)}
        onDismiss={() => void calls.dismissed++}
      />
    </>
  )
}

async function mount(
  options: { it?: Item; detail?: (it: Item) => DetailSnapshot; strict?: boolean; calls?: Calls } = {},
) {
  const calls = options.calls ?? { helpers: 0, dismissed: 0 }
  const root = createRoot(need('#root'))
  const value = support.board({ data: support.payload({ items: [asking] }), ui: { open: 'a' } })
  const draw = (it: Item) => {
    const page = (
      <I18nProvider lang="en">
        <BoardContext.Provider value={value}>
          <Sheet it={it} detail={options.detail?.(it) ?? emptyDetail(it.key)} calls={calls} />
        </BoardContext.Provider>
      </I18nProvider>
    )
    return act(async () => root.render(options.strict ? <StrictMode>{page}</StrictMode> : page))
  }
  await draw(options.it ?? asking)
  let gone = false
  const unmount = async () => {
    if (gone) return
    gone = true
    await act(async () => root.unmount())
  }
  mounted.push(unmount)
  return { calls, redraw: draw, unmount }
}

const kept = (key: string) => dom.window.localStorage.getItem(key)

test('a wide panel starts with the head whole; the chevron folds it on the spring, and its choice is kept', async () => {
  const { unmount } = await mount()
  const toggle = need('#sheet-compact-toggle')
  const details = need('#sheet-details')
  expect([toggle.getAttribute('aria-expanded'), details.hasAttribute('data-folded')]).toEqual(['true', false])
  expect(q('.sheet-headline > #sheet-name')).toBeTruthy()

  await clickOn(toggle)
  // Folding: the fold goes from its open size, a frame at a time, to nothing; the chevron already says so.
  expect([toggle.getAttribute('aria-expanded'), details.hasAttribute('data-folded')]).toEqual(['false', true])
  expect(details.hasAttribute('data-moving')).toBe(true)
  expect(height(details)).toBe(120)
  await frames(6)
  expect(height(details)).toBeGreaterThan(0)
  expect(height(details)).toBeLessThan(120)
  await frames()
  expect(details.hasAttribute('data-moving')).toBe(false)
  expect(bare(details)).toBe('')
  expect(details.hasAttribute('data-folded')).toBe(true)

  // Kept for this width, and only for it.
  expect(kept(DENSITY_KEYS.wide)).toBe('compact')
  expect(kept(DENSITY_KEYS.phone)).toBeNull()
  await unmount()
  dom.window.document.body.innerHTML = '<div id="root"></div>'
  await mount()
  expect(need('#sheet-details').hasAttribute('data-folded')).toBe(true)
  expect(need('#sheet-compact-toggle').getAttribute('aria-expanded')).toBe('false')
})

test('a second tap midway turns it back from where it is, with no jump, and it opens whole', async () => {
  await mount()
  const details = need('#sheet-details')
  await clickOn(need('#sheet-compact-toggle'))
  await frames(8)
  const midway = height(details)
  expect(midway).toBeGreaterThan(0)
  expect(midway).toBeLessThan(120)
  await clickOn(need('#sheet-compact-toggle'))
  // Drawn at once from the height it was at: not from folded, not from whole.
  expect(details.hasAttribute('data-folded')).toBe(false)
  expect(Math.abs(height(details) - midway)).toBeLessThan(0.5)
  await frames()
  expect(details.hasAttribute('data-moving')).toBe(false)
  expect(bare(details)).toBe('')
  expect(kept(DENSITY_KEYS.wide)).toBe('full')
})

test('under React’s StrictMode, which runs every effect twice, the fold folds and opens once', async () => {
  await mount({ strict: true })
  const details = need('#sheet-details')
  await clickOn(need('#sheet-compact-toggle'))
  expect(height(details)).toBe(120)
  await frames()
  expect([details.hasAttribute('data-folded'), details.hasAttribute('data-moving'), bare(details)]).toEqual([
    true,
    false,
    '',
  ])
  await clickOn(need('#sheet-compact-toggle'))
  await frames()
  expect([details.hasAttribute('data-folded'), details.hasAttribute('data-moving'), bare(details)]).toEqual([
    false,
    false,
    '',
  ])
})

test('a phone starts compact; its choice does not touch the wide one', async () => {
  media.phone = true
  dom.window.localStorage.setItem(DENSITY_KEYS.wide, 'full')
  await mount()
  expect(need('#sheet-details').hasAttribute('data-folded')).toBe(true)
  await clickOn(need('#sheet-compact-toggle'))
  await frames()
  expect(need('#sheet-details').hasAttribute('data-folded')).toBe(false)
  expect([kept(DENSITY_KEYS.phone), kept(DENSITY_KEYS.wide)]).toEqual(['full', 'full'])
})

test('with reduced motion nothing moves: no frame is asked for, no size is set', async () => {
  media.reduce = true
  await mount()
  const details = need('#sheet-details')
  await clickOn(need('#sheet-compact-toggle'))
  expect(queue.length).toBe(0)
  expect(details.hasAttribute('data-folded')).toBe(true)
  expect(details.hasAttribute('data-moving')).toBe(false)
  expect(bare(details)).toBe('')
})

test('with reduced motion what folds fades out before it is gone, and what opens fades in', async () => {
  media.reduce = true
  // jsdom has no Web Animations: each fade is a call, finished by hand. Several parts fold with the
  // head (its fold, the helpers' strip, the action row): the fade of the head's fold is the one read.
  const fades: { on: Element; frames: unknown; cancelled: boolean; end: () => void }[] = []
  const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto.animate = function (this: Element, frames: unknown) {
    let end = () => {}
    const finished = new Promise<void>(resolve => {
      end = resolve
    })
    const fade = {
      on: this,
      frames,
      cancelled: false,
      end,
      finished,
      cancel: () => {
        fade.cancelled = true
      },
    }
    fades.push(fade)
    return fade
  }
  try {
    await mount()
    const details = need('#sheet-details')
    const own = () => fades.filter(f => f.on === details)
    await clickOn(need('#sheet-compact-toggle'))
    // It stays drawn as it was while it fades: the folded state comes when the fade is over.
    expect(own().map(f => f.frames)).toEqual([{ opacity: [1, 0] }])
    expect([details.hasAttribute('data-folded'), details.hasAttribute('data-moving')]).toEqual([true, true])
    await act(async () => {
      own()[0]?.end()
      await Promise.resolve()
    })
    expect(details.hasAttribute('data-moving')).toBe(false)
    expect(own()[0]?.cancelled).toBe(true)
    // Opening: it is there at once and fades in.
    await clickOn(need('#sheet-compact-toggle'))
    expect(own().map(f => f.frames)).toEqual([{ opacity: [1, 0] }, { opacity: [0, 1] }])
    expect([details.hasAttribute('data-folded'), details.hasAttribute('data-moving')]).toEqual([false, false])
    // A tap in the middle of a fade-out cancels it and the part is drawn for the state it was turned to.
    await clickOn(need('#sheet-compact-toggle'))
    await clickOn(need('#sheet-compact-toggle'))
    expect(own()[2]?.cancelled).toBe(true)
    expect([details.hasAttribute('data-folded'), details.hasAttribute('data-moving')]).toEqual([false, false])
    expect(queue.length).toBe(0)
  } finally {
    Reflect.deleteProperty(proto, 'animate')
  }
})

test('the controls are real buttons a keyboard reaches, and what the chevron controls is there', async () => {
  media.phone = true
  await mount({ detail: withHelpers })
  for (const id of ['sheet-compact-toggle', 'sheet-helpers-chip']) {
    const el = need(`#${id}`)
    el.focus()
    expect([el.tagName, el.getAttribute('type'), el.tabIndex, dom.window.document.activeElement === el]).toEqual([
      'BUTTON',
      'button',
      0,
      true,
    ])
    expect(el.hasAttribute('disabled')).toBe(false)
  }
  // The head's fold, the helpers' strip and the action row: all there for it to name.
  const controls = (need('#sheet-compact-toggle').getAttribute('aria-controls') ?? '').split(' ')
  expect(controls).toEqual(['sheet-details', 'sheet-helpers', 'sheet-actions'])
  for (const id of controls) expect([id, !!q(`#${id}`)]).toEqual([id, true])
})

test('the helpers’ strip folds into their count, which opens their list; the chevron brings the strip back', async () => {
  media.phone = true
  const { calls } = await mount({ detail: withHelpers })
  const strip = need('#sheet-helpers')
  expect([strip.hasAttribute('data-folded'), strip.hasAttribute('hidden')]).toEqual([true, false])
  await clickOn(need('#sheet-helpers-chip'))
  expect(calls.helpers).toBe(1)
  await clickOn(need('#sheet-compact-toggle'))
  expect(height(strip)).toBe(0)
  await frames(6)
  expect(height(strip)).toBeGreaterThan(0)
  await frames()
  expect([strip.hasAttribute('data-folded'), strip.hasAttribute('data-moving'), bare(strip)]).toEqual([
    false,
    false,
    '',
  ])
  expect(strip.textContent).toContain('check the ledger')
})

test('the open question stays: two lines of it and its button, and a tap on the text opens it whole', async () => {
  media.phone = true
  // The browser's layout says the text is cut at two lines: its whole is taller than they are. An
  // element that left the page has no size (the browser reports it at 0 by 0).
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected && this.classList.contains('asked-clip') ? 90 : 0
    },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected && this.classList.contains('asked-clip') ? 36 : 0
    },
  })
  try {
    const { calls } = await mount()
    // The text moved into a button once it was cut; the observer reports the element it left, drawn
    // at 0 by 0, and that is not the question fitting (it did, once: the chevron never stayed).
    await act(async () => void watching.map(w => w.notify()))
    const clip = need('.asked-clip')
    const toggle = need('.asked-toggle')
    expect([toggle.tagName, toggle.getAttribute('aria-expanded'), clip.hasAttribute('data-folded')]).toEqual([
      'BUTTON',
      'false',
      true,
    ])
    expect(toggle.textContent).toContain('Keep the name in the report?')
    // Never hidden: its button is there while it is cut.
    expect(need('.asked-dismiss').hasAttribute('disabled')).toBe(false)

    await clickOn(toggle)
    expect([toggle.getAttribute('aria-expanded'), clip.hasAttribute('data-folded')]).toEqual(['true', false])
    expect(height(clip)).toBe(36)
    await frames(5)
    expect(height(clip)).toBeGreaterThan(36)
    await frames()
    expect(bare(clip)).toBe('')
    expect(toggle.getAttribute('title')).toBe('Show less')

    await clickOn(toggle)
    await frames()
    expect([toggle.getAttribute('aria-expanded'), clip.hasAttribute('data-folded')]).toEqual(['false', true])

    await clickOn(need('.asked-dismiss'))
    expect(calls.dismissed).toBe(1)
  } finally {
    Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'scrollHeight')
    Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'clientHeight')
  }
})

test('a question opened whole is folded again when another one comes; one that is no longer cut loses its chevron', async () => {
  media.phone = true
  let cutAt: number | null = 90
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected && this.classList.contains('asked-clip') ? (cutAt ?? 36) : 0
    },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected && this.classList.contains('asked-clip') ? 36 : 0
    },
  })
  try {
    const { redraw } = await mount()
    await clickOn(need('.asked-toggle'))
    await frames()
    expect(need('.asked-toggle').getAttribute('aria-expanded')).toBe('true')
    // The next question of the same session starts at its two lines.
    await redraw({ ...asking, question: 'Another question, as long as the first one, or longer than that.' })
    expect([
      need('.asked-toggle').getAttribute('aria-expanded'),
      need('.asked-clip').hasAttribute('data-folded'),
    ]).toEqual(['false', true])
    await frames()
    // The panel gets wider: the text fits its two lines, and there is nothing to open.
    cutAt = null
    await act(async () => void watching.map(w => w.notify()))
    expect(q('.asked-toggle')).toBeNull()
    expect(need('.asked-dismiss')).toBeTruthy()
  } finally {
    Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'scrollHeight')
    Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'clientHeight')
  }
})

test('a question that fits in its two lines has nothing to open, and still has its button', async () => {
  media.phone = true
  await mount()
  expect(q('.asked-toggle')).toBeNull()
  expect(need('.asked-clip').textContent).toContain('Keep the name in the report?')
  expect(need('.asked-dismiss')).toBeTruthy()
})

test('the action row opens from the footer line; the buttons were in it all along', async () => {
  media.phone = true
  await mount()
  const row = need('#sheet-actions')
  const toggle = need('.foot-toggle')
  expect([toggle.getAttribute('aria-expanded'), row.hasAttribute('data-folded')]).toEqual(['false', true])
  // Folded, the row's buttons are still laid out (its fit reads their widths) and reachable once it opens.
  expect(row.querySelector('#sheet-more')).toBeTruthy()
  await clickOn(toggle)
  await frames()
  expect([toggle.getAttribute('aria-expanded'), row.hasAttribute('data-folded')]).toEqual(['true', false])
  expect(bare(row)).toBe('')
  await clickOn(toggle)
  await frames()
  expect([toggle.getAttribute('aria-expanded'), row.hasAttribute('data-folded')]).toEqual(['false', true])
})

test('the head turned whole, the footer is as it was: a row with no chevron on its line', async () => {
  media.phone = true
  await mount()
  expect(need('.composer-actions').hasAttribute('data-folded')).toBe(true)
  await clickOn(need('#sheet-compact-toggle'))
  await frames()
  expect(q('.foot-toggle')).toBeNull()
  expect(need('.composer-actions').hasAttribute('data-folded')).toBe(false)
  expect(need('.composer-actions').hasAttribute('id')).toBe(false)
  expect(bare(need('.composer-actions'))).toBe('')
})

test('a flow outside the sheet that needs the fold has it opened for that session, and the choice is not changed', async () => {
  media.phone = true
  dom.window.localStorage.setItem(DENSITY_KEYS.phone, 'compact')
  await mount()
  const details = need('#sheet-details')
  expect(details.hasAttribute('data-folded')).toBe(true)
  // Another session's field, or one the sheet has not shown yet: this one stays as it was, and the head
  // of that one is compact, which the flow is told (it waits for the fold to open).
  await act(async () => void revealSheetDetails('b'))
  expect(details.hasAttribute('data-folded')).toBe(true)
  expect(revealSheetDetails('c')).toBe(true)
  // This one's: its fold opens, and the page's choice stays compact.
  let asked = false
  await act(async () => {
    asked = revealSheetDetails('a')
  })
  expect(asked).toBe(true)
  expect(details.hasAttribute('data-folded')).toBe(false)
  await frames()
  expect(kept(DENSITY_KEYS.phone)).toBe('compact')
  // Nothing is asked of a fold that is open.
  expect(revealSheetDetails('a')).toBe(false)
  // The chevron then folds it, and that is kept as the choice.
  expect(need('#sheet-compact-toggle').getAttribute('aria-expanded')).toBe('true')
  await clickOn(need('#sheet-compact-toggle'))
  await frames()
  expect(details.hasAttribute('data-folded')).toBe(true)
  expect(kept(DENSITY_KEYS.phone)).toBe('compact')
})
