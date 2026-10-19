// The board's context menus without a page: where a menu goes so it stays on screen, which
// items a card, a lane or the board gets in each state, and keyboard movement through them.
// The DOM side is components/menu (the old page's menu.js); the items' actions are wired up in
// hooks/useContextMenus.ts (the old page's app.js).
//
// `reason` says why a disabled item is gray.

import { TIDY_DAYS } from '../../../src/core/archive.ts'
import type { Translator } from '../../../src/core/types.ts'

/** One item of a menu; `submenu` opens beside it (null: it would, but cannot now). */
export interface MenuItem {
  id: string
  label: string
  hint?: string
  /** Set (true or false): the item has a check, and the menu a check column. */
  checked?: boolean
  disabled?: boolean
  reason?: string
  danger?: boolean
  submenu?: MenuEntry[] | null
  /** A lane's color: a square swatch. */
  swatch?: string
  /** A column's color: a round dot. */
  dot?: string
  separator?: undefined
}

export interface MenuSeparator {
  separator: true
}

export type MenuEntry = MenuItem | MenuSeparator

/** What tidy() leaves out: an item a condition took away (`claude && { … }`). */
export type Absent = false | null | undefined | ''

export const isSeparator = (it: MenuEntry): it is MenuSeparator => it.separator === true

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface MenuPlace {
  x: number
  y: number
  originX: 'left' | 'right'
  originY: 'top' | 'bottom'
  maxHeight: number
}

/**
 * Where a menu of `size` opens for a click at `point`: down and to the right of it, flipped
 * left or up when it would leave the viewport, and pressed against the margin when it fits
 * neither way. Taller than the viewport: it scrolls (maxHeight). origin is the corner it grows from.
 * `up`: above the point whenever it fits there, for a control low in its window.
 */
export function placeMenu(
  point: Point,
  size: Size,
  viewport: Size,
  { margin = 8, up = false }: { margin?: number; up?: boolean } = {},
): MenuPlace {
  const maxHeight = viewport.height - 2 * margin
  const h = Math.min(size.height, maxHeight)
  const w = Math.min(size.width, viewport.width - 2 * margin)
  let x = point.x
  let originX: MenuPlace['originX'] = 'left'
  if (x + w > viewport.width - margin) {
    if (point.x - w >= margin) {
      x = point.x - w
      originX = 'right'
    } else x = viewport.width - margin - w
  }
  let y = point.y
  let originY: MenuPlace['originY'] = 'top'
  if (y + h > viewport.height - margin || (up && point.y - h >= margin)) {
    if (point.y - h >= margin) {
      y = point.y - h
      originY = 'bottom'
    } else y = viewport.height - margin - h
  }
  // A click inside the margin itself: the flipped menu still keeps the margin.
  const clamp = (v: number, length: number, room: number) => Math.max(margin, Math.min(v, room - margin - length))
  return { x: clamp(x, w, viewport.width), y: clamp(y, h, viewport.height), originX, originY, maxHeight }
}

export interface SubmenuPlace {
  x: number
  y: number
  side: 'right' | 'left'
  maxHeight: number
}

export interface SubmenuOptions {
  margin?: number
  inset?: number
  overlap?: number
}

/**
 * A submenu beside the item that opens it: right of the parent menu with its first item level
 * with that item (`inset`: the menu's top padding), left when the right has no room, moved up
 * when it would leave the bottom.
 */
export function placeSubmenu(
  item: { top: number; bottom: number },
  parent: { left: number; right: number; top: number; bottom: number },
  size: Size,
  viewport: Size,
  { margin = 8, inset = 5, overlap = 3 }: SubmenuOptions = {},
): SubmenuPlace {
  let x = parent.right - overlap
  let side: SubmenuPlace['side'] = 'right'
  if (x + size.width > viewport.width - margin) {
    const left = parent.left - size.width + overlap
    if (left >= margin) {
      x = left
      side = 'left'
    } else x = viewport.width - margin - size.width
  }
  const maxHeight = viewport.height - 2 * margin
  const h = Math.min(size.height, maxHeight)
  let y = item.top - inset
  if (y + h > viewport.height - margin) y = viewport.height - margin - h
  return { x: Math.max(margin, x), y: Math.max(margin, y), side, maxHeight }
}

