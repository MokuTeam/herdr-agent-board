// Runs the schedule (schedule.mjs) in the board's process: when an entry is due, its text goes
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
// not happen: <why>" instead, once it is free.
//
// It also closes the panes of sessions put in the archive once their time to come back from the
// page's toast is over (archive.mjs closeDue): a board that restarts meanwhile does it on start.
import { ARCHIVE_DIR, closeDue, listArchive } from './archive.mjs'
import { beginReport, deferReport, settleReport, verifyReport } from './call-receipts.mjs'
import { mkdirSync, watch } from 'node:fs'
import { readyToSleep, send, sleepSession, wake } from './actions.mjs'
import { t } from './lang.mjs'
import { collect, forgetSleepers } from './model.mjs'
import { CALL_NOTE } from './notices.mjs'
import { cleanText, getEntry, listEntries, logRun, removeEntry, SCHEDULE_DIR, updateEntry } from './schedule.mjs'
import { countRuns, nextRun } from './when.mjs'
import { callTitle } from '../web/notice-model.js'
import { longWhen, span } from '../web/when.js'

// A run on its way (waking a session takes up to three minutes) holds its claim this long.
const CLAIM_MS = 5 * 60_000
// Later than this, the prompt says by how much.
const LATE_MS = 2 * 60_000
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

/**
 * What the session gets: "[board reminder] text", with a note when it is late or stands for
 * several runs. A MokuPilot call's results (kind 'call') come as "[mokupilot call report]", the
 * report on lines of its own, and a closing note that they are for its information.
 */
export function promptOf(entry, now) {
  if (entry.kind === 'restart') return restartPrompt(entry)
  const notes = []
  if (entry.cron) {
    const runs = countRuns(entry.cron, entry.next, now)
    if (runs > 1) notes.push(t('sched.prompt.runs', { n: runs, since: longWhen(entry.next, t, now) }))
  } else if (now - entry.next > LATE_MS) {
    notes.push(t('sched.prompt.late', { late: span(now - entry.next, t), due: longWhen(entry.next, t, now) }))
  }
  // Set by another session, or for the one this pane held before /clear: the receiver judges it.
  const before = entry.movedFrom
  const setter = entry.from && entry.from.key !== (before?.key ?? entry.key) ? entry.from.name || entry.from.key.slice(0, 8) : ''
  if (before) notes.push(t(setter ? 'sched.prompt.clearedFor' : 'sched.prompt.cleared', { name: before.name || before.key.slice(0, 8) }))
  // The tag stays in English: the hook knows a board prompt by it (hook.mjs).
  const from = setter ? ` from ${setter}` : ''
  if (entry.kind === 'call') return `[mokupilot call report${notes.length ? `; ${notes.join('; ')}` : ''}]\n${entry.text}\n\n${CALL_NOTE}`
  const tag = entry.cron ? `board schedule ${entry.id}${from}: ${entry.cron}` : `board reminder${from}`
  return `[${tag}${notes.length ? `; ${notes.join('; ')}` : ''}] ${entry.text}`
}

/**
 * After a restart, "[board reminder; restarted ...] <its note>": who asked (the session itself,
 * another one, the user), and the note for after it. One that did not happen says why. Late
 * means nothing here, and a restart never moves to another session (targetOf).
 */
function restartPrompt(entry) {
  const setter = entry.from && entry.from.key !== entry.key ? entry.from.name || entry.from.key.slice(0, 8) : ''
  const from = setter ? ` from ${setter}` : ''
  if (entry.failed) return `[board reminder${from}] ${t('sched.prompt.restartFailed', { why: entry.failed })}${entry.text ? ` ${t('sched.prompt.restartNote', { text: entry.text })}` : ''}`
  const by = entry.by === 'user' ? 'User' : setter ? 'Other' : ''
  return `[board reminder${from}; ${t(`sched.prompt.restarted${by}`)}] ${entry.text || t(`sched.prompt.restartText${by === 'User' ? 'User' : ''}`)}`
}

const folder = p => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()

/**
 * The session an entry is for: by its id, else the Claude session now in its pane and folder.
 * /clear gives a session a new id in the same pane; the reminder follows it there. A restart does
 * not: the session after /clear, or another one started in that pane, did not ask for it.
 */
