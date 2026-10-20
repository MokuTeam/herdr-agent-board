// The board's context menus (the old page's board-menus.js and the menus' part of app.js): a right
// click, a long press or the menu key opens the menu of what is under the pointer or has the
// focus — a card, the open session's head, a lane, the board, a starting session, a file chip —
// and the sheet's More lists the buttons its row hides. Which menu, and what its items
// do, is models/board-menus.ts; one menu is open at a time (components/menu/menu-engine.ts).
import { useEffect, useState } from 'react'
import type { ColumnId, Item, Translator } from '../../../src/core/types.ts'
import { filesApi } from '../api/files.ts'
import { focusLaunch } from '../api/launch.ts'
import { isFocusable, MenuEngine, type MenuSource } from '../components/menu/menu-engine.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import {
  type BoardMenu,
  type BoardMenuActions,
  type BoardMenuDeps,
  elementOf,
  isMenuKey,
  keepsNativeMenu,
  keyPoint,
  type LaunchMenus,
  LONG_PRESS_MS,
  type MenuOrigin,
  menuFor,
  pressOpensMenu,
  SHEET_MORE,
  type SheetButton,
  SLOP,
  sheetMoreMenu,
  typingIn,
} from '../models/board-menus.ts'
import { catOf, colOf } from '../models/board-view.ts'
import { categoryChoices, type MenuCategory, type Point, statusChoices } from '../models/menu-model.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import type { BoardAction } from '../state/board-ui.ts'
import { useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'
import type { OpenLaunch } from './useNewSession.ts'
import type { QuickLook } from './useQuickLook.ts'
import type { RenameKind } from './useRenameInPlace.ts'
import { type SessionActions, useSessionActions } from './useSessionActions.ts'

/** What the listeners open a menu with. */
export interface MenuOpener {
  open: MenuEngine['open']
  isOpen(): boolean
}

export interface ListenerDeps {
  menu: MenuOpener
  /** The menu for what is under `target` (models/board-menus.ts menuFor, with the page). */
  menuFor(target: unknown, at: Point): BoardMenu | null
  /** performance.now(). */
  now?: () => number
}

const asElement = (node: unknown): Element | null => {
  const el = elementOf(node)
  return el === node ? el : null
}

/**
 * The board's listeners: a right click, the menu key (or Shift+F10), a long press. Returns what
 * takes them away again.
 */
export function boardMenuListeners({ menu, menuFor: menuAt, now = () => performance.now() }: ListenerDeps): () => void {
  let keyAt = -1e9
  let pressAt = -1e9
  let swallowUntil = 0

  function show(target: unknown, at: Point, source: MenuSource): boolean {
    const m = menuAt(target, at)
    if (!m) return false
    const active = document.activeElement
    menu.open(m.items, {
      x: at.x,
      y: at.y,
      source,
      ...(m.label !== undefined && { label: m.label }),
      onPick: m.pick,
      origin: isFocusable(active) ? active : null,
    })
    return true
  }

  /** Text the user selected, under the pointer: the browser's menu copies it. */
  function inSelection(target: EventTarget | null): boolean {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !(target instanceof Node)) return false
    return sel.getRangeAt(0).intersectsNode(target)
  }

  const onContextMenu = (e: MouseEvent) => {
    const at = now()
    // The menu key and a long press open ours themselves; the browser's that follows them must
    // not. A touch that was no long press of ours (text, the toolbar) keeps the browser's.
    if ('pointerType' in e && e.pointerType === 'touch') return void (at - pressAt < 1500 && e.preventDefault())
    if (e.button !== 2 && at - keyAt < 1500) return void e.preventDefault() // the key's own event: button -1
    if (keepsNativeMenu(elementOf(e.target), { shift: e.shiftKey, inSelection: inSelection(e.target) })) return
    if (show(e.target, { x: e.clientX, y: e.clientY }, 'mouse')) e.preventDefault()
  }

  // The menu key and Shift+F10: the menu of what has the focus, under it.
  const onKey = (e: KeyboardEvent) => {
    if (!isMenuKey(e) || menu.isOpen()) return
    const el = document.activeElement
    if (typingIn(el)) return
    const focused = !!el && el !== document.body
    const target = focused ? el : document.querySelector('#board')
    if (!target) return
    if (show(target, keyPoint(target.getBoundingClientRect(), focused), 'keyboard')) {
      e.preventDefault()
      keyAt = now()
    }
  }

  // Touch: a long press opens the menu where the finger is, unless the finger moved (a scroll)
  // or lifted first. The tap it ends in does not also open the card.
  let press: { id: number; x: number; y: number; target: Element; timer: ReturnType<typeof setTimeout> } | null = null
  const onPress = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return
    const el = asElement(e.target)
    if (!el || !pressOpensMenu(el)) return
    clearTimeout(press?.timer)
    press = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      target: el,
      timer: setTimeout(() => {
        const p = press
        press = null
        if (!p) return
        if (show(p.target, { x: p.x, y: p.y }, 'touch')) {
          pressAt = now()
          swallowUntil = pressAt + 900
          getSelection()?.removeAllRanges()
          navigator.vibrate?.(8)
        }
      }, LONG_PRESS_MS),
    }
  }
  const cancel = (e: { type: string; pointerId?: number; clientX?: number; clientY?: number }) => {
    if (!press || (e.pointerId !== undefined && e.pointerId !== press.id)) return
    if (e.type === 'pointermove' && Math.hypot((e.clientX ?? 0) - press.x, (e.clientY ?? 0) - press.y) < SLOP) return
    clearTimeout(press.timer)
    press = null
  }
  const onScroll = () => press && cancel({ type: 'scroll' })
  const onClick = (e: MouseEvent) => {
    if (now() > swallowUntil) return
    swallowUntil = 0
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  document.addEventListener('contextmenu', onContextMenu)
  addEventListener('keydown', onKey)
  addEventListener('pointerdown', onPress, true)
  for (const type of ['pointermove', 'pointerup', 'pointercancel'] as const) addEventListener(type, cancel, true)
  addEventListener('scroll', onScroll, true)
  addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('contextmenu', onContextMenu)
    removeEventListener('keydown', onKey)
    removeEventListener('pointerdown', onPress, true)
    for (const type of ['pointermove', 'pointerup', 'pointercancel'] as const) removeEventListener(type, cancel, true)
    removeEventListener('scroll', onScroll, true)
    removeEventListener('click', onClick, true)
    clearTimeout(press?.timer)
  }
}