/** What the keys read of an item. */
export interface Navigable {
  separator?: boolean | undefined
  disabled?: boolean | undefined
  label?: string | undefined
}

const usable = (it: Navigable | undefined): boolean => !!it && !it.separator && !it.disabled

/** The next item to light from `from` going `dir` (+1 / -1), over separators and gray items, wrapping. */
export function nextIndex(items: readonly Navigable[], from: number, dir: number): number {
  const n = items.length
  if (!n) return -1
  let i = from
  for (let step = 0; step < n; step++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n
    if (usable(items[i])) return i
  }
  return -1
}

/** First and last usable items, for Home and End. */
export const firstIndex = (items: readonly Navigable[]): number => nextIndex(items, -1, 1)
export const lastIndex = (items: readonly Navigable[]): number => nextIndex(items, -1, -1)

/**
 * Type to select: the next usable item after `from` whose label starts with what was typed. The
 * same letter again moves on to the next item that starts with it, as macOS menus do.
 */
export function typeahead(items: readonly Navigable[], typed: string | null | undefined, from: number): number {
  const q = String(typed ?? '').toLowerCase()
  if (!q) return from
  const same = [...q].every(c => c === q[0])
  const n = items.length
  const starts = (i: number) =>
    usable(items[i]) &&
    String(items[i]?.label ?? '')
      .toLowerCase()
      .startsWith(same ? (q[0] ?? '') : q)
  const begin = same || from < 0 ? from + 1 : from
  for (let k = 0; k < n; k++) {
    const i = (Math.max(0, begin) + k) % n
    if (starts(i)) return i
  }
  return from
}

/** What shareReasons reads of an item. */
export interface Reasoned {
  separator?: boolean | undefined
  disabled?: boolean | undefined
  reason?: string | undefined
}

/**
 * When several items are gray for the same reason (no fresh herdr data), the reason goes once
 * under the menu instead of under each of them. Returns { items, note }.
 */
export function shareReasons<T extends Reasoned>(items: readonly T[], min = 2): { items: T[]; note: string } {
  const counts = new Map<string, number>()
  for (const it of items) if (it.disabled && it.reason) counts.set(it.reason, (counts.get(it.reason) ?? 0) + 1)
  const [shared] = [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1])[0] ?? []
  if (!shared) return { items: [...items], note: '' }
  return { items: items.map(it => (it.reason === shared ? { ...it, reason: '' } : it)), note: shared }
}

/** Separators only between groups: none first, last or twice in a row. */
export function tidy<T extends { separator?: boolean | undefined }>(items: readonly (T | Absent)[]): T[] {
  const out: T[] = []
  for (const it of items) {
    if (!it) continue
    if (it.separator && (!out.length || out.at(-1)?.separator)) continue
    out.push(it)
  }
  while (out.at(-1)?.separator) out.pop()
  return out
}

const SEP: MenuSeparator = { separator: true }
const PIN_COLUMNS = ['me', 'ext', 'done', 'idle']
const COLUMN_COLOR: Record<string, string> = {
  me: 'var(--orange)',
  ext: 'var(--purple)',
  done: 'var(--blue)',
  idle: 'var(--gray)',
  work: 'var(--green)',
}

/** What every menu is built with: the texts, and what the board can do now. */
export interface MenuContext {
  t: Translator
  /** Fresh herdr data: what goes through herdr can be done. */
  canMutate: boolean
  /** The board is reachable: its own edits can be done. */
  canEdit: boolean
}

/** A lane as the menus show it. */
export interface MenuCategory {
  id: string
  title: string
  color: string
}

export interface CardMenuContext extends MenuContext {
  categories?: readonly MenuCategory[] | undefined
  /** The column the card shows in now. */
  column: string
  /** The lane the card is in now. */
  category: string
  /** The board offers its terminal (config `terminal`). */
  terminal?: boolean | undefined
  /** MokuPilot is here for calls with a fork of a session. */
  mokupilot?: boolean | undefined
  /** A restart of it is on its way. */
  restarting?: boolean | undefined
  /** Why it cannot go to the archive now, a text key, or '' (src/core/archive.ts archiveBlock). */
  archiveWhy?: string | undefined
}

