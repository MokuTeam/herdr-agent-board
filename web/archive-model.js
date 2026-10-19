// The archive without a page: which sessions may go to it and why not, which sleeping ones a
// tidy-up takes, how the archive list is searched. Shared by the page, the server and the board
// command (src/archive.mjs); no DOM here, so the tests can read it.

const DAY = 86_400_000

/** How long a tidy-up's sessions have slept at least, in days; 0 takes every sleeping one. */
export const TIDY_DAYS = [1, 3, 7, 0]

/**
 * Why a board item cannot go to the archive now, as a text key, or '' when it can. `schedules`
 * is the board's schedule. What only herdr can tell (text in its input box, a background command,
 * another session in its pane) the server checks before it closes anything.
 */
export function archiveBlock(it, schedules = []) {
  if (!it || it.launchOnly || it.launch) return 'archive.why.starting'
  // Only a Claude session comes back: Return resumes it by its id.
  if (!it.session || it.agent !== 'claude') return 'archive.why.notClaude'
  if (!it.pane) return 'archive.why.noPane'
  if (it.status === 'working') return 'archive.why.working'
  if (it.status === 'blocked') return 'archive.why.dialog'
  if (!it.sleeping && (it.helpers?.running || it.helpers?.workflows)) return 'archive.why.helpers'
  for (const e of schedules) {
    if (e.key !== it.key) continue
    // Claude is out and coming back right now.
    if (e.kind === 'restart' && (e.step === 'sleep' || e.step === 'wake') && !e.failed) return 'archive.why.restarting'
    // A report with a receipt must reach the session or be settled; it cannot wait in a record.
    if (e.receipt) return 'archive.why.report'
  }
  return ''
}

/** The schedule entries that wait with an archived session and come back with it (a restart does not: a resume is one). */
export const heldEntries = (schedules, key) => schedules.filter(e => e.key === key && e.kind !== 'restart')

/**
 * The sleeping sessions in "Idle" that a tidy-up takes: asleep and quiet for at least `days` days
 * (0: all of them), and free to go. Sessions that wait on the user or on someone else stay.
 */
export function tidyList(items, days, schedules = [], now = Date.now()) {
  return items.filter(it => it.sleeping && it.column === 'idle' && !archiveBlock(it, schedules) && now - (it.activity || 0) >= days * DAY)
}

/** Records whose name, lane, folder, note, workspace or day archived has every word of `query`. */
export function searchArchive(records, query, { laneTitle = id => id, dayText = () => '' } = {}) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return records
  return records.filter(r => {
    const hay = [r.name, r.autoName, r.title, laneTitle(r.category), r.category, r.cwd, r.note, r.workspace, dayText(r.archivedAt)].filter(Boolean).join('\n').toLowerCase()
    return words.every(w => hay.includes(w))
  })
}

/**
 * Whether a card let go at `p` (moving at `v`, px/s) lands on the drop place `r` (a rect): over
 * it, with `pad` px of slop around it, or flicked at it from within `reach` px, so that where the
 * flick would come to rest (the scroll-view projection, spring.js) is on it.
 */
export function dropsOn(r, p, v = { x: 0, y: 0 }, { pad = 18, reach = 160, rate = 0.99 } = {}) {
  const on = q => q.x >= r.left - pad && q.x <= r.right + pad && q.y >= r.top - pad && q.y <= r.bottom + pad
  if (on(p)) return true
  const dx = Math.max(r.left - p.x, 0, p.x - r.right)
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom)
  if (dx * dx + dy * dy > reach * reach) return false
  const k = rate / (1 - rate) / 1000
  return on({ x: p.x + v.x * k, y: p.y + v.y * k })
}
