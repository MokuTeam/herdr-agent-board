// The focus kept across redraws (hooks/useKeepFocus.ts, upstream's helpers.js redraw) in a fake
// DOM (support/fake-dom.ts): where a draw takes the focused element away, the one that opens the
// same helper, run or list takes the focus back. The draws here make every element anew, as
// upstream's redraw did and as React does where a row changes kind or place; the keeper hears
// what React's onFocus and onBlur would tell it, and is asked after each draw, as its layout
// effect does.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { PublicHelper } from '../../src/core/helpers.ts'
import { HelpersStrip } from '../../web/src/components/helpers/HelpersStrip.tsx'
import { HelpersWindowView } from '../../web/src/components/helpers/HelpersWindow.tsx'
import type { HelpersView } from '../../web/src/hooks/useHelpers.ts'
import { type FocusKeeper, focusKeeper } from '../../web/src/hooks/useKeepFocus.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { FakeWorld } from './support/fake-dom.ts'
import { type Element, find, hasClass, serializeNodes } from './support/markup.ts'
import { asDom, first } from './support/react-commit.ts'

let world: FakeWorld
beforeEach(() => {
  world = new FakeWorld({ viewport: { w: 1200, h: 800 } })
  world.install()
})
afterEach(() => world.uninstall())

const NOW = Date.now()
const S = 1000
const helper = (id: string, more: Partial<PublicHelper> = {}): PublicHelper => ({
  id,
  kind: 'agent',
  type: 'general-purpose',
  name: '',
  description: `Task ${id}`,
  color: '',
  model: '',
  background: true,
  parent: null,
  toolUseId: null,
  workflow: null,
  phase: '',
  status: 'running',
  startedAt: NOW - 600 * S,
  endedAt: null,
  activity: NOW - 60 * S,
  prompt: `Do ${id}.`,
  from: '',
  now: null,
  after: '',
  waiting: 0,
  tokens: null,
  result: '',
  ...more,
})
const done = (h: PublicHelper, endedAt = NOW - 5 * S): PublicHelper => ({ ...h, status: 'done', endedAt })

/** The sheet's strip as React draws it for these helpers. */
const strip = (helpers: PublicHelper[]): Element =>
  first(
    renderInBoard(
      <HelpersStrip helpers={helpers} workflows={[]} onHelper={() => {}} onList={() => {}} />,
      board({ now: NOW }),
    ),
  )

const session = item({ key: 'k', name: 'Here', column: 'work' })
/** The helpers window's body as React draws the list of these helpers. */
function listBody(helpers: PublicHelper[]): Element {
  const view: HelpersView = {
    hidden: false,
    closing: false,
    key: 'k',
    stack: [{ list: true, run: null }],
    seq: 1,
    data: null,
    first: false,
    error: '',
  }
  const detail = { item: session, conversation: [], screen: '', dialog: null, checkout: false, helpers, workflows: [] }
  const nodes = renderInBoard(
    <HelpersWindowView view={view} sheet={{ key: 'k', data: detail }} item={session} items={[session]} />,
    board({ data: payload({ items: [session] }), now: NOW }),
  )
  return find(nodes, el => hasClass(el, 'helper-body'))
}

/** What was drawn, in the page under #sheet. */
function mount(drawn: Element): HTMLElement {
  const sheet = asDom(world.mount({ kind: 'element', tag: 'div', attrs: new Map([['id', 'sheet']]), children: [] }))
  const el = asDom(world.wrap(drawn))
  sheet.append(el)
  world.index(drawn)
  return el
}

function query(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}

/** The reader puts the focus on `el` (React's onFocus tells the keeper). */
function focusOn(keeper: FocusKeeper, root: HTMLElement, el: HTMLElement): void {
  el.focus()
  keeper.focused(root, el)
}

/**
 * A draw of `next` into `root` where every element is new; the browser moves the focus to <body>
 * when the element it was on leaves the page. Then the keeper is asked (its layout effect).
 */
function redraw(keeper: FocusKeeper, root: HTMLElement, next: Element): void {
  root.innerHTML = serializeNodes(next.children)
  const active = document.activeElement
  if (active instanceof HTMLElement && !active.isConnected) active.blur()
  keeper.drawn()
}