/** What a card's menu reads of the board item. */
export interface MenuSession {
  status: string
  session?: string | null | undefined
  pane?: string | null | undefined
  cwd?: string | undefined
  sleeping?: boolean | undefined
  attention?: string | undefined
  pin?: string | undefined
  auto?: string | undefined
  [extra: string]: unknown
}

/**
 * A card's menu. `it` is the board item; ctx: { t, canMutate, canEdit, categories, column (where
 * it shows now), category (its lane now), restarting (a restart of it is on its way), archiveWhy
 * (why it cannot go to the archive now, a text key, or '') }. Items gray out with the reason when herdr data is stale (going to, waking, sleeping, restarting,
 * renaming in Claude) or the board is offline (card edits).
 */
export function cardMenu(it: MenuSession, ctx: CardMenuContext): MenuEntry[] {
  const { t } = ctx
  const herdrWhy = ctx.canEdit ? t('mobile.readOnly') : t('live.off')
  const editWhy = t('live.off')
  const herdr = (extra?: Partial<MenuItem>): Partial<MenuItem> =>
    ctx.canMutate ? (extra ?? {}) : { disabled: true, reason: herdrWhy }
  const edit = (): Partial<MenuItem> => (ctx.canEdit ? {} : { disabled: true, reason: editWhy })
  const turn = it.status === 'working' || it.status === 'blocked'
  const claude = !!it.session
  const dismissable = it.attention === 'ask' || it.attention === 'question' || it.attention === 'later'
  const pinned = it.pin && ctx.column === it.pin
  const columns: MenuEntry[] = PIN_COLUMNS.map(id => ({
    id: `col:${id}`,
    label: t(`col.${id}`),
    checked: ctx.column === id,
    dot: COLUMN_COLOR[id] ?? '',
  }))
  if (pinned) columns.push(SEP, { id: `col:${it.auto}`, label: t('chip.auto'), hint: t(`col.${it.auto}`) })
  const copy: (MenuItem | Absent)[] = [
    { id: 'copy:name', label: t('menu.copyName') },
    it.cwd && { id: 'copy:cwd', label: t('menu.copyPath') },
    claude && { id: 'copy:session', label: t('menu.copySession') },
    it.pane && { id: 'copy:pane', label: t('menu.copyPane') },
  ]
  return tidy<MenuEntry>([
    { id: 'open', label: t('menu.open'), hint: 'Enter' },
    { id: 'focus', label: t(it.sleeping ? 'menu.wakeFocus' : 'menu.focus'), ...herdr() },
    // Looking needs no fresh data; typing and opening a shell wait for it in the window itself.
    ctx.terminal && (it.cwd || it.pane) && { id: 'terminal', label: t('term.open'), hint: 'Ctrl+`' },
    // A MokuPilot call with a fork of the session: needs the board, not fresh herdr data.
    ctx.mokupilot && claude && it.agent === 'claude' && { id: 'mokupilot', label: t('mokupilot.call'), ...edit() },
    { id: 'write', label: t('menu.write'), ...(it.pane ? {} : { disabled: true, reason: t('err.noPane') }) },
    it.sleeping
      ? { id: 'wake', label: t('sheet.wake'), ...herdr() }
      : claude && {
          id: 'sleep',
          label: t('card.sleep'),
          ...herdr(turn ? { disabled: true, reason: t('sheet.sleepBusy') } : {}),
        },
    // Waits until the session is free by itself, so a turn does not gray it; one asked for already does.
    !it.sleeping &&
      claude &&
      it.agent === 'claude' && {
        id: 'restart',
        label: t('sheet.restart'),
        ...herdr(ctx.restarting ? { disabled: true, reason: t('sheet.restartPending') } : {}),
      },
    { id: 'rename', label: t('menu.rename'), hint: 'F2', ...edit() },
    SEP,
    {
      id: 'category',
      label: t('menu.category'),
      ...edit(),
      submenu: ctx.canEdit
        ? (ctx.categories ?? []).map(c => ({
            id: `cat:${c.id}`,
            label: c.title,
            checked: c.id === ctx.category,
            swatch: c.color,
          }))
        : null,
    },
    { id: 'status', label: t('menu.status'), ...edit(), submenu: ctx.canEdit ? columns : null },
    dismissable && { id: 'dismiss', label: t(it.attention === 'later' ? 'asked.seen' : 'card.noReply'), ...edit() },
    SEP,
    it.cwd && { id: 'reveal', label: t('menu.openFolder'), ...edit() },
    it.cwd && { id: 'changes', label: t('changes.open') },
    claude && { id: 'history', label: t('history.open') },
    SEP,
    it.cwd && { id: 'newHere', label: t('menu.newHere'), ...herdr() },
    SEP,
    {
      id: 'copy',
      label: t('menu.copy'),
      submenu: copy.filter((c): c is MenuItem => !!c),
    },
    SEP,
    // Off the board until Return: its tab closes, Claude keeps the conversation.
    claude &&
      it.agent === 'claude' && {
        id: 'archive',
        label: t('archive.menu'),
        ...herdr(ctx.archiveWhy ? { disabled: true, reason: t(ctx.archiveWhy) } : {}),
      },
    { id: 'clear', label: t('menu.clear'), danger: true, ...edit() },
  ])
}

