// Which menu a right click, a long press or the menu key opens on the board, and what its items
// do. Cards, lanes, the board's empty space, the open session's head, starting sessions and
// file chips get the board's own menu; fields, selected text and links keep the browser's, and
// Shift+right click always gives the browser's (copy, paste, the inspector).
//
// The pure part of the old page's board-menus.js: what is under the pointer
// or the focus and the menu for it, with the board handed in. The listeners that open it are the
// page's (hooks/useContextMenus.ts).
import type { Item, LaunchView, Translator } from '../../../src/core/types.ts'
import {
  boardMenu,
  cardMenu,
  chipMenu,
  laneMenu,
  launchMenu,
  type MenuCategory,
  type MenuContext,
  type MenuEntry,
  type MenuItem,
  type Point,
  wantsNativeMenu,
} from './menu-model.ts'

export const LONG_PRESS_MS = 480
export const SLOP = 9 // px a finger may wander before a long press becomes a scroll

/** A rectangle around a point, for what grows out of a place that is no element (a lane, the board). */
export interface PointRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** What a dialog opened from a menu grows out of: the card, else where the menu was opened. */
export type MenuOrigin = Element | PointRect

export const pointRect = (x: number, y: number): PointRect => ({
  left: x - 12,
  top: y - 12,
  right: x + 12,
  bottom: y + 12,
  width: 24,
  height: 24,
})

/** Where a session started from a menu goes: a lane, a new workspace, by a session, in a folder. */
export interface MenuLaunchContext {
  category?: string
  newWorkspace?: boolean
  item?: Item
  cwd?: string
}

/** What the menus' items do (the old page's `board.do`). */
export interface BoardMenuActions {
  open(key: string, from: MenuOrigin): unknown
  focus(key: string, from: MenuOrigin): unknown
  write(key: string, from: MenuOrigin): unknown
  wake(key: string, from: MenuOrigin): unknown
  sleep(key: string, from: MenuOrigin): unknown
  dismiss(key: string, from: MenuOrigin): unknown
  clear(key: string, from: MenuOrigin): unknown
  changes(key: string, from: MenuOrigin): unknown
  history(key: string, from: MenuOrigin): unknown
  /** The terminal window of the session (hooks/useTerminal.ts). */
  terminal(key: string, from: MenuOrigin): unknown
  /** Rename where the name is (`name`: the card's name or the sheet's head). */
  rename(key: string, name: Element | null): unknown
  move(key: string, to: { cat?: string; column?: string }): unknown
  newSession(ctx: MenuLaunchContext, from: MenuOrigin): unknown
  /** The categories panel, at a lane. */
  cats(id?: string): unknown
  filter(id: string): unknown
  sleepers(): unknown
  search(): unknown
  copy(text: string | null | undefined, done: string): unknown
  openPath(path: string, how: 'open' | 'reveal'): unknown
  look(target: { path: string; line: number | null }, el: Element): unknown
  focusLaunch(id: string): unknown
}

/** The sessions on their way, and what their menu does that is the launch window's. */
export interface LaunchMenus {
  placeholders(): readonly { launch: LaunchView }[]
  trust(id: string): unknown
  closeTab(id: string): unknown
  retry(l: LaunchView, el: Element): unknown
  dismiss(id: string): unknown
}

/** What the page knows and can do (the old page's `board`, app.js). */
export interface BoardMenuDeps {
  t(): Translator
  canMutate(): boolean
  canEdit(): boolean
  item(key: string): Item | undefined
  /** The column a card shows in now (with the user's move). */
  column(it: Item): string
  /** The lane a card is in now (with the user's move). */
  category(it: Item): string
  state(): {
    open: string | null
    filter: string
    sleepers: boolean
    data: { categories: readonly MenuCategory[]; terminal?: boolean | undefined }
  }
  /** Sessions on their way (the launch window); none: their cards get no menu. */
  launch?: LaunchMenus | null | undefined
  do: BoardMenuActions
}

/** The menu to open: its items, its name for screen readers, and what a pick does. */
export interface BoardMenu {
  items: MenuEntry[]
  label?: string
  pick(id: string, item?: MenuItem): void
}

const isElement = (node: unknown): node is Element =>
  typeof node === 'object' && node !== null && 'closest' in node && typeof node.closest === 'function'

/** The element a target is, or the one a text node is in. */
export function elementOf(target: unknown): Element | null {
  if (isElement(target)) return target
  if (typeof target === 'object' && target !== null && 'parentElement' in target && isElement(target.parentElement))
    return target.parentElement
  return null
}

