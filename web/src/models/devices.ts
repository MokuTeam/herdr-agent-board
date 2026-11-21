// The devices of a master's board on the page (#502, docs/design/nodes 12): the device a card is on
// and whether the master hears it now, the device switch's options and the device it shows, the words
// of a start placed on a device (8.3), and the words of a node-offline answer. A board without
// `nodes` sends no `devices` and no item with a `device`: nothing here draws, the switch is not
// there, and every filter passes what it passed before.
import type { BoardDevice } from '../../../src/core/payload.ts'
import type { Item, LaunchView, Translator } from '../../../src/core/types.ts'
import { ago } from './card.ts'
import type { ProfileOption } from './profiles.ts'

type Devices = readonly BoardDevice[] | undefined

/** A device by its id; null when the payload does not list it. */
export const deviceOf = (devices: Devices, id: string): BoardDevice | null => devices?.find(d => d.id === id) ?? null

/** The master hears it now: this computer (no link), or a node whose link is online. */
export const reachable = (d: BoardDevice): boolean => d.kind === null || d.link?.state === 'online'

/** A card's device as the page shows it. */
export interface NodeLook {
  id: string
  /** Its title from `devices`; its id while the payload does not list it. */
  title: string
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
 * The device of a card (or a launch) of another device; null for this computer's own, which has
 * no `device`. One the payload does not list is not heard either.
 */
export function nodeLook(item: Pick<Item, 'device'>, devices: Devices, now: number, t: Translator): NodeLook | null {
  const id = item.device
  if (!id) return null
  const d = deviceOf(devices, id)
  const title = d?.title || id
  if (d && reachable(d)) return { id, title, offline: false, asOf: '', why: '' }
  return { id, title, offline: true, asOf: asOf(d, now, t), why: t('node.offline', { name: title }) }
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
      title: d.title,
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
  const name = d?.title || device || ''
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
  for (const d of devices) titles.set(d.id, d.title)
}

/**
 * The words of the server's answer for an action on an offline device's card (503,
 * `{ error: 'node-offline', device }`): "server-1 is not reachable". Null for any other answer.
 */
export function offlineAnswer(reply: { error?: unknown; device?: unknown }, t: Translator): string | null {
  if (reply.error !== 'node-offline') return null
  const id = typeof reply.device === 'string' ? reply.device : ''
  return id ? t('node.offline', { name: titles.get(id) || id }) : t('node.offlineAny')
}