export interface TidyContext extends MenuContext {
  /** How many sleeping sessions in "Idle" a tidy-up of `days` takes (src/core/archive.ts tidyList). */
  tidyCount(days: number): number
}

/**
 * "Archive the sleeping ones" with a submenu by how long they have slept, each with its count.
 * ctx: { t, canMutate, canEdit, tidyCount(days) }. Gray when no session sleeps there at all.
 */
function tidyItem(ctx: TidyContext): MenuItem {
  const { t } = ctx
  const all = ctx.tidyCount(0)
  if (!all) return { id: 'tidy', label: t('archive.tidy.menu'), disabled: true, reason: t('archive.tidy.none') }
  if (!ctx.canMutate)
    return {
      id: 'tidy',
      label: t('archive.tidy.menu'),
      disabled: true,
      reason: ctx.canEdit ? t('mobile.readOnly') : t('live.off'),
    }
  const label = (d: number) =>
    d === 0 ? t('archive.tidy.all') : d === 7 ? t('archive.tidy.week') : t('archive.tidy.days', { n: d })
  return {
    id: 'tidy',
    label: t('archive.tidy.menu'),
    submenu: TIDY_DAYS.map(d => {
      const n = ctx.tidyCount(d)
      return { id: `tidy:${d}`, label: label(d), hint: String(n), ...(n ? {} : { disabled: true }) }
    }),
  }
}

/** A column head's menu: only "Idle" has one, for taking its sleeping sessions to the archive. */
export function columnMenu(col: string | undefined, ctx: TidyContext): MenuEntry[] | null {
  if (col !== 'idle') return null
  return tidy<MenuEntry>([tidyItem(ctx), SEP, { id: 'archiveOpen', label: ctx.t('archive.menuOpen') }])
}

export interface LaneMenuContext extends MenuContext {
  /** The lane on show, or 'all'. */
  filter: string
  /** The lane's sleeping sessions a tidy-up takes (its menu then offers it). */
  tidyCount?: ((days: number) => number) | undefined
}

/** A lane's menu: new sessions there, its category, the filter, its sleeping sessions to the archive. */
export function laneMenu(cat: MenuCategory, ctx: LaneMenuContext): MenuEntry[] {
  const { t } = ctx
  const herdr = ctx.canMutate ? {} : { disabled: true, reason: ctx.canEdit ? t('mobile.readOnly') : t('live.off') }
  const only = ctx.filter === cat.id
  return tidy<MenuEntry>([
    { id: 'new', label: t('menu.newIn', { lane: cat.title }), hint: 'Shift+N', ...herdr },
    { id: 'newWorkspace', label: t('menu.newWorkspace'), ...herdr },
    SEP,
    {
      id: 'editCat',
      label: t('menu.editCat', { lane: cat.title }),
      ...(ctx.canEdit ? {} : { disabled: true, reason: t('live.off') }),
    },
    only
      ? { id: 'showAll', label: t('menu.showAll') }
      : { id: 'showOnly', label: t('menu.showOnly', { lane: cat.title }) },
    ctx.tidyCount && SEP,
    ctx.tidyCount && tidyItem({ ...ctx, tidyCount: ctx.tidyCount }),
  ])
}