const ctxOf = (board: BoardMenuDeps): MenuContext => ({
  t: board.t(),
  canMutate: board.canMutate(),
  canEdit: board.canEdit(),
})

/** The menu for whatever is under `target`, or null when the browser's own should show. */
export function menuFor(target: unknown, at: Point, board: BoardMenuDeps): BoardMenu | null {
  const el = elementOf(target)
  if (!el) return null
  const t = board.t()
  const chip = el.closest<HTMLElement>('[data-fs="file"], [data-fs="dir"]')
  if (chip) {
    const path = chip.dataset.abs ?? ''
    return {
      items: chipMenu({ dir: chip.dataset.fs === 'dir' }, ctxOf(board)),
      label: path,
      pick: id => {
        if (id === 'look') board.do.look({ path, line: Number(chip.dataset.line) || null }, chip)
        else if (id === 'open' || id === 'reveal') board.do.openPath(path, id)
        else if (id === 'copyPath')
          board.do.copy(chip.dataset.line ? `${path}:${chip.dataset.line}` : path, t('ql.copied'))
        else if (id === 'newHere') board.do.newSession({ cwd: path }, chip)
      },
    }
  }
  if (el.closest('.ql, .launch, .limits-pop, .rename, .menu')) return null
  const head = el.closest('#sheet .sheet-head')
  if (head) {
    const key = board.state().open
    const it = key ? board.item(key) : undefined
    return key && it ? forCard(board, key, it, head.querySelector('#sheet-name') ?? head, at) : null
  }
  if (el.closest('.sheet')) return null
  const card = el.closest<HTMLElement>('.card[data-key]')
  if (card) {
    const key = card.dataset.key ?? ''
    if (key.startsWith('launch:')) return forLaunch(board, key.slice(7), card)
    const it = board.item(key)
    return it ? forCard(board, key, it, card, at) : null
  }
  const lane = el.closest<HTMLElement>('.lane[data-cat]')
  if (lane) {
    const cat = board.state().data.categories.find(c => c.id === lane.dataset.cat)
    if (cat) return forLane(board, cat, at)
  }
  return forBoard(board, at)
}

/** What a picked card item does by itself: the rest are `board.do` actions of the same name. */
const CARD_ACTIONS = [
  'open',
  'focus',
  'write',
  'wake',
  'sleep',
  'dismiss',
  'clear',
  'changes',
  'history',
  'terminal',
] as const
type CardAction = (typeof CARD_ACTIONS)[number]
const isCardAction = (id: string): id is CardAction => CARD_ACTIONS.some(a => a === id)

function forCard(board: BoardMenuDeps, key: string, it: Item, el: Element, at: Point): BoardMenu {
  const t = board.t()
  const state = board.state()
  const nameEl = el.matches?.('.card') ? el.querySelector('.name') : el
  return {
    label: it.name,
    items: cardMenu(it, {
      ...ctxOf(board),
      terminal: state.data.terminal !== false,
      categories: state.data.categories,
      column: board.column(it),
      category: board.category(it),
    }),
    pick: id => {
      const [what, arg = ''] = id.split(/:(.*)/s)
      const from: MenuOrigin = el.isConnected ? el : pointRect(at.x, at.y)
      if (what === 'cat') return void board.do.move(key, { cat: arg })
      if (what === 'col') return void board.do.move(key, { column: arg })
      if (what === 'copy') {
        const values: Record<string, string | null | undefined> = {
          name: it.name,
          cwd: it.cwd,
          session: it.session,
          pane: it.pane,
        }
        return void board.do.copy(values[arg], t('menu.copied'))
      }
      if (id === 'rename') return void board.do.rename(key, nameEl)
      if (id === 'reveal') return void board.do.openPath(it.cwd, 'open')
      if (id === 'newHere') return void board.do.newSession({ item: it }, from)
      if (isCardAction(id)) board.do[id](key, from)
    },
  }
}

