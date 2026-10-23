// Several sessions put to sleep in one go (`board sleep`, POST /api/sleep), for a session that
// coordinates others: every one that is free now goes to sleep through herdr-wake, after the
// checks a restart makes (actions.ts readyToSleep), and each says how it went: asleep, or kept up
// and why. With `whenFree`, one held for a reason that passes (a turn, a dialog, the user's draft,
// background tasks, herdr-wake refusing) gets a schedule entry of kind 'sleep' instead, which the
// scheduler carries out once it is free (services/scheduler.ts). Claude sessions, and pi sessions
// where the board's own wake runs (#178): herdr-wake puts no other agent to sleep.
import { askSleep } from '../adapters/schedule-store.ts'
import { isPiItem } from '../core/pi.ts'
import type { SessionRef } from '../core/schedule-rules.ts'
import type { Item } from '../core/types.ts'
import { readyToSleep, sleepSession, wakeSleepsPi } from './actions.ts'
import type { Deps } from './deps.ts'

/**
 * Why a session stays up (or, scheduled, what holds it now): busy, dialog, draft, tasks (what
 * passes), gone (another session in its pane now), unknown (no session on the board by that name,
 * id or pane), ambiguous (a name several go by), notClaude, profile (its profile is not known),
 * refused (herdr-wake said no), error (herdr did not answer). `detail` says more for the last
 * four.
 */
export type SleepWhy =
  | 'busy'
  | 'dialog'
  | 'draft'
  | 'tasks'
  | 'gone'
  | 'unknown'
  | 'ambiguous'
  | 'notClaude'
  | 'profile'
  | 'refused'
  | 'error'

/** How it went for one target: asleep now, asleep already, scheduled (entry `id`), or kept up. */
export interface SleepOutcome {
  /** The name, id or pane as asked. */
  target: string
  result: 'asleep' | 'already' | 'scheduled' | 'kept'
  why?: SleepWhy
  detail?: string
  key?: string
  name?: string
  pane?: string | null
  /** The schedule entry, and whether it was asked for before. */
  id?: string
  again?: boolean
}

type Outcome = Omit<SleepOutcome, 'target'>

// Sessions put to sleep at once: each takes herdr several calls, and herdr-wake waits for /exit.
const AT_ONCE = 4
const PASSES: ReadonlySet<string> = new Set(['busy', 'dialog', 'draft', 'tasks'])

/** The sessions on the board a target fits: by its id or pane exactly, else by its name (any case). */
export function sessionsFor(items: readonly Item[], target: string): Item[] {
  const want = target.trim().toLowerCase()
  if (!want) return []
  const fits = (i: Item, fields: readonly ('key' | 'session' | 'pane' | 'name' | 'autoName')[]): boolean =>
    fields.some(f => {
      const v = i[f]
      return typeof v === 'string' && v.toLowerCase() === want
    })
  const exact = items.filter(i => fits(i, ['key', 'session', 'pane']))
  return exact.length ? exact : items.filter(i => fits(i, ['name', 'autoName']))
}

/**
 * Put the sessions `targets` name to sleep (`items`: the board's sessions), AT_ONCE at a time, a
 * session named twice once. `by` and `from` go into the entries `whenFree` makes. One outcome per
 * target, in their order; a target asked twice answers once.
 */
export async function sleepMany(
  deps: Deps,
  items: readonly Item[],
  targets: readonly string[],
  { whenFree = false, by = 'agent', from }: { whenFree?: boolean; by?: string; from?: SessionRef } = {},
): Promise<SleepOutcome[]> {
  const asked = [...new Set(targets.map(s => s.trim()).filter(Boolean))].map(target => ({
    target,
    fits: sessionsFor(items, target),
  }))
  const unique = new Map<string, Item>()
  for (const { fits } of asked) if (fits.length === 1 && fits[0]) unique.set(fits[0].key, fits[0])
  const done = new Map<string, Outcome>()
  const queue = [...unique.values()]
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift())
      done.set(item.key, await sleepOne(deps, item, { whenFree, by, ...(from && { from }) }))
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker))
  return asked.map(({ target, fits }): SleepOutcome => {
    const item = fits[0]
    if (!item) return { target, result: 'kept', why: 'unknown' }
    if (fits.length > 1)
      return {
        target,
        result: 'kept',
        why: 'ambiguous',
        detail: fits.map(i => `${i.name} in ${i.pane ?? '?'}`).join(', '),
      }
    const outcome = done.get(item.key) ?? { result: 'kept', why: 'error' }
    return { target, key: item.key, name: item.name, pane: item.pane, ...outcome }
  })
}

async function sleepOne(
  deps: Deps,
  item: Item,
  opts: { whenFree: boolean; by: string; from?: SessionRef },
): Promise<Outcome> {
  if (item.sleeping) return { result: 'already' }
  // pi too, where the board's own wake puts sessions to sleep (#178); the separate plugin does not.
  const agentOk = item.agent === 'claude' || (isPiItem(item) && wakeSleepsPi(deps))
  if (!item.session || !item.pane || !agentOk) return { result: 'kept', why: 'notClaude' }
  const ready = await readyToSleep(deps, item)
  if (!ready.ok) {
    const why: SleepWhy = PASSES.has(ready.why)
      ? (ready.why as SleepWhy)
      : ready.profile
        ? 'profile'
        : ready.why === 'gone'
          ? 'gone'
          : 'error'
    if (opts.whenFree && PASSES.has(why)) return later(item, why, opts)
    return { result: 'kept', why, ...((why === 'profile' || why === 'error') && { detail: ready.why }) }
  }
  // herdr's status as just read: a turn that ended meanwhile is not "working".
  const r = await sleepSession(deps, { ...item, status: ready.status }).finally(() => deps.wake.forget())
  if (r.ok) return { result: 'asleep' }
  // herdr-wake said no: the session got to work meanwhile, or /exit asked about background tasks.
  return opts.whenFree ? later(item, 'refused', opts, r.error) : { result: 'kept', why: 'refused', detail: r.error }
}

/** To sleep once it is free: its entry (askSleep), or kept up when the schedule has no room for it. */
function later(item: Item, why: SleepWhy, opts: { by: string; from?: SessionRef }, detail?: string): Outcome {
  try {
    const { entry, again } = askSleep({
      key: item.key,
      name: item.name,
      ...(item.pane && { pane: item.pane }),
      ...(item.cwd && { cwd: item.cwd }),
      by: opts.by,
      ...(opts.from && { from: opts.from }),
    })
    return { result: 'scheduled', why, id: entry.id, again, ...(detail && { detail }) }
  } catch (err) {
    return { result: 'kept', why: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
}
