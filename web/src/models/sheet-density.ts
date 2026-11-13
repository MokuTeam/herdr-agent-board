// How much of the session sheet's head shows (#345): everything, or one compact row (status, title,
// helpers count, close) with the rest folded under it, the open question cut to two lines and the
// action row folded behind the footer line. The choice is this browser's (localStorage), kept once
// per width class: a phone's width starts compact, a wider panel starts whole, and a narrow desktop
// window and a wide one do not overwrite each other. It is not per session and not on the server.

export type DensityClass = 'phone' | 'wide'

/** Where the choice is kept, for a width class. */
export const DENSITY_KEYS: Record<DensityClass, string> = {
  phone: 'board.sheetHead.phone',
  wide: 'board.sheetHead.wide',
}

export const densityClass = (phone: boolean): DensityClass => (phone ? 'phone' : 'wide')

/** Without a choice: the phone's sheet starts compact, a wider panel whole. */
export const defaultCompact = (width: DensityClass): boolean => width === 'phone'

/** What this browser kept for `width` (`raw`: the stored text); nothing, or anything else, is the default. */
export function keptCompact(width: DensityClass, raw: string | null): boolean {
  if (raw === 'compact') return true
  if (raw === 'full') return false
  return defaultCompact(width)
}

export const densityValue = (compact: boolean): 'compact' | 'full' => (compact ? 'compact' : 'full')