describe('the sheet strip', () => {
  test('the last running row turns into the "last" line: that line keeps the focus', () => {
    const keeper = focusKeeper()
    const a1 = helper('a1', { description: 'Check the logs' })
    const d1 = done(helper('d1'), NOW - 300 * S)
    const root = mount(strip([a1, d1]))
    focusOn(keeper, root, query(root, '.helper-row[data-helper="a1"]'))
    redraw(keeper, root, strip([done(a1), d1]))
    const active = document.activeElement
    expect(active).toBe(query(root, '.helper-last'))
    expect(active instanceof HTMLElement && active.dataset.helper).toBe('a1')
  })

  test('"N more" goes when fewer run: "All" takes the focus', () => {
    const keeper = focusKeeper()
    const five = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => helper(id))
    const root = mount(strip(five))
    const more = query(root, '.helper-more')
    expect(more.textContent).toBe('1 more at work')
    focusOn(keeper, root, more)
    redraw(keeper, root, strip([...five.slice(0, 4), done(helper('a5'))]))
    expect(root.querySelector('.helper-more')).toBeNull()
    expect(document.activeElement).toBe(query(root, '.helpers-all'))
  })

  test('of several that open the same, the same one keeps it', () => {
    const keeper = focusKeeper()
    const five = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => helper(id))
    const root = mount(strip(five))
    focusOn(keeper, root, query(root, '.helper-more'))
    redraw(keeper, root, strip(five))
    // "All" opens the list too, and comes first.
    expect(document.activeElement).toBe(query(root, '.helper-more'))
    // Again: the element it put the focus on is the one it keeps now.
    redraw(keeper, root, strip(five))
    expect(document.activeElement).toBe(query(root, '.helper-more'))
  })

  test('a row that keeps its kind and place keeps the focus by itself; nothing moves it', () => {
    const keeper = focusKeeper()
    const root = mount(strip([helper('a1'), helper('a2')]))
    const row = query(root, '[data-helper="a2"]')
    focusOn(keeper, root, row)
    keeper.drawn()
    expect(document.activeElement).toBe(row)
  })
})

describe('the helpers window', () => {
  test('a helper that finishes moves from "At work" to "Finished": its row there keeps the focus', () => {
    const keeper = focusKeeper()
    const a1 = helper('a1')
    const a2 = helper('a2')
    const root = mount(listBody([a1, a2]))
    focusOn(keeper, root, query(root, '[data-helper="a1"]'))
    redraw(keeper, root, listBody([done(a1), a2]))
    const active = document.activeElement
    expect(active instanceof HTMLElement && active.dataset.helper).toBe('a1')
    const section = active instanceof HTMLElement ? active.closest('.helper-section') : null
    expect(section?.querySelector('h4')?.textContent).toBe('Finished')
  })

  test('a row that is gone from the list: the focus stays where the browser put it', () => {
    const keeper = focusKeeper()
    const root = mount(listBody([helper('a1'), helper('a2')]))
    focusOn(keeper, root, query(root, '[data-helper="a1"]'))
    redraw(keeper, root, listBody([helper('a2')]))
    expect(document.activeElement).toBe(document.body)
  })
})

describe('where the reader put the focus', () => {
  test('somewhere else on the page: a later draw does not take it back', async () => {
    const keeper = focusKeeper()
    const root = mount(strip([helper('a1')]))
    const other = asDom(world.mount({ kind: 'element', tag: 'button', attrs: new Map(), children: [] }))
    focusOn(keeper, root, query(root, '[data-helper="a1"]'))
    other.focus()
    keeper.blurred()
    await world.flush()
    redraw(keeper, root, strip([done(helper('a1'))]))
    expect(document.activeElement).toBe(other)
  })

  test('nowhere, by a click beside it: a later draw leaves it on <body>', async () => {
    const keeper = focusKeeper()
    const root = mount(strip([helper('a1')]))
    const row = query(root, '[data-helper="a1"]')
    focusOn(keeper, root, row)
    row.blur()
    keeper.blurred()
    await world.flush()
    redraw(keeper, root, strip([done(helper('a1'))]))
    expect(document.activeElement).toBe(document.body)
  })

  test('on a row a draw takes away with a blur (as Chrome says it): it comes back, and stays kept', async () => {
    const keeper = focusKeeper()
    const a1 = helper('a1')
    const root = mount(strip([a1]))
    const row = query(root, '[data-helper="a1"]')
    focusOn(keeper, root, row)
    // The row leaves the page and says blur at once; the layout effect runs before that blur's microtask.
    root.innerHTML = serializeNodes(strip([done(a1)]).children)
    row.blur()
    keeper.blurred()
    keeper.drawn()
    expect(document.activeElement).toBe(query(root, '.helper-last'))
    await world.flush()
    // Still kept: the next draw that takes it away gives it back too.
    redraw(keeper, root, strip([done(a1)]))
    expect(document.activeElement).toBe(query(root, '.helper-last'))
  })
})
