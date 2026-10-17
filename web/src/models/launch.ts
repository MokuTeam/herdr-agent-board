// New sessions from the board, without a page (the pure parts of web/launch.js): where the window
// grows out of and how its spring draws it, the folder field's list and columns, and the cards of
// sessions on their way. What the form starts with and lacks is models/launch-form.ts.
import { baseName, completions, type folderSuggestions } from '../../../src/core/launch/names.ts'
import type { ColumnId, Item, LaunchView, Translator } from '../../../src/core/types.ts'

// ---------------------------------------------------------------- the window's motion

/** A box on screen: an element's, or a point's (a lane, the board) where a menu was opened. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
  bottom: number
}

/** Where the window grows out of, against its own place: offset of the centre and scale. */
export interface GrowFrom {
  dx: number
  dy: number
  s: number
}

/** A little drop from below: for nothing to grow out of, or something off screen. */
export const FROM_BELOW: GrowFrom = { dx: 0, dy: 24, s: 0.94 }

/** The window's spring: it opens on `open`, folds away on `close`. */
export const LAUNCH_MOTION = {
  precision: 0.002,
  open: { damping: 1, response: 0.34 },
  close: { damping: 1, response: 0.28 },
}

/** From `rect`'s centre and width to the window's own box `win`. */
export function growFrom(rect: Box | null | undefined, win: Box, viewportHeight: number): GrowFrom {
  if (!rect?.width || rect.bottom < 0 || rect.top > viewportHeight) return { ...FROM_BELOW }
  return {
    dx: rect.left + rect.width / 2 - (win.left + win.width / 2),
    dy: rect.top + rect.height / 2 - (win.top + win.height / 2),
    s: Math.max(0.08, Math.min(0.6, rect.width / win.width)),
  }
}

/** The window's and the scrim's inline style at spring value `p` (0 folded, 1 open). */
export interface WindowPaint {
  transform: string
  opacity: string
  scrim: string
}

export function windowPaint(p: number, from: GrowFrom, reduced: boolean): WindowPaint {
  const q = Math.max(0, p)
  const scrim = String(Math.min(1, q))
  if (reduced) return { transform: '', opacity: String(Math.min(1, q)), scrim }
  const k = from.s + (1 - from.s) * q
  return {
    transform: `translate(${from.dx * (1 - q)}px, ${from.dy * (1 - q)}px) scale(${k})`,
    opacity: String(Math.min(1, q * 1.8)),
    scrim,
  }
}

// ---------------------------------------------------------------- the folder field

/** What the server says about a folder (POST /api/fs/dirs; '' lists the roots). */
export interface DirListing {
  path?: string
  exists?: boolean
  dir?: boolean
  slow?: boolean
  roots?: { name: string; path: string }[]
  entries?: string[]
  sep?: string
  error?: string | null
  git?: { root: string; branch: string } | null
}

/** A folder's own folder `name`, with the folder's separator between. */
export const childPath = (r: DirListing, name: string): string =>
  (r.path ?? '').replace(/[\\/]?$/, r.sep ?? '\\') + name

/** A line of the list under the field. `complete`: a folder name typed so far, completed. */
export interface PopItem {
  path: string
  label: string
  detail: string
  why?: string
  complete?: boolean
}

type FolderSuggestion = ReturnType<typeof folderSuggestions>[number]

/** The suggestions of the context, while the field is untouched. */
export const suggestionItems = (list: FolderSuggestion[], t: Translator): PopItem[] =>
  list.map(x => ({ path: x.path, label: baseName(x.path), detail: x.path, why: t(`launch.why.${x.why}`) }))

/** Nothing but "C:" or "~" yet: the drives and home that start like it. */
export function rootItems(r: DirListing | null, prefix: string, t: Translator): PopItem[] {
  const p = prefix.toLowerCase()
  return (r?.roots ?? [])
    .filter(x => x.name.toLowerCase().startsWith(p) || x.path.toLowerCase().startsWith(p))
    .map(x => ({ path: x.path, label: x.name === '~' ? t('launch.home') : x.name, detail: x.path }))
}

/** The folders in `dir` that match the name being typed. */
export function completionItems(r: DirListing | null, dir: string, prefix: string): PopItem[] {
  const base = r?.path ? childPath(r, '') : dir
  return r?.dir
    ? completions(r.entries ?? [], prefix).map(n => ({ path: base + n, label: n, detail: base + n, complete: true }))
    : []
}

/** The folders from the top down to `path`, for the columns: C:\, C:\Work, C:\Work\Acme. */
export function chainOf(path: string, sep: string): string[] {
  const parts = String(path)
    .split(/[\\/]+/)
    .filter(Boolean)
  const out: string[] = []
  let acc = /^[\\/]/.test(path) ? sep : ''
  parts.forEach((p, i) => {
    acc = i === 0 ? (/^[A-Za-z]:$/.test(p) ? `${p}${sep}` : `${acc}${p}`) : `${acc.replace(/[\\/]$/, '')}${sep}${p}`
    out.push(acc)
  })
  return out
}

