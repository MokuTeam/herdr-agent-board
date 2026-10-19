// What the menus' items do on the React board (hooks/useContextMenus.ts boardActions and the
// sheet's More), against the old page's app.js: its copyText, openPath and focusLaunch (at the
// parity baseline) through the same fetch and clipboard, and its #sheet-more handler (at the
// session panel's row) on the same buttons, the same of them hidden in the row; the rest asks the
// React board's ported actions for what the old `do` did.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import { type ActionDeps, boardActions, sheetMoreMenuFrom } from '../../web/src/hooks/useContextMenus.ts'
import {
  type ActResult,
  callMokuPilot,
  restartSession,
  type SessionActions,
} from '../../web/src/hooks/useSessionActions.ts'
import { pointRect } from '../../web/src/models/board-menus.ts'
import type { MenuEntry, MenuItem } from '../../web/src/models/menu-model.ts'
import type { BoardAction } from '../../web/src/state/board-ui.ts'
import { item } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { oldCode, oldFunction } from './support/old-app.ts'
import { asDom } from './support/react-commit.ts'

const t = translator('en')
const session = item({ key: 's1', name: 'acme', cwd: '/srv/acme' })

const PAGE = `<div id="page"><article class="card" data-key="s1" id="card"><span class="name" id="card-name">acme</span></article>
<h2 id="sheet-name">acme</h2><input id="search" type="search">
<div class="composer-actions"><button id="sheet-more">More actions</button>
<button id="sheet-focus">Go</button>
<button id="sheet-wake" hidden> Wake </button>
<button id="sheet-sleep" title="It works; it can sleep after this turn" disabled> Sleep </button>
<button id="sheet-changes" title="Changes in this folder"> Changes </button>
<button id="sheet-history" disabled> History </button>
<button id="sheet-new" disabled> New here </button></div></div>`

/** The buttons the sheet's row shows (the stylesheet's say): More lists the others. */
const WIDE_ROW = ['sheet-focus', 'sheet-mokupilot', 'sheet-term', 'sheet-changes', 'sheet-more']
const NARROW_ROW = ['sheet-focus', 'sheet-more']
let rowShows = new Set(WIDE_ROW)

let world: FakeWorld
beforeEach(() => {
  rowShows = new Set(WIDE_ROW)
  world = new FakeWorld({
    viewport: { w: 1000, h: 700 },
    computed: el => ({ display: rowShows.has(el.id) ? 'inline-flex' : 'none' }),
  })
  world.install()
  for (const node of parseHtml(PAGE)) if (node.kind === 'element') world.mount(node)
})
afterEach(async () => {
  try {
    await world.settle()
  } finally {
    world.uninstall()
  }
})
const page = (id: string): FakeElement => {
  const el = world.document.getElementById(id)
  if (!el) throw new Error(`no #${id}`)
  return el
}

// ---------------------------------------------------------------- the board's actions

function actionsWorld(fields: Partial<{ canEdit: boolean; canMutate: boolean; act: ActResult }> = {}) {
  const calls: string[] = []
  const note =
    (name: string) =>
    async (...args: unknown[]) =>
      void calls.push(`${name} ${args.map(nameOf).join(' ')}`)
  const actions: SessionActions = {
    act: async (key, action, body) => {
      calls.push(`act ${JSON.stringify([key, action, body])}`)
      return fields.act ?? { ok: true }
    },
    moveCard: note('moveCard'),
    focusSession: note('focusSession'),
    wakeSession: note('wakeSession'),
    sleepSession: note('sleepSession'),
    restartSession: note('restartSession'),
    dismissAsk: note('dismissAsk'),
    callMokuPilot: note('callMokuPilot'),
  }
  const deps: ActionDeps = {
    t: () => t,
    canEdit: () => fields.canEdit ?? true,
    canMutate: () => fields.canMutate ?? true,
    item: key => (key === 's1' ? session : undefined),
    dispatch: (action: BoardAction) => void calls.push(`dispatch ${JSON.stringify(action)}`),
    toast: (text, error = false) => void calls.push(`toast ${error ? 'error ' : ''}${text}`),
    actions,
    quickLook: {
      look: (target, el) => void calls.push(`look ${JSON.stringify(target)} ${nameOf(el)}`),
      lookChanges: (key, el) => void calls.push(`lookChanges ${key} ${nameOf(el)}`),
      lookHistory: (key, cwd, el) => void calls.push(`lookHistory ${key} ${cwd} ${nameOf(el)}`),
    },
    newSession: (ctx, from) => void calls.push(`newSession ${JSON.stringify(ctx)} ${nameOf(from)}`),
    openCategories: id => void calls.push(`openCategories ${id}`),
    rename: (key, el) => void calls.push(`rename ${key} ${nameOf(el)}`),
  }
  return { calls, deps, act: boardActions(deps) }
}