function forLaunch(board: BoardMenuDeps, id: string, el: Element): BoardMenu | null {
  const t = board.t()
  const launch = board.launch
  const l = launch?.placeholders().find(x => x.launch.id === id)?.launch
  if (!launch || !l) return null
  return {
    label: l.name,
    items: launchMenu(l, ctxOf(board)),
    pick: what => {
      if (what === 'focus') board.do.focusLaunch(id)
      else if (what === 'trust') launch.trust(id)
      else if (what === 'closeTab') launch.closeTab(id)
      else if (what === 'retry') launch.retry(l, el)
      else if (what === 'copyError') board.do.copy(l.error, t('menu.copied'))
      else if (what === 'copy:cwd') board.do.copy(l.cwd, t('menu.copied'))
      else if (what === 'dismiss') launch.dismiss(id)
    },
  }
}

function forLane(board: BoardMenuDeps, cat: MenuCategory, at: Point): BoardMenu {
  const state = board.state()
  return {
    label: cat.title,
    items: laneMenu(cat, { ...ctxOf(board), filter: state.filter }),
    pick: id => {
      const from = pointRect(at.x, at.y)
      if (id === 'new') board.do.newSession({ category: cat.id }, from)
      else if (id === 'newWorkspace') board.do.newSession({ category: cat.id, newWorkspace: true }, from)
      else if (id === 'editCat') board.do.cats(cat.id)
      else if (id === 'showOnly') board.do.filter(cat.id)
      else if (id === 'showAll') board.do.filter('all')
    },
  }
}

function forBoard(board: BoardMenuDeps, at: Point): BoardMenu {
  const state = board.state()
  return {
    items: boardMenu({ ...ctxOf(board), filter: state.filter, sleepers: state.sleepers }),
    pick: id => {
      const from = pointRect(at.x, at.y)
      if (id === 'new') board.do.newSession({}, from)
      else if (id === 'newWorkspace') board.do.newSession({ newWorkspace: true }, from)
      else if (id === 'cats') board.do.cats()
      else if (id === 'sleepers') board.do.sleepers()
      else if (id === 'showAll') board.do.filter('all')
      else if (id === 'search') board.do.search()
    },
  }
}

/**
 * A right click here keeps the browser's menu: with Shift, in a field, on text the user selected
 * (`inSelection`), on a link (a file chip is no link here: it gets the board's).
 */
export function keepsNativeMenu(el: Element | null, { shift, inSelection }: { shift: boolean; inSelection: boolean }) {
  const editable = !!el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
  const link = !!el?.closest('a[href]:not([data-fs="file"]):not([data-fs="dir"])')
  return wantsNativeMenu({ shift, editable, inSelection, link })
}

/** The menu key, or Shift+F10. */
export const isMenuKey = (e: { key: string; shiftKey: boolean }): boolean =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)

/** The focus is in a field: the menu key is the field's. */
export const typingIn = (el: Element | null): boolean => !!el?.closest('input, textarea, select, [contenteditable]')

/** Where the menu key opens a menu: under the focused element, else at the board's corner. */
export function keyPoint(r: { left: number; top: number; width: number; height: number }, focused: boolean): Point {
  return focused
    ? { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(r.height - 4, 30) }
    : { x: r.left + 24, y: r.top + 8 }
}

/** The sheet's buttons that "More actions" lists on a phone, in their order. */
export const SHEET_MORE = [
  'sheet-term',
  'sheet-wake',
  'sheet-sleep',
  'sheet-changes',
  'sheet-history',
  'sheet-new',
] as const

/** What the "More actions" menu reads of a sheet button. */
export interface SheetButton {
  id: string
  hidden: boolean
  disabled: boolean
  title: string
  textContent: string | null
}

/** Those that go through herdr: gray without fresh herdr data, whatever their own title says. */
const HERDR_BUTTONS: readonly string[] = ['sheet-wake', 'sheet-sleep', 'sheet-new']

/** The sheet's buttons on show as a menu, gray with why when they are. */
export function sheetMoreMenu(buttons: readonly SheetButton[], canMutate: boolean, t: Translator): MenuItem[] {
  return buttons
    .filter(el => !el.hidden)
    .map(el => ({
      id: el.id,
      label: (el.textContent ?? '').trim(),
      disabled: el.disabled,
      reason: el.disabled
        ? !canMutate && HERDR_BUTTONS.includes(el.id)
          ? t('mobile.readOnly')
          : el.title || t('mobile.readOnly')
        : '',
    }))
}

/** A finger held here opens a menu: on a card, a lane or the board, not on what has its own press. */
export const pressOpensMenu = (el: Element): boolean =>
  !el.closest('input, textarea, select, button, a[href], .sheet, .ql, .launch, .menu, .rename, .toolbar') &&
  !!el.closest('.card, .lane, #board')
