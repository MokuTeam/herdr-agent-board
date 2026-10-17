// Which menu opens where, both ways in a fake DOM (support/fake-dom.ts), for parity: the old page's
// board-menus.js (initBoardMenus as it was at the terminal's merge — the parity baseline and
// upstream PR #36's terminal item, nothing else — with its own menu-model.js) and
// the React board's listeners (hooks/useContextMenus.ts boardMenuListeners with
// models/board-menus.ts menuFor). Each side gets the same page, the same
// board (what the page knows and its actions, which note what they were asked to do) and a menu
// that notes what it was asked to open; picks go through the onPick the menu was handed.
import { translator } from '../../../src/core/i18n/translator.ts'
import type { Item, LaunchView, Translator } from '../../../src/core/types.ts'
import type { MenuOpen } from '../../../web/src/components/menu/menu-engine.ts'
import { boardMenuListeners } from '../../../web/src/hooks/useContextMenus.ts'
import { type BoardMenuDeps, menuFor } from '../../../web/src/models/board-menus.ts'
import type { MenuEntry } from '../../../web/src/models/menu-model.ts'
import { box, type EventFields, type FakeElement, FakeWorld, type RectBox } from './fake-dom.ts'
import { parseHtml } from './markup.ts'
import { oldCode, oldFunction } from './old-app.ts'

// ---------------------------------------------------------------- the page

export const PAGE = `<div id="page">
<div class="toolbar"><button id="tb-button">Categories</button><input id="search" type="search"></div>
<main class="board" id="board">
  <section class="lane" data-cat="acme" id="lane-acme">
    <div class="lane-bar"><header class="lane-head" id="lane-head"><span class="lane-tag">Acme</span></header><button class="lane-new" id="lane-new">+</button></div>
    <div class="lane-grid"><div class="col" data-col="idle" id="col-idle">
      <article class="card" data-key="s1" tabindex="0" id="card"><div class="card-top"><span class="name" id="card-name">acme</span></div>
        <div class="what" id="card-what">fix <a href="https://example.com" id="link">the docs</a> in <a data-fs="file" data-abs="C:\\Acme\\README.md" data-line="12" href="#" id="chip">README.md</a> and <span data-fs="dir" data-abs="/srv/app" id="dir-chip">app</span></div>
        <div class="card-actions"><button data-act="write" id="card-write">w</button></div>
      </article>
      <article class="card launch-card" data-key="launch:L1" tabindex="0" id="launch-card"><span id="launch-name">starting</span></article>
      <article class="card launch-card" data-key="launch:L9" tabindex="0" id="launch-gone"><span>gone</span></article>
      <article class="card" data-key="gone" tabindex="0" id="card-gone"><span class="name">gone</span></article>
    </div></div>
  </section>
  <section class="lane" data-cat="unknown" id="lane-unknown"><div class="lane-grid" id="unknown-grid"></div></section>
  <p class="empty" id="board-empty">No sessions</p>
</main>
</div>
<aside class="sheet" id="sheet"><div class="sheet-inner"><header class="sheet-head" id="sheet-head"><div class="sheet-title"><h2 id="sheet-name" tabindex="0">acme</h2><p class="sheet-meta" id="sheet-meta">Acme</p></div></header><div class="sheet-body" id="sheet-body"><p id="sheet-text">thread</p><span data-fs="file" data-abs="/srv/app/a.ts" tabindex="0" id="sheet-chip">a.ts</span><textarea id="message"></textarea></div></div></aside>
<aside class="sheet" id="cats-sheet"><p id="cats-text">lanes</p></aside>
<div class="ql"><p id="ql-text">preview</p><a data-fs="dir" data-abs="/srv" href="#" id="ql-chip">srv</a></div>
<div class="launch"><p id="launch-text">new session</p></div>
<div class="limits-pop"><p id="limits-text">usage</p></div>
<div class="rename"><p id="rename-text">rename</p></div>
<div class="menu"><p id="menu-text">menu</p></div>
<div contenteditable="true" id="editable">notes</div>
<div contenteditable="" id="editable-empty">notes</div>
<div contenteditable="false" id="not-editable">notes</div>
<select id="select"><option>a</option></select>`