/** An element by its id; anything else as JSON. */
function nameOf(el: unknown): string {
  if (el === null || el === undefined) return 'none'
  if (typeof el === 'object' && 'id' in el && 'node' in el) return `#${String(el.id)}`
  return JSON.stringify(el)
}

describe('the menus’ actions', () => {
  test('a card’s: open, write, go to it, wake, sleep, move, dismiss, the quick looks, a new session there', async () => {
    const { calls, act } = actionsWorld()
    const card = asDom(page('card'))
    const rect = pointRect(10, 20)
    act.open('s1', card)
    act.write('s1', card)
    act.focus('s1', card)
    act.wake('s1', card)
    act.sleep('s1', card)
    act.dismiss('s1', card)
    act.move('s1', { cat: 'other' })
    act.move('s1', { column: 'done' })
    act.move('s1', { column: 'nowhere' })
    act.changes('s1', card)
    act.history('s1', rect)
    act.newSession({ item: session }, rect)
    act.look({ path: '/srv/a.ts', line: 3 }, card)
    act.mokupilot('s1', card)
    await world.flush()
    expect(calls).toEqual([
      'dispatch {"type":"open","key":"s1"}',
      'dispatch {"type":"open","key":"s1","compose":true}',
      'focusSession "s1"',
      'wakeSession "s1"',
      'sleepSession "s1"',
      'dismissAsk "s1"',
      'moveCard "s1" {"cat":"other","column":null}',
      'moveCard "s1" {"cat":null,"column":"done"}',
      'moveCard "s1" {"cat":null,"column":null}',
      'lookChanges s1 #card',
      // A point (a lane's, the board's) is nothing the quick look grows out of.
      'lookHistory s1 /srv/acme none',
      `newSession {"item":${JSON.stringify(session)}} {"left":-2,"top":8,"right":22,"bottom":32,"width":24,"height":24}`,
      'look {"path":"/srv/a.ts","line":3} #card',
      'callMokuPilot "s1"',
    ])
  })

  test('the board’s: the categories panel (at a lane), the filter, the sleepers, the search', () => {
    const { calls, act } = actionsWorld()
    act.cats('acme')
    act.cats()
    act.filter('acme')
    act.sleepers()
    act.search()
    expect(calls).toEqual([
      'openCategories acme',
      'openCategories undefined',
      'dispatch {"type":"filter","id":"acme"}',
      'dispatch {"type":"toggleSleepers"}',
    ])
    expect(world.document.activeElement?.id).toBe('search')
  })

  test('rename where the name is; a name drawn anew since: in the sheet’s head once it opened', async () => {
    const { calls, act } = actionsWorld()
    act.rename('s1', asDom(page('card-name')))
    const gone = asDom(page('card-name'))
    page('card-name').remove()
    act.rename('s1', gone)
    act.rename('s1', null)
    await world.tick(370)
    expect(calls).toEqual([
      'rename s1 #card-name',
      'dispatch {"type":"open","key":"s1"}',
      'dispatch {"type":"open","key":"s1"}',
    ])
    await world.tick(20)
    expect(calls.slice(3)).toEqual(['rename s1 #sheet-name', 'rename s1 #sheet-name'])
  })

  test('clearing a card says so, or why not', async () => {
    const ok = actionsWorld()
    await ok.act.clear('s1', pointRect(0, 0))
    expect(ok.calls).toEqual(['act ["s1","card",{"clear":true}]', `toast ${t('tui.cleared', { name: 'acme' })}`])
    const refused = actionsWorld({ act: { ok: false, error: 'Board offline' } })
    await refused.act.clear('s1', pointRect(0, 0))
    expect(refused.calls.at(-1)).toBe('toast error Board offline')
  })
})

// ---------------------------------------------------------------- the same as app.js: copy, open with the system, go to a launch

interface Net {
  /** What answers a POST: a status and a body, or a throw (offline). */
  reply: { status: number; body: unknown } | Error
}