/** What the menus' items act with. */
export interface ActionDeps {
  t(): Translator
  canEdit(): boolean
  canMutate(): boolean
  item(key: string): Item | undefined
  dispatch(action: BoardAction): void
  toast(text: string, error?: boolean): void
  actions: SessionActions
  quickLook: Pick<QuickLook, 'look' | 'lookChanges' | 'lookHistory'>
  newSession: OpenLaunch
  /** The categories panel, at a lane. */
  openCategories(id?: string): void
  /** Rename where the name is: the session's, or its workspace's (hooks/useRenameInPlace.ts). */
  rename(key: string, el: Element | null, kind?: RenameKind): void
  /** The terminal window of a session, grown from `el` (hooks/useTerminal.ts). */
  terminal?: ((key: string, el: Element | null) => void) | undefined
  /** The archive (hooks/useArchive.ts): a session off the board, a tidy-up, its panel. */
  archive?: ArchiveMenus | undefined
}

/** What the menus do with the archive (hooks/useArchive.ts). */
export interface ArchiveMenus {
  archiveSession(key: string): unknown
  archiveMany(keys: readonly string[]): unknown
  tidyItems(days: number, lane?: string | null): readonly { key: string }[]
  openPanel(): void
}

const COLUMNS = ['work', 'me', 'ext', 'done', 'idle'] as const
const columnOf = (id: string | undefined) => COLUMNS.find(c => c === id) ?? null
/** The element a dialog grows out of; a point (a lane's, the board's) is none for the quick look. */
const elementFrom = (from: MenuOrigin): Element | null => (from instanceof Element ? from : null)

