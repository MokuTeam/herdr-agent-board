// Which menu opens for a card, the open session's head, a lane, the board, a starting session and
// a file chip, and where the browser keeps its own (models/board-menus.ts, hooks/useContextMenus.ts),
// against the old page's board-menus.js at the parity baseline (with upstream's Terminal item,
// support/board-menu-sides.ts): the same right clicks, menu keys
// and long presses on the same page (support/board-menu-sides.ts) must open the same menus at the
// same places, and their picks must ask the board for the same things.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { LaunchView } from '../../src/core/types.ts'
import {
  type BoardMenuDeps,
  isMenuKey,
  keepsNativeMenu,
  keyPoint,
  menuFor,
  pointRect,
  pressOpensMenu,
  typingIn,
} from '../../web/src/models/board-menus.ts'
import { wantsNativeMenu } from '../../web/src/models/menu-model.ts'
import { item } from './support/board.tsx'
import { type BoardScene, type MenuSide, oldBoardMenus, reactBoardMenus, scene } from './support/board-menu-sides.ts'
import type { EventFields } from './support/fake-dom.ts'
import { FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { asDom } from './support/react-commit.ts'

type Step = (side: MenuSide) => Promise<unknown> | unknown

async function run(make: () => MenuSide, steps: Step[]): Promise<string[]> {
  const side = make()
  try {
    for (const step of steps) await step(side)
    return side.log
  } finally {
    await side.dispose()
  }
}

/** Both sides note the same; returns the baseline's notes. */
async function compare(s: BoardScene, steps: Step[]): Promise<string[]> {
  const baseline = await run(() => oldBoardMenus(s), steps)
  const react = await run(() => reactBoardMenus(s), steps)
  expect(react.join('\n')).toBe(baseline.join('\n'))
  return baseline
}

const t = translator('en')
// In no herdr workspace herdr names: the old page had no Rename workspace (the board's own, below).
const session = item({
  key: 's1',
  name: 'acme',
  autoName: 'acme-api',
  cwd: 'C:\\Acme',
  pane: 'w1:p1',
  workspace: null,
  category: 'acme',
  column: 'me',
  attention: 'question',
  agent: 'claude',
})
const launch = (fields: Partial<LaunchView> = {}): LaunchView => ({
  id: 'L1',
  name: 'new-api',
  cwd: '/srv/new',
  category: 'acme',
  workspace: 'ws',
  workspaceId: null,
  state: 'failed',
  step: 'agent',
  error: 'launcher exited 1',
  kind: 'launcher',
  pane: 'w1:p9',
  key: null,
  startedAt: 1,
  doneAt: null,
  message: '',
  worktree: null,
  newWorkspace: false,
  ...fields,
})
const BOARD = scene({ items: [session], launches: [launch()], open: 's1', columns: { s1: 'done' } })

const right =
  (id: string, fields: EventFields = {}): Step =>
  s =>
    s.fire(s.page(id), 'contextmenu', { button: 2, clientX: 210, clientY: 330, ...fields })
const focus =
  (id: string): Step =>
  s =>
    s.page(id).focus()
const keyDown =
  (key: string, fields: EventFields = {}): Step =>
  s =>
    s.fire(s.world.document.activeElement ?? 'window', 'keydown', { key, ...fields })
const pick =
  (id: string): Step =>
  s =>
    s.pick(id)
const tick =
  (ms: number): Step =>
  s =>
    s.world.tick(ms)
const touch =
  (type: string, id: string, fields: EventFields = {}): Step =>
  s =>
    s.fire(s.page(id), type, { pointerType: 'touch', pointerId: 7, clientX: 120, clientY: 340, ...fields })

/** The menu a step opened: its first line's items, or none. */
const menus = (log: string[]) => log.filter(line => line.startsWith('menu '))

describe('which menu opens', () => {
  test('a card’s, at the click, named after it; its picks', async () => {
    const steps: Step[] = [right('card-name')]
    for (const id of [
      'open',
      'focus',
      'terminal',
      'write',
      'sleep',
      'rename',
      'dismiss',
      'reveal',
      'changes',
      'history',
      'newHere',
      'clear',
    ])
      steps.push(pick(id))
    for (const id of ['cat:other', 'col:ext', 'col:me', 'copy:name', 'copy:cwd', 'copy:session', 'copy:pane'])
      steps.push(pick(id))
    const log = await compare(BOARD, steps)
    expect(log[0]).toStartWith('menu {"x":210,"y":330,"source":"mouse","label":"acme"} ["open","focus"')
    expect(log[1]).toBe('contextmenu prevented')
    expect(log).toContain('do.rename("s1", #card-name)')
    expect(log).toContain('do.move("s1", {"cat":"other"})')
    expect(log).toContain('do.openPath("C:\\\\Acme", "open")')
    expect(log).toContain('do.copy("w1:p1", "Copied")')
    expect(log).toContain('do.newSession({}+item s1, #card)')
    expect(log).toContain('do.terminal("s1", #card)')
    expect(log[0]).toContain('"open","focus","terminal","write"')
    // Where the board offers no terminal (config `terminal: false`), no such item.
    const off = await compare({ ...BOARD, terminal: false }, [right('card-name')])
    expect(off[0]).toContain('"open","focus","write"')
  })

  test('with MokuPilot here a Claude session’s card calls it in; it needs the board, not fresh herdr data', async () => {
    const on = await compare({ ...BOARD, mokupilot: true }, [right('card-name'), pick('mokupilot')])
    expect(on[0]).toContain('"open","focus","terminal","mokupilot","write"')
    expect(on).toContain('do.mokupilot("s1", #card)')
    const stale = await compare({ ...BOARD, mokupilot: true, canMutate: false }, [right('card-name')])
    expect(stale[0]).toContain('"mokupilot","write')
    const away = await compare({ ...BOARD, mokupilot: true, canMutate: false, canEdit: false }, [right('card-name')])
    expect(away[0]).toContain('"mokupilot (gray)"')
    const codex = await compare({ ...BOARD, mokupilot: true, items: [{ ...session, agent: 'codex' }] }, [
      right('card-name'),
    ])
    expect(codex[0]).not.toContain('mokupilot')
  })

  test('a Claude session’s card restarts it (#51); gray while one is on its way, not for one that gave up, nor with stale data', async () => {
    const on = await compare(BOARD, [right('card-name'), pick('restart')])
    expect(on[0]).toContain('"sleep","restart","rename"')
    expect(on).toContain('do.restart("s1", #card)')
    const restart = { id: 'r1', key: 's1', kind: 'restart', text: '', next: 1 }
    const pending = await compare({ ...BOARD, schedules: [restart] }, [right('card-name')])
    expect(pending[0]).toContain('"restart (gray)"')
    const failed = await compare({ ...BOARD, schedules: [{ ...restart, failed: 'herdr-wake is down' }] }, [
      right('card-name'),
    ])
    expect(failed[0]).toContain('"sleep","restart","rename"')
    const other = await compare({ ...BOARD, schedules: [{ ...restart, key: 's2' }] }, [right('card-name')])
    expect(other[0]).toContain('"sleep","restart","rename"')
    const stale = await compare({ ...BOARD, canMutate: false }, [right('card-name')])
    expect(stale[0]).toContain('"restart (gray)"')
    const codex = await compare({ ...BOARD, items: [{ ...session, agent: 'codex' }] }, [right('card-name')])
    expect(codex[0]).not.toContain('restart')
  })

  test('the open session’s head: its card’s menu; none without one open, nor in the rest of a panel', async () => {
    const log = await compare(BOARD, [
      right('sheet-meta'),
      pick('rename'),
      pick('open'),
      right('sheet-text'),
      right('cats-text'),
    ])
    expect(log[0]).toContain('"label":"acme"')
    expect(log).toContain('do.rename("s1", #sheet-name)')
    expect(log).toContain('do.open("s1", #sheet-name)')
    expect(log.slice(-2)).toEqual(['contextmenu', 'contextmenu'])
    const closed = await compare({ ...BOARD, open: null }, [right('sheet-meta')])
    expect(closed).toEqual(['contextmenu'])
    const gone = await compare({ ...BOARD, open: 'gone' }, [right('sheet-meta')])
    expect(gone).toEqual(['contextmenu'])
  })

  test('the card’s fields in the head keep the browser’s menu, as they did under it (React only: the old page had them under the head)', async () => {
    expect(await run(() => reactBoardMenus(BOARD), [right('sheet-card-text')])).toEqual(['contextmenu'])
    expect((await run(() => reactBoardMenus(BOARD), [right('sheet-meta')]))[0]).toContain('"label":"acme"')
  })

  test('a file chip’s (on a card, in the sheet, even in the quick look): the quick look, open, show, copy, a session there', async () => {
    const log = await compare(BOARD, [
      right('chip'),
      pick('look'),
      pick('open'),
      pick('reveal'),
      pick('copyPath'),
      right('dir-chip'),
      pick('newHere'),
      pick('copyPath'),
      right('sheet-chip'),
      right('ql-chip'),
    ])
    expect(log[0]).toContain('"label":"C:\\\\Acme\\\\README.md"')
    expect(log).toContain('do.look({"path":"C:\\\\Acme\\\\README.md","line":12}, #chip)')
    expect(log).toContain('do.copy("C:\\\\Acme\\\\README.md:12", "Path copied")')
    expect(log).toContain('do.newSession({"cwd":"/srv/app"}, #dir-chip)')
    expect(menus(log)).toHaveLength(4)
  })

  test('a lane’s and the board’s, at the point; the filter and sleepers in them', async () => {
    const steps: Step[] = [right('lane-head')]
    for (const id of ['new', 'newWorkspace', 'editCat', 'showOnly']) steps.push(pick(id))
    steps.push(right('board-empty'))
    for (const id of ['new', 'newWorkspace', 'cats', 'sleepers', 'search']) steps.push(pick(id))
    steps.push(right('unknown-grid'), right('tb-button'))
    const log = await compare(BOARD, steps)
    expect(log[0]).toContain('"label":"Acme"')
    expect(log).toContain(
      'do.newSession({"category":"acme","newWorkspace":true}, {"left":198,"top":318,"right":222,"bottom":342,"width":24,"height":24})',
    )
    expect(log).toContain('do.cats("acme")')
    expect(menus(log)).toHaveLength(4)
    const filtered = await compare({ ...BOARD, filter: 'acme', sleepers: false }, [
      right('lane-head'),
      pick('showAll'),
      right('board-empty'),
      pick('showAll'),
    ])
    expect(filtered.filter(line => line === 'do.filter("all")')).toHaveLength(2)
  })

  test('a starting or failed session’s; none for one that is gone or a card not on the board', async () => {
    const log = await compare(BOARD, [
      right('launch-name'),
      ...['focus', 'retry', 'copyError', 'copy:cwd', 'dismiss'].map(pick),
      right('launch-gone'),
      right('card-gone'),
    ])
    expect(log[0]).toContain('"label":"new-api"')
    expect(log).toContain('do.focusLaunch("L1")')
    expect(log).toContain('launch.retry(L1, #launch-card)')
    expect(log).toContain('do.copy("launcher exited 1", "Copied")')
    expect(log.slice(-2)).toEqual(['contextmenu', 'contextmenu'])
    expect(menus(log)).toHaveLength(1)
    const trust = await compare({ ...BOARD, launches: [launch({ state: 'trust', step: 'trust' })] }, [
      right('launch-name'),
      pick('trust'),
      pick('closeTab'),
    ])
    expect(trust).toContain('launch.trust("L1")')
    expect(trust).toContain('launch.closeTab("L1")')
  })

  test('stale or offline: the same menus, gray where they must be', async () => {
    await compare({ ...BOARD, canMutate: false }, [
      right('card-name'),
      right('lane-head'),
      right('board-empty'),
      right('launch-name'),
      right('dir-chip'),
    ])
    await compare({ ...BOARD, canMutate: false, canEdit: false }, [right('card-name'), right('chip')])
    await compare({ ...BOARD, t: translator('ru') }, [right('card-name'), right('board-empty')])
  })
})

describe('the browser’s own menu', () => {
  test('with Shift, in fields, on links (a file chip is none) and on selected text', async () => {
    const log = await compare(BOARD, [
      right('card-name', { shiftKey: true }),
      right('search'),
      right('message'),
      right('select'),
      right('editable'),
      right('editable-empty'),
      right('link'),
      right('not-editable'),
      right('chip'),
    ])
    expect(log.slice(0, 7)).toEqual(Array(7).fill('contextmenu'))
    expect(menus(log)).toHaveLength(2)
    const selected = await compare(BOARD, [
      s => {
        s.world.selection = {
          isCollapsed: false,
          rangeCount: 1,
          getRangeAt: () => ({ intersectsNode: node => node === s.page('card-what') }),
          removeAllRanges() {},
        }
      },
      right('card-what'),
      right('card-name'),
    ])
    expect(selected[0]).toBe('contextmenu')
    expect(menus(selected)).toHaveLength(1)
  })

  test('wantsNativeMenu and keepsNativeMenu', () => {
    expect(wantsNativeMenu({})).toBe(false)
    for (const k of ['shift', 'editable', 'inSelection', 'link']) expect(wantsNativeMenu({ [k]: true })).toBe(true)
    const world = new FakeWorld({ viewport: { w: 100, h: 100 } })
    world.install()
    try {
      for (const node of parseHtml(
        '<div><input id="i"><a href="x" id="a">a</a><a href="#" data-fs="file" id="c">c</a><p id="p">p</p></div>',
      ))
        if (node.kind === 'element') world.mount(node)
      const el = (id: string) => {
        const found = world.document.querySelector(`#${id}`)
        return found ? asDom(found) : null
      }
      const native = (id: string, shift = false, inSelection = false) => keepsNativeMenu(el(id), { shift, inSelection })
      expect([native('i'), native('a'), native('c'), native('p'), native('p', true), native('p', false, true)]).toEqual(
        [true, true, false, false, true, true],
      )
      expect(keepsNativeMenu(null, { shift: false, inSelection: false })).toBe(false)
      expect([typingIn(el('i')), typingIn(el('p')), typingIn(null)]).toEqual([true, false, false])
      expect(pressOpensMenu(asDom(world.document.body))).toBe(false)
    } finally {
      world.uninstall()
    }
  })
})

describe('the menu key and Shift+F10', () => {
  test('the menu of what has the focus, under it; the board’s at its corner when nothing has it', async () => {
    const log = await compare(BOARD, [
      focus('card'),
      keyDown('ContextMenu'),
      // The browser's own contextmenu that follows the key (button -1) does not open another.
      s => s.fire(s.page('card'), 'contextmenu', { button: -1 }),
      tick(1600),
      s => s.fire(s.page('card'), 'contextmenu', { button: -1, clientX: 5, clientY: 5 }),
      focus('sheet-chip'),
      keyDown('F10', { shiftKey: true }),
      keyDown('F10'),
      focus('message'),
      keyDown('ContextMenu'),
      s => {
        s.world.document.activeElement = s.world.document.body
      },
      keyDown('ContextMenu'),
    ])
    expect(log[0]).toStartWith('menu {"x":64,"y":330,"source":"keyboard","label":"acme"} ["open"')
    expect(log[1]).toBe('keydown prevented')
    expect(log[2]).toBe('contextmenu prevented')
    expect(menus(log).map(line => line.split(' [')[0])).toEqual([
      'menu {"x":64,"y":330,"source":"keyboard","label":"acme"}',
      'menu {"x":5,"y":5,"source":"mouse","label":"acme"}',
      'menu {"x":915,"y":412,"source":"keyboard","label":"/srv/app/a.ts"}',
      'menu {"x":24,"y":128,"source":"keyboard"}',
    ])
  })

  test('isMenuKey and keyPoint', () => {
    expect([
      isMenuKey({ key: 'ContextMenu', shiftKey: false }),
      isMenuKey({ key: 'F10', shiftKey: true }),
      isMenuKey({ key: 'F10', shiftKey: false }),
    ]).toEqual([true, true, false])
    expect(keyPoint({ left: 10, top: 20, width: 30, height: 20 }, true)).toEqual({ x: 25, y: 36 })
    expect(keyPoint({ left: 10, top: 20, width: 300, height: 200 }, true)).toEqual({ x: 34, y: 50 })
    expect(keyPoint({ left: 10, top: 20, width: 300, height: 200 }, false)).toEqual({ x: 34, y: 28 })
    expect(pointRect(100, 50)).toEqual({ left: 88, top: 38, right: 112, bottom: 62, width: 24, height: 24 })
  })
})

describe('a long press', () => {
  test('opens the menu where the finger is; the browser’s menu and the tap that follow do nothing', async () => {
    const log = await compare(BOARD, [
      touch('pointerdown', 'card-name'),
      touch('pointermove', 'card-name', { clientX: 125, clientY: 344 }),
      tick(500),
      touch('contextmenu', 'card-name'),
      s => s.fire(s.page('card-name'), 'click'),
      tick(1000),
      s => s.fire(s.page('card-name'), 'click'),
      tick(1000),
      touch('contextmenu', 'card-name'),
    ])
    expect(menus(log)).toEqual([expect.stringContaining('"x":120,"y":340,"source":"touch","label":"acme"')])
    expect(log).toContain('click prevented stopped')
    expect(log.at(-1)).toBe('contextmenu')
  })

  test('not when the finger moved, lifted, scrolled, or is on a button, the toolbar, a panel; nor for a mouse or a second finger', async () => {
    const log = await compare(BOARD, [
      touch('pointerdown', 'card-name'),
      touch('pointermove', 'card-name', { clientX: 140, clientY: 340 }),
      tick(500),
      touch('pointerdown', 'card-name'),
      touch('pointerup', 'card-name'),
      tick(500),
      touch('pointerdown', 'lane-head'),
      s => s.fire(s.page('lane-head'), 'scroll'),
      tick(500),
      touch('pointerdown', 'card-write'),
      tick(500),
      touch('pointerdown', 'tb-button'),
      tick(500),
      touch('pointerdown', 'sheet-text'),
      tick(500),
      touch('pointerdown', 'card-name', { pointerType: 'mouse' }),
      tick(500),
      touch('pointerdown', 'card-name', { isPrimary: false }),
      tick(500),
      touch('pointerdown', 'card-name'),
      touch('pointerup', 'card-name', { pointerId: 8 }),
      tick(500),
    ])
    expect(menus(log)).toHaveLength(1)
  })
})

describe('without the launch window', () => {
  test('a starting session’s card has no menu', () => {
    const world = new FakeWorld({ viewport: { w: 100, h: 100 } })
    world.install()
    try {
      for (const node of parseHtml('<article class="card" data-key="launch:L1"><span id="x">x</span></article>'))
        if (node.kind === 'element') world.mount(node)
      const none = () => undefined
      const deps: BoardMenuDeps = {
        t: () => t,
        canMutate: () => true,
        canEdit: () => true,
        item: none,
        column: () => 'idle',
        category: () => 'acme',
        state: () => ({ open: null, filter: 'all', sleepers: true, data: { categories: [] } }),
        launch: null,
        tidyCount: () => 0,
        do: {
          open: none,
          focus: none,
          write: none,
          wake: none,
          sleep: none,
          favorite: none,
          restart: none,
          dismiss: none,
          clear: none,
          changes: none,
          history: none,
          terminal: none,
          mokupilot: none,
          fork: none,
          archive: none,
          tidy: none,
          archiveOpen: none,
          rename: none,
          renameWorkspace: none,
          move: none,
          newSession: none,
          cats: none,
          filter: none,
          sleepers: none,
          search: none,
          copy: none,
          openPath: none,
          look: none,
          focusLaunch: none,
        },
      }
      expect(menuFor(world.document.querySelector('#x'), { x: 0, y: 0 }, deps)).toBeNull()
    } finally {
      world.uninstall()
    }
  })
})

describe('favorites (the React board’s own, #64)', () => {
  test('a card’s Favorites item goes to the board’s favorite action, from the card and from the sheet’s head', async () => {
    const log = await run(
      () => reactBoardMenus(BOARD),
      [right('card-name'), pick('favorite'), right('sheet-meta'), pick('favorite')],
    )
    expect(log.filter(l => l.startsWith('do.favorite'))).toEqual([
      'do.favorite("s1", #card)',
      'do.favorite("s1", #sheet-name)',
    ])
  })
})

describe('renaming a session’s workspace (the React board’s own)', () => {
  const react = (s: BoardScene, steps: Step[]) => run(() => reactBoardMenus(s), steps)
  const inWorkspace = { ...BOARD, items: [{ ...session, workspace: 'Sessions' }] }

  test('a card in a workspace offers it by Rename; from the card it renames in the sheet’s head, from the head right there', async () => {
    const log = await react(inWorkspace, [
      right('card-name'),
      pick('renameWorkspace'),
      right('sheet-meta'),
      pick('renameWorkspace'),
    ])
    expect(log[0]).toContain('"restart","rename","renameWorkspace","—","category')
    expect(log).toContain('do.renameWorkspace("s1", null)')
    expect(log).toContain('do.renameWorkspace("s1", #sheet-workspace)')
  })

  test('gray without fresh herdr data; none for a session in no workspace', async () => {
    const stale = await react({ ...inWorkspace, canMutate: false }, [right('card-name')])
    expect(stale[0]).toContain('"renameWorkspace (gray)"')
    const none = await react(BOARD, [right('card-name')])
    expect(none[0]).not.toContain('renameWorkspace')
  })
})
