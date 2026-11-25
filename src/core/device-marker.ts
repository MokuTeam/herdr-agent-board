// How a card shows the machine it runs on (#789): the coloured corner of #758 / #771 (the default),
// a thin coloured stripe along one side, or nothing; its place and size. Kept in config.json as
// `nodes.marker` (only what differs from the default), set in Settings, Devices, and sent in the
// payload as `deviceMarker` only while it differs, so a board that never touched it draws as
// before. Zero-dependency leaf module: web/src/ reads it too.

export const MARKER_STYLES = ['corner', 'stripe', 'off'] as const
export type MarkerStyle = (typeof MARKER_STYLES)[number]

export const CORNER_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
export type CornerPosition = (typeof CORNER_POSITIONS)[number]

export const STRIPE_POSITIONS = ['left', 'right', 'top', 'bottom'] as const
export type StripePosition = (typeof STRIPE_POSITIONS)[number]

export type MarkerPosition = CornerPosition | StripePosition

export const MARKER_SIZES = ['small', 'medium', 'large'] as const
export type MarkerSize = (typeof MARKER_SIZES)[number]

export interface DeviceMarker {
  style: MarkerStyle
  position: MarkerPosition
  size: MarkerSize
}

/** Today's look: the corner at the bottom-right, medium (11px; 9px on a compact card). */
export const DEFAULT_MARKER: DeviceMarker = { style: 'corner', position: 'bottom-right', size: 'medium' }

/** The place a style starts at: the corner bottom-right (the card actions sit top-right), the stripe left. */
export const defaultMarkerPosition = (style: MarkerStyle): MarkerPosition =>
  style === 'stripe' ? 'left' : 'bottom-right'

/** The places a style may take; none for off. */
export const markerPositions = (style: MarkerStyle): readonly MarkerPosition[] =>
  style === 'corner' ? CORNER_POSITIONS : style === 'stripe' ? STRIPE_POSITIONS : []

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

export const MARKER_KEYS = ['style', 'position', 'size'] as const

/**
 * `nodes.marker` read: the marker it gives, or null when it is not one (not an object, an unknown
 * key, a value outside its list, a place the style does not take). An absent key (or null) takes
 * the default: the style's own place, medium.
 */
export function deviceMarkerOf(raw: unknown): DeviceMarker | null {
  if (!isObject(raw)) return null
  if (Object.keys(raw).some(k => !(MARKER_KEYS as readonly string[]).includes(k))) return null
  const given = (v: unknown) => v !== undefined && v !== null
  if (given(raw.style) && !oneOf(MARKER_STYLES, raw.style)) return null
  const style: MarkerStyle = oneOf(MARKER_STYLES, raw.style) ? raw.style : DEFAULT_MARKER.style
  let position = defaultMarkerPosition(style)
  if (given(raw.position)) {
    if (style === 'off') {
      if (!oneOf([...CORNER_POSITIONS, ...STRIPE_POSITIONS], raw.position)) return null
      position = raw.position as MarkerPosition
    } else if (oneOf(markerPositions(style), raw.position)) position = raw.position
    else return null
  }
  if (given(raw.size) && !oneOf(MARKER_SIZES, raw.size)) return null
  const size: MarkerSize = oneOf(MARKER_SIZES, raw.size) ? raw.size : DEFAULT_MARKER.size
  return { style, position, size }
}

/** The payload's `deviceMarker` read for the page: today's look when absent or not one. */
export const markerOrDefault = (raw: unknown): DeviceMarker => deviceMarkerOf(raw) ?? DEFAULT_MARKER

export const isDefaultMarker = (m: DeviceMarker): boolean =>
  m.style === DEFAULT_MARKER.style && m.position === DEFAULT_MARKER.position && m.size === DEFAULT_MARKER.size

/**
 * A marker as config.json keeps it: only the keys that differ from the default of its style, null
 * when nothing differs (the key goes).
 */
export function markerConfigOf(m: DeviceMarker): Record<string, string> | null {
  const out: Record<string, string> = {}
  if (m.style !== DEFAULT_MARKER.style) out.style = m.style
  if (m.style !== 'off' && m.position !== defaultMarkerPosition(m.style)) out.position = m.position
  if (m.style !== 'off' && m.size !== DEFAULT_MARKER.size) out.size = m.size
  return Object.keys(out).length ? out : null
}

/**
 * The classes of a card's marker: null for off. The default gives exactly `card-device-corner`,
 * the class #758 drew, so a board that never set a marker renders the same element.
 */
export function markerClasses(m: DeviceMarker): string[] | null {
  if (m.style === 'off') return null
  if (m.style === 'corner') {
    const out = ['card-device-corner']
    if (m.position !== 'bottom-right') out.push(`at-${m.position}`)
    if (m.size !== 'medium') out.push(`size-${m.size}`)
    return out
  }
  const out = ['card-device-stripe', `at-${m.position}`]
  if (m.size !== 'medium') out.push(`size-${m.size}`)
  return out
}
