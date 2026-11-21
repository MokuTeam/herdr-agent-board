// Watches at work (#486): the scheduler's probe pass (services/scheduler.ts calls it on its tick
// while config.json's `watches` is on). A watch whose check is due is claimed in its file, so a
// second board never runs it too, and its probe runs with no model (adapters/watch-probe.ts),
// never two runs of one watch at once and MAX_RUNNING on the board at most. Then, under the
// watch's lock: fired, it becomes a plain reminder due now (schedule-store.ts fireWatch), which the
// scheduler sends as any, waking a sleeping session; nothing yet or an error, its next check
// (core/watches.ts afterRun: the interval, doubled after each error up to an hour), and the lines
// the session gets for it as reminders of their own (the silence one wakes it, an error one waits
// until it is awake).
//
// herdr is asked only when a watch is due: for the board's sessions, so a watch follows its session
// after /clear as a reminder does (core/schedule-rules.ts targetOf) and is not run while its
// session is not on the board. Gone longer than the scheduler's patience (`scheduleWaitMin`), it is
// removed and logged as missed, as a reminder is.
import { readCard } from '../adapters/cards.ts'
import { isAlive } from '../adapters/process.ts'
import { addEntry, fireWatch, listWatches, logRun, removeWatch, updateWatch } from '../adapters/schedule-store.ts'
import { runProbe as realProbe } from '../adapters/watch-probe.ts'
import { itemProfile } from '../core/item-profile.ts'
import { sessionProfile } from '../core/profiles.ts'
import { targetOf } from '../core/schedule-rules.ts'
import type { Item } from '../core/types.ts'
import {
  afterRun,
  firedText,
  MAX_RUNNING,
  type Note,
  outcomeOf,
  type ProbeRun,
  WATCH_FROM,
  type WatchEntry,
} from '../core/watches.ts'
import { collect } from './board.ts'
import type { Deps } from './deps.ts'

// A run holds its claim this long at most (a probe's timeout is 90 s at most).
const CLAIM_MS = 5 * 60_000
// A watch whose session is not on the board is looked at again this soon at the latest.
const GONE_RECHECK_MS = 5 * 60_000

