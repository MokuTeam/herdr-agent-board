// Sessions moved to another Claude profile, keeping their conversation (#250, `board move`). Each
// one asleep first: one asleep already as it is, a free one put to sleep as `board sleep` does
// (services/sleep.ts), a busy one refused with the reason, or with `whenFree` given a sleep entry
// that moves it once it is asleep (services/scheduler.ts). Then its conversation copied into the
// target profile's folder (adapters/move-files.ts; the originals stay), the source profile's trust
// in its folder with it, and its card and wake's entry switched to that folder: `board resume` and
// every wake run it there, with no "wrong profile" tag. One that was awake is woken again, now in
// the new profile; one that was asleep stays asleep.
import { homedir } from 'node:os'
import { writeCard } from '../adapters/cards.ts'
import { copySession, copyTrust } from '../adapters/move-files.ts'
import { claudeStateFile, moveProfile, moveSource } from '../core/move.ts'
import type { Profile } from '../core/profiles.ts'
import { SESSION_ID } from '../core/resume.ts'
import type { SessionRef } from '../core/schedule-rules.ts'
import type { Item } from '../core/types.ts'
import type { BoardWake } from '../integrations/wake.ts'
import { wake } from './actions.ts'
import type { Deps } from './deps.ts'
import { type SleepOutcome, sessionsFor, sleepMany } from './sleep.ts'

/**
 * How it went for one target: moved; scheduled (once free, its sleep entry `sleep.id`); or refused,
 * `why` saying why, or `sleep` saying what kept it up when it could not be put to sleep.
 */
