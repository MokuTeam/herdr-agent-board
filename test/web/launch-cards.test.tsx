// The cards of sessions on their way against the old page's (at the parity baseline): launch.js's
// cardHTML and note beside <LaunchCard> and <LaunchNote> as the board draws them
// (hooks/useLaunch.ts launchSlots); the card around them as web/app.js updateCard drew it beside
// <Card> (the `compact` decision); which launches get a card (launch.js pending and placeholders
// beside models/launch.ts and the page's own launches in board-ui.ts); and what their buttons do
// (launch.js onCardAction, trust, closeTab, dismiss beside useLaunch.ts launchCards).
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { LaunchView, Translator } from '../../src/core/types.ts'
import { launchApi } from '../../web/src/api/launch.ts'
import { Card } from '../../web/src/components/Card.tsx'
import type { LaunchLook } from '../../web/src/components/launch/LaunchCard.tsx'
import {
  isPressed,
  launchCards,
  launchMenus,
  launchSlots,
  type Pressed,
  takeoversOf,
} from '../../web/src/hooks/useLaunch.ts'
import * as launchModel from '../../web/src/models/launch.ts'
import { pendingLaunches, placeholderOf } from '../../web/src/models/launch.ts'
import { boardUi, initialUi } from '../../web/src/state/board-ui.ts'
import { board, item, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { FakeServer, type LaunchScene, launchWorld, OPTIONS, oldLaunch } from './support/launch-sides.tsx'
import { addButtonTypes, canonical, find, hasClass, parseHtml, reactMarkup } from './support/markup.ts'
import { oldCode, oldFunction } from './support/old-app.ts'
import { asDom, clone, commit, first } from './support/react-commit.ts'

const launch = (fields: Partial<LaunchView> = {}): LaunchView => ({
  id: 'L1',
  name: 'acme <fix> & "co"',
  cwd: 'C:\\Work\\acme',
  category: 'acme',
  workspace: 'Acme',
  workspaceId: 'w2',
  state: 'starting',
  step: 'prepare',
  error: '',
  kind: '',
  pane: null,
  key: null,
  startedAt: 1000,
  doneAt: null,
  message: '',
  worktree: null,
  newWorkspace: false,
  ...fields,
})

/** Every way a launch shows: each step, waiting, at the trust dialog, each failure, with and without a pane. */
const LAUNCHES: LaunchView[] = [
  ...(['prepare', 'worktree', 'workspace', 'tab', 'agent', 'rename', 'message', 'command'] as const).map(step =>
    launch({ step }),
  ),
  launch({ state: 'done', step: 'message', workspace: '' }),
  launch({ state: 'waiting', step: 'dialog' }),
  launch({ state: 'waiting', step: 'dialog', pane: 'w2:p3' }),
  launch({ state: 'trust', step: 'trust', cwd: '/srv/web' }),
  launch({ state: 'trust', step: 'trusting', pane: 'w2:p3' }),
  launch({ state: 'failed', error: 'launcher exited 1', kind: 'launcher' }),
  launch({ state: 'failed', error: '', kind: 'dialog', pane: 'w2:p3' }),
  launch({ state: 'failed', error: 'no message', kind: 'message', pane: 'w2:p3' }),
  launch({ state: 'failed', error: 'took too long', kind: 'timeout' }),
  launch({ state: 'failed', error: 'odd', kind: '' }),
]

const scene = (t: Translator, fields: Partial<LaunchScene> = {}): LaunchScene => ({
  t,
  categories: [],
  items: [],
  launches: [],
  filter: 'all',
  canMutate: true,
  ...fields,
})

/** The old page's launch.js in a world, with the options of a command launcher (for its step's name). */
async function oldPage(t: Translator, fields: Partial<LaunchScene> = {}) {
  const world = launchWorld()
  const log: string[] = []
  const server = new FakeServer(log)
  server.options = { ...OPTIONS, launcher: { kind: 'command', name: 'my-cli' } }
  const s = scene(t, fields)
  const call = oldLaunch(world, s, server, log)
  // The options come with the window: open it once, then put it away.
  void call('open', {}, null)
  for (let i = 0; i < 6; i++) await world.flush()
  call('close')
  await world.settle()
  log.length = 0
  return { world, log, server, call, scene: s }
}

const look = (t: Translator, pressed: Pressed = new Map()): LaunchLook => ({
  t,
  launcher: 'my-cli',
  pressed: (what, l) => isPressed(pressed, what, l),
})

const oldMarkup = (html: unknown): string => {
  const nodes = parseHtml(String(html))
  addButtonTypes(nodes)
  return canonical(nodes)
}

describe('the markup of a launch on the board', () => {
  for (const lang of ['en', 'ru'])
    test(`its card and its lines on a session's card, every state (${lang})`, async () => {
      const t = translator(lang)
      const page = await oldPage(t)
      try {
        const slots = launchSlots(look(t), () => false)
        for (const l of LAUNCHES) {
          const placeholder = placeholderOf(l)
          expect(canonical(reactMarkup(slots.card(placeholder)))).toBe(oldMarkup(page.call('cardHTML', { launch: l })))
          expect(canonical(reactMarkup(slots.note(l)))).toBe(oldMarkup(page.call('note', l)))
        }
      } finally {
        page.world.uninstall()
      }
    })
})

describe('the card around it', () => {
  test("the old page flipped `compact` at every draw (a launch has no `sleeping`); React's card is never compact", () => {
    // Decision (Task 24's carry): the old page's updateCard ran classList.toggle('compact', undefined)
    // on a launch's card, which toggles: compact on the first draw, not on the next, and so on, with
    // each board that came in. That flicker is no state it meant to show — compact is for a session
    // asleep in the idle column, and a launch is never asleep nor idle — so React draws the card it
    // meant, never compact, and a session asleep in the idle column stays compact.
    const world = new FakeWorld({ viewport: { w: 1000, h: 700 } })
    world.install()
    try {
      const updateCard = oldFunction(
        oldCode('web/app.js', ['compact', 'updateCard'], {
          cardHTML: () => '<div class="card-top"></div>',
          unseenResult: () => false,
          viewed: {},
          state: { open: null, busy: new Map() },
        }),
        'updateCard',
      )
      const card = world.document.createElement('article')
      card.className = 'card'
      const placeholder = placeholderOf(launch())
      const old = { ...placeholder, sleeping: undefined }
      const classes: boolean[] = []
      for (let draw = 0; draw < 4; draw++) {
        updateCard(card, old)
        classes.push(card.classList.contains('compact'))
      }
      expect(classes).toEqual([true, false, true, false])
    } finally {
      world.uninstall()
    }
    const t = translator('en')
    const slots = launchSlots(look(t), () => false)
    const drawn = (it: ReturnType<typeof placeholderOf>) =>
      find(
        renderInBoard(
          <Card
            item={it}
            selected={false}
            busy={undefined}
            placeholder={false}
            launch={slots}
            onPointerDown={() => {}}
            onClick={() => {}}
            onKeyDown={() => {}}
          />,
          board(),
        ),
        el => el.tag === 'article',
      )
    for (const l of LAUNCHES) {
      const article = drawn(placeholderOf(l))
      expect(hasClass(article, 'compact')).toBe(false)
      expect(hasClass(article, 'launch-card')).toBe(true)
      expect(article.attrs.get('data-col')).toBe(launchModel.launchColumn(l))
    }
    expect(hasClass(drawn(item({ key: 's9', sleeping: true, column: 'idle' })), 'compact')).toBe(true)
  })
})

describe('which launches get a card', () => {
  const NOW = 100_000
  const SERVER = [
    launch({ id: 'S1', startedAt: NOW - 60_000 }),
    launch({ id: 'S2', state: 'done', doneAt: NOW - 10_000, key: 'k-gone' }),
    launch({ id: 'S3', state: 'done', doneAt: NOW - 40_000 }),
    launch({ id: 'S4', key: 'k-on-board' }),
  ]
  const LOCAL = [
    launch({ id: 'S1', startedAt: NOW - 1000 }),
    launch({ id: 'P1', startedAt: NOW - 1000 }),
    launch({ id: 'P2', startedAt: NOW - 16_000 }),
  ]
  const ITEMS = [item({ key: 'k-on-board' })]
  // What the old placeholder had (React's card reads no more; its other fields are the empty ones Item needs).
  const OLD_FIELDS = ['key', 'launchOnly', 'launch', 'name', 'category', 'column', 'cwd', 'workspace', 'activity']
  const pick = (it: Record<string, unknown>) => Object.fromEntries(OLD_FIELDS.map(k => [k, it[k]]))

  test("the server's and the page's own, as launch.js pending and placeholders", () => {
    const local = new Map(LOCAL.map(l => [l.id, l]))
    const code = oldCode(
      'web/launch.js',
      [
        { name: 'pending', indent: '  ' },
        { name: 'placeholders', indent: '  ' },
      ],
      { d: () => ({ launches: SERVER, items: ITEMS }), local, Date: { now: () => NOW } },
    )
    const old = oldFunction(code, 'placeholders')()
    const mine = pendingLaunches(SERVER, LOCAL, ITEMS, NOW).map(placeholderOf)
    expect(Array.isArray(old) ? old.map(it => pick(it)) : old).toEqual(mine.map(it => pick(it)))
    expect(mine.map(it => it.key)).toEqual(['launch:S1', 'launch:S2', 'launch:P1'])
    // The old page forgot its own once the server had them or they waited too long; so does board-ui.
    const ui = boardUi(
      LOCAL.reduce(
        (u, l) => boardUi(u, { type: 'launched', launch: l }),
        initialUi((_k, f) => f),
      ),
      { type: 'settle', items: ITEMS, launches: SERVER, now: NOW },
    )
    expect(ui.launched.map(l => l.id)).toEqual([...local.keys()])
  })

  test('the page forgets its own when one is dismissed; a board without launches keeps them', () => {
    let ui = initialUi((_k, f) => f)
    ui = boardUi(ui, { type: 'launched', launch: launch({ id: 'P1' }) })
    ui = boardUi(ui, { type: 'launched', launch: launch({ id: 'P1', name: 'again' }) })
    expect(ui.launched.map(l => l.name)).toEqual(['again'])
    expect(boardUi(ui, { type: 'settle', items: [], now: 0 })).toBe(ui)
    expect(boardUi(ui, { type: 'launchGone', id: 'nope' })).toBe(ui)
    expect(boardUi(ui, { type: 'launchGone', id: 'P1' }).launched).toEqual([])
  })

  test("a session the board started takes over its launch's card on screen", () => {
    expect([...takeoversOf([launch({ id: 'L1', key: 's1' }), launch({ id: 'L2' })])]).toEqual([['s1', 'launch:L1']])
  })
})

// ---------------------------------------------------------------- the buttons

/** A side the buttons are clicked on: the card in a page, what went out and the toasts. */
interface CardSide {
  /** Clicks the button `what` of the card (`.card-top`: beside the buttons); true when the card took it. */
  click(what: string): Promise<boolean>
  /** The card as drawn now, and the log. */
  shot(): string
  /** What the page was asked to do that only one side does its own way (start again, forget). */
  asked: string[]
  dispose(): Promise<void>
}

const flush = async (world: FakeWorld) => {
  for (let i = 0; i < 6; i++) await world.flush()
}

const buttonOf = (el: FakeElement, what: string) =>
  what === '.card-top' ? el.querySelector('.card-top') : el.querySelector(`[data-launch="${what}"]`)

async function oldCardSide(l: LaunchView, fields: Partial<LaunchScene>, acts: FakeServer['acts']): Promise<CardSide> {
  const page = await oldPage(translator('en'), { launches: [l], ...fields })
  page.server.acts = acts
  const [card] = parseHtml(
    `<article class="card launch-card" data-key="launch:${l.id}">${page.call('cardHTML', { launch: l })}</article>`,
  )
  if (card?.kind !== 'element') throw new Error('no card')
  const el = page.world.mount(card)
  return {
    asked: [],
    async click(what) {
      const took = !!page.call('onCardAction', { target: buttonOf(el, what) })
      await flush(page.world)
      return took
    },
    shot: () => `${oldMarkup(el.innerHTML)}\nlog: ${page.log.join(' | ')}`,
    async dispose() {
      await page.world.settle()
      page.world.uninstall()
    },
  }
}

async function reactCardSide(l: LaunchView, fields: Partial<LaunchScene>, acts: FakeServer['acts']): Promise<CardSide> {
  const t = translator('en')
  const world = launchWorld()
  const log: string[] = []
  const asked: string[] = []
  const server = new FakeServer(log)
  server.acts = acts
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'fetch', { value: server.fetch, configurable: true, writable: true })
  const s = scene(t, { launches: [l], ...fields })
  let pressed: Pressed = new Map()
  const cards = launchCards({
    t: () => t,
    canMutate: () => s.canMutate,
    toast: (text, error = false) => log.push(`toast ${error ? 'error ' : ''}${text}`),
    api: launchApi,
    launches: () => s.launches,
    local: () => [],
    forget: id => asked.push(`forget ${id}`),
    retry: (x, el) =>
      asked.push(`retry ${x.id} from ${el instanceof Element ? el.getAttribute('data-launch') : 'nothing'}`),
    press: (key, shown) => {
      const next = new Map(pressed)
      if (shown === null) next.delete(key)
      else next.set(key, shown)
      pressed = next
    },
  })
  // The board's card: what the slot draws, drawn again after every event (React's commit).
  const tree = () => (
    <article className="card launch-card">{launchSlots(look(t, pressed), () => false).card(placeholderOf(l))}</article>
  )
  let markup = first(reactMarkup(tree()))
  const el = world.mount(clone(markup))
  world.afterFlush = () => {
    const next = first(reactMarkup(tree()))
    commit(world, el.node, markup, next)
    markup = next
  }
  return {
    asked,
    async click(what) {
      const button = buttonOf(el, what)
      const took = cards.onAction(button ? asDom(button) : null)
      await flush(world)
      return took
    },
    shot: () => `${canonical(el.node.children)}\nlog: ${log.join(' | ')}`,
    async dispose() {
      await world.settle()
      world.uninstall()
      if (savedFetch) Object.defineProperty(globalThis, 'fetch', savedFetch)
      else Reflect.deleteProperty(globalThis, 'fetch')
    },
  }
}

