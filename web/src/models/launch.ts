// New sessions from the board, without a page (the pure parts of web/launch.js): where the window
// grows out of (models/grow.ts draws it), the folder field's list and columns, and the cards of
// sessions on their way. What the form starts with and lacks is models/launch-form.ts.
import { baseName, completions, type folderSuggestions } from '../../../src/core/launch/names.ts'
import type { Blocker, Refusal, Unfit } from '../../../src/core/placement.ts'
import type { PortableWhy } from '../../../src/core/portable.ts'
import type { ColumnId, Item, LaunchView, Translator } from '../../../src/core/types.ts'
import { FROM_BELOW, type GrowFrom } from './grow.ts'

// ---------------------------------------------------------------- the window's motion

/** A box on screen: an element's, or a point's (a lane, the board) where a menu was opened. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
  bottom: number
}

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

/** "Working" while it starts, "Needs me" once it needs the user, "Waiting" while it waits for room on a device (#504). */
export const launchColumn = (l: Pick<LaunchView, 'state'>): ColumnId =>
  needsYou(l) ? 'me' : l.state === 'queued' ? 'ext' : 'work'

/**
 * A launch's board item, in its lane, and in the profile it starts in (the profile switch shows it
 * as it shows a session). The fields a session has and a launch has not are empty; nothing reads
 * them for a launch's card.
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
    ...(l.profile ? { profile: l.profile } : {}),
    // A start placed on another device (#502): its card shows that device and its switch finds it.
    ...(l.device ? { device: l.device } : {}),
  }
}

/** How it goes, for the line on its card; a session back from the archive is resumed, not started anew. */
export function stepText(l: LaunchView, t: Translator, launcher: string): string {
  if (l.state === 'waiting') return t('launch.step.dialog')
  // A master's start (#504): the device it is choosing, cloning on or starting on.
  const device = l.place?.device ? deviceName(l.place.device, t) : ''
  if (l.place && (l.state === 'starting' || l.state === 'done')) {
    if (l.step === 'cloning' || l.step === 'syncing') return t(`node.place.${l.step}`, { name: device })
    if (device) return t('place.on', { device })
    if (l.step === 'placing') return t('node.place.choosing')
  }
  if (l.state === 'done') return t('launch.step.done')
  if (l.resume && l.step === 'agent') return t('archive.step')
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

// ---------------------------------------------------------------- where a start runs (#504)

/** A device as the launch card names it: `local` is this computer. */
const deviceName = (id: string, t: Translator): string => (id === 'local' ? t('place.local') : id)

/** What keeps a device from taking a start now (core/placement.ts Blocker), in words. */
export function blockerText(b: Blocker, t: Translator): string {
  const device = deviceName(b.device, t)
  switch (b.kind) {
    case 'sessions':
      return t('place.blocker.sessions', { device, busy: b.busy, max: b.max })
    case 'memory':
      return t('place.blocker.memory', { device, free: Math.max(0, Math.round(b.freeMb)), need: b.needMb })
    case 'load':
      return t('place.blocker.load', { device, load: b.perCore.toFixed(2), max: b.max })
    default:
      return t(`place.blocker.${b.kind}`, { device })
  }
}

/** Why a start stays on the device that has its folder (core/portable.ts PortableWhy), in words. */
export function homeText(why: PortableWhy, t: Translator): string {
  if (why.kind === 'base-unpushed') return t('place.home.base-unpushed', { branch: why.branch })
  if (why.kind === 'local-path') return t('place.home.local-path', { path: why.path })
  if (why.kind === 'name') return t('place.home.name', { name: why.name })
  return t(`place.home.${why.kind}`)
}

function unfitText(u: Unfit, t: Translator): string {
  const device = deviceName(u.device, t)
  switch (u.kind) {
    case 'tags':
      return t('place.unfit.tags', { device, tags: u.missing.join(', ') })
    case 'no-profile':
    case 'not-logged-in':
      return t(`place.unfit.${u.kind}`, { device, profile: u.profile })
    case 'no-agent':
      return t('place.unfit.no-agent', { device, agent: u.agent })
    default:
      return t(`place.unfit.${u.kind}`, { device })
  }
}

const pinText = (pin: { device: string } | { tag: string }, t: Translator): string =>
  'device' in pin ? deviceName(pin.device, t) : pin.tag

/** Why no device could ever take a start (core/placement.ts Refusal), in words. */
export function refusalText(r: Refusal, t: Translator): string {
  if (r.kind === 'no-device') return t('place.refuse.no-device', { pin: r.pin ? pinText(r.pin, t) : '' })
  if (r.kind === 'unfit') return t('place.refuse.unfit', { list: r.devices.map(u => unfitText(u, t)).join('; ') })
  return t('place.refuse.pinned-away', {
    origin: deviceName(r.origin, t),
    why: homeText(r.home, t),
    pin: pinText(r.pin, t),
  })
}

/** The devices that turned a start away on its way, in words; '' for none. */
export const turnedText = (l: Pick<LaunchView, 'place'>, t: Translator): string =>
  (l.place?.turned ?? [])
    .map(x => t('place.turned', { device: deviceName(x.device, t), why: t(`place.turn.${x.error}`) }))
    .join('; ')

/** Why a start of a master failed before it ran, when the placer refused it; null for any other failure. */
export function placeRefusal(l: Pick<LaunchView, 'place'>, t: Translator): string | null {
  if (l.place?.refuse) return refusalText(l.place.refuse, t)
  if (l.place?.queueFull) return t('place.queueFull')
  return null
}

/** What a queued start waits for. */
export const queuedText = (l: Pick<LaunchView, 'place'>, t: Translator): string =>
  l.place?.wait ? t('place.queued', { why: blockerText(l.place.wait, t) }) : t('place.queuedTurned')
