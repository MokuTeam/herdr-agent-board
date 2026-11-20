// Verified done (#492, docs/design/threads 3.8): on a thread that asks for it, a session's done is
// held while a fresh verifier, started by the board, checks the work against the thread's
// acceptance lines and a checklist, knowing nothing of the worker's conversation. Pure: the
// verifier's name, its brief, the lines its entries say. The fold is core/work-threads.ts
// (applyEntry, VerifyHead); starting it, the time limit and the verdict services/work-verify.ts.
import {
  clip,
  entryWords,
  oneLine,
  partyName,
  SUMMARY_MAX,
  type ThreadEntry,
  type ThreadFile,
  type ThreadHead,
  whenText,
} from './work-threads.ts'

/** The verifier's name on the board: its session's, and the author of the board's entries about it. */
export const verifierName = (key: string): string => `verify-${key}`.slice(0, 60)

/** The brief at most: a launch's first message takes 20,000 characters. */
export const VERIFY_BRIEF_MAX = 12_000
/** The thread's recent entries in the brief: this many, each cut to this many characters. */
const RECENT = 5
const RECENT_MAX = 400
/** The held done's own words in the brief. */
const DONE_MAX = 3000

export interface BriefInput {
  head: ThreadHead
  /** The thread's entries, oldest first. */
  entries: readonly ThreadEntry[]
  /** The checklist's text (the default file, or the one verify.brief names). */
  checklist: string
  /** The worker's folder, where the verifier runs. */
  folder: string
  /** The time limit and now, for the words. */
  until: number
  now: number
  limitMin: number
  fileAt: (f: ThreadFile) => string
}

/** The entry that holds the done now: the newest done held for verification. */
export const heldEntry = (entries: readonly ThreadEntry[]): ThreadEntry | undefined =>
  [...entries].reverse().find(e => e.set?.status === 'done' && e.set.hold === true)

/**
 * The verifier's first message: who it is and the rule (it changes nothing and ends with one
 * verdict), the thread (title, acceptance lines, the held done's words, its files and links, the
 * last entries), then the checklist. At most VERIFY_BRIEF_MAX characters: the checklist is cut
 * first, then the recent entries.
 */
export function verifyBrief(o: BriefInput): string {
  const h = o.head
  const done = heldEntry(o.entries)
  const by = h.proposed ? partyName(h.proposed.by) : done ? partyName(done.author) : 'the worker'
  const accept = h.verify?.accept ?? []
  const rule = [
    `[board verify] You are the verifier of thread ${h.key}, started by the board. You know nothing of the worker's conversation, and you change nothing: no edits, no commits, no pushes, no messages, no thread posts. Reading files and records, git log and diff, gh ... view, and running single test files are fine; never a whole test suite on a shared machine unless the checklist below says so.`,
    '',
    "Check whether the work below is really done, against the acceptance lines and the checklist. Never take the worker's word for anything: look at the thing each claim names. Then end with exactly one verdict:",
    `  board thread verdict ${h.key} pass --file <report.md> "<one line>"   the report names each acceptance line and checklist point with what you looked at`,
    `  board thread verdict ${h.key} fail "<what is missing or wrong>"`,
    `  board thread verdict ${h.key} unsure "<what you could not check, and why>"`,
    'Write the report in a temp folder, not in the work folder.',
    `Time limit: ${whenText(o.until, o.now)} (${o.limitMin} min). Without a verdict by then the thread goes to the owner.`,
  ]
  const thread = [
    '',
    `Thread ${h.key}: ${h.title}`,
    `Lane ${h.lane} · done proposed by ${by} · folder ${o.folder}`,
    accept.length ? 'Acceptance lines:' : 'Acceptance lines: none; judge by what the thread asks.',
    ...accept.map(a => `- ${a}`),
    '',
    `The done it proposed${done ? ` (#${done.n}, ${whenText(done.at, o.now)})` : ''}: ${h.proposed?.why || '(no summary)'}`,
    ...(done?.text ? [clip(done.text, DONE_MAX)] : []),
    ...(done?.files ?? []).map(f => `File: ${f.name} ${o.fileAt(f)}`),
    ...(done?.links ?? []).map(l => `Link: ${l.url}`),
  ]
  const recent = o.entries
    .filter(e => e.id !== done?.id)
    .slice(-RECENT)
    .map(e => `#${e.n} ${clip(entryWords(e, { fileAt: o.fileAt }).replace(/\s*\n\s*/g, ' '), RECENT_MAX)}`)
  const tail = [
    ...(recent.length ? ['', 'Recent entries, oldest first:', ...recent] : []),
    `More: board thread show ${h.key} --full`,
  ]
  const checklist = ['', 'Checklist:', o.checklist.trim()]
  const join = (parts: string[][]): string => parts.flat().join('\n')
  let text = join([rule, thread, tail, checklist])
  if (text.length <= VERIFY_BRIEF_MAX) return text
  const room = VERIFY_BRIEF_MAX - join([rule, thread, tail]).length - 40
  text = join([rule, thread, tail, ['', 'Checklist:', clip(o.checklist.trim(), Math.max(200, room))]])
  return clip(text, VERIFY_BRIEF_MAX)
}

/** What the thread waits on after a verification that reached the owner (#492). */
export function ownerLine(outcome: 'fail' | 'unsure' | 'timeout' | 'error', line: string, limitMin = 30): string {
  const why =
    outcome === 'fail'
      ? `verification failed twice: ${line}`
      : outcome === 'unsure'
        ? `the verifier could not check: ${line}`
        : outcome === 'timeout'
          ? `no verdict within ${limitMin} min`
          : `no verifier: ${line}`
  return oneLine(why, SUMMARY_MAX)
}
