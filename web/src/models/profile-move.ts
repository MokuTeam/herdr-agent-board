// Sessions moved to another Claude profile from the board's menus (#256): POST /api/move, as
// `board move` moves them (src/services/move.ts), and what the toast says of it. A card's move says
// how it went for that one; a lane's sums its sessions up in one toast. One kept up by what passes
// (a turn, a dialog, a draft, background tasks) is refused with the reason, and its toast offers
// "Move once it is free", which asks again with whenFree.
import type { Translator } from '../../../src/core/types.ts'
import type { Reply } from '../api/client.ts'
import type { ToastOptions } from '../state/board-ui.ts'

/** One target as POST /api/move answers it (src/services/move.ts MoveOutcome), as far as the page reads it. */
export interface MoveResult {
  target: string
  result: 'moved' | 'scheduled' | 'refused'
  why?: string
  /** What putting it to sleep came to (src/services/sleep.ts SleepOutcome). */
  sleep?: { result: string; why?: string; detail?: string }
  key?: string
  name?: string
}

/** What keeps a session up only for a while: moved once it is free, it goes. */
const PASSES: readonly string[] = ['busy', 'dialog', 'draft', 'tasks']

/** Why a session was not moved, in the page's words where the board has them, else the server's. */
export function refusedWhy(o: MoveResult, t: Translator): string {
  const why = o.sleep?.why ?? ''
  if (PASSES.includes(why) || why === 'gone') return t(`move.why.${why}`)
  return o.sleep ? o.sleep.detail || why : o.why || ''
}

/** Kept up by what passes: "Move once it is free" would take it. */
export const passes = (o: MoveResult): boolean => o.result === 'refused' && PASSES.includes(o.sleep?.why ?? '')

const isResult = (v: unknown): v is MoveResult =>
  typeof v === 'object' && v !== null && typeof (v as MoveResult).target === 'string'

/** A toast: its text, red or not, and the sessions "Move once it is free" asks for (none: no such button). */
export interface MoveToast {
  text: string
  error: boolean
  later: string[]
}

/** A card's toast: moved, moving once free, or why it stays. */
export function cardToast(o: MoveResult, name: string, profile: string, t: Translator): MoveToast {
  if (o.result === 'moved') return { text: t('move.done', { name, profile }), error: false, later: [] }
  if (o.result === 'scheduled') return { text: t('move.later', { name, profile }), error: false, later: [] }
  return {
    text: t('move.refused', { name, why: refusedWhy(o, t) }),
    error: true,
    later: passes(o) ? [o.key ?? o.target] : [],
  }
}

/**
 * A lane's toast: how many moved, how many go once free, how many stay and why (each by name),
 * and what became of its usual profile (`usual`: '' for nothing asked, else the text to add).
 */
export function laneToast(
  results: readonly MoveResult[],
  lane: string,
  profile: string,
  t: Translator,
  usual = '',
): MoveToast {
  const count = (r: MoveResult['result']) => results.filter(o => o.result === r).length
  const moved = count('moved')
  const later = count('scheduled')
  const refused = results.filter(o => o.result === 'refused')
  const parts = [
    t('move.sum.moved', { n: moved, profile }),
    later && t('move.sum.later', { n: later }),
    refused.length &&
      `${t('move.sum.refused', { n: refused.length })} (${refused.map(o => `${o.name || o.target}: ${refusedWhy(o, t)}`).join('; ')})`,
    usual,
  ].filter(Boolean)
  return {
    text: t('move.sum', { lane, parts: parts.join(', ') }),
    error: refused.length > 0 && !moved && !later,
    later: refused.filter(passes).map(o => o.key ?? o.target),
  }
}

/** What a move from the page goes with. */
export interface MoveDeps {
  t(): Translator
  /** POST to the board; throws when it says no (api/client.ts post). */
  post(path: string, body: unknown): Promise<Reply>
  /** The text of a failed call (api/client.ts errorText). */
  errorText(err: unknown): string
  toast(text: string, error?: boolean, options?: ToastOptions): void
  /** The card's busy label while it moves (null: done). */
  busy(key: string, label: string | null): void
  /** The title of the profile `id`. */
  title(id: string): string
  /** A session's name on the board. */
  name(key: string): string
}

/** POST /api/move: the outcomes, or the call's error for every target. */
async function moveKeys(deps: MoveDeps, keys: readonly string[], profile: string, whenFree: boolean) {
  const label = deps.t()('move.busy')
  for (const key of keys) deps.busy(key, label)
  try {
    const reply = await deps.post('/api/move', { targets: keys, profile, ...(whenFree && { whenFree: true }) })
    const results = Array.isArray(reply.results) ? reply.results.filter(isResult) : []
    return { ok: true as const, results }
  } catch (err) {
    return { ok: false as const, error: deps.errorText(err) }
  } finally {
    for (const key of keys) deps.busy(key, null)
  }
}

/** A toast with "Move once it is free" when some session was kept up by what passes. */
function show(deps: MoveDeps, toast: MoveToast, profile: string): void {
  const t = deps.t()
  deps.toast(toast.text, toast.error, {
    ...(toast.later.length && {
      action: { label: t('move.whenFree'), run: () => void moveLater(deps, toast.later, profile) },
    }),
  })
}

/** "Move once it is free": each a sleep entry that moves it once it is asleep. */
async function moveLater(deps: MoveDeps, keys: readonly string[], profile: string): Promise<void> {
  const r = await moveKeys(deps, keys, profile, true)
  if (!r.ok) return deps.toast(r.error, true)
  const t = deps.t()
  const title = deps.title(profile)
  const [one] = r.results
  if (r.results.length === 1 && one)
    return show(deps, cardToast(one, deps.name(one.key ?? one.target), title, t), profile)
  const later = r.results.filter(o => o.result === 'scheduled').length
  const stays = r.results.filter(o => o.result !== 'scheduled')
  deps.toast(
    [t('move.sum.later', { n: later }), ...stays.map(o => `${o.name || o.target}: ${refusedWhy(o, t)}`)].join('; '),
    stays.length > 0 && !later,
  )
}

/** A card's session to the profile `profile`: put to sleep, moved and woken again, as `board move` does. */
export async function moveCard(deps: MoveDeps, key: string, profile: string): Promise<void> {
  const r = await moveKeys(deps, [key], profile, false)
  if (!r.ok) return deps.toast(r.error, true)
  const [one] = r.results
  if (!one) return
  show(deps, cardToast(one, deps.name(key), deps.title(profile), deps.t()), profile)
}

/**
 * A lane's Claude sessions (`keys`) to the profile `profile`, one toast for them all; with `usual`,
 * it becomes the lane's usual profile too (POST /api/categories, as the categories panel sets it).
 */
export async function moveLane(
  deps: MoveDeps,
  lane: { id: string; title: string },
  keys: readonly string[],
  profile: string,
  usual: boolean,
): Promise<void> {
  const t = deps.t()
  const title = deps.title(profile)
  const [moves, set] = await Promise.all([
    keys.length ? moveKeys(deps, keys, profile, false) : Promise.resolve({ ok: true as const, results: [] }),
    usual
      ? deps.post('/api/categories', { op: 'update', id: lane.id, profile }).then(
          () => t('move.sum.usual', { profile: title }),
          err => t('move.err.usual', { lane: lane.title, why: deps.errorText(err) }),
        )
      : Promise.resolve(''),
  ])
  if (!moves.ok) return deps.toast(set ? `${moves.error}; ${set}` : moves.error, true)
  show(deps, laneToast(moves.results, lane.title, title, t, set), profile)
}
