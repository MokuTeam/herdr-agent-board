// The devices of a master's board on the page (#502, docs/design/nodes 12): the device a card is on
// and whether the master hears it now, the device switch's options and the device it shows, the words
// of a start placed on a device (8.3), and the words of a node-offline answer. A board without
// `nodes` sends no `devices` and no item with a `device`: nothing here draws, the switch is not
// there, and every filter passes what it passed before.
import { DEVICE_COLORS, deviceColorFallback, resolveDeviceColors } from '../../../src/core/device-color.ts'
import { type GitLack, gitLacks } from '../../../src/core/git-access.ts'
import { parseNodeKey } from '../../../src/core/node-key.ts'
import type { NodesPanelSettings } from '../../../src/core/nodes.ts'
import type { BoardCategory, BoardDevice } from '../../../src/core/payload.ts'
import { NODE_OFFLINE_WHY, type ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { Item, LaunchView, Translator } from '../../../src/core/types.ts'
import { ago } from './card.ts'
import { loggedOut, loginCommand } from './node-setup.ts'
import type { ProfileOption } from './profiles.ts'

export { DEVICE_COLORS }

type Devices = readonly BoardDevice[] | undefined

/** Whether the board has at least one remote device configured alongside the master. */
export const hasNodes = (devices: Devices): boolean => !!devices && devices.some(d => d.id !== 'local')

const isLocalTitle = (title: string | undefined): boolean => !!title && title.trim().toLowerCase() === 'local'

const defaultDeviceTitle = (d: Pick<BoardDevice, 'id' | 'selfId' | 'status'>, t: Translator): string =>
  d.id === 'local' ? d.selfId || d.status?.id || t('node.dev.master') : d.id

/**
 * What the owner reads for a device: the master's own row (`local`) shows its custom title, else its
 * configured device id (`selfId` / `status.id`), else "master"; any other device its title or id.
 * A stored placeholder title "local" (any case) is normalised to the device id.
 */
export function deviceTitle(
  d: Pick<BoardDevice, 'id' | 'title' | 'kind'> & Partial<Pick<BoardDevice, 'selfId' | 'status'>>,
  t: Translator,
): string {
  const title = d.title?.trim() ?? ''
  if (title && !isLocalTitle(title)) return title
  if (d.id !== 'local') return d.id
  return d.selfId || d.status?.id || t('node.dev.master')
}

/** A device by its id; null when the payload does not list it. */
export const deviceOf = (devices: Devices, id: string): BoardDevice | null => devices?.find(d => d.id === id) ?? null

/** The master hears it now: this computer (no link), or a node whose link is online. */
export const reachable = (d: BoardDevice): boolean => d.kind === null || d.link?.state === 'online'

/** A card's device as the page shows it. */
export interface NodeLook {
  id: string
  /** Its title from `devices`; its id while the payload does not list it. */
  title: string
  /** Resolved #rrggbb colour for the card corner and Settings, Devices legend (#758). */
  color: string
  /** The master does not hear it: its cards are its last ones, greyed. */
  offline: boolean
  /** While offline, how old those cards are ("as of 8 min ago"); '' while it is heard. */
  asOf: string
  /** While offline, what its actions answer ("server-1 is not reachable"); '' while it is heard. */
  why: string
}

/** How old an offline device's cards are: from when its last payload came, else when its link last heard a byte. */
function asOf(d: BoardDevice | null, now: number, t: Translator): string {
  const at = d?.payloadAt ?? d?.link?.heardAt ?? null
  if (!at) return t('node.asOfNever')
  if (now - at < 60_000) return t('node.asOfNow')
  return t('node.asOf', { age: ago(at, now, t) })
}

/**
 * The device of a card (or a launch): every machine is named when the board has at least one
 * remote node; null on standalone boards or single-device boards without remote nodes.
 */
export function nodeLook(item: Pick<Item, 'device'>, devices: Devices, now: number, t: Translator): NodeLook | null {
  const id = item.device
  if (!id) {
    if (!hasNodes(devices)) return null
    const master = deviceOf(devices, 'local')
    if (!master) return null
    const colors = resolveDeviceColors(devices ?? [])
    const color = colors.get('local')?.hex ?? deviceColorFallback('local').hex
    return { id: 'local', title: deviceTitle(master, t), color, offline: false, asOf: '', why: '' }
  }
  const d = deviceOf(devices, id)
  const title = d ? deviceTitle(d, t) : id
  const colors = resolveDeviceColors(devices ?? [])
  const color = colors.get(id)?.hex ?? deviceColorFallback(id).hex
  if (d && reachable(d)) return { id, title, color, offline: false, asOf: '', why: '' }
  return { id, title, color, offline: true, asOf: asOf(d, now, t), why: t('node.offline', { name: title }) }
}

/**
 * The pick that shows a session just started (`l`, a launch): 'all' when the switch shows another
 * device than the one it starts on, else null (no change). As the profile switch does (pickShowing).
 */
export const deviceShowing = (picked: string, devices: Devices, l: Pick<Item, 'device'>): string | null => {
  const now = pickedDevice(picked, devices)
  return now === 'all' || deviceShown(now, l, devices) ? null : 'all'
}

/** A card of another device that the master does not hear now. */
export const nodeOffline = (item: Pick<Item, 'device'>, devices: Devices): boolean => {
  if (!item.device) return false
  const d = deviceOf(devices, item.device)
  return !d || !reachable(d)
}

// ---------------------------------------------------------------- the device switch

/**
 * Whether the switch (`picked`: 'all' or a device id) shows a card: one with no `device` is this
 * computer's, the device without a link. Nothing of core/nodes.ts is imported for it: that module
 * brings the peer network's crypto into the page of every board.
 */
export const deviceShown = (picked: string, item: Pick<Item, 'device'>, devices: Devices): boolean =>
  picked === 'all' || (item.device ? item.device === picked : deviceOf(devices, picked)?.kind === null)

/**
 * The device the switch shows: the one picked while the payload lists it and has more than one
 * device, else 'all'. A board without `nodes` always reads 'all'.
 */
export function pickedDevice(picked: string, devices: Devices): string {
  return devices && devices.length > 1 && devices.some(d => d.id === picked) ? picked : 'all'
}

/**
 * The switch: "All devices" with every card on show (`visible`, whatever the switch picks), then
 * each device in the payload's order with its cards. Null with one device or none: no switch.
 */
export function deviceOptions(devices: Devices, visible: readonly Item[], t: Translator): ProfileOption[] | null {
  if (!devices || devices.length < 2) return null
  return [
    { id: 'all', title: t('node.all'), color: '', n: visible.length },
    ...devices.map(d => ({
      id: d.id,
      title: deviceTitle(d, t),
      color: '',
      n: visible.filter(i => deviceShown(d.id, i, devices)).length,
    })),
  ]
}

// ---------------------------------------------------------------- a start placed on a device

/**
 * What a start the master places says while it decides or waits (design 8.3): choosing a device,
 * syncing the profile to it, cloning there, waiting for room. The state `queued` and the steps
 * `placing`, `syncing` and `cloning` come with the placer (#504), the device in its `place`;
 * null for any other launch, whose card says what it said before. Here with the device's title;
 * models/launch.ts stepText words the same steps with the id when the payload lists no devices.
 */
export function placingText(l: LaunchView, devices: Devices, t: Translator): string | null {
  // Read as strings: the placer adds these values to LaunchState and LaunchStep.
  const state: string = l.state
  const step: string = l.step
  const device = l.place?.device ?? l.device
  const d = device ? deviceOf(devices, device) : null
  const name = (d && deviceTitle(d, t)) || device || ''
  if (state === 'queued') {
    const n = d?.status ? d.status.sessions.awake : null
    if (!name || n === null || d?.maxSessions == null) return t('node.queuedNoRoom')
    return t('node.queued', { name, n, max: d.maxSessions })
  }
  if (step === 'placing' && !name) return t('node.place.choosing')
  if (!name) return null
  if (step === 'syncing') return t('node.place.syncing', { name })
  if (step === 'cloning') return t('node.place.cloning', { name })
  return null
}

// ---------------------------------------------------------------- a node-offline answer

/** The devices' titles as the last payload with `devices` named them, for the words of an answer. */
const titles = new Map<string, string>()

/** Keeps the devices' titles of a master's payload (BoardProvider, only for a payload that has `devices`). */
export function knowDevices(devices: readonly BoardDevice[]): void {
  for (const d of devices) {
    const raw = d.title?.trim() ?? ''
    const title = raw && !isLocalTitle(raw) ? raw : d.id === 'local' ? d.selfId || d.status?.id || '' : d.id
    titles.set(d.id, title)
  }
}

/**
 * The words of the server's answer for an action on an offline device's card (503,
 * `{ error: 'node-offline', device }`): "server-1 is not reachable". Null for any other answer.
 */
export function offlineAnswer(reply: { error?: unknown; device?: unknown }, t: Translator): string | null {
  // A node's call its master answers (#780, core/master-relay.ts RELAY_ERRORS.offline) while the shared board is away.
  if (reply.error === 'node-master-offline') return t('node.err.masterOffline')
  if (reply.error !== 'node-offline') return null
  const id = typeof reply.device === 'string' ? reply.device : ''
  return id ? t('node.offline', { name: titles.get(id) || id }) : t('node.offlineAny')
}

// ---------------------------------------------------------------- Settings, Devices (#510)

/** What the panel shows beside the devices, from `GET /api/nodes` (core/nodes.ts NodesPanelSettings). */
export type PanelSettings = NodesPanelSettings

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** GET and POST /api/nodes as the panel reads them: an object, its `settings` when it has them. */
export function isPanelReply(v: unknown): v is { settings?: PanelSettings } {
  if (!isObj(v)) return false
  const s = v.settings
  if (s === undefined) return true
  return (
    isObj(s) &&
    (s.whenFull === 'local' || s.whenFull === 'wait') &&
    (s.lanes === 'all' || Array.isArray(s.lanes)) &&
    (s.seen === null || Array.isArray(s.seen)) &&
    isObj(s.defaults)
  )
}

/** The words of a change the server refused for a field (400, `{ error: <field> }`); null for any other answer. */
export function refusedText(status: number, error: unknown, t: Translator): string | null {
  if (status !== 400 || typeof error !== 'string') return null
  if (error === 'title') return t('node.dev.refused', { field: t('node.dev.name') })
  if (error === 'color') return t('node.dev.refused', { field: t('node.dev.color') })
  if (['maxSessions', 'minFreeMemMb', 'maxLoad'].includes(error))
    return t('node.dev.refused', { field: t(`node.dev.${error}`) })
  // The list the panel showed is not the board's any more (a device added or left out meanwhile).
  return t('node.dev.refusedStale')
}

/** The thresholds the panel edits, in the order its fields show. */
export const THRESHOLDS = ['maxSessions', 'minFreeMemMb', 'maxLoad'] as const
export type Threshold = (typeof THRESHOLDS)[number]

/** One device's row in Settings, Devices. */
export interface DeviceRow {
  id: string
  title: string
  /** The custom title from config.json, or '' when the device uses its default name. */
  rawTitle: string
  /** The default name shown when no custom title is set ("This computer" for local, else the id). */
  defaultTitle: string
  /** Resolved #rrggbb colour for the legend swatch and card corner (#758). */
  color: string
  /** Palette swatch id or #rrggbb hex currently resolved for this device (#758). */
  colorId: string
  /** This computer: no link line, no Pause. */
  here: boolean
  /** The link in words; null for this computer. */
  link: string | null
  linkState: string | null
  /** Sessions awake against `maxSessions`: the bar's share (null: no limit, no bar) and its words. */
  sessions: { share: number | null; text: string } | null
  /** Memory available: its share of the whole, where `minFreeMemMb` sits on that bar, and the words. */
  memory: { share: number; floor: number | null; low: boolean; text: string } | null
  /** Its version, and whether it runs this board's commit (null: not known). */
  version: string | null
  same: boolean | null
  /** Another version, an update on its way or one that failed (#590), in words; `offer`: the Update button. */
  update: UpdateLine | null
  /** Each profile's bundle as the status has it. */
  bundles: string[]
  paused: boolean
  drain: boolean
  /** A sync gives it the secrets its profile needs (#604); this computer's row has no such switch. */
  giveSecrets: boolean
  /** The secrets its last syncs gave, and those to give by hand, in words (#604). */
  secrets: string[]
  /** What an agent there cannot do for want of git, an identity, a GitHub login or gh, in words (#609). */
  git: string[]
  /** Master schedule entries held while this device is offline (#695); null when none. */
  held: { count: number; label: string; entries: { id: string; who: string; text: string }[] } | null
  values: Record<Threshold, number | null>
  /**
   * Claude's login there (#509): the node's profiles that are not logged in, and the command that
   * logs it in when the device is linked by ssh; null while every profile is (or the status cannot tell).
   */
  login: { out: string[]; command: string | null } | null
}

/** A node's version against this board's (#590): what its row says, and whether it offers Update. */
export interface UpdateLine {
  state: 'behind' | 'updating' | 'restarting' | 'failed'
  text: string
  offer: boolean
}

/** Failures the button cannot mend: the row says to update by hand instead. */
const BY_HAND: ReadonlySet<string> = new Set(['platform', 'no-checkout', 'restart', 'not-built', 'revoked'])
/** The codes the panel has words for; any other is quoted. */
const UPDATE_CODES: ReadonlySet<string> = new Set([
  'offline',
  'busy',
  'no-checkout',
  'git-archive',
  'platform',
  'restart',
  'not-built',
  'sha256',
  'blob',
  'archive',
  'unpack',
  'install',
  'swap',
  'not-back',
  'timeout',
  'revoked',
  'too-big',
  'token',
  'update',
  'loads',
  'node',
])

/**
 * The row's update line: null for this computer, a revoked device, and a node on this board's
 * version with nothing under way. Update is offered only while the device is online.
 */
export function updateLine(
  d: Pick<BoardDevice, 'kind' | 'sameCommit' | 'update' | 'link' | 'status' | 'revoked'>,
  t: Translator,
): UpdateLine | null {
  if (d.kind === null || d.revoked) return null
  const online = d.link?.state === 'online'
  const u = d.update
  if (u?.state === 'updating') return { state: 'updating', text: t('node.dev.updating'), offer: false }
  if (u?.state === 'restarting') return { state: 'restarting', text: t('node.dev.restarting'), offer: false }
  if (u?.state === 'failed') {
    const error = u.error ?? ''
    const why = UPDATE_CODES.has(error) ? t(`node.dev.upd.${error}`) : t('node.dev.upd.other', { error })
    return { state: 'failed', text: t('node.dev.updateFailed', { why }), offer: online && !BY_HAND.has(error) }
  }
  // A node that knows no commit of its own (no checkout, no stamp) is behind too: an update gives it one.
  if (d.sameCommit === false || (d.status && !d.status.commit))
    return { state: 'behind', text: t('node.dev.behind'), offer: online }
  return null
}

const share = (n: number, of: number): number => (of > 0 ? Math.min(1, Math.max(0, n / of)) : 0)
const gb = (mb: number): string => (Math.round(mb / 102.4) / 10).toString()

/**
 * A device's link in words: online, connecting, not reachable and for how long, refused and why.
 * `noToken`: the device store holds no token for it, so a refusal for `token` means none was
 * given yet, and the line says the command that gives one.
 */
export function linkWords(
  d: Pick<BoardDevice, 'id' | 'link'>,
  now: number,
  t: Translator,
  noToken = false,
): string | null {
  const link = d.link
  if (!link) return null
  if (link.state === 'online') return t('node.dev.link.online')
  if (link.state === 'connecting') return t('node.dev.link.connecting')
  if (link.state === 'refused' && link.reason === 'token' && noToken) return t('node.dev.noToken', { id: d.id })
  if (link.state === 'refused') return t('node.dev.link.refused', { why: t(`node.dev.why.${link.reason ?? 'ssh'}`) })
  // Offline since `since`: how long, once that is a minute or more.
  return now - link.since >= 60_000
    ? t('node.dev.link.offline', { age: ago(link.since, now, t) })
    : t('node.dev.link.offlineNever')
}

/** Held schedule entries for a remote device while it is offline (#695). */
function heldForDevice(
  d: Pick<BoardDevice, 'id' | 'kind' | 'held'>,
  schedules: readonly ScheduleEntry[] | undefined,
  items: readonly Pick<Item, 'key' | 'name'>[] | undefined,
  t: Translator,
): DeviceRow['held'] {
  if (d.kind === null) return null
  const matched = (schedules ?? []).filter(
    e => !e.device && e.why === NODE_OFFLINE_WHY && parseNodeKey(e.key)?.device === d.id,
  )
  const count = Math.max(d.held ?? 0, matched.length)
  if (count <= 0) return null
  const itemName = (key: string): string => items?.find(i => i.key === key)?.name ?? ''
  return {
    count,
    label: t('node.dev.held', { n: count }),
    entries: matched.map(e => ({
      id: e.id,
      who: itemName(e.key) || e.name || parseNodeKey(e.key)?.key.slice(0, 8) || e.key,
      text: e.text,
    })),
  }
}

/**
 * The rows of the panel, in the payload's order (config.json's `nodes.order`). `settings`: what
 * GET /api/nodes added; a device without a `maxSessions` of its own fills its bar against the
 * board's figure for it, the one its field shows as the placeholder. The payload does not tell an
 * absent key from an explicit null (no limit), so such a device shows that figure too; the placer
 * writes the figures on a device's first status, so this lasts until then.
 */
export function deviceRows(
  devices: readonly BoardDevice[],
  now: number,
  t: Translator,
  settings?: Pick<PanelSettings, 'defaults' | 'noToken' | 'hosts' | 'secrets'> | null,
  schedules?: readonly ScheduleEntry[],
  items?: readonly Pick<Item, 'key' | 'name'>[],
): DeviceRow[] {
  const colors = resolveDeviceColors(devices)
  return devices.map(d => {
    const s = d.status
    const here = d.kind === null
    const max = d.maxSessions ?? settings?.defaults[d.id]?.maxSessions ?? null
    const sessions = s
      ? {
          share: max ? share(s.sessions.awake, max) : null,
          text: max
            ? t('node.dev.sessions', { n: s.sessions.awake, max })
            : t('node.dev.sessionsAny', { n: s.sessions.awake }),
        }
      : null
    const free = s?.memAvailableMb
    const memory =
      s && free != null
        ? {
            share: share(free, s.memTotalMb),
            floor: d.minFreeMemMb != null ? share(d.minFreeMemMb, s.memTotalMb) : null,
            low: d.minFreeMemMb != null && free < d.minFreeMemMb,
            text:
              d.minFreeMemMb != null
                ? t('node.dev.memory', { free: gb(free), min: gb(d.minFreeMemMb) })
                : t('node.dev.memoryAny', { free: gb(free) }),
          }
        : null
    const title = deviceTitle(d, t)
    const defaultTitle = defaultDeviceTitle(d, t)
    const trimmedTitle = d.title?.trim() ?? ''
    const rawTitle =
      trimmedTitle && !isLocalTitle(trimmedTitle) && trimmedTitle !== d.id && trimmedTitle !== defaultTitle
        ? trimmedTitle
        : ''
    const resolvedColor = colors.get(d.id) ?? deviceColorFallback(d.id)
    return {
      id: d.id,
      title,
      rawTitle,
      defaultTitle,
      color: resolvedColor.hex,
      colorId: resolvedColor.id,
      here,
      link: here ? null : linkWords(d, now, t, settings?.noToken?.includes(d.id) ?? false),
      linkState: d.link?.state ?? null,
      sessions,
      memory,
      version: s?.version || null,
      same: here ? null : d.sameCommit,
      update: updateLine(d, t),
      bundles: (s?.profiles ?? []).flatMap(p =>
        p.bundle ? [t('node.dev.bundle', { profile: p.id, seq: p.bundle.seq })] : [],
      ),
      paused: d.paused,
      drain: d.drain,
      giveSecrets: d.giveSecrets !== false,
      secrets: secretLines(settings?.secrets?.[d.id], t),
      git: d.kind === null ? [] : gitLacks(d.status).map(k => t(GIT_LACK[k], { device: title })),
      held: heldForDevice(d, schedules, items, t),
      values: { maxSessions: d.maxSessions, minFreeMemMb: d.minFreeMemMb, maxLoad: d.maxLoad },
      login: loginOf(d, settings?.hosts),
    }
  })
}

/** What the row says a node lacks for git (#609): its status says, a node of an older board says nothing. */
const GIT_LACK: Record<GitLack, string> = {
  git: 'node.dev.noGit',
  identity: 'node.dev.noIdentity',
  login: 'node.dev.noLogin',
  gh: 'node.dev.noGh',
}

/** The secrets of a device's last syncs (#604): those given, and those to give by hand. */
function secretLines(s: { given: string[]; toGive: string[] } | undefined, t: Translator): string[] {
  if (!s) return []
  return [
    ...(s.given.length ? [t('node.dev.secretsGiven', { names: s.given.join(', ') })] : []),
    ...(s.toGive.length ? [t('node.dev.secretsToGive', { names: s.toGive.join(', ') })] : []),
  ]
}

/** A node's profiles not logged in to Claude, and the command for it; this computer's are its own business. */
function loginOf(d: BoardDevice, hosts: PanelSettings['hosts']): DeviceRow['login'] {
  if (d.kind === null || !d.status) return null
  const out = loggedOut(d.status.profiles)
  if (!out.length) return null
  const host = hosts?.[d.id]
  return { out, command: host ? loginCommand(host) : null }
}

/** The order with `id` moved `by` places (−1 up, +1 down), held inside the list; the same list at an end. */
export function movedOrder(order: readonly string[], id: string, by: number): string[] {
  const from = order.indexOf(id)
  const to = Math.min(order.length - 1, Math.max(0, from + by))
  if (from < 0 || to === from) return [...order]
  const next = order.filter(o => o !== id)
  next.splice(to, 0, id)
  return next
}

/** A tick in "Lanes that may leave this computer". */
export interface LaneTick {
  id: string
  title: string
  color: string
  ticked: boolean
  /** Added since the list was last saved: unticked, and marked. */
  fresh: boolean
}

/** The board's lanes as ticks, by `nodes.lanes` and the lanes seen when it was last saved. */
export function laneTicks(
  categories: readonly Pick<BoardCategory, 'id' | 'title' | 'color'>[],
  lanes: PanelSettings['lanes'],
  seen: PanelSettings['seen'],
): LaneTick[] {
  return categories.map(c => {
    const ticked = lanes === 'all' || lanes.includes(c.id.toLowerCase())
    return { id: c.id, title: c.title, color: c.color, ticked, fresh: !ticked && seen !== null && !seen.includes(c.id) }
  })
}

/**
 * The lanes after one tick: every lane ticked by name (so a lane added later still starts unticked,
 * as with nothing ticked); 'all' only from the All tick.
 */
export function lanesAfter(lanes: PanelSettings['lanes'], ids: readonly string[], id: string, on: boolean): string[] {
  const now = lanes === 'all' ? ids.map(i => i.toLowerCase()) : [...lanes]
  const key = id.toLowerCase()
  const without = now.filter(l => l !== key)
  return on ? [...without, key] : without
}

/**
 * A threshold field as left: the number to save, or null to put the field back as it was. An
 * empty field takes the board's own figure (`dflt`, the placeholder); none known, nothing changes.
 */
export function thresholdTyped(
  key: Threshold,
  text: string,
  dflt: number | undefined,
  was: number | null,
): number | null {
  const typed = text.trim().replace(',', '.')
  const n = typed === '' ? (dflt ?? Number.NaN) : Number(typed)
  if (!Number.isFinite(n)) return null
  const fits = key === 'maxLoad' ? n > 0 : Number.isInteger(n) && (key === 'maxSessions' ? n >= 1 : n >= 0)
  return fits && n !== was ? n : null
}

/**
 * A device's title as left: the trimmed string to send ('' resets to the default), or null when
 * nothing changed. Typing the device's own id resets to the default too.
 */
export function deviceTitleEdited(id: string, rawTitle: string, value: string, defaultTitle = id): string | null {
  const trimmed = value.trim()
  const next = trimmed === id || trimmed === defaultTitle || isLocalTitle(trimmed) ? '' : trimmed
  return next === rawTitle ? null : next
}
