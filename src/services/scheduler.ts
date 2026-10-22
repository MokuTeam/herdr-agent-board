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
//
// A restart (kind 'restart') waits until the session is free (no turn, no dialog, no draft, no
// background command), has herdr-wake put it to sleep (/exit) and wake it again (resumed in its
// pane: the same conversation, MCP servers, settings, hooks and skills loaded anew), then types
// "[board reminder; restarted ...] <its note>". How far it got is kept in the entry (step), so a
// board that restarts meanwhile goes on from there. When herdr-wake refuses or fails a few times,
// or background tasks hold the session too long, the session gets "[board reminder] restart did
// not happen: <why>" instead, once it is free. The wake goes through the board's profile guard
// (actions.ts checkWake): one the board would refuse is refused before the session is put to
// sleep. A wake refused after the sleep (the pane's evidence changed, or herdr failed) leaves the
// session asleep, the safe outcome, never resumed in another account; it is tried again and
// reported after RESTART_TRIES (3) tries.
//
// A sleep (kind 'sleep', `board sleep --when-free`) waits as a restart does until the session is
// free, then has herdr-wake put it to sleep, and that is all: no wake, no note. It waits as long as
// a reminder does (`scheduleWaitMin`); herdr-wake refusing is tried RESTART_TRIES times, then the
// log says it did not happen. Asleep by other means meanwhile (the reaper, the user), it is done.
//
// A run for a sleeping session waits for wake while wake is slow to answer (it may be waking that
// session), or while the board's own wake of one from wake's session file cannot reach herdr
// (#119, safeguard 14): tried again on every tick, without counting the wait and without counting
// the session as gone, so no reminder is missed and no cron entry dropped for it; once wake answers,
// or the session is awake, it goes as usual.
//
// It also closes the panes of sessions put in the archive once their time to come back from the
// page's toast is over (archive.ts closeDue): a board that restarts meanwhile does it on start.
import { type FSWatcher, mkdirSync, watch } from 'node:fs'
import { beginReport, deferReport, settleReport, verifyReport } from '../adapters/call-receipts.ts'
import { readCard } from '../adapters/cards.ts'
import { archiveDir, scheduleDir } from '../adapters/paths.ts'
import { getEntry, listEntries, logRun, removeEntry, updateEntry } from '../adapters/schedule-store.ts'
import { itemProfile } from '../core/item-profile.ts'
import { t } from '../core/lang.ts'
import { callTitle } from '../core/notices.ts'
import { profileLabel, sessionProfile } from '../core/profiles.ts'
import { cleanText, promptOf, type ScheduleEntry, targetOf } from '../core/schedule-rules.ts'
import type { Item } from '../core/types.ts'
import { wakeOffByKey } from '../core/wake/mode.ts'
import { nextRun } from '../core/when.ts'
import { type ActionResult, checkWake, readyToSleep, send, sleepSession, wake } from './actions.ts'
import { closeDue, listArchive } from './archive.ts'
import { collect } from './board.ts'
import type { Deps } from './deps.ts'
import { currentWakeMode } from './wake/mode.ts'

// A run on its way (waking a session takes up to three minutes) holds its claim this long.
const CLAIM_MS = 5 * 60_000
// Sessions woken at once, so a board back after a night does not start every sleeper together.
const MAX_WAKING = 2
// A cron entry whose session is gone for this many runs in a row is dropped: it would wait and
// miss forever.
const GONE_RUNS = 3
// A restart herdr-wake refused or failed (to put the session to sleep, or to wake it) is tried
// again two ticks later (30 s), RESTART_TRIES times in all; background tasks hold one for
// TASKS_WAIT_MS at most. A woken session gets its note `restartSettleSec` (8) later, so the MCP
// servers it starts have a moment to connect before its turn.
const RESTART_TRIES = 3
const TASKS_WAIT_MS = 10 * 60_000

const positive = (v: unknown, fallback: number): number => (Number(v) > 0 ? Number(v) : fallback)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * A wake refused in a way the run waits for (safeguard 14): wake slow to answer, or the board's own
 * wake of a sleeper from wake's session file that could not reach herdr.
 */
const waitsForWake = (item: Item, r: ActionResult): boolean =>
  !r.ok && (r.wakeBusy === true || (item.fromFile === true && r.herdrDown === true))

