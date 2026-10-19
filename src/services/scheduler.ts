// Runs the schedule (schedule-store.ts) in the board's process: when an entry is due, its text goes
// into the session's prompt as "[board reminder] <text>", waking the session first when
// herdr-wake put it to sleep. On time by default: a working session gets it queued into its turn.
// A session that waits on a dialog or has the user's unsent text in its input box (and, for an
// `idle` entry, one that works) gets it once it is free, tried on every tick, up to
// `scheduleWaitMin` minutes of trying; then the run is logged as missed. A one-off entry goes
// after its run; a cron one moves to its next time.
//
// Runs that came due while the board was off: a one-off is sent once, saying how late it is; the
// missed runs of a cron entry go as one, saying how many. Time the board was off does not count
// against the wait. An entry is claimed in its file before it is sent, so a second board (a
// restart that overlaps, a test copy) never sends the same run twice.
import { type FSWatcher, mkdirSync, watch } from 'node:fs'
import { beginReport, deferReport, settleReport, verifyReport } from '../adapters/call-receipts.ts'
import { readCard } from '../adapters/cards.ts'
import { scheduleDir } from '../adapters/paths.ts'
import { getEntry, listEntries, logRun, removeEntry, updateEntry } from '../adapters/schedule-store.ts'
import { itemProfile } from '../core/item-profile.ts'
import { t } from '../core/lang.ts'
import { callTitle } from '../core/notices.ts'
import { profileLabel, sessionProfile } from '../core/profiles.ts'
import { promptOf, type ScheduleEntry, targetOf } from '../core/schedule-rules.ts'
import type { Item } from '../core/types.ts'
import { nextRun } from '../core/when.ts'
import { send, wake } from './actions.ts'
import { collect } from './board.ts'
import type { Deps } from './deps.ts'

// A run on its way (waking a session takes up to three minutes) holds its claim this long.
const CLAIM_MS = 5 * 60_000
// Sessions woken at once, so a board back after a night does not start every sleeper together.
const MAX_WAKING = 2
// A cron entry whose session is gone for this many runs in a row is dropped: it would wait and
// miss forever.
const GONE_RUNS = 3

const positive = (v: unknown, fallback: number): number => (Number(v) > 0 ? Number(v) : fallback)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Start sending due entries. `deps.cfg` is the live config: scheduleTickSec (15), scheduleWaitMin
 * (240). `onChange` is called after each run, so the board redraws.
 */