export interface MoveOutcome {
  /** The name, id or pane as asked. */
  target: string
  result: 'moved' | 'scheduled' | 'refused'
  why?: string
  /** What putting it to sleep came to, for one that was not asleep and was not moved. */
  sleep?: SleepOutcome
  key?: string
  name?: string
  pane?: string | null
  /** What else happened with a move: the trust copied, wake's entry, woken again or not. */
  notes?: string[]
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Move the sessions `targets` name (`items`: the board's sessions) to the profile `profile`, one
 * after the other, a session named twice once. `by` and `from` go into the entries `whenFree`
 * makes. One outcome per target, in their order.
 */
export async function moveMany(
  deps: Deps,
  items: readonly Item[],
  targets: readonly string[],
  {
    profile,
    whenFree = false,
    by = 'agent',
    from,
  }: { profile: string; whenFree?: boolean; by?: string; from?: SessionRef },
): Promise<MoveOutcome[]> {
  const asked = [...new Set(targets.map(s => s.trim()).filter(Boolean))]
  const set = deps.profiles()
  const to = moveProfile(set.list, profile)
  if ('error' in to) return asked.map(target => ({ target, result: 'refused', why: to.error }))
  // By target for what is refused before a session is known, by session key after.
  const done = new Map<string, MoveOutcome>()
  const checked: { target: string; item: Item }[] = []
  const seen = new Set<string>()
  for (const target of asked) {
    const fits = sessionsFor(items, target)
    const item = fits[0]
    if (!item) {
      done.set(target, { target, result: 'refused', why: 'no such session on the board' })
      continue
    }
    if (fits.length > 1) {
      const several = fits.map(i => `${i.name} in ${i.pane ?? '?'}`).join(', ')
      done.set(target, {
        target,
        result: 'refused',
        why: `fits several sessions (${several}); give its session id or pane`,
      })
      continue
    }
    if (seen.has(item.key)) continue
    seen.add(item.key)
    const who = { key: item.key, name: item.name, pane: item.pane }
    const why =
      item.agent !== 'claude' || !item.session || !SESSION_ID.test(item.session)
        ? 'not a Claude session'
        : (() => {
            const src = moveSource(item, set.list, to.profile)
            return 'error' in src ? src.error : ''
          })()
    if (why) done.set(item.key, { target, result: 'refused', why, ...who })
    else checked.push({ target, item })
  }
  // The awake ones put to sleep first, at once, as `board sleep` does; with whenFree the busy ones
  // get a sleep entry that moves them once they are asleep.
  const awake = checked.filter(c => !c.item.sleeping)
  const slept = awake.length
    ? await sleepMany(
        deps,
        items,
        awake.map(c => c.item.key),
        { whenFree, by, ...(from && { from }), moveTo: to.profile.id },
      )
    : []
  const sleepOf = new Map(slept.map(o => [o.key ?? o.target, o]))
  for (const { target, item } of checked) {
    const who = { key: item.key, name: item.name, pane: item.pane }
    const s = item.sleeping ? null : sleepOf.get(item.key)
    if (s && s.result === 'scheduled') {
      done.set(item.key, { target, result: 'scheduled', sleep: s, ...who })
      continue
    }
    if (s && s.result === 'kept') {
      done.set(item.key, { target, result: 'refused', sleep: s, ...who })
      continue
    }
    const r = await moveAsleep(deps, item, to.profile, { wakeAfter: s?.result === 'asleep' })
    const outcome: MoveOutcome = r.ok
      ? { target, result: 'moved', notes: r.notes, ...who }
      : { target, result: 'refused', why: r.error, ...who }
    done.set(item.key, outcome)
  }
  // A session two targets name answers under each.
  return asked.map((target): MoveOutcome => {
    const fits = sessionsFor(items, target)
    const own = done.get(target) ?? (fits.length === 1 && fits[0] ? done.get(fits[0].key) : undefined)
    return own ? { ...own, target } : { target, result: 'refused', why: 'no such session on the board' }
  })
}

/**
 * The profile `id` names, for a move: listed and shown, else why not. For the scheduler, which
 * keeps only the id in a sleep entry.
 */
export function moveTarget(deps: Pick<Deps, 'profiles'>, id: string): { profile: Profile } | { error: string } {
  return moveProfile(deps.profiles().list, id)
}

/**
 * One session asleep moved to `to`: its conversation copied, the source profile's trust in its
 * folder copied, its card and wake's entry switched. `wakeAfter`: it was awake before the move,
 * and is woken again, in the new profile. The notes say what else happened.
 */
export async function moveAsleep(
  deps: Deps,
  item: Item,
  to: Profile,
  {
    wakeAfter = false,
    home = homedir(),
    platform = process.platform,
  }: { wakeAfter?: boolean; home?: string; platform?: string } = {},
): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }> {
  const src = moveSource(item, deps.profiles().list, to)
  if ('error' in src) return { ok: false, error: src.error }
  const session = item.session ?? ''
  const copied = copySession(src.dir, to.dir, session, item.cwd)
  if (!copied.ok) return copied
  const notes: string[] = []
  try {
    const from = claudeStateFile(src.dir, home, platform)
    if (copyTrust(from, claudeStateFile(to.dir, home, platform), item.cwd, platform)) notes.push('folder trust copied')
  } catch (err) {
    notes.push(`folder trust not copied (${messageOf(err)})`)
  }
  writeCard(item.key, { profileDir: to.dir, profile: to.id, profileWant: '' })
  // Wake's entry: the board's own wake keeps it in memory, so only it changes it. Without one the
  // card decides: `board resume` takes its folder first.
  const board = deps.wake as Partial<BoardWake>
  if (board.mode === 'new' && typeof board.moveProfile === 'function') {
    const r = await board.moveProfile(session, to.dir)
    if (!r.ok) notes.push(`wake's entry not changed, the card decides (${r.error})`)
    deps.wake.forget()
  }
  if (wakeAfter) {
    // By its session id: its pane may have closed as it went to sleep (#204).
    const { profileFolder: _folder, profileWanted: _want, ...rest } = item
    const woke = await wake(deps, { ...rest, pane: null, sleeping: true, profile: to.id }).finally(() =>
      deps.wake.forget(),
    )
    notes.push(woke.ok ? 'woken again' : `asleep, not woken again (${woke.error ?? ''})`)
  }
  return { ok: true, notes }
}