function rects(el: FakeElement): RectBox | null {
  if (el.id === 'board') return box(0, 120, 1200, 700)
  if (el.id === 'card') return box(40, 300, 260, 120)
  if (el.id === 'sheet-chip') return box(900, 400, 30, 16)
  if (el.id === 'lane-new') return box(300, 130, 20, 20)
  return null
}

// ---------------------------------------------------------------- the board

/** Upstream's merge of the terminal (PR #36): board-menus.js and menu-model.js are the baseline's and its item. */
const TERMINAL_MERGE = '1a1b270'

const categories = [
  { id: 'acme', title: 'Acme', color: '#007AFF' },
  { id: 'other', title: 'Other', color: '#8E8E93' },
]

export interface BoardScene {
  items: Item[]
  launches: LaunchView[]
  canMutate: boolean
  canEdit: boolean
  open: string | null
  filter: string
  sleepers: boolean
  t: Translator
  /** The page's own moves: key -> the column it shows in. */
  columns: Record<string, string>
  /** The payload's `terminal` (config `terminal`); missing, the board offers one. */
  terminal?: boolean
}

export function scene(fields: Partial<BoardScene> = {}): BoardScene {
  return {
    items: [],
    launches: [],
    canMutate: true,
    canEdit: true,
    open: null,
    filter: 'all',
    sleepers: true,
    t: translator('en'),
    columns: {},
    ...fields,
  }
}

const describeValue = (value: unknown): string => {
  if (typeof value === 'object' && value !== null && 'node' in value && 'world' in value && 'id' in value)
    return `#${String(value.id) || '?'}`
  if (typeof value === 'object' && value !== null && 'key' in value && 'name' in value)
    return `item ${String(value.key)}`
  if (typeof value === 'object' && value !== null && 'item' in value) {
    const { item, ...rest } = value
    return `${JSON.stringify(rest)}+${describeValue(item)}`
  }
  if (typeof value === 'object' && value !== null && 'launch' in value) return 'launch'
  return JSON.stringify(value) ?? 'undefined'
}

/** The old page's `board`: what it knows, and actions that note what they were asked to do. */
function boardOf(s: BoardScene, log: string[], menu: unknown): BoardMenuDeps & { menu: unknown } {
  const note =
    (name: string) =>
    (...args: unknown[]) =>
      void log.push(`${name}(${args.map(describeValue).join(', ')})`)
  const doActions: BoardMenuDeps['do'] = {
    open: note('do.open'),
    focus: note('do.focus'),
    write: note('do.write'),
    wake: note('do.wake'),
    sleep: note('do.sleep'),
    dismiss: note('do.dismiss'),
    clear: note('do.clear'),
    changes: note('do.changes'),
    history: note('do.history'),
    terminal: note('do.terminal'),
    rename: note('do.rename'),
    move: note('do.move'),
    newSession: note('do.newSession'),
    cats: note('do.cats'),
    filter: note('do.filter'),
    sleepers: note('do.sleepers'),
    search: note('do.search'),
    copy: note('do.copy'),
    openPath: note('do.openPath'),
    look: note('do.look'),
    focusLaunch: note('do.focusLaunch'),
  }
  return {
    menu,
    t: () => s.t,
    canMutate: () => s.canMutate,
    canEdit: () => s.canEdit,
    item: key => s.items.find(i => i.key === key),
    column: it => s.columns[it.key] ?? it.column,
    category: it => it.category,
    state: () => ({
      open: s.open,
      filter: s.filter,
      sleepers: s.sleepers,
      data: { categories, ...(s.terminal !== undefined && { terminal: s.terminal }) },
    }),
    launch: {
      placeholders: () => s.launches.map(launch => ({ launch })),
      trust: note('launch.trust'),
      closeTab: note('launch.closeTab'),
      retry: (l: LaunchView, el: Element) => void log.push(`launch.retry(${l.id}, ${describeValue(el)})`),
      dismiss: note('launch.dismiss'),
    },
    do: doActions,
  }
}

// ---------------------------------------------------------------- the sides