/** Runs `go` with fetch and the clipboard answering as told; what was asked of them, and the toasts. */
async function through(net: Net, go: (deps: { toast: (text: string, error?: boolean) => void }) => Promise<unknown>) {
  const asked: string[] = []
  const toasts: string[] = []
  const fetch = async (url: string, init: { method?: string; headers?: unknown; body?: string } = {}) => {
    asked.push(`${init.method ?? 'GET'} ${url} ${JSON.stringify(init.headers)} ${init.body ?? ''}`)
    if (net.reply instanceof Error) throw net.reply
    const { status, body } = net.reply
    return { ok: status < 400, status, json: async () => body }
  }
  const clipboard = {
    writeText: async (text: string) => {
      asked.push(`clipboard ${text}`)
      if (net.reply instanceof Error) throw net.reply
    },
  }
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'fetch', { value: fetch, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true, writable: true })
  try {
    await go({ toast: (text, error = false) => void toasts.push(`${error ? 'error ' : ''}${text}`) })
  } finally {
    if (savedFetch) Object.defineProperty(globalThis, 'fetch', savedFetch)
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
  return { asked, toasts }
}

type Run = 'copy' | 'openPath' | 'focusLaunch'
const call = (fn: unknown, args: unknown[]) => {
  if (typeof fn !== 'function') throw new Error('not a function')
  return Reflect.apply(fn, undefined, args)
}

async function oldSide(net: Net, what: Run, args: unknown[], allowed = { canEdit: true, canMutate: true }) {
  return through(net, async ({ toast }) => {
    const code = oldCode('web/app.js', ['focusLaunch', 'copyText', 'openPath'], {
      toast,
      t,
      canEdit: () => allowed.canEdit,
      canMutate: () => allowed.canMutate,
    })
    await call(oldFunction(code, what === 'copy' ? 'copyText' : what), args)
  })
}

async function newSide(net: Net, what: Run, args: unknown[], allowed = { canEdit: true, canMutate: true }) {
  return through(net, async ({ toast }) => {
    const { deps } = actionsWorld(allowed)
    const act = boardActions({ ...deps, toast })
    await call(act[what], args)
  })
}

describe('as the old page: copying, opening with the system, going to a starting session', () => {
  const cases: [string, Net][] = [
    ['ok', { reply: { status: 200, body: { ok: true } } }],
    ['refused', { reply: { status: 400, body: { ok: false, error: 'Not a folder' } } }],
    ['refused without a word', { reply: { status: 500, body: {} } }],
    ['said no', { reply: { status: 200, body: { ok: false } } }],
    ['offline', { reply: new Error('Failed to fetch') }],
  ]
  for (const [name, net] of cases)
    test(name, async () => {
      for (const [what, args] of [
        ['copy', ['/srv/acme', t('menu.copied')]],
        ['copy', [null, t('menu.copied')]],
        ['openPath', ['/srv/acme', 'open']],
        ['openPath', ['C:\\Acme\\README.md', 'reveal']],
        ['focusLaunch', ['L 1']],
      ] as const) {
        expect(await newSide(net, what, [...args])).toEqual(await oldSide(net, what, [...args]))
      }
    })
  test('without the board, or without fresh herdr data', async () => {
    const net: Net = { reply: { status: 200, body: { ok: true } } }
    for (const allowed of [
      { canEdit: false, canMutate: false },
      { canEdit: true, canMutate: false },
    ])
      for (const [what, args] of [
        ['openPath', ['/srv/acme', 'open']],
        ['focusLaunch', ['L1']],
      ] as const)
        expect(await newSide(net, what, [...args], allowed)).toEqual(await oldSide(net, what, [...args], allowed))
  })
})

// ---------------------------------------------------------------- More

/** Upstream's merge of the call's move to the row (#55): More lists what the row hides, in groups. */
const MORE_MERGE = '8745585'

interface MoreOpened {
  items: MenuEntry[]
  options: Record<string, unknown> & { onPick?: ((id: string, item: MenuItem) => void) | undefined }
}

