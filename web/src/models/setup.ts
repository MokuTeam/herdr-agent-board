// The setup note, the logic without a page: when the toolbar shows it, the list's order, the
// command that fixes several things shown once on top, and where the list hangs from the note.
// The server checks (src/core/setup.ts) and sends `setup: { todo, sig }` with the board.
import type { SetupCheck, SetupLevel, SetupSummary } from '../../../src/core/setup.ts'

export type { SetupCheck, SetupLevel, SetupSummary }

/** Where "Hide until something changes" keeps the problems it was asked to hide. */
export const SETUP_HIDDEN_KEY = 'board.setupHidden'

const ORDER: Record<SetupLevel, number> = { error: 0, warn: 1, off: 2, na: 3, ok: 4 }
const LEVELS = new Set<string>(Object.keys(ORDER))

/**
 * Whether the toolbar shows the note: while the list is open (it stays where the list hangs from,
 * even once the last problem is fixed), or while something needs a look that was not hidden.
 */
export const noteShown = (open: boolean, summary: SetupSummary | null | undefined, hiddenSig: string): boolean =>
  open || (!!summary && summary.todo > 0 && hiddenSig !== summary.sig)

/** How many checks need a look (what does not work, not what is merely off). */
export const problems = (checks: readonly SetupCheck[]): number =>
  checks.filter(c => c.level === 'error' || c.level === 'warn').length

/** One row of the list and what it shows of its check. */
export interface SetupRow {
  check: SetupCheck
  problem: boolean
  /** The fix line under it (none when the shared command on top says it). */
  fix: boolean
  /** Its own command to copy (none when it is the shared one). */
  code: boolean
}

export interface SetupList {
  /** A command that fixes several of them (the install, as a rule), shown once on top with its fix. */
  common: { fix: string; code: string } | null
  rows: SetupRow[]
}

/** The checks in order (problems first), the shared command lifted out. */
export function setupList(checks: readonly SetupCheck[]): SetupList {
  const sorted = [...checks].sort((a, b) => ORDER[a.level] - ORDER[b.level])
  const uses = new Map<string, number>()
  for (const c of sorted) if (c.level !== 'ok' && c.code) uses.set(c.code, (uses.get(c.code) ?? 0) + 1)
  const code = [...uses].find(([, n]) => n > 1)?.[0]
  const lead = code ? sorted.find(c => c.code === code && c.fix) : undefined
  const rows = sorted.map(check => {
    const problem = check.level !== 'ok'
    const shared = !!check.code && check.code === code
    return {
      check,
      problem,
      fix: problem && !!check.fix && !(shared && !!lead && check.fix === lead.fix),
      code: problem && !!check.code && !shared,
    }
  })
  return { common: code && lead ? { fix: lead.fix, code } : null, rows }
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
}

/**
 * Under the note when there is room, its right edge on the note's, grown out of the note's
 * corner: left, top and the transform's origin.
 */
export function setupPopPlace(
  note: Box,
  pop: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; origin: string } {
  const left = Math.max(8, Math.min(note.right - pop.width, viewport.width - pop.width - 8))
  const below = note.bottom + 8 + pop.height <= viewport.height
  const top = below ? note.bottom + 8 : Math.max(8, note.top - pop.height - 8)
  return { left, top, origin: `${Math.round(note.left + note.width / 2 - left)}px ${below ? 0 : pop.height}px` }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const isCheck = (v: unknown): v is SetupCheck =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  typeof v.level === 'string' &&
  LEVELS.has(v.level) &&
  ['title', 'detail', 'fix', 'code'].every(k => typeof v[k] === 'string')

/** The board payload's `setup` (null before the server's first check). */
export const isSetupSummary = (v: unknown): v is SetupSummary =>
  isRecord(v) && typeof v.todo === 'number' && typeof v.sig === 'string'

/** GET /api/setup: the checks, and the summary the board would send. */
export interface SetupReply {
  checks: SetupCheck[]
  todo: number
  sig: string
}

export const isSetupReply = (v: unknown): v is SetupReply =>
  isRecord(v) &&
  Array.isArray(v.checks) &&
  v.checks.every(isCheck) &&
  typeof v.todo === 'number' &&
  typeof v.sig === 'string'