/** Both sides click the same buttons; after each, the card and what went out must be the same. */
async function compareClicks(
  l: LaunchView,
  clicks: string[],
  { fields = {}, acts = {} }: { fields?: Partial<LaunchScene>; acts?: FakeServer['acts'] } = {},
): Promise<{ shots: string[]; asked: string[] }> {
  const run = async (make: typeof oldCardSide) => {
    const side = await make(l, fields, acts)
    try {
      const shots: string[] = []
      for (const what of clicks) shots.push(`${what} took: ${await side.click(what)}\n${side.shot()}`)
      return { shots, asked: side.asked }
    } finally {
      await side.dispose()
    }
  }
  const old = await run(oldCardSide)
  const react = await run(reactCardSide)
  expect(react.shots).toEqual(old.shots)
  return { shots: old.shots, asked: react.asked }
}

const TRUST = launch({ state: 'trust', step: 'trust', pane: 'w2:p3' })
const FAILED = launch({ state: 'failed', error: 'launcher exited 1', kind: 'launcher', pane: 'w2:p3' })

describe('what the buttons of a launch do', () => {
  test('trust: the button stays off while it goes; refused, it is on again and the toast says why', async () => {
    const ok = await compareClicks(TRUST, ['trust'])
    expect(ok.shots[0]).toContain('POST /api/launch/L1/trust {}')
    expect(ok.shots[0]).toContain('data-id="L1" data-launch="trust" disabled=""')
    const refused = await compareClicks(TRUST, ['trust'], {
      acts: { trust: { status: 409, body: { ok: false, error: 'Not at the dialog' } } },
    })
    expect(refused.shots[0]).toContain('toast error Not at the dialog')
    expect(refused.shots[0]).not.toContain('disabled=""')
  })

  test('close the tab: a toast when done; refused, on again', async () => {
    const ok = await compareClicks(TRUST, ['closeTab'])
    expect(ok.shots[0]).toContain('toast Tab closed')
    await compareClicks(TRUST, ['closeTab'], { acts: { close: { status: 500, body: {} } } })
  })

  test('go to its tab, with fresh data or without', async () => {
    const ok = await compareClicks(FAILED, ['focus'])
    expect(ok.shots[0]).toContain('POST /api/launch/L1/focus {}')
    const stale = await compareClicks(FAILED, ['focus'], { fields: { canMutate: false } })
    expect(stale.shots[0]).toContain('toast error')
  })

  test('dismiss: forgotten by the page, and the server asked; refused, the toast says why', async () => {
    const ok = await compareClicks(FAILED, ['dismiss', '.card-top'])
    expect(ok.shots[0]).toContain('POST /api/launch/L1/dismiss {}')
    expect(ok.shots[1]).toContain('.card-top took: false')
    expect(ok.asked).toEqual(['forget L1'])
    await compareClicks(FAILED, ['dismiss'], { acts: { dismiss: { status: 404, body: { ok: false, error: 'gone' } } } })
  })

  test('retry: the window opens for it, grown out of the button', async () => {
    const page = await oldPage(translator('en'), { launches: [FAILED] })
    try {
      const [card] = parseHtml(`<article class="card">${page.call('cardHTML', { launch: FAILED })}</article>`)
      if (card?.kind !== 'element') throw new Error('no card')
      const el = page.world.mount(card)
      expect(page.call('onCardAction', { target: el.querySelector('[data-launch="retry"]') })).toBe(true)
      await flush(page.world)
      expect(page.call('isOpen')).toBe(true)
      expect(page.world.document.documentElement.querySelector('#launch-title')?.textContent).toBe('Start it again')
    } finally {
      await page.world.settle()
      page.world.uninstall()
    }
    const react = await compareClicks(launch({ ...FAILED, pane: null }), ['.card-top'])
    expect(react.asked).toEqual([])
    const side = await reactCardSide(FAILED, {}, {})
    try {
      expect(await side.click('retry')).toBe(true)
      expect(side.asked).toEqual(['retry L1 from retry'])
    } finally {
      await side.dispose()
    }
  })

  test("the menus of a launch's card: its launches, and the same actions", () => {
    const calls: string[] = []
    const retry = () => {}
    const menus = launchMenus(
      () => [FAILED],
      {
        trust: async id => void calls.push(`trust ${id}`),
        closeTab: async id => void calls.push(`closeTab ${id}`),
        dismiss: async id => void calls.push(`dismiss ${id}`),
      },
      retry,
    )
    expect(menus.placeholders()).toEqual([{ launch: FAILED }])
    menus.trust('L1')
    menus.closeTab('L1')
    menus.dismiss('L1')
    expect(calls).toEqual(['trust L1', 'closeTab L1', 'dismiss L1'])
    expect(menus.retry).toBe(retry)
  })
})