/** The same folder, but for a trailing separator and the case. */
export const sameish = (a: string, b: string): boolean =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** A row of a column: a root (home, a drive) or a folder, lit when it is the one chosen next. */
export interface FolderRow {
  path: string
  name: string
  icon: 'home' | 'drive' | 'folder'
  /** It opens a next column (a folder; the roots have no chevron). */
  chev: boolean
  on: boolean
}

export interface FolderColumn {
  label: string
  rows: FolderRow[]
  /** What it says when it has no rows. */
  empty: string
}

/** One column: the roots, or the folders inside a folder (hidden ones left out); `next`: the one chosen in it. */
export function folderColumn(r: DirListing | null, next: string | undefined, t: Translator): FolderColumn {
  const roots = r?.roots
  const rows: Omit<FolderRow, 'on'>[] = roots
    ? roots.map(x => ({
        path: x.path,
        name: x.name === '~' ? t('launch.home') : x.name,
        icon: x.name === '~' ? 'home' : 'drive',
        chev: false,
      }))
    : (r?.entries ?? [])
        .filter(n => !n.startsWith('.'))
        .map(n => ({ path: childPath(r ?? {}, n), name: n, icon: 'folder', chev: true }))
  return {
    label: r?.path || t('launch.computer'),
    rows: rows.map(x => ({ ...x, on: !!next && sameish(next, x.path) })),
    empty: t(r?.error === 'denied' ? 'ql.denied' : 'launch.noFolders'),
  }
}

// ---------------------------------------------------------------- the launcher

/** How sessions start (GET /api/launch/options): herdr opening an agent, or the config's command. */
export type LauncherInfo = { kind: 'herdr'; agent: string } | { kind: 'command'; name: string }

/** The line under the window's title. */
export const launcherLine = (l: LauncherInfo, t: Translator): string =>
  l.kind === 'command'
    ? t('launch.viaCommand', { name: l.name })
    : t('launch.viaHerdr', { agent: l.agent === 'claude' ? 'Claude' : l.agent })

/** The command's name, for the step it is at ("Starting with {name}…"); none for herdr. */
export const launcherName = (l: LauncherInfo): string => (l.kind === 'command' ? l.name : '')

// ---------------------------------------------------------------- sessions on their way

/** A launch the page started waits this long for the server's board to show it. */
export const LOCAL_MS = 15_000
/** A launch done starting keeps its card this long for herdr to show the session. */
export const DONE_MS = 30_000

/** A launch of the page's own is still to be shown: the server's board has not got it, and it is recent. */
export const keepsLocal = (l: LaunchView, server: LaunchView[], now: number): boolean =>
  !server.some(x => x.id === l.id) && now - l.startedAt <= LOCAL_MS

/** Launches to draw as cards of their own: not yet a session on the board. */
export function pendingLaunches(
  server: LaunchView[],
  local: readonly LaunchView[],
  items: readonly { key: string }[],
  now: number,
): LaunchView[] {
  const keys = new Set(items.map(i => i.key))
  // A launcher can finish before herdr shows the session: its card waits a little for it.
  return [...server, ...local.filter(l => keepsLocal(l, server, now))].filter(
    l => !(l.key && keys.has(l.key)) && (l.state !== 'done' || now - (l.doneAt ?? 0) < DONE_MS),
  )
}

/** It needs the user: it failed, waits for a dialog in herdr, or for its folder to be trusted. */
export const needsYou = (l: Pick<LaunchView, 'state'>): boolean =>
  l.state === 'failed' || l.state === 'waiting' || l.state === 'trust'

/** "Working" while it starts, "Needs me" once it needs the user. */
export const launchColumn = (l: Pick<LaunchView, 'state'>): ColumnId => (needsYou(l) ? 'me' : 'work')

/**
 * A launch's board item, in its lane. The fields a session has and a launch has not are empty;
 * nothing reads them for a launch's card.
 */
export function placeholderOf(l: LaunchView): Item {
  return {
    key: `launch:${l.id}`,
    launchOnly: true,
    launch: l,
    name: l.name,
    category: l.category,
    column: launchColumn(l),
    cwd: l.cwd,
    workspace: l.workspace,
    activity: l.startedAt,
    status: 'unknown',
    session: null,
    pane: null,
    autoName: '',
    categorySet: false,
    attention: '',
  }
}

/** How it goes, for the line on its card. */
export function stepText(l: LaunchView, t: Translator, launcher: string): string {
  if (l.state === 'waiting') return t('launch.step.dialog')
  if (l.state === 'done') return t('launch.step.done')
  return t(`launch.step.${l.step}`, { name: launcher })
}

/** What to do about a failure, by its kind. */
export const failureHint = (l: Pick<LaunchView, 'kind'>): string =>
  `launch.hint.${l.kind === 'dialog' ? 'dialogFailed' : l.kind || 'other'}`

/** Failed only at its first message, the session runs: a retry would start a second one. */
export const retries = (l: Pick<LaunchView, 'kind'>): boolean => l.kind !== 'message'

/** The folder's name and the workspace, under the name on its card. */
export const launchWhere = (l: Pick<LaunchView, 'cwd' | 'workspace'>, t: Translator): string =>
  [baseName(l.cwd), l.workspace && t('meta.workspace', { name: l.workspace })].filter(Boolean).join(' · ')