/** The handler as it was at MORE_MERGE, with its groups. */
function oldMore(
  canMutate: boolean,
  coarse: boolean,
  log: string[],
): { click(button: FakeElement, detail: number): void; opened: () => MoreOpened | null } {
  let opened: MoreOpened | null = null
  let handler: ((e: unknown) => void) | null = null
  const wanted = ['MORE', 'HERDR_MORE', { statement: "$('#sheet-more').addEventListener('click'" }]
  const deps = {
    $: () => ({
      addEventListener: (_type: string, fn: (e: unknown) => void) => {
        handler = fn
      },
    }),
    menu: {
      open: (items: MenuEntry[], options: MoreOpened['options']) => {
        opened = { items, options }
      },
    },
    canMutate: () => canMutate,
    t,
    matchMedia: () => ({ matches: coarse }),
    document: world.document,
    state: { open: 's1' },
    itemOf: (key: string) => (key === 's1' ? session : undefined),
    files: {
      lookHistory: (key: string, cwd: string, el: FakeElement) => void log.push(`lookHistory ${key} ${cwd} #${el.id}`),
      lookChanges: (key: string, el: FakeElement) => void log.push(`lookChanges ${key} #${el.id}`),
    },
    newSession: (ctx: { item?: Item }, el: FakeElement) => void log.push(`newSession ${ctx.item?.key} #${el.id}`),
    openTerminal: (key: string, el: FakeElement) => void log.push(`terminal ${key} #${el.id}`),
  }
  oldCode('web/app.js', wanted, deps, MORE_MERGE)
  return {
    click: (button, detail) => handler?.({ currentTarget: button, detail }),
    opened: () => opened,
  }
}

function newMore(canMutate: boolean, coarse: boolean, log: string[]) {
  let opened: MoreOpened | null = null
  const more = sheetMoreMenuFrom({
    menu: {
      open: (items, options) => {
        opened = { items: [...items], options: { ...options } }
      },
      isOpen: () => false,
    },
    t: () => t,
    canMutate: () => canMutate,
    open: () => 's1',
    item: key => (key === 's1' ? session : undefined),
    quickLook: {
      lookHistory: (key, cwd, el) => void log.push(`lookHistory ${key} ${cwd} ${nameOf(el)}`),
      lookChanges: (key, el) => void log.push(`lookChanges ${key} ${nameOf(el)}`),
    },
    newSession: (ctx, from) => void log.push(`newSession ${ctx.item?.key} ${nameOf(from)}`),
    terminal: (key, el) => void log.push(`terminal ${key} ${nameOf(el)}`),
    coarse: () => coarse,
  })
  return {
    click: (button: FakeElement, detail: number) => more(asDom(button), detail === 0),
    opened: () => opened,
  }
}

/** A pick in the menu opened: the item the menu would hand over with it. */
function pickIn(o: MoreOpened | null, id: string): void {
  const it = o?.items.find((i): i is MenuItem => !i.separator && i.id === id)
  if (it) o?.options.onPick?.(id, it)
}

const shown = (o: MoreOpened | null) =>
  o && {
    items: o.items,
    options: Object.fromEntries(Object.entries(o.options).filter(([k]) => k !== 'onPick' && k !== 'origin')),
    origin: nameOf(o.options.origin),
  }

/** The menu opened, an item a line: `id:label:reason`, a separator `—`. */
const lines = (o: MoreOpened | null) => o?.items.map(it => (it.separator ? '—' : `${it.id}:${it.label}:${it.reason}`))