export function startScheduler({ deps, onChange = () => {} }: { deps: Deps; onChange?: () => void }): {
  stop(): void
} {
  const { cfg, log } = deps
  // Five minutes at most: setTimeout takes no more than 24 days, and a larger value runs at once.
  const tickMs = (): number => Math.min(300, Math.max(0.1, positive(cfg.scheduleTickSec, 15))) * 1000
  const patience = (): number => positive(cfg.scheduleWaitMin, 240) * 60_000
  const flying = new Set<string>() // sessions with a run on its way: one at a time per session
  // Runs that went out but whose entry could not be updated (its lock was taken): the next
  // tick finishes the entry instead of sending it again.
  const delivered = new Map<string, number>() // id -> next
  let waking = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let ticking = false
  let stopped = false

  async function tick(): Promise<void> {
    if (ticking || stopped) return
    ticking = true
    try {
      const now = Date.now()
      // A run that waits for its session is tried again once a tick, not on every file change.
      const tried = (e: ScheduleEntry): boolean => typeof e.tried === 'number' && e.tried > now - tickMs() * 0.9
      const due = listEntries().filter(e => e.next <= now && !flying.has(e.key) && !tried(e))
      if (!due.length) return
      // Fresh: whether a session sleeps or works decides what happens now.
      const items = await collect(deps)
      const set = deps.profiles()
      // A session's profile: as its item on the board says, else (gone from the board) its card.
      const profileOf = (key: string): Pick<Item, 'profile' | 'profileFolder'> =>
        items.find(i => i.key === key) ?? sessionProfile(readCard(key), set.list)
      const profileIdOf = (key: string): string | undefined => itemProfile(profileOf(key), set.list)?.id
      for (const entry of due) {
        if (delivered.get(entry.id) === entry.next) {
          finish(entry)
          continue
        }
        const { item, other } = targetOf(entry, items, profileIdOf)
        if (flying.has(entry.key) || (item && flying.has(item.key)) || (item?.sleeping && waking >= MAX_WAKING))
          continue
        const keys = [entry.key, item?.key].filter((k): k is string => !!k)
        for (const k of keys) flying.add(k)
        // The session now in its pane runs in another profile: the entry waits, saying so.
        const held = other
          ? t('sched.err.profile', {
              now: profileLabel(other, set),
              was: profileLabel(profileOf(entry.key), set),
            })
          : ''
        run(entry, item, held)
          .catch(err => log(`schedule ${entry.id}: ${messageOf(err)}`))
          .finally(() => {
            for (const k of keys) flying.delete(k)
            onChange()
          })
      }
    } catch (err) {
      log(`schedule: ${messageOf(err)}`)
    } finally {
      ticking = false
    }
  }

  /** `other`: why it does not go to the session now in its pane (another profile's), '' for none. */
  async function run(entry: ScheduleEntry, item: Item | undefined, other: string): Promise<void> {
    const receipt = entry.receipt ? verifyReport(entry) : null // Before even waking a session.
    if (receipt && receipt.state !== 'queued' && receipt.state !== 'dispatching') {
      removeEntry(entry.id)
      logRun(record(entry, Date.now(), receipt.state))
      return
    }
    const now = Date.now()
    // On time (the default) goes into a working session too, queued into its turn as the user's
    // own mid-turn messages are; `idle` entries wait until it is free. A dialog always waits:
    // typing would answer it.
    const held = item && !item.sleeping && (item.status === 'blocked' || (entry.idle && item.status === 'working'))
    let why = !item ? other || 'gone' : held ? (item.status === 'blocked' ? 'dialog' : 'busy') : ''
    if (item && !why) {
      if (!claim(entry.id, now)) return
      if (item.key !== entry.key) {
        // Followed into the session that took its pane: the card and the log say the new one, the
        // prompt the one it was set for.
        const movedFrom = entry.movedFrom ?? { key: entry.key, name: entry.name ?? '' }
        entry = { ...entry, key: item.key, name: item.name, movedFrom }
        updateEntry(entry.id, e => ({ ...e, key: item.key, name: item.name, movedFrom: e.movedFrom ?? movedFrom }))
      }
      let r: Awaited<ReturnType<typeof send>> = { ok: true }
      if (item.sleeping) {
        waking++
        r = await wake(deps, item).finally(() => {
          waking--
          deps.wake.forget()
        })
        // Cancelled while the session woke up: nothing to send.
        if (r.ok && !getEntry(entry.id)) return
      }
      if (r.ok && entry.receipt) {
        const state = beginReport(entry)
        if (state !== 'dispatching') {
          removeEntry(entry.id)
          logRun(record(entry, Date.now(), state))
          return
        }
      }
      if (r.ok) {
        try {
          r = await send(deps, { ...item, sleeping: false }, promptOf(entry, Date.now()), {
            free: !!entry.idle,
            draft: true,
          })
        } catch (err) {
          if (entry.receipt) settleReport(entry, 'delivery-unknown')
          throw err
        }
        if (entry.receipt && !r.ok && r.busy) {
          deferReport(entry)
          return wait(entry, now, r.draft ? 'draft' : r.dialog ? 'dialog' : 'busy', false)
        }
        if (entry.receipt && !r.ok) {
          settleReport(entry, 'delivery-unknown')
          removeEntry(entry.id)
          logRun(record(entry, Date.now(), 'delivery-unknown', r.error))
          return
        }
      }
      if (r.ok) return sent(entry)
      why = r.draft ? 'draft' : r.dialog ? 'dialog' : r.busy ? 'busy' : r.error
    }
    wait(entry, now, why, !item)
  }

  /**
   * Taken for this process, unless another board holds a fresh claim or it was handled already.
   * Legacy delivery is at least once; receipt-backed exports refuse replay after dispatch starts.
   * A legacy board that dies between typing the text and finish() leaves
   * its claim, and the run goes out again once that claim expires (CLAIM_MS).
   */
  function claim(id: string, now: number): boolean {
    return !!updateEntry(id, e => {
      if (e.next > now) return undefined
      const held = e.claim as { pid: number; at: number } | undefined
      if (held && held.pid !== process.pid && now - held.at < CLAIM_MS) return undefined
      return { ...e, claim: { pid: process.pid, at: now } }
    })
  }

  function sent(entry: ScheduleEntry): void {
    const now = Date.now()
    if (entry.receipt) settleReport(entry, 'sent')
    delivered.set(entry.id, entry.next)
    finish(entry, now)
    logRun(record(entry, now, 'sent'))
  }

  /** After a run went out: a one-off goes, a cron entry moves on. */
  function finish(entry: ScheduleEntry, now = Date.now()): void {
    try {
      if (entry.cron) updateEntry(entry.id, e => settle(e, now, { lastRun: now, runs: (Number(e.runs) || 0) + 1 }))
      else removeEntry(entry.id)
      delivered.delete(entry.id)
    } catch (err) {
      log(`schedule ${entry.id}: ${messageOf(err)}`)
    }
  }

  // A call's results go into the log by their title: the report itself is the session's now.
  const record = (entry: ScheduleEntry, at: number, result: string, why?: string): Record<string, unknown> => ({
    id: entry.id,
    key: entry.key,
    name: entry.name,
    text: entry.kind === 'call' ? callTitle(entry.text) : entry.text,
    ...(entry.kind && { kind: entry.kind }),
    cron: entry.cron,
    due: entry.next,
    at,
    result,
    why,
  })

  /**
   * Not sent this time: try again on the next tick, or log it as missed once the wait is over.
   * `gone`: its session is not on the board (none in its pane, or one in another profile).
   */
  function wait(entry: ScheduleEntry, now: number, why: string, gone: boolean): void {
    // Only time spent trying counts: a gap (the board was off) is not waiting.
    const tried = typeof entry.tried === 'number' ? entry.tried : 0
    const step = tried ? Math.min(now - tried, 2 * tickMs() + 5000) : 0
    const waited = (Number(entry.waited) || 0) + step
    if (waited < patience()) {
      updateEntry(entry.id, e => ({
        ...e,
        pendingSince: e.pendingSince ?? now,
        tried: now,
        waited,
        why,
        claim: undefined,
      }))
      return
    }
    const goneRuns = gone ? (Number(entry.gone) || 0) + 1 : 0
    const drop = !entry.cron || goneRuns >= GONE_RUNS
    if (drop) removeEntry(entry.id, 'missed')
    else
      updateEntry(entry.id, e =>
        settle(e, now, { missed: (Number(e.missed) || 0) + 1, ...(goneRuns && { gone: goneRuns }) }),
      )
    logRun({
      ...record(entry, now, entry.cron && drop ? 'dropped' : 'missed', why),
      ...(entry.cron && drop && { n: goneRuns }),
    })
  }

  /** A cron entry after a run: its next time, the waiting fields cleared. */
  function settle(e: ScheduleEntry, now: number, counts: Record<string, unknown>): ScheduleEntry | undefined {
    const { pendingSince, tried, waited, why, claim, gone, ...rest } = e
    const next = e.cron ? nextRun(e.cron, now) : null
    // null deletes the file; the store's type only names the "no change" case.
    return (next === null ? null : { ...rest, ...counts, next }) as ScheduleEntry | undefined
  }

  // The next tick comes at the soonest due time, or after tickMs at the latest.
  function plan(ms: number): void {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(loop, Math.max(50, ms))
  }
  async function loop(): Promise<void> {
    await tick()
    const now = Date.now()
    const soonest = Math.min(...listEntries().map(e => (e.next <= now ? Number.POSITIVE_INFINITY : e.next)))
    plan(Math.min(tickMs(), soonest - now + 50))
  }
  // A new entry may be due sooner than the next tick.
  let watcher: FSWatcher | null = null
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  try {
    mkdirSync(scheduleDir(), { recursive: true })
    watcher = watch(scheduleDir(), () => {
      clearTimeout(watchTimer)
      watchTimer = setTimeout(() => plan(0), 300)
    })
    // On Windows a watched folder that is deleted errors (EPERM); unhandled, that ends the
    // board. The ticks go on without it.
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {}
  plan(1000)

  return {
    stop() {
      stopped = true
      clearTimeout(timer)
      clearTimeout(watchTimer)
      watcher?.close()
    },
  }
}
