// The device/machine picker for the New session window (#948): shown only when the board has
// multiple devices (hidden and omitted from requests on single-machine setups). Keeps no import of
// src/core/nodes.ts so the page bundle never pulls in node:crypto.
import { deviceColorFallback, resolveDeviceColors } from '../../../src/core/device-color.ts'
import { LOCAL } from '../../../src/core/node-key.ts'
import type { BoardDevice } from '../../../src/core/payload.ts'
import type { Translator } from '../../../src/core/types.ts'
import { deviceTitle, reachable } from './devices.ts'
import type { LaunchContext } from './launch-form.ts'

/** localStorage key remembering the last machine picked in this browser. */
export const LAUNCH_DEVICE = 'board.launch.device'

export interface DeviceChip {
  id: string
  title: string
  color: string
  pressed: boolean
  online: boolean
  titleAttr: string
}

export interface DeviceRow {
  offered: boolean
  options: DeviceChip[]
}

export const NO_DEVICE_ROW: DeviceRow = { offered: false, options: [] }

/** Multi-node picker is offered only when the board has more than one device. */
export const offersDevices = (devices: readonly BoardDevice[] | undefined): boolean => !!devices && devices.length > 1

/** Platform string of a device (`win32`, `darwin`, `linux`), if known. */
export const devicePlatform = (d: BoardDevice | undefined): string | null => d?.platform ?? d?.status?.platform ?? null

/**
 * Browser OS platform mapped to Node `process.platform` values (`win32`, `darwin`, `linux`), or
 * `null` when unknown / mobile.
 */
export function browserPlatform(
  nav:
    | { userAgentData?: { platform?: string }; platform?: string; userAgent?: string }
    | undefined = typeof navigator !== 'undefined'
    ? (navigator as { userAgentData?: { platform?: string }; platform?: string; userAgent?: string })
    : undefined,
): 'win32' | 'darwin' | 'linux' | null {
  if (!nav) return null
  const raw = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`.toLowerCase()
  if (raw.includes('win')) return 'win32'
  if ((raw.includes('mac') || raw.includes('darwin')) && !raw.includes('iphone') && !raw.includes('ipad'))
    return 'darwin'
  if ((raw.includes('linux') || raw.includes('x11')) && !raw.includes('android')) return 'linux'
  return null
}

/** Whether `path` fits a device of `platform` (`~` fits any platform). */
export function pathMatchesPlatform(path: string, platform: string | null): boolean {
  if (!platform) return true
  const trimmed = path.trim()
  if (trimmed === '~' || /^~[\\/]/.test(trimmed)) return true
  const win = /^[A-Za-z]:[\\/]|^\\\\/.test(trimmed)
  return platform === 'win32' ? win : !win
}

function retryRefusedDevice(retry: LaunchContext['retry']): string | undefined {
  const pin = retry?.place?.refuse?.kind === 'pinned-away' ? retry.place.refuse.pin : undefined
  return pin && 'device' in pin ? pin.device : undefined
}

/**
 * Adaptive default device when opening New session in multi-node setups; null on single-device boards.
 * Priority:
 * 1. Context card / retry device
 * 2. Active board device filter
 * 3. Remembered browser choice (localStorage)
 * 4. Node's own page (`relayedDevices`) -> `local`
 * 5. Browser OS match against online remote nodes when browser OS differs from master
 * 6. Fallback: `local` (or first online device if `local` unavailable)
 */
export function deviceStart(
  ctx: LaunchContext,
  s: {
    devices?: readonly BoardDevice[] | undefined
    filterDevice?: string | undefined
    remembered?: string | null | undefined
    relayedDevices?: { master: string } | undefined
    browserOs?: string | null | undefined
  },
): string | null {
  const devices = s.devices
  if (!devices || !offersDevices(devices)) return null
  const isOnline = (id: string | undefined): id is string => {
    if (!id) return false
    const d = devices.find(x => x.id === id)
    return !!d && reachable(d)
  }

  // 1. Context card / retry
  const ctxDevice = ctx.item
    ? (ctx.item.device ?? LOCAL)
    : ctx.retry
      ? (ctx.retry.device ?? ctx.retry.place?.device ?? retryRefusedDevice(ctx.retry) ?? LOCAL)
      : undefined
  if (isOnline(ctxDevice)) return ctxDevice

  // 2. Active board device filter
  if (s.filterDevice && s.filterDevice !== 'all' && isOnline(s.filterDevice)) return s.filterDevice

  // 3. Remembered browser choice
  if (isOnline(s.remembered ?? undefined)) return s.remembered as string

  // 4. Node's own page
  if (s.relayedDevices && isOnline(LOCAL)) return LOCAL

  // 5. Browser OS match
  if (s.browserOs) {
    const masterOs = devicePlatform(devices.find(d => d.id === LOCAL))
    if (masterOs && s.browserOs !== masterOs) {
      const matched = devices.find(d => d.id !== LOCAL && reachable(d) && devicePlatform(d) === s.browserOs)
      if (matched) return matched.id
    }
  }

  // 6. Fallback
  return isOnline(LOCAL) ? LOCAL : (devices.find(reachable)?.id ?? LOCAL)
}

export function deviceRow(
  picked: string | null,
  devices: readonly BoardDevice[] | undefined,
  t: Translator,
): DeviceRow {
  if (!devices || !offersDevices(devices) || picked === null) return NO_DEVICE_ROW
  const colors = resolveDeviceColors(devices)
  return {
    offered: true,
    options: devices.map(d => {
      const title = deviceTitle(d, t)
      const online = reachable(d)
      return {
        id: d.id,
        title,
        color: (colors.get(d.id) ?? deviceColorFallback(d.id)).hex,
        pressed: d.id === picked,
        online,
        titleAttr: online ? '' : t('node.offline', { name: title }),
      }
    }),
  }
}

/** `pin` payload for `POST /api/launch` on multi-node boards; empty on single-device boards. */
export const deviceBody = (
  picked: string | null,
  devices: readonly BoardDevice[] | undefined,
): { pin?: { device: string } } =>
  picked !== null && offersDevices(devices) && devices?.some(d => d.id === picked) ? { pin: { device: picked } } : {}