/** The menus' actions on the React board (the old page's `board.do`). */
export function boardActions(deps: ActionDeps): BoardMenuActions {
  const { dispatch, toast } = deps
  const actions = () => deps.actions
  async function copy(text: string | null | undefined, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(String(text ?? ''))
      toast(done)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true)
    }
  }
  return {
    open: key => dispatch({ type: 'open', key }),
    focus: key => actions().focusSession(key),
    write: key => dispatch({ type: 'open', key, compose: true }),
    wake: key => actions().wakeSession(key),
    sleep: key => actions().sleepSession(key),
    restart: key => actions().restartSession(key),
    // A card's name that is gone (the board drew it anew): rename it in the sheet's head.
    rename: (key, el) => {
      if (el?.isConnected) return deps.rename(key, el)
      dispatch({ type: 'open', key })
      setTimeout(() => deps.rename(key, document.getElementById('sheet-name')), 380)
    },
    // The workspace's name is in the sheet's head alone: from a card, there once it opened.
    renameWorkspace: (key, el) => {
      if (el?.isConnected) return deps.rename(key, el, 'workspace')
      dispatch({ type: 'open', key })
      setTimeout(() => deps.rename(key, document.getElementById('sheet-workspace'), 'workspace'), 380)
    },
    move: (key, to) => actions().moveCard(key, { cat: to.cat ?? null, column: columnOf(to.column) }),
    dismiss: key => actions().dismissAsk(key),
    favorite: key => actions().setFavorite(key, !deps.item(key)?.favorite),
    clear: async key => {
      const r = await actions().act(key, 'card', { clear: true })
      toast(r.ok ? deps.t()('tui.cleared', { name: deps.item(key)?.name ?? '' }) : r.error, !r.ok)
    },
    changes: (key, from) => deps.quickLook.lookChanges(key, elementFrom(from)),
    history: (key, from) => deps.quickLook.lookHistory(key, deps.item(key)?.cwd ?? '', elementFrom(from)),
    terminal: (key, from) => deps.terminal?.(key, elementFrom(from)),
    mokupilot: key => actions().callMokuPilot(key),
    archive: key => deps.archive?.archiveSession(key),
    tidy: (days, lane) => deps.archive?.archiveMany((deps.archive?.tidyItems(days, lane) ?? []).map(i => i.key)),
    archiveOpen: () => deps.archive?.openPanel(),
    newSession: (ctx, from) => deps.newSession(ctx, from),
    cats: id => deps.openCategories(id),
    filter: id => dispatch({ type: 'filter', id }),
    sleepers: () => dispatch({ type: 'toggleSleepers' }),
    search: () => document.getElementById('search')?.focus(),
    copy,
    openPath: async (path, how) => {
      if (!deps.canEdit()) return toast(deps.t()('live.off'), true)
      const error = await filesApi(() => deps.t()).open(path, how)
      if (error) toast(error, true)
    },
    look: (target, el) => deps.quickLook.look(target, el),
    focusLaunch: id => focusLaunch(id, { t: deps.t(), canMutate: deps.canMutate(), toast }),
  }
}

export interface SheetMoreDeps {
  menu: MenuOpener
  t(): Translator
  canMutate(): boolean
  /** The open session. */
  open(): string | null
  item(key: string): Item | undefined
  quickLook: Pick<QuickLook, 'lookChanges' | 'lookHistory'>
  newSession: OpenLaunch
  /** The terminal window of the open session, out of the button. */
  terminal?: ((key: string, el: Element | null) => void) | undefined
  /** The pointer is a finger. */
  coarse(): boolean
}

const isSheetButton = (el: unknown): el is SheetButton & HTMLElement =>
  typeof el === 'object' && el !== null && 'hidden' in el && 'disabled' in el && 'click' in el

/** A button the row leaves over (`.over`, hooks/useActionRow.ts): More lists it. */
const overInRow = (el: HTMLElement): boolean => el.classList.contains('over')