export interface Opened {
  items: MenuEntry[]
  options: MenuOpen
}

export interface MenuSide {
  world: FakeWorld
  page(id: string): FakeElement
  log: string[]
  /** The last menu opened. */
  opened: Opened | null
  fire(target: FakeElement | 'window' | 'document', type: string, fields?: EventFields): Promise<void>
  pick(id: string): void
  dispose(): Promise<void>
}

function newWorld(): FakeWorld {
  const world = new FakeWorld({ viewport: { w: 1280, h: 900 }, rects })
  world.install()
  for (const node of parseHtml(PAGE)) if (node.kind === 'element') world.mount(node)
  return world
}

const ids = (items: readonly MenuEntry[]): unknown =>
  items.map(it =>
    it.separator
      ? '—'
      : `${it.id}${it.disabled ? ' (gray)' : ''}${it.submenu ? ` [${(ids(it.submenu) as string[]).join(' ')}]` : ''}`,
  )

function side(world: FakeWorld, log: string[], recorder: { opened: Opened | null }): MenuSide {
  const page = (id: string) => {
    const el = world.document.documentElement.querySelector(`#${id}`)
    if (!el) throw new Error(`no #${id}`)
    return el
  }
  return {
    world,
    page,
    log,
    get opened() {
      return recorder.opened
    },
    async fire(target, type, fields = {}) {
      const at = target === 'window' ? world.window : target === 'document' ? world.document : target
      const e = await world.fire(at, type, fields)
      log.push(`${type}${e.defaultPrevented ? ' prevented' : ''}${e.immediateStopped ? ' stopped' : ''}`)
    },
    pick(id) {
      const item = recorder.opened?.items.find(it => !it.separator && it.id === id)
      if (item && !item.separator) recorder.opened?.options.onPick?.(id, item)
      else recorder.opened?.options.onPick?.(id, { id, label: id })
    },
    async dispose() {
      try {
        await world.settle()
      } finally {
        world.uninstall()
      }
    },
  }
}

/** A menu that notes what it opens; it is never open itself (the listeners only open it). */
function recordingMenu(log: string[]) {
  const recorder: { opened: Opened | null } = { opened: null }
  const menu = {
    open(items: readonly MenuEntry[], options: MenuOpen) {
      recorder.opened = { items: [...items], options }
      const { x, y, source, label } = options
      log.push(`menu ${JSON.stringify({ x, y, source, label })} ${JSON.stringify(ids(items))}`)
    },
    isOpen: () => false,
  }
  return { recorder, menu }
}

/** web/menu-model.js at the terminal's merge: what board-menus.js imported from it. */
function baselineModel(): Record<string, unknown> {
  const names = [
    'usable',
    'tidy',
    'SEP',
    'PIN_COLUMNS',
    'COLUMN_COLOR',
    'cardMenu',
    'laneMenu',
    'boardMenu',
    'launchMenu',
    'chipMenu',
    'wantsNativeMenu',
  ]
  return Object.fromEntries(oldCode('web/menu-model.js', names, {}, TERMINAL_MERGE))
}

/** initBoardMenus of web/board-menus.js as it was at the terminal's merge. */
export function oldBoardMenus(s: BoardScene): MenuSide {
  const world = newWorld()
  const log: string[] = []
  const { recorder, menu } = recordingMenu(log)
  const code = oldCode(
    'web/board-menus.js',
    ['LONG_PRESS_MS', 'SLOP', 'initBoardMenus'],
    { ...baselineModel(), performance: { now: () => world.now } },
    TERMINAL_MERGE,
  )
  oldFunction(code, 'initBoardMenus')(boardOf(s, log, menu))
  return side(world, log, recorder)
}

/** The React board's listeners, with menuFor and the same board. */
export function reactBoardMenus(s: BoardScene): MenuSide {
  const world = newWorld()
  const log: string[] = []
  const { recorder, menu } = recordingMenu(log)
  const board = boardOf(s, log, menu)
  boardMenuListeners({
    menu,
    menuFor: (target, at) => menuFor(target, at, board),
    now: () => world.now,
  })
  return side(world, log, recorder)
}