export interface WatchPassOpts {
  deps: Deps
  /** The scheduler's patience: how long a watch's session may be gone before it goes. */
  patience: () => number
  onChange?: () => void
  /** The tests' probe. */
  runProbe?: (cmd: string, cwd: string | undefined, timeoutMs: number, id: string) => Promise<ProbeRun>
  /** The tests' sessions; else the board's (services/board.ts collect). */
  items?: () => Promise<Item[]>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A claim another live process took a moment ago. */
function heldElsewhere(w: WatchEntry, now: number): boolean {
  const c = w.claim as { pid?: unknown; at?: unknown } | undefined
  if (!c || typeof c.pid !== 'number' || typeof c.at !== 'number') return false
  return c.pid !== process.pid && now - c.at < CLAIM_MS && isAlive(c.pid)
}

export function watchPass(o: WatchPassOpts): { pass(): Promise<void>; running(): number; stop(): void } {
  const { deps, patience, onChange = () => {} } = o
  const probe = o.runProbe ?? realProbe
  const running = new Set<string>()
  let passing = false
  let stopped = false

  async function pass(): Promise<void> {
    if (passing || stopped) return
    passing = true
    try {
      const now = Date.now()
      const due = listWatches().filter(w => w.next <= now && !running.has(w.id) && !heldElsewhere(w, now))
      if (!due.length) return
      const items = await (o.items ?? (() => collect(deps)))()
      const set = deps.profiles()
      const profileOf = (key: string): Pick<Item, 'profile' | 'profileFolder'> =>
        items.find(i => i.key === key) ?? sessionProfile(readCard(key), set.list)
      const profileIdOf = (key: string): string | undefined => itemProfile(profileOf(key), set.list)?.id
      let changed = false
      for (const w of due) {
        if (running.size >= MAX_RUNNING) break
        const { item } = targetOf(w, items, profileIdOf)
        if (!item) {
          gone(w, now)
          changed = true
          continue
        }
        const claimed = updateWatch(w.id, cur => {
          if (cur.next > now || heldElsewhere(cur, now)) return undefined
          const { goneSince, ...rest } = cur
          // Followed into the session that took its pane after /clear: the card and the log say the
          // new one, the reminder the one it was set for.
          const moved =
            item.key === cur.key
              ? {}
              : { key: item.key, name: item.name, movedFrom: cur.movedFrom ?? { key: cur.key, name: cur.name ?? '' } }
          return { ...rest, ...moved, claim: { pid: process.pid, at: now } }
        })
        if (!claimed) continue
        running.add(claimed.id)
        void runOne(claimed)
          .catch(err => {
            deps.log(`watch ${claimed.id}: ${messageOf(err)}`)
            // Its result was not written (a lock, a file the system held): the next run waits an
            // interval, as after any run, and the claim goes.
            try {
              updateWatch(claimed.id, cur => {
                const { claim, ...rest } = cur
                return { ...rest, next: Date.now() + cur.probe.everyMs }
              })
            } catch {}
          })
          .finally(() => {
            running.delete(claimed.id)
            onChange()
          })
      }
      if (changed) onChange()
    } catch (err) {
      deps.log(`watches: ${messageOf(err)}`)
    } finally {
      passing = false
    }
  }

  /** Its session is not on the board: no run; gone past the patience, it goes, logged as missed. */
  function gone(w: WatchEntry, now: number): void {
    const since = w.goneSince ?? now
    if (now - since >= patience()) {
      if (removeWatch(w.id)) logRun(record(w, now, 'missed', 'gone'))
      return
    }
    // Looked at again within five minutes, whatever the interval: a session missing from one look
    // at the board (herdr slow, a restart) is back on the card soon.
    updateWatch(w.id, cur => ({
      ...cur,
      goneSince: cur.goneSince ?? now,
      next: now + Math.min(cur.probe.everyMs, GONE_RECHECK_MS),
    }))
  }

  async function runOne(w: WatchEntry): Promise<void> {
    const run = await probe(w.probe.cmd, w.cwd, w.probe.timeoutMs, w.id)
    if (stopped) return
    const outcome = outcomeOf(run)
    const now = Date.now()
    // The same watch still (not cancelled, nor replaced by a new board wait) is what changes.
    const same = (cur: WatchEntry): boolean => cur.created === w.created && cur.probe.cmd === w.probe.cmd
    if (outcome.kind === 'fired') {
      const fired = fireWatch(w.id, firedText(w, outcome.output), now)
      if (fired) logRun(record(w, now, 'fired'))
      return
    }
    let notes: Note[] = []
    const after = updateWatch(w.id, cur => {
      if (!same(cur)) return undefined
      const r = afterRun(cur, outcome, now)
      notes = r.notes
      return r.watch
    })
    if (!after) return
    if (outcome.kind === 'error') deps.log(`watch ${w.id}: ${outcome.why}`)
    // Each line goes in first and is marked told after (core/watches.ts Note): one that could not be
    // written is tried again at the next run. The session's cap of entries does not refuse them.
    for (const n of notes) {
      try {
        addEntry(
          {
            key: after.key,
            text: n.text,
            at: now,
            next: now,
            ...(after.name !== undefined && { name: after.name }),
            ...(after.pane !== undefined && { pane: after.pane }),
            ...(after.cwd !== undefined && { cwd: after.cwd }),
            by: after.by ?? 'agent',
            from: WATCH_FROM,
            ...(!n.wake && { noWake: true }),
          },
          { overCap: true },
        )
        updateWatch(w.id, cur => (same(cur) ? { ...cur, [n.mark]: true } : undefined))
      } catch (err) {
        deps.log(`watch ${w.id}: a note was not scheduled: ${messageOf(err)}`)
      }
    }
  }

  const record = (w: WatchEntry, at: number, result: string, why?: string): Record<string, unknown> => ({
    id: w.id,
    key: w.key,
    name: w.name,
    text: w.text,
    kind: 'watch',
    probe: w.probe.cmd,
    due: w.next,
    at,
    result,
    ...(why !== undefined && { why }),
  })

  return {
    pass,
    running: () => running.size,
    stop() {
      stopped = true
    },
  }
}