/** The sheet's buttons the row leaves over, as a menu opened upward out of More (`button`). */
export function sheetMoreMenuFrom(deps: SheetMoreDeps): (button: HTMLElement, keyboard: boolean) => void {
  return (button, keyboard) => {
    const rect = button.getBoundingClientRect()
    const t = deps.t()
    const groups = SHEET_MORE.map(group =>
      group
        .map(id => document.getElementById(id))
        .filter(isSheetButton)
        .filter(el => !el.hidden && overInRow(el)),
    )
    deps.menu.open(sheetMoreMenu(groups, deps.canMutate(), t), {
      x: rect.right,
      y: rect.top - 4,
      up: true,
      source: keyboard ? 'keyboard' : deps.coarse() ? 'touch' : 'mouse',
      origin: button,
      label: t('sheet.more'),
      onPick: id => {
        const action = document.getElementById(id)
        if (!isSheetButton(action) || action.disabled || action.hidden) return
        const open = deps.open()
        // Dialogs must return focus to this visible opener, not the hidden toolbar button.
        if (id === 'sheet-history')
          return void (open && deps.quickLook.lookHistory(open, deps.item(open)?.cwd ?? '', button))
        if (id === 'sheet-changes') return void (open && deps.quickLook.lookChanges(open, button))
        if (id === 'sheet-term') return void (open && deps.terminal?.(open, button))
        if (id === 'sheet-new') {
          const it = open ? deps.item(open) : undefined
          return void (open && deps.newSession(it ? { item: it } : {}, button))
        }
        action.click()
      },
    })
  }
}

/** The sheet head's pills that open a menu: where the card shows, and its lane. */
export type SheetPick = 'status' | 'category'

export interface SheetPickDeps {
  menu: MenuOpener
  t(): Translator
  /** The open session's card: its pin, its column and lane now, the lanes there are. */
  card(): { key: string; item: Item; column: string; category: string; categories: readonly MenuCategory[] } | null
  move(key: string, to: { cat: string | null; column: ColumnId | null }): void
  coarse(): boolean
}

/** A pill's choices as a menu out of it (`button`), downward: picking one moves the card, as its chips did. */
export function sheetPickMenuFrom(
  deps: SheetPickDeps,
): (kind: SheetPick, button: HTMLElement, keyboard: boolean) => void {
  return (kind, button, keyboard) => {
    const card = deps.card()
    if (!card) return
    const t = deps.t()
    const rect = button.getBoundingClientRect()
    const items =
      kind === 'status'
        ? statusChoices(card.item, { t, column: card.column })
        : categoryChoices({ categories: card.categories, category: card.category })
    deps.menu.open(items, {
      x: rect.left,
      y: rect.bottom + 4,
      source: keyboard ? 'keyboard' : deps.coarse() ? 'touch' : 'mouse',
      origin: button,
      label: t(kind === 'status' ? 'menu.status' : 'row.category'),
      onPick: id => {
        const [what = '', arg = ''] = id.split(':')
        if (what === 'cat') deps.move(card.key, { cat: arg, column: null })
        else if (what === 'col') deps.move(card.key, { cat: null, column: arg as ColumnId })
      },
    })
  }
}

export interface ContextMenusOptions {
  quickLook: Pick<QuickLook, 'look' | 'lookChanges' | 'lookHistory'>
  newSession: OpenLaunch
  openCategories(id?: string): void
  rename(key: string, el: Element | null, kind?: RenameKind): void
  /** Sessions on their way and what their menu does that is the launch window's (hooks/useLaunch.ts). */
  launch?: LaunchMenus | null
  /** The terminal window of a session (hooks/useTerminal.ts). */
  terminal?: ((key: string, el: Element | null) => void) | undefined
  /** The archive: a card's Archive, the tidy-ups, the panel (hooks/useArchive.ts). */
  archive?: ArchiveMenus | undefined
}

export interface ContextMenus {
  menu: MenuEngine
  /** A menu is open: the Back button closes it first. */
  open: boolean
  /** The menu open is the sheet's "More actions" one (its aria-expanded). */
  moreOpen: boolean
  /** "More actions": the sheet's buttons as a menu. */
  sheetMore(button: HTMLElement, keyboard: boolean): void
  /** The sheet head's pill whose menu is open (its aria-expanded), if one is. */
  pickOpen: SheetPick | null
  /** A pill in the sheet's head: its choices as a menu. */
  sheetPick(kind: SheetPick, button: HTMLElement, keyboard: boolean): void
}

