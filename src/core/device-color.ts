// Stable per-device colour palette and auto-assignment (#758): zero-dependency leaf module so
// web/src/ can resolve device corner colours without importing core/nodes.ts.

export interface DeviceColorSwatch {
  readonly id: string
  readonly hex: string
}

/**
 * Curated 12-colour palette distinct from card status colours (--green, --orange, --purple, --blue,
 * --red, --gray) and legible against both light and dark card surfaces. The first seven are the
 * automatic ones (#758); the last five (#789) are picked by hand only, so adding them moved no
 * device's automatic colour.
 */
export const DEVICE_COLORS: readonly DeviceColorSwatch[] = [
  { id: 'teal', hex: '#2A9DB0' },
  { id: 'indigo', hex: '#5856D6' },
  { id: 'bronze', hex: '#A2845E' },
  { id: 'rose', hex: '#D64F86' },
  { id: 'sky', hex: '#38A2DB' },
  { id: 'ochre', hex: '#B8952E' },
  { id: 'slate', hex: '#68778C' },
  { id: 'pine', hex: '#2F8F76' },
  { id: 'plum', hex: '#8B4F92' },
  { id: 'clay', hex: '#B4664C' },
  { id: 'olive', hex: '#7F8A3C' },
  { id: 'wine', hex: '#9E3D52' },
] as const

/** How many swatches, from the first, the automatic assignment draws from (#758's seven). */
export const AUTO_COLOR_COUNT = 7
const AUTO_COLORS = DEVICE_COLORS.slice(0, AUTO_COLOR_COUNT)

const BY_ID = new Map(DEVICE_COLORS.map(s => [s.id, s.hex]))
const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** Normalises a configured palette id or #rrggbb hex string; null when invalid. */
export function normalizeDeviceColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (BY_ID.has(s) || HEX_COLOR.test(s)) return s
  return null
}

/** Resolves a palette id or #rrggbb hex string to its #rrggbb hex, falling back to the first swatch. */
export function deviceColorHex(color: string): string {
  const norm = normalizeDeviceColor(color)
  if (!norm) return DEVICE_COLORS[0]?.hex ?? '#2A9DB0'
  return BY_ID.get(norm) ?? norm
}

/**
 * Stable identifier for deterministic auto-colouring: `local` resolves to its machine id
 * (`selfId` / `status.id`) so a device keeps its colour across master handover.
 */
export const stableDeviceKey = (d: {
  id: string
  selfId?: string | undefined
  status?: { id?: string } | null | undefined
}): string => (d.id === 'local' ? d.selfId || d.status?.id || 'local' : d.id)

/** Unsigned 32-bit FNV-1a hash for deterministic colour seeding. */
export function hashDeviceKey(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Single-device fallback colour when a card's device is absent from `devices`. */
export function deviceColorFallback(key: string): DeviceColorSwatch {
  const idx = hashDeviceKey(key) % AUTO_COLORS.length
  return AUTO_COLORS[idx] ?? { id: 'teal', hex: '#2A9DB0' }
}

/**
 * Resolves each device's colour id and hex:
 * 1) Devices with a valid explicit `color` keep it and reserve that swatch id.
 * 2) Remaining devices are processed in sorted `stableDeviceKey` order (so drag-reordering in
 *    Settings -> Devices never reshuffles auto-assigned colours), probing from `hashDeviceKey(key)`
 *    to avoid collisions until all swatches are taken.
 */
export function resolveDeviceColors(
  devices: readonly {
    id: string
    color?: string | undefined
    selfId?: string | undefined
    status?: { id?: string } | null | undefined
  }[],
): Map<string, DeviceColorSwatch> {
  const out = new Map<string, DeviceColorSwatch>()
  const used = new Set<string>()
  const pending: { id: string; key: string }[] = []

  for (const d of devices) {
    const explicit = normalizeDeviceColor(d.color)
    if (explicit) {
      out.set(d.id, { id: explicit, hex: deviceColorHex(explicit) })
      used.add(explicit)
    } else {
      pending.push({ id: d.id, key: stableDeviceKey(d) })
    }
  }

  pending.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const n = AUTO_COLORS.length
  for (const p of pending) {
    const base = hashDeviceKey(p.key) % n
    let chosen: DeviceColorSwatch | undefined
    for (let i = 0; i < n; i++) {
      const candidate = AUTO_COLORS[(base + i) % n]
      if (candidate && !used.has(candidate.id)) {
        chosen = candidate
        used.add(candidate.id)
        break
      }
    }
    out.set(p.id, chosen ?? AUTO_COLORS[base] ?? { id: 'teal', hex: '#2A9DB0' })
  }

  return out
}