export interface BoardMenuContext extends LaneMenuContext {
  /** Sessions asleep in the idle column are on show. */
  sleepers: boolean
}

/** The board's own menu, on empty space. */
export function boardMenu(ctx: BoardMenuContext): MenuEntry[] {
  const { t } = ctx
  const herdr = ctx.canMutate ? {} : { disabled: true, reason: ctx.canEdit ? t('mobile.readOnly') : t('live.off') }
  return tidy<MenuEntry>([
    { id: 'new', label: t('menu.new'), hint: 'Shift+N', ...herdr },
    { id: 'newWorkspace', label: t('menu.newWorkspace'), ...herdr },
    SEP,
    { id: 'cats', label: t('menu.cats') },
    { id: 'archiveOpen', label: t('archive.menuOpen') },
    { id: 'sleepers', label: t('tb.sleepersTitle'), checked: ctx.sleepers },
    ctx.filter !== 'all' && { id: 'showAll', label: t('menu.showAll') },
    { id: 'search', label: t('menu.search'), hint: '/' },
  ])
}

/** What a starting or failed new session's menu reads of the launch. */
export interface MenuLaunch {
  state: string
  pane?: string | null | undefined
  kind?: string | undefined
}

/** A starting or failed new session's menu. */
export function launchMenu(l: MenuLaunch, ctx: MenuContext): MenuEntry[] {
  const { t } = ctx
  const herdr = ctx.canMutate ? {} : { disabled: true, reason: t('mobile.readOnly') }
  return tidy<MenuEntry>([
    l.state === 'trust' && { id: 'trust', label: t('launch.trust.go'), ...herdr },
    l.state === 'trust' && { id: 'closeTab', label: t('launch.trust.close'), ...herdr },
    l.state === 'trust' && SEP,
    l.pane && { id: 'focus', label: t('menu.focus'), ...herdr },
    // A launch that failed only at its first message has a running session: a retry would start a second one.
    l.state === 'failed' && l.kind !== 'message' && { id: 'retry', label: t('launch.retry') },
    l.state === 'failed' && { id: 'copyError', label: t('launch.copyError') },
    SEP,
    { id: 'copy:cwd', label: t('menu.copyPath') },
    SEP,
    { id: 'dismiss', label: t(l.state === 'failed' ? 'launch.dismiss' : 'launch.forget') },
  ])
}

/** A file or folder chip in the conversation: the quick look's own actions, and copying the path. */
export function chipMenu(chip: { dir: boolean }, ctx: MenuContext): MenuEntry[] {
  const { t } = ctx
  const edit = ctx.canEdit ? {} : { disabled: true, reason: t('live.off') }
  return tidy<MenuEntry>([
    { id: 'look', label: t('menu.quickLook'), hint: 'Enter' },
    { id: 'open', label: t('ql.open'), ...edit },
    { id: 'reveal', label: t('ql.reveal'), ...edit },
    SEP,
    { id: 'copyPath', label: t('ql.copy') },
    chip.dir && {
      id: 'newHere',
      label: t('menu.newHere'),
      ...(ctx.canMutate ? {} : { disabled: true, reason: t('mobile.readOnly') }),
    },
  ])
}

export interface NativeMenuScene {
  shift?: boolean
  editable?: boolean
  inSelection?: boolean
  link?: boolean
}

/**
 * Whether a right click there keeps the browser's own menu: in fields, on selected text, on
 * links. Shift+right click always does (the way out to copy, paste and the inspector).
 */
export function wantsNativeMenu({
  shift = false,
  editable = false,
  inSelection = false,
  link = false,
}: NativeMenuScene): boolean {
  return shift || editable || inSelection || link
}