export function useContextMenus(options: ContextMenusOptions): ContextMenus {
  const t = useT()
  const board = useBoardContext()
  const actions = useSessionActions()
  const latest = useLatest({ t, board, actions, options })
  const [moreOpen, setMoreOpen] = useState(false)
  const [pickOpen, setPickOpen] = useState<SheetPick | null>(null)
  const [menu] = useState(() => {
    const engine: MenuEngine = new MenuEngine({
      onChange: () => {
        if (engine.isOpen()) return
        setMoreOpen(false)
        setPickOpen(null)
      },
    })
    return engine
  })
  const open = useStore(menu.openNow)

  // Before the page's own keys (capture on the window); after the quick look's, as before.
  useEffect(() => menu.start(), [menu])

  useEffect(() => {
    const page = () => latest.current
    const itemOf = (key: string) => page().board.data?.items.find(i => i.key === key)
    const deps: BoardMenuDeps = {
      t: () => page().t,
      canMutate: () => page().board.canMutate,
      canEdit: () => page().board.canEdit,
      item: itemOf,
      column: it => colOf(page().board.ui.moves, it),
      category: it => catOf(page().board.ui.moves, it),
      state: () => {
        const { ui, data } = page().board
        return {
          open: ui.open,
          filter: ui.filter,
          sleepers: ui.sleepers,
          data: {
            categories: data?.categories ?? [],
            terminal: data?.terminal,
            mokupilot: data?.mokupilot,
            schedules: data?.schedules,
          },
        }
      },
      get launch() {
        return page().options.launch
      },
      tidyCount: (days, lane) => page().options.archive?.tidyItems(days, lane).length ?? 0,
      do: boardActions({
        t: () => page().t,
        canEdit: () => page().board.canEdit,
        canMutate: () => page().board.canMutate,
        item: itemOf,
        dispatch: action => page().board.dispatch(action),
        toast: (text, error) => page().board.toast(text, error),
        get actions() {
          return page().actions
        },
        quickLook: {
          look: (target, el) => page().options.quickLook.look(target, el),
          lookChanges: (key, el) => page().options.quickLook.lookChanges(key, el),
          lookHistory: (key, cwd, el) => page().options.quickLook.lookHistory(key, cwd, el),
        },
        newSession: (ctx, from) => page().options.newSession(ctx, from),
        openCategories: id => page().options.openCategories(id),
        rename: (key, el, kind) => page().options.rename(key, el, kind),
        terminal: (key, el) => page().options.terminal?.(key, el),
        get archive() {
          return page().options.archive
        },
      }),
    }
    return boardMenuListeners({ menu, menuFor: (target, at) => menuFor(target, at, deps) })
  }, [menu, latest])

  const [sheetMore] = useState(() =>
    sheetMoreMenuFrom({
      menu,
      t: () => latest.current.t,
      canMutate: () => latest.current.board.canMutate,
      open: () => latest.current.board.ui.open,
      item: key => latest.current.board.data?.items.find(i => i.key === key),
      quickLook: {
        lookChanges: (key, el) => latest.current.options.quickLook.lookChanges(key, el),
        lookHistory: (key, cwd, el) => latest.current.options.quickLook.lookHistory(key, cwd, el),
      },
      newSession: (ctx, from) => latest.current.options.newSession(ctx, from),
      terminal: (key, el) => latest.current.options.terminal?.(key, el),
      coarse: () => matchMedia('(pointer: coarse)').matches,
    }),
  )

  const [sheetPick] = useState(() =>
    sheetPickMenuFrom({
      menu,
      t: () => latest.current.t,
      card: () => {
        const { ui, data } = latest.current.board
        const item = ui.open ? data?.items.find(i => i.key === ui.open) : undefined
        if (!item) return null
        const { moves } = ui
        const categories = data?.categories ?? []
        return { key: item.key, item, column: colOf(moves, item), category: catOf(moves, item), categories }
      },
      move: (key, to) => void latest.current.actions.moveCard(key, to),
      coarse: () => matchMedia('(pointer: coarse)').matches,
    }),
  )

  return {
    menu,
    open,
    moreOpen: moreOpen && open,
    sheetMore(button, keyboard) {
      sheetMore(button, keyboard)
      setPickOpen(null)
      setMoreOpen(true)
    },
    pickOpen: open ? pickOpen : null,
    sheetPick(kind, button, keyboard) {
      sheetPick(kind, button, keyboard)
      setMoreOpen(false)
      setPickOpen(kind)
    },
  }
}
