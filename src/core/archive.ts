// The archive without a page: which sessions may go to it and why not, which sleeping ones a
// tidy-up takes, how the archive list is searched. Shared by the page, the server and the board
// command (src/services/archive.ts); no DOM here, so the tests can read it. It also holds the
// archive's shapes: a record as it is kept on disk (src/adapters/archive-store.ts), as the page
// gets it, the log of what became of it, and the HTTP bodies and answers (src/server).
import type { ScheduleEntry, SessionRef } from './schedule-rules.ts'

const DAY = 86_400_000

/** How long a tidy-up's sessions have slept at least, in days; 0 takes every sleeping one. */
export const TIDY_DAYS: readonly number[] = [1, 3, 7, 0]

/** What the archive's rules read of a board item (an Item is one). */
export interface ArchiveCandidate {
  key: string
  session?: string | null
  agent?: string
  pane?: string | null
  status?: string
  sleeping?: boolean
  helpers?: { running?: number; workflows?: number } | null
  /** A launch's own card, no session yet. */
  launchOnly?: unknown
  /** A launch on its way into this session. */
  launch?: unknown
}

/** What the archive's rules read of a schedule entry (a ScheduleEntry is one). */
export interface ArchiveEntryFacts {
  key: string
  kind?: string
  /** A restart's: how far it got ('sleep', 'wake', 'note'). */
  step?: unknown
  /** A restart's: it gave up, why. */
  failed?: unknown
  receipt?: unknown
}

/**
 * Why a board item cannot go to the archive now, as a text key, or '' when it can. `schedules`
 * is the board's schedule. What only herdr can tell (text in its input box, a background command,
 * another session in its pane) the server checks before it closes anything.
 */