export function targetOf(entry, items) {
  const own = items.find(i => i.key === entry.key)
  if (own || entry.receipt || entry.kind === 'restart' || !entry.pane || !entry.cwd) return own
  return items.find(i => i.pane === entry.pane && i.session && !i.sleeping && folder(i.cwd) === folder(entry.cwd))
}

const positive = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback)

/**
 * Start sending due entries. `cfg` is the live config: scheduleTickSec (15), scheduleWaitMin
 * (240), restartSettleSec (8). Returns { tick, stop }.
 */
export function startScheduler({ cfg, log = () => {}, onChange = () => {} }) {
  // Five minutes at most: setTimeout takes no more than 24 days, and a larger value runs at once.
  const tickMs = () => Math.min(300, Math.max(0.1, positive(cfg.scheduleTickSec, 15))) * 1000
  const patience = () => positive(cfg.scheduleWaitMin, 240) * 60_000
  const settleMs = () => Math.min(60, Number(cfg.restartSettleSec ?? 8) || 0) * 1000
  const flying = new Set() // sessions with a run on its way: one at a time per session
  // Runs that went out but whose entry could not be updated (its lock was taken): the next
  // tick finishes the entry instead of sending it again.
  const delivered = new Map() // id -> next
  let waking = 0
  let timer = null
  let ticking = false
  let stopped = false

  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      const archived = await closeDue({ log }).catch(err => log(`archive: ${err.message}`))
      if (archived?.closed || archived?.kept) onChange()
      const now = Date.now()
      // A run that waits for its session is tried again once a tick, not on every file change; a
      // restart herdr-wake refused, not before its retry time.
      const due = listEntries().filter(e => e.next <= now && !flying.has(e.key) && !(e.tried > now - tickMs() * 0.9) && !(e.retryAt > now))
      if (!due.length) return
      // Fresh: whether a session sleeps or works decides what happens now.
      const items = await collect(cfg)
      for (const entry of due) {
        if (delivered.get(entry.id) === entry.next) {
          finish(entry)
          continue
        }
        const item = targetOf(entry, items)
        if (flying.has(entry.key) || (item && flying.has(item.key)) || (item?.sleeping && waking >= MAX_WAKING)) continue
        const keys = [entry.key, item?.key].filter(Boolean)
        for (const k of keys) flying.add(k)
        run(entry, item)
          .catch(err => log(`schedule ${entry.id}: ${err.message}`))
          .finally(() => {
            for (const k of keys) flying.delete(k)
            onChange()
          })
      }
    } catch (err) {
      log(`schedule: ${err.message}`)
    } finally {
      ticking = false
    }
  }

  async function run(entry, item) {
    if (entry.kind === 'restart') return restart(entry, item)
    const receipt = entry.receipt ? verifyReport(entry) : null // Before even waking a session.
    if (receipt && !['queued', 'dispatching'].includes(receipt.state)) {
      removeEntry(entry.id)
      logRun(record(entry, Date.now(), receipt.state))
      return
    }
    const now = Date.now()
    // On time (the default) goes into a working session too, queued into its turn as the user's
    // own mid-turn messages are; `idle` entries wait until it is free. A dialog always waits:
    // typing would answer it.
    const held = item && !item.sleeping && (item.status === 'blocked' || (entry.idle && item.status === 'working'))
    let why = !item ? 'gone' : held ? (item.status === 'blocked' ? 'dialog' : 'busy') : ''
    if (!why) {
      if (!claim(entry.id, now)) return
      if (item.key !== entry.key) {
        // Followed into the session that took its pane: the card and the log say the new one, the
        // prompt the one it was set for.
        const movedFrom = entry.movedFrom ?? { key: entry.key, name: entry.name }
        entry = { ...entry, key: item.key, name: item.name, movedFrom }
        updateEntry(entry.id, e => ({ ...e, key: item.key, name: item.name, movedFrom: e.movedFrom ?? movedFrom }))
      }
      let r = { ok: true }
      if (item.sleeping) {
        waking++
        r = await wake(cfg, item).finally(() => {
          waking--
          forgetSleepers()
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
          r = await send(cfg, { ...item, sleeping: false }, promptOf(entry, Date.now()), { free: !!entry.idle, draft: true })
        } catch (error) {
          if (entry.receipt) settleReport(entry, 'delivery-unknown')
          throw error
        }
        if (entry.receipt && !r.ok && r.busy) {
          deferReport(entry)
          return wait(entry, now, r.draft ? 'draft' : r.dialog ? 'dialog' : 'busy')
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
    wait(entry, now, why)
  }

  const whyNot = r => (r.draft ? 'draft' : r.dialog ? 'dialog' : r.busy ? 'busy' : r.error)

  /**
   * A restart, as far as it can go now (see the top of the file). Each step is written to the
   * entry before it starts: a board that stops halfway leaves the session asleep at worst, and
   * the next one wakes it.
   */
  async function restart(entry, item) {
    const now = Date.now()
    // Only the session that asked: targetOf does not follow a restart to another one in its pane.
    if (!item) return wait(entry, now, 'gone')
    // Put to sleep by this restart already: what is left is waking it, if it still sleeps, and the note.
    const slept = entry.step === 'wake' || entry.step === 'note'
    if (!entry.failed && !item.sleeping && !slept) {
      if (!item.session) return giveUp(entry, t('err.notClaude', { name: item.name }))
      if (!cfg.wakeUrl) return giveUp(entry, t('err.restart.noWake'))
      const ready = await readyToSleep(item)
      // Background tasks hold it TASKS_WAIT_MS at most, counted from when they began to: a hold
      // for any other reason starts that count over.
      if (ready.why === 'tasks') {
        const since = entry.tasksSince ?? now
        return now - since >= TASKS_WAIT_MS ? giveUp(entry, t('err.restart.tasks')) : wait(entry, now, 'tasks', { tasksSince: since })
      }
      if (!ready.ok) return wait(entry, now, ready.why, { tasksSince: undefined })
      if (!claim(entry.id, now, { step: 'sleep', tasksSince: undefined })) return
      // herdr's status as just read, not the tick's: a turn that ended meanwhile is not "working".
      const asleep = await sleepSession(cfg, { ...item, status: ready.status }).finally(forgetSleepers)
      if (!asleep.ok) return retry(entry, asleep.error)
      entry = updateEntry(entry.id, e => ({ ...e, step: 'wake', attempts: undefined, claim: { pid: process.pid, at: Date.now() } })) ?? entry
      item = { ...item, sleeping: true }
    } else if (!claim(entry.id, now)) return
    if (item.sleeping) {
      // Asleep: put to sleep just now, or before (by a board that stopped halfway, the reaper, by
      // hand). Waking it is what restarts it, so a restart that had given up is one after all.
      // One this restart just put to sleep is woken whatever MAX_WAKING says: it is the board's doing.
      waking++
      const woke = await wake(cfg, item).finally(() => {
        waking--
        forgetSleepers()
      })
      if (!woke.ok) return retry(entry, woke.error, true)
      entry = updateEntry(entry.id, e => ({ ...e, step: 'note', failed: undefined, attempts: undefined, claim: { pid: process.pid, at: Date.now() } }))
      // Cancelled meanwhile: it is up again, with nothing to type.
      if (!entry) return
      item = { ...item, sleeping: false }
      await new Promise(resolve => setTimeout(resolve, settleMs()))
      if (stopped || !getEntry(entry.id)) return
    }
    const r = await send(cfg, item, promptOf(entry, Date.now()), { free: true, draft: true })
    if (!r.ok) return wait(entry, now, whyNot(r))
    return entry.failed ? sent(entry, 'failed', entry.failed) : sent(entry)
  }

  /**
   * herdr-wake refused or failed: tried again in a while, RESTART_TRIES times in all. Then the
   * session hears why; one that could not be woken sleeps on (a message wakes it), and only the
   * log says so. The time is taken now: a sleep or a wake can take minutes to fail.
   */
  function retry(entry, why, asleep = false) {
    const now = Date.now()
    const attempts = (entry.attempts ?? 0) + 1
    if (attempts < RESTART_TRIES) {
      updateEntry(entry.id, e => ({ ...e, attempts, retryAt: now + 2 * tickMs(), step: asleep ? e.step : undefined, pendingSince: e.pendingSince ?? now, tried: now, why, claim: undefined }))
      return
    }
    if (!asleep) return giveUp(entry, why)
    removeEntry(entry.id)
    logRun(record(entry, now, 'failed', why))
  }

  /**
   * A restart that will not happen: the entry stays only to tell the session why, once it is
   * free. One the user asked for on the board is the user's to hear about (the log, a toast on
   * the page): the session did not ask, so nothing is typed into it. The reason comes from
   * herdr-wake too, and goes into a terminal: no control characters.
   */
  function giveUp(entry, why) {
    why = cleanText(why, 300)
    if (entry.by === 'user') {
      removeEntry(entry.id)
      return logRun(record(entry, Date.now(), 'failed', why))
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
  function claim(id, now, extra = {}) {
    return !!updateEntry(id, e => {
      if (e.next > now) return undefined
      if (e.claim && e.claim.pid !== process.pid && now - e.claim.at < CLAIM_MS) return undefined
      return { ...e, ...extra, claim: { pid: process.pid, at: now } }
    })
  }

  /** Gone out; `result` 'failed' for the note that a restart did not happen, `why` its reason. */
  function sent(entry, result = 'sent', why) {
    const now = Date.now()
    if (entry.receipt) settleReport(entry, 'sent')
    delivered.set(entry.id, entry.next)
    finish(entry, now)
    logRun(record(entry, now, result, why))
  }

  /** After a run went out: a one-off goes, a cron entry moves on. */
  function finish(entry, now = Date.now()) {
    try {
      if (entry.cron) updateEntry(entry.id, e => settle(e, now, { lastRun: now, runs: (e.runs ?? 0) + 1 }))
      else removeEntry(entry.id)
      delivered.delete(entry.id)
    } catch (err) {
      log(`schedule ${entry.id}: ${err.message}`)
    }
  }

  // A call's results go into the log by their title: the report itself is the session's now.
  // A restart says who asked for it: the page tells the user how one of theirs went.
  const record = (entry, at, result, why) => ({ id: entry.id, key: entry.key, name: entry.name, text: entry.kind === 'call' ? callTitle(entry.text) : entry.text, ...(entry.kind && { kind: entry.kind }), ...(entry.kind === 'restart' && { by: entry.by }), cron: entry.cron, due: entry.next, at, result, why })

  /**
   * Not sent this time: try again on the next tick, or log it as missed once the wait is over.
   * `extra` goes into the entry (when background tasks began to hold a restart).
   */
  function wait(entry, now, why, extra = {}) {
    // Only time spent trying counts: a gap (the board was off) is not waiting.
    const step = entry.tried ? Math.min(now - entry.tried, 2 * tickMs() + 5000) : 0
    const waited = (entry.waited ?? 0) + step
    if (waited < patience()) {
      updateEntry(entry.id, e => ({ ...e, ...extra, pendingSince: e.pendingSince ?? now, tried: now, waited, why, claim: undefined }))
      return
    }
    const gone = why === 'gone' ? (entry.gone ?? 0) + 1 : 0
    const drop = !entry.cron || gone >= GONE_RUNS
    if (drop) removeEntry(entry.id, 'missed')
    else updateEntry(entry.id, e => settle(e, now, { missed: (e.missed ?? 0) + 1, ...(gone && { gone }) }))
    logRun({ ...record(entry, now, entry.cron && drop ? 'dropped' : 'missed', why), ...(entry.cron && drop && { n: gone }) })
  }

  /** A cron entry after a run: its next time, the waiting fields cleared. */
  function settle(e, now, counts) {
    const { pendingSince, tried, waited, why, claim, gone, ...rest } = e
    const next = nextRun(e.cron, now)
    return next === null ? null : { ...rest, ...counts, next }
  }

  // The next tick comes at the soonest due time, or after tickMs at the latest.
  function plan(ms) {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(loop, Math.max(50, ms))
  }
  async function loop() {
    await tick()
    const now = Date.now()
    // An archived session whose pane is to close counts as an entry.
    const closing = listArchive().filter(r => r.state === 'closing').map(r => r.closeAt)
    const soonest = Math.min(...[...listEntries().map(e => e.next), ...closing].filter(at => at > now))
    plan(Math.min(tickMs(), soonest - now + 50))
  }
  // A new entry, or a session put in the archive, may be due sooner than the next tick.
  const watchers = []
  let watchTimer = null
  for (const dir of [SCHEDULE_DIR, ARCHIVE_DIR]) {
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
    tick,
    stop() {
      stopped = true
      clearTimeout(timer)
      clearTimeout(watchTimer)
      for (const w of watchers) w.close()
    },
  }
}
