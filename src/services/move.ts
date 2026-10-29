// Sessions moved to another Claude profile, keeping their conversation (#250, `board move`). Each
// one asleep first: one asleep already as it is, a free one put to sleep as `board sleep` does
// (services/sleep.ts), a busy one refused with the reason, or with `whenFree` given a sleep entry
// that moves it once it is asleep (services/scheduler.ts). Then its conversation copied into the
// target profile's folder (adapters/move-files.ts; the originals stay), the source profile's trust
// in its folder with it, and its card and wake's entry switched to that folder: `board resume` and
// every wake run it there, with no "wrong profile" tag. One that was awake is woken again, now in
// the new profile; one that was asleep stays asleep. The board's card and lane menus move them
// through POST /api/move (server/routes/move.ts, #256).
import { homedir } from 'node:os'
import { writeCard } from '../adapters/cards.ts'
import { checkCopy, copySession, copyTrust } from '../adapters/move-files.ts'
import { itemProfile } from '../core/item-profile.ts'
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
 * The folder wake's entry names for a session whose card names no profile and no folder (a card
 * from before the board kept profiles, #256), else ''. Wake is asked only for such a one.
 */
async function wakeDirOf(deps: Deps, item: Item, list: readonly Profile[]): Promise<string> {
  if (!item.session || item.profileFolder || itemProfile(item, list)) return ''
  const s = (await deps.wake.sleepers()).find(x => x.session === item.session)
  return s?.profile?.dir ?? ''
}

/** Whether the session `session` runs now in the profile folder `dir`, as its registry there says. */
const runsIn = (deps: Deps, dir: string, session: string): boolean => deps.homes.forDir(dir).liveSessions().has(session)

/**
 * Why the session cannot be moved from `from` to `to`, known before anything is done: it runs in
 * the target profile, or the files refuse (adapters/move-files.ts checkCopy); '' when it can. Asked
 * before a running session is put to sleep, so it is not put to sleep for nothing.
 */
function copyBlock(deps: Deps, item: Item, from: string, to: Profile): string {
  const session = item.session ?? ''
  if (runsIn(deps, to.dir, session)) return `it is running in ${to.id}`
  const check = checkCopy(from, to.dir, session, item.cwd)
  return check.ok ? '' : check.error
}

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
        : await (async () => {
            const src = moveSource(item, set.list, to.profile, await wakeDirOf(deps, item, set.list))
            return 'error' in src ? src.error : copyBlock(deps, item, src.dir, to.profile)
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
    // One failing is its own line; the others still go.
    const r = await moveAsleep(deps, item, to.profile, { wakeAfter: s?.result === 'asleep' }).catch((err: unknown) => ({
      ok: false as const,
      error: messageOf(err),
    }))
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
 * and is woken again, in the new profile. The notes say what else happened. A move cut off
 * halfway is finished by the next one: a target transcript the same as the source's counts as
 * copied (adapters/move-files.ts copySession). Refused when the session runs again in its profile
 * (a reminder or a message woke it meanwhile): its transcript is being written.
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
  const list = deps.profiles().list
  const src = moveSource(item, list, to, await wakeDirOf(deps, item, list))
  if ('error' in src) return { ok: false, error: src.error }
  const session = item.session ?? ''
  if (runsIn(deps, src.dir, session)) return { ok: false, error: 'it is running again' }
  // Resumed by hand in the target meanwhile: its transcript there is being written.
  if (runsIn(deps, to.dir, session)) return { ok: false, error: `it is running in ${to.id}` }
  const copied = copySession(src.dir, to.dir, session, item.cwd)
  if (!copied.ok) return copied
  const notes: string[] = copied.copied.again
    ? ['its conversation was there already, from a move cut off before']
    : copied.copied.back
      ? [`its older copy in ${to.id} brought up to date`]
      : []
  try {
    const from = claudeStateFile(src.dir, home, platform)
    const trust = copyTrust(from, claudeStateFile(to.dir, home, platform), item.cwd, platform)
    if (trust === 'copied') notes.push('folder trust copied')
    if (trust === 'none') notes.push(`folder not trusted in ${to.id}: Claude will ask once`)
  } catch (err) {
    notes.push(`folder trust not copied (${messageOf(err)}): Claude will ask once`)
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