export function archiveBlock(
  it: ArchiveCandidate | null | undefined,
  schedules: readonly ArchiveEntryFacts[] = [],
): string {
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

/**
 * The schedule entries that wait with an archived session and come back with it (a restart does
 * not: a resume is one; nor does a sleep, which would put it back to sleep as it comes back).
 */
export const heldEntries = <E extends { key: string; kind?: string | undefined }>(
  schedules: readonly E[],
  key: string,
): E[] => schedules.filter(e => e.key === key && e.kind !== 'restart' && e.kind !== 'sleep')

/**
 * The sleeping sessions in "Idle" that a tidy-up takes: asleep and quiet for at least `days` days
 * (0: all of them), and free to go. Sessions that wait on the user or on someone else stay.
 */
export function tidyList<T extends ArchiveCandidate & { column?: string; activity?: number }>(
  items: readonly T[],
  days: number,
  schedules: readonly ArchiveEntryFacts[] = [],
  now = Date.now(),
): T[] {
  return items.filter(
    it => it.sleeping && it.column === 'idle' && !archiveBlock(it, schedules) && now - (it.activity || 0) >= days * DAY,
  )
}

/** What searchArchive reads of a record. */
export interface ArchiveSearchFacts {
  name?: string
  autoName?: string
  title?: string
  category: string
  cwd?: string
  note?: string
  workspace?: string
  archivedAt: number
}

/** Records whose name, lane, folder, note, workspace or day archived has every word of `query`. */
export function searchArchive<R extends ArchiveSearchFacts>(
  records: R[],
  query: unknown,
  {
    laneTitle = (id: string) => id,
    dayText = (_ms: number) => '',
  }: { laneTitle?: (id: string) => string; dayText?: (ms: number) => string } = {},
): R[] {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return records
  return records.filter(r => {
    const hay = [
      r.name,
      r.autoName,
      r.title,
      laneTitle(r.category),
      r.category,
      r.cwd,
      r.note,
      r.workspace,
      dayText(r.archivedAt),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    return words.every(w => hay.includes(w))
  })
}

// ------------------------------------------------------------------ the shapes

/**
 * Where a record is: its pane closes soon (`closing`: the card is off the board, Return puts it
 * back as it was), it is closed (`archived`), or it is on its way back onto the board (`restoring`:
 * its entries go back into the schedule, then the record goes).
 */
export type ArchiveState = 'closing' | 'archived' | 'restoring'

/** A close of the record's pane on its way, by this board process. */
export interface ArchiveClaim {
  pid: number
  at: number
}

/** A Return on its way: since when, and its launch's id (null while it is being started). */
export interface ArchiveReturning {
  at: number
  launch: string | null
}

/** What a record and the page's copy of it share. Unknown fields survive. */
interface ArchiveFacts {
  key: string
  session: string
  name: string
  autoName: string
  category: string
  cwd: string
  workspace: string
  workspaceId: string
  pane: string
  tab: string
  /** What its card said last. */
  note: string
  title: string
  sleeping: boolean
  activity: number
  archivedAt: number
  /** Who archived it: the user (the web board), or an agent (`board archive`). */
  by: 'user' | 'agent'
  /** The session that archived it, when another one did. */
  from?: SessionRef
  state: ArchiveState
  /** When its pane closes. */
  closeAt: number
  /** When its pane closed. */
  closedAt?: number
  /** The id of the Claude profile it ran in (Item.profile), at archive time. */
  profile?: string | null
  /** The folder it reported when no profile had it (Item.profileFolder). */
  profileFolder?: string
  /** The profile its start asked for, when it ran in another (Item.profileWanted). */
  profileWanted?: string
  [extra: string]: unknown
}

/** A session in the archive, as its file holds it (one per session, in the state folder's archive/). */
export interface ArchiveRecord extends ArchiveFacts {
  /** Its schedule entries, without the scheduler's bookkeeping: they wait with it and come back with it. */
  held: ScheduleEntry[]
  /** How many times herdr failed to close its pane. */
  tries?: number
  claim?: ArchiveClaim
  returning?: ArchiveReturning
  /** Being put back in the pane it came back in (Return, or resumed by hand). */
  moved?: boolean
}

/** A record as the page gets it (GET /api/archive): no claims, the held entries as a count. */
export interface PublicArchiveRecord extends ArchiveFacts {
  held: number
  /** A Return of it is on its way. */
  returning: boolean
}

/** What the page shows of a record: no claims, the held entries as a count. */
export function publicRecord(
  r: ArchiveRecord,
  { returning = false }: { returning?: boolean } = {},
): PublicArchiveRecord {
  const { claim, held, tries, moved, ...rest } = r
  return { ...rest, held: (held ?? []).length, returning }
}

/** What became of a session: its pane closed, it stayed on the board, came back, was removed, or an entry of it did not go back. */
export type ArchiveResult = 'closed' | 'kept' | 'returned' | 'removed' | 'unrestored'

/** A line of the archive's log (the board payload's `archive.log`, newest first). */
export interface ArchiveLogEntry {
  key: string
  name: string
  at: number
  result: ArchiveResult
  /** Why it stayed on the board, as a text key. */
  why?: string
  /** What herdr said, or the entry that did not go back. */
  detail?: string
  [extra: string]: unknown
}

/** GET /api/archive: every record, newest first, and how long a session keeps its pane for Return. */
export interface ArchiveList {
  records: PublicArchiveRecord[]
  undoMs: number
}

export type ArchiveOp = 'archive' | 'return' | 'remove'

/** POST /api/archive: archive, bring back or remove sessions (by their keys), one or many. */
export interface ArchiveRequest {
  op: ArchiveOp
  keys: string[]
}

/** A session archived: how many of its entries wait with it, when its pane closes. */
export interface ArchivedOne {
  key: string
  name: string
  held: number
  closeAt: number
}

/**
 * A session brought back: put back as it was before its pane closed (`back`), already on its way
 * back from an earlier Return (`again`), or resumed in a new tab by the launch `launch` (`resume`).
 */
export interface ReturnedOne {
  key: string
  ok: true
  name: string
  back?: boolean
  again?: boolean
  resume?: true
  launch?: string
}

/** A session removed from the archive. */
export interface RemovedOne {
  key: string
  name: string
}

/** A session a POST /api/archive did not do: why, as a text key (an archive refused) and as text. */
export interface ArchiveFailure {
  key: string
  error: string
  name?: string
  why?: string
}

/** What each op answers for a session it did. */
export interface ArchiveDoneOf {
  archive: ArchivedOne
  return: ReturnedOne
  remove: RemovedOne
}

/** POST /api/archive's answer: 200 when it did one or failed none, else 409 with the first error. */
export interface ArchiveAnswer<O extends ArchiveOp = ArchiveOp> {
  ok: boolean
  done: ArchiveDoneOf[O][]
  failed: ArchiveFailure[]
  error?: string
}

/** POST /api/session/<key>/archive: the card is off the board, its pane closes at `closeAt`; or why it stays. */
export type ArchiveActionAnswer =
  | { ok: true; held: number; dropped: number; closeAt: number }
  | { ok: false; why: string; error: string }

/** The board payload's `archive`: what became of the latest sessions put in it, newest first (the page's toasts). */
export interface BoardArchive {
  log: ArchiveLogEntry[]
}