describe('More at the end of the session panel’s row', () => {
  test('the buttons the row hides, in groups, gray with why; upward out of the button, by keys, finger or mouse', async () => {
    const all = [...WIDE_ROW, 'sheet-wake', 'sheet-sleep', 'sheet-new']
    for (const row of [WIDE_ROW, NARROW_ROW, all]) {
      rowShows = new Set(row)
      for (const canMutate of [true, false])
        for (const coarse of [true, false])
          for (const detail of [0, 1]) {
            const [a, b] = [oldMore(canMutate, coarse, []), newMore(canMutate, coarse, [])]
            a.click(page('sheet-more'), detail)
            b.click(page('sheet-more'), detail)
            expect(shown(b.opened())).toEqual(shown(a.opened()))
          }
    }
    rowShows = new Set(WIDE_ROW)
    const wide = newMore(true, false, [])
    wide.click(page('sheet-more'), 1)
    expect(lines(wide.opened())).toEqual([
      `sheet-history:History:${t('mobile.readOnly')}`,
      '—',
      `sheet-new:New here:${t('mobile.readOnly')}`,
      '—',
      'sheet-sleep:Sleep:It works; it can sleep after this turn',
    ])
    expect(wide.opened()?.options).toMatchObject({ y: page('sheet-more').getBoundingClientRect().top - 4, up: true })
    rowShows = new Set(NARROW_ROW)
    const narrow = newMore(true, false, [])
    narrow.click(page('sheet-more'), 1)
    expect(lines(narrow.opened())).toEqual([
      'sheet-changes:Changes:',
      `sheet-history:History:${t('mobile.readOnly')}`,
      '—',
      `sheet-new:New here:${t('mobile.readOnly')}`,
      '—',
      'sheet-sleep:Sleep:It works; it can sleep after this turn',
    ])
  })

  test('a pick: the quick looks out of the button, a new session here, a button’s own click; none once it went gray', async () => {
    rowShows = new Set(NARROW_ROW)
    const clicked: string[] = []
    page('sheet-sleep').addEventListener('click', () => clicked.push('sleep'))
    for (const id of ['sheet-history', 'sheet-new', 'sheet-sleep']) {
      page(id).disabled = false
      page(id).hidden = false
    }
    const [oldLog, newLog]: [string[], string[]] = [[], []]
    const [a, b] = [oldMore(true, false, oldLog), newMore(true, false, newLog)]
    a.click(page('sheet-more'), 1)
    b.click(page('sheet-more'), 1)
    for (const id of ['sheet-history', 'sheet-changes', 'sheet-new', 'sheet-sleep']) {
      pickIn(a.opened(), id)
      pickIn(b.opened(), id)
    }
    page('sheet-changes').disabled = true
    pickIn(a.opened(), 'sheet-changes')
    pickIn(b.opened(), 'sheet-changes')
    page('sheet-changes').disabled = false
    page('sheet-changes').hidden = true
    pickIn(a.opened(), 'sheet-changes')
    pickIn(b.opened(), 'sheet-changes')
    await world.flush()
    expect(newLog).toEqual(oldLog)
    expect(oldLog).toEqual([
      'lookHistory s1 /srv/acme #sheet-more',
      'lookChanges s1 #sheet-more',
      'newSession s1 #sheet-more',
    ])
    expect(clicked).toEqual(['sleep', 'sleep'])
  })

  test('the Terminal first of the tools when the row hides it; picked, it opens out of More', async () => {
    rowShows = new Set(NARROW_ROW)
    const term = world.document.createElement('button')
    term.id = 'sheet-term'
    term.title = t('term.hint')
    term.textContent = ` ${t('term.open')} `
    page('sheet-focus').after(term)
    const clicked: string[] = []
    term.addEventListener('click', () => clicked.push('terminal'))
    for (const canMutate of [true, false]) {
      const [oldLog, newLog]: [string[], string[]] = [[], []]
      const [a, b] = [oldMore(canMutate, false, oldLog), newMore(canMutate, false, newLog)]
      a.click(page('sheet-more'), 1)
      b.click(page('sheet-more'), 1)
      expect(shown(b.opened())).toEqual(shown(a.opened()))
      expect(b.opened()?.items[0]).toMatchObject({ id: 'sheet-term', label: 'Terminal', disabled: false })
      pickIn(a.opened(), 'sheet-term')
      pickIn(b.opened(), 'sheet-term')
      await world.flush()
      expect(newLog).toEqual(oldLog)
      expect(oldLog).toEqual(['terminal s1 #sheet-more'])
    }
    // In the row, or hidden (no terminal on this board), it is not in the menu.
    for (const inRow of [true, false]) {
      rowShows = new Set(inRow ? WIDE_ROW : NARROW_ROW)
      term.hidden = !inRow
      const b = newMore(true, false, [])
      b.click(page('sheet-more'), 1)
      expect(b.opened()?.items.some(it => !it.separator && it.id === 'sheet-term')).toBe(false)
    }
    expect(clicked).toEqual([])
  })

  test('“Restart” with the session’s own life: without fresh data it waits for herdr, else its own why; picked it is the button’s own click', async () => {
    rowShows = new Set(NARROW_ROW)
    const restart = world.document.createElement('button')
    restart.id = 'sheet-restart'
    restart.textContent = ` ${t('sheet.restart')} `
    page('sheet-sleep').after(restart)
    let clicks = 0
    restart.addEventListener('click', () => void clicks++)
    for (const canMutate of [true, false])
      for (const disabled of [false, true]) {
        restart.disabled = disabled
        restart.title = disabled ? `${t('sheet.restartPending')}. ${t('restart.title.wait')}` : t('sheet.restartHint')
        const [oldLog, newLog]: [string[], string[]] = [[], []]
        const [a, b] = [oldMore(canMutate, false, oldLog), newMore(canMutate, false, newLog)]
        a.click(page('sheet-more'), 1)
        b.click(page('sheet-more'), 1)
        expect(shown(b.opened())).toEqual(shown(a.opened()))
        const item = b.opened()?.items.find(it => !it.separator && it.id === 'sheet-restart')
        expect(item).toMatchObject({
          label: 'Restart',
          disabled,
          reason: !disabled ? '' : canMutate ? restart.title : t('mobile.readOnly'),
        })
        pickIn(a.opened(), 'sheet-restart')
        pickIn(b.opened(), 'sheet-restart')
        await world.flush()
        expect(newLog).toEqual(oldLog)
      }
    // Picked while it could: the button's own click, on each side, both times.
    expect(clicks).toBe(4)
  })

  test('Restart from the sheet or a card’s menu says it is asked for, on its way already, or why not, as upstream’s restartSession', async () => {
    const asleep = { ...session, sleeping: true }
    const replies: ActResult[] = [
      { ok: true },
      { ok: true, again: true },
      { ok: false, error: 'A restart needs herdr-wake' },
    ]
    for (const reply of replies)
      for (const key of ['s1', 'z1', 'gone']) {
        const said: { old: unknown[]; react: unknown[] } = { old: [], react: [] }
        const asked: { old: unknown[]; react: unknown[] } = { old: [], react: [] }
        const deps = (side: 'old' | 'react') => ({
          t,
          itemOf: (k: string) => (k === 's1' ? session : k === 'z1' ? asleep : undefined),
          act: async (k: string, action: string) => {
            asked[side].push([k, action])
            return reply
          },
          toast: (text: string, error = false) => void said[side].push([text, error]),
        })
        const code = oldCode('web/app.js', ['restartSession'], deps('old'), '513e441')
        await oldFunction(code, 'restartSession')(key)
        await restartSession(key, deps('react'))
        expect(said.react).toEqual(said.old)
        expect(asked.react).toEqual(asked.old)
      }
  })

  test('a MokuPilot call says it started, or why not, as upstream’s callMokuPilot', async () => {
    for (const reply of [{ ok: true }, { ok: false, error: 'MokuPilot not found (meet)' }] as ActResult[])
      for (const key of ['s1', 'gone']) {
        const said: { old: unknown[]; react: unknown[] } = { old: [], react: [] }
        const asked: { old: unknown[]; react: unknown[] } = { old: [], react: [] }
        const deps = (side: 'old' | 'react') => ({
          t,
          itemOf: (k: string) => (k === 's1' ? session : undefined),
          act: async (k: string, action: string) => {
            asked[side].push([k, action])
            return reply
          },
          toast: (text: string, error = false) => void said[side].push([text, error]),
        })
        const code = oldCode('web/app.js', ['callMokuPilot'], deps('old'), '75e9c61')
        await oldFunction(code, 'callMokuPilot')(key)
        await callMokuPilot(key, deps('react'))
        expect(said.react).toEqual(said.old)
        expect(asked.react).toEqual(asked.old)
      }
  })

  test('“Call in MokuPilot” first, before the tools; gray without the board, picked it is the button’s own click', async () => {
    rowShows = new Set(NARROW_ROW)
    const term = world.document.createElement('button')
    term.id = 'sheet-term'
    term.textContent = ` ${t('term.open')} `
    const call = world.document.createElement('button')
    call.id = 'sheet-mokupilot'
    call.title = t('mokupilot.hint')
    call.textContent = ` ${t('mokupilot.call')} `
    page('sheet-focus').after(term)
    term.after(call)
    const clicked: string[] = []
    call.addEventListener('click', () => clicked.push('mokupilot'))
    for (const disabled of [false, true]) {
      call.disabled = disabled
      const [oldLog, newLog]: [string[], string[]] = [[], []]
      const [a, b] = [oldMore(false, false, oldLog), newMore(false, false, newLog)]
      a.click(page('sheet-more'), 1)
      b.click(page('sheet-more'), 1)
      expect(shown(b.opened())).toEqual(shown(a.opened()))
      expect(b.opened()?.items.map(it => (it.separator ? '—' : it.id))).toEqual([
        'sheet-mokupilot',
        'sheet-term',
        'sheet-changes',
        'sheet-history',
        '—',
        'sheet-new',
        '—',
        'sheet-sleep',
      ])
      expect(b.opened()?.items[0]).toMatchObject({ id: 'sheet-mokupilot', label: 'Call in MokuPilot', disabled })
      pickIn(a.opened(), 'sheet-mokupilot')
      pickIn(b.opened(), 'sheet-mokupilot')
      await world.flush()
      expect(newLog).toEqual(oldLog)
    }
    // Picked while it could: the button's own click, on each side.
    expect(clicked).toEqual(['mokupilot', 'mokupilot'])
  })
})
