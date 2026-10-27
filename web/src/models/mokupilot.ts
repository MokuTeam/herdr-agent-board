// Settings → MokuPilot…, its rules on their own: GET /api/mokupilot's answer read through its guard
// (src/server/routes/mokupilot.ts), and the line that says where a call from this browser starts
// right now under Auto.
import { MOKUPILOT_MODES, type MokupilotMode } from '../../../src/core/mokupilot-mode.ts'
import type { Translator } from '../../../src/core/types.ts'

export { MOKUPILOT_MODES, type MokupilotMode }

/** Where a call starts and the branch that decided (src/core/mokupilot-mode.ts resolveMode). */
export interface MokupilotPlace {
  resolved: 'local' | 'link'
  why: string
  viewer?: string
}

/** GET /api/mokupilot's answer, as far as the page relies on it. */
export interface MokupilotView extends MokupilotPlace {
  mode: MokupilotMode
  off: boolean
  /** MokuPilot on the board's computer: what `local` would start. */
  here: 'ok' | 'missing'
  hereFile?: string
  /** Where a call from this browser would start under Auto. */
  auto: MokupilotPlace
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isPlace = (v: unknown): v is MokupilotPlace =>
  isRecord(v) && (v.resolved === 'local' || v.resolved === 'link') && typeof v.why === 'string'

export const isMokupilotView = (v: unknown): v is MokupilotView =>
  isRecord(v) &&
  (MOKUPILOT_MODES as readonly unknown[]).includes(v.mode) &&
  typeof v.off === 'boolean' &&
  (v.here === 'ok' || v.here === 'missing') &&
  isPlace(v) &&
  isPlace(v.auto)

/** "Right now, from this browser: …" for Auto's answer; none yet: the board is being asked. */
export function nowLine(view: MokupilotView | null, t: Translator): string {
  if (!view) return t('mokupilot.now.asking')
  return t(view.auto.resolved === 'link' ? 'mokupilot.now.link' : 'mokupilot.now.local')
}

/** What decided Auto's answer, for a wrong guess to be told: the branch, and the address taken for the viewer. */
export function whyLine(view: MokupilotView | null, t: Translator): string {
  if (!view) return ''
  const { why, viewer } = view.auto
  return t('mokupilot.now.why', { why: viewer ? `${why}, ${viewer}` : why })
}