/** A number an entry keeps (the scheduler's own fields), else undefined. */
const numberOf = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/**
 * Start sending due entries. `deps.cfg` is the live config: scheduleTickSec (15), scheduleWaitMin
 * (240), restartSettleSec (8). `onChange` is called after each run, so the board redraws.
 */
export function startScheduler({ deps, onChange = () => {} }: { deps: Deps; onChange?: () => void }): {
  stop(): void
} {
  const { cfg, log } = deps
  // Five minutes at most: setTimeout takes no more than 24 days, and a larger value runs at once.
  const tickMs = (): number => Math.min(300, Math.max(0.1, positive(cfg.scheduleTickSec, 15))) * 1000
  const patience = (): number => positive(cfg.scheduleWaitMin, 240) * 60_000
  const settleMs = (): number => Math.min(60, Number(cfg.restartSettleSec ?? 8) || 0) * 1000
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
      const archived = await closeDue(deps, { log }).catch((err: unknown) => {
        log(`archive: ${messageOf(err)}`)
        return null
      })
      if (archived?.closed || archived?.kept) onChange()
      const now = Date.now()
      // A run that waits for its session is tried again once a tick, not on every file change; a
      // restart herdr-wake refused, not before its retry time.
      const tried = (e: ScheduleEntry): boolean => typeof e.tried === 'number' && e.tried > now - tickMs() * 0.9
      const later = (e: ScheduleEntry): boolean => typeof e.retryAt === 'number' && e.retryAt > now
      const due = listEntries().filter(e => e.next <= now && !flying.has(e.key) && !tried(e) && !later(e))
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
    if (entry.kind === 'restart') return restart(entry, item)
    if (entry.kind === 'sleep') return sleep(entry, item)
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
        if (waitsForWake(item, r)) return hold(entry, now)
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
          // Woken in another pane (a pi session whose own was gone, #178): the message goes there.
          const pane = r.ok && r.pane ? r.pane : item.pane
          r = await send(deps, { ...item, sleeping: false, pane }, promptOf(entry, Date.now()), {
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
      why = whyNot(r)
    }
    wait(entry, now, why, !item)
  }

  const whyNot = (r: { draft?: boolean; dialog?: boolean; busy?: boolean; error: string }): string =>
    r.draft ? 'draft' : r.dialog ? 'dialog' : r.busy ? 'busy' : r.error

  /**
   * A restart, as far as it can go now (see the top of the file). Each step is written to the
   * entry before it starts: a board that stops halfway leaves the session asleep at worst, and
   * the next one wakes it.
   */
  async function restart(entry: ScheduleEntry, item: Item | undefined): Promise<void> {
    const now = Date.now()
    // Only the session that asked: targetOf does not follow a restart to another one in its pane.
    if (!item) return wait(entry, now, 'gone', true)
    // Put to sleep by this restart already: what is left is waking it, if it still sleeps, and the note.
    const slept = entry.step === 'wake' || entry.step === 'note'
    if (!entry.failed && !item.sleeping && !slept) {
      if (!item.session) return giveUp(entry, t('err.notClaude', { name: item.name }))
      // The new wake has no wakeUrl; the old path needs it, as today (wake off in config.json says so).
      if (!cfg.wakeUrl && currentWakeMode(cfg).kind !== 'new')
        return giveUp(entry, wakeOffByKey(cfg) ? t('err.wakeOff') : t('err.restart.noWake'))
      // Before anything is put to sleep: the wake that ends the restart must be one the board
      // makes (its profile guard). One it refuses is refused now; herdr not answering waits.
      const guard = await checkWake(deps, item)
      if (!guard.ok) return guard.refused ? giveUp(entry, guard.error) : wait(entry, now, guard.error, false)
      const ready = await readyToSleep(deps, item)
      // Background tasks hold it TASKS_WAIT_MS at most, counted from when they began to: a hold
      // for any other reason starts that count over.
      if (!ready.ok && ready.why === 'tasks') {
        const since = numberOf(entry.tasksSince) ?? now
        return now - since >= TASKS_WAIT_MS
          ? giveUp(entry, t('err.restart.tasks'))
          : wait(entry, now, 'tasks', false, { tasksSince: since })
      }
      if (!ready.ok) return wait(entry, now, ready.why, false, { tasksSince: undefined })
      if (!claim(entry.id, now, { step: 'sleep', tasksSince: undefined })) return
      // herdr's status as just read, not the tick's: a turn that ended meanwhile is not "working".
      const asleep = await sleepSession(deps, { ...item, status: ready.status }).finally(() => deps.wake.forget())
      if (!asleep.ok) return retry(entry, asleep.error)
      entry =
        updateEntry(entry.id, e => ({
          ...e,
          step: 'wake',
          attempts: undefined,
          claim: { pid: process.pid, at: Date.now() },
        })) ?? entry
      item = { ...item, sleeping: true }
    } else if (!claim(entry.id, now)) return
    if (item.sleeping) {
      // Asleep: put to sleep just now, or before (by a board that stopped halfway, the reaper, by
      // hand). Waking it is what restarts it, so a restart that had given up is one after all.
      // One this restart just put to sleep is woken whatever MAX_WAKING says: it is the board's doing.
      waking++
      const woke = await wake(deps, item).finally(() => {
        waking--
        deps.wake.forget()
      })
      if (!woke.ok) return waitsForWake(item, woke) ? hold(entry, now) : retry(entry, woke.error, true)
      const noted = updateEntry(entry.id, e => ({
        ...e,
        step: 'note',
        failed: undefined,
        attempts: undefined,
        claim: { pid: process.pid, at: Date.now() },
      }))
      // Cancelled meanwhile: it is up again, with nothing to type.
      if (!noted) return
      entry = noted
      item = { ...item, sleeping: false }
      await new Promise(resolve => setTimeout(resolve, settleMs()))
      if (stopped || !getEntry(entry.id)) return
    }
    const r = await send(deps, item, promptOf(entry, Date.now()), { free: true, draft: true })
    if (!r.ok) return wait(entry, now, whyNot(r), false)
    const failed = typeof entry.failed === 'string' ? entry.failed : ''
    return failed ? sent(entry, 'failed', failed) : sent(entry)
  }

  /** A sleep, once the session is free (see the top of the file). */
  async function sleep(entry: ScheduleEntry, item: Item | undefined): Promise<void> {
    const now = Date.now()
    // Only the session it was asked for: targetOf does not follow a sleep to another one in its pane.
    if (!item) return wait(entry, now, 'gone', true)
    if (item.sleeping) {
      if (claim(entry.id, now)) sent(entry)
      return
    }
    const ready = await readyToSleep(deps, item)
    if (!ready.ok) return ready.profile ? giveUp(entry, ready.why) : wait(entry, now, ready.why, false)
    if (!claim(entry.id, now)) return
    // herdr's status as just read, not the tick's: a turn that ended meanwhile is not "working".
    const asleep = await sleepSession(deps, { ...item, status: ready.status }).finally(() => deps.wake.forget())
    return asleep.ok ? sent(entry) : retry(entry, asleep.error)
  }

  /**
   * herdr-wake refused or failed: tried again in a while, RESTART_TRIES times in all. Then the
   * session hears why; one that could not be woken sleeps on (a message wakes it), and only the
   * log says so. The time is taken now: a sleep or a wake can take minutes to fail.
   */
  function retry(entry: ScheduleEntry, why: string, asleep = false): void {
    const now = Date.now()
    const attempts = (numberOf(entry.attempts) ?? 0) + 1
    if (attempts < RESTART_TRIES) {
      updateEntry(entry.id, e => ({
        ...e,
        attempts,
        retryAt: now + 2 * tickMs(),
        step: asleep ? e.step : undefined,
        pendingSince: e.pendingSince ?? now,
        tried: now,
        why,
        claim: undefined,
      }))
      return
    }
    if (!asleep) {
      giveUp(entry, why)
      return
    }
    removeEntry(entry.id)
    logRun(record(entry, now, 'failed', why))
  }

  /**
   * A restart that will not happen: the entry stays only to tell the session why, once it is
   * free. One the user asked for on the board is the user's to hear about (the log, a toast on
   * the page): the session did not ask, so nothing is typed into it. The reason comes from
   * herdr-wake too, and goes into a terminal: no control characters. A sleep that will not happen
   * is only logged too: the session it is for did not ask either.
   */
  function giveUp(entry: ScheduleEntry, reason: string): void {
    const why = cleanText(reason, 300)
    if (entry.by === 'user' || entry.kind === 'sleep') {
      removeEntry(entry.id)
      logRun(record(entry, Date.now(), 'failed', why))
      return
    }
    updateEntry(entry.id, e => {
      const { step, attempts, retryAt, tasksSince, claim, tried, ...rest } = e
      return { ...rest, failed: why }
    })
  }

  /**
   * Taken for this process, unless another board holds a fresh claim or it was handled already.
   * Legacy delivery is at least once; receipt-backed exports refuse replay after dispatch starts.
   * A legacy board that dies between typing the text and finish() leaves
   * its claim, and the run goes out again once that claim expires (CLAIM_MS). `extra` goes into
   * the entry with the claim (a restart's step).
   */
  function claim(id: string, now: number, extra: Record<string, unknown> = {}): boolean {
    return !!updateEntry(id, e => {
      if (e.next > now) return undefined
      const held = e.claim as { pid: number; at: number } | undefined
      if (held && held.pid !== process.pid && now - held.at < CLAIM_MS) return undefined
      return { ...e, ...extra, claim: { pid: process.pid, at: now } }
    })
  }

  /** Gone out; `result` 'failed' for the note that a restart did not happen, `why` its reason. */
  function sent(entry: ScheduleEntry, result = 'sent', why?: string): void {
    const now = Date.now()
    if (entry.receipt) settleReport(entry, 'sent')
    delivered.set(entry.id, entry.next)
    finish(entry, now)
    logRun(record(entry, now, result, why))
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
  // A restart says who asked for it: the page tells the user how one of theirs went.
  const record = (entry: ScheduleEntry, at: number, result: string, why?: string): Record<string, unknown> => ({
    id: entry.id,
    key: entry.key,
    name: entry.name,
    text: entry.kind === 'call' ? callTitle(entry.text) : entry.text,
    ...(entry.kind && { kind: entry.kind }),
    ...(entry.kind === 'restart' && { by: entry.by }),
    cron: entry.cron,
    due: entry.next,
    at,
    result,
    why,
  })

  /**
   * Not sent this time: try again on the next tick, or log it as missed once the wait is over.
   * `gone`: its session is not on the board (none in its pane, or one in another profile).
   * `extra` goes into the entry (when background tasks began to hold a restart).
   */
  function wait(
    entry: ScheduleEntry,
    now: number,
    why: string,
    gone: boolean,
    extra: Record<string, unknown> = {},
  ): void {
    // Only time spent trying counts: a gap (the board was off) is not waiting.
    const tried = typeof entry.tried === 'number' ? entry.tried : 0
    const step = tried ? Math.min(now - tried, 2 * tickMs() + 5000) : 0
    const waited = (Number(entry.waited) || 0) + step
    if (waited < patience()) {
      updateEntry(entry.id, e => ({
        ...e,
        ...extra,
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

  /**
   * Waiting for wake (safeguard 14): tried again on the next tick, the wait not counted and the
   * session not gone, so it is never missed nor dropped for this; a restart keeps its step.
   */
  function hold(entry: ScheduleEntry, now: number): void {
    updateEntry(entry.id, e => ({
      ...e,
      pendingSince: e.pendingSince ?? now,
      tried: now,
      why: 'wake',
      claim: undefined,
    }))
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
    // An archived session whose pane is to close counts as an entry.
    const closing = listArchive()
      .filter(r => r.state === 'closing')
      .map(r => r.closeAt)
    const soonest = Math.min(...[...listEntries().map(e => e.next), ...closing].filter(at => at > now))
    plan(Math.min(tickMs(), soonest - now + 50))
  }
  // A new entry, or a session put in the archive, may be due sooner than the next tick.
  const watchers: FSWatcher[] = []
  let watchTimer: ReturnType<typeof setTimeout> | undefined
  for (const dir of [scheduleDir(), archiveDir()]) {
    try {
      mkdirSync(dir, { recursive: true })
      const watcher = watch(dir, () => {
        clearTimeout(watchTimer)
        watchTimer = setTimeout(() => plan(0), 300)
      })
      // On Windows a watched folder that is deleted errors (EPERM); unhandled, that ends the
      // board. The ticks go on without it.
      watcher.on('error', () => watcher.close())
      watchers.push(watcher)
    } catch {}
  }
  plan(1000)

  return {
    stop() {
      stopped = true
      clearTimeout(timer)
      clearTimeout(watchTimer)
      for (const w of watchers) w.close()
    },
  }
}
