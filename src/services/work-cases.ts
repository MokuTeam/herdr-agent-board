// Case files (#488, core/work-cases.ts) against the board's database: a case read with its sessions
// and their reminders for `show`, `brief` and the page, and the nudge `board wait`, `board done` and
// `board sleep --self` add to their line. What the board knows of a session now (up, asleep, in the
// archive) and its reminders come from the caller, which asks herdr, wake and the schedule only when
// a case has sessions to name.
import { type BoardDb, openDb } from '../adapters/db.ts'
import { entriesOf, listThreads } from '../adapters/work-thread-store.ts'
import type { Config } from '../core/types.ts'
import {
  type CaseReminder,
  type CaseSession,
  caseHolders,
  caseSessions,
  isCase,
  type SessionLive,
  staleCase,
} from '../core/work-cases.ts'
import { type ThreadEntry, type ThreadHead, threadsConfig } from '../core/work-threads.ts'

/** How the caller finds what the board knows of sessions now, and their open reminders. */
export interface CaseResolvers {
  live?(keys: readonly string[]): Promise<Map<string, SessionLive>>
  reminders?(keys: readonly string[]): CaseReminder[] | Promise<CaseReminder[]>
  /** The names of the sessions up or asleep now, lowercased (spawn-agent --thread names a new one). */
  names?(): Promise<ReadonlySet<string>>
}

/** A case as read: its head, its whole feed, its sessions, where they are now and their reminders. */
export interface CaseRead {
  head: ThreadHead
  entries: ThreadEntry[]
  sessions: CaseSession[]
  live: Map<string, SessionLive>
  reminders: CaseReminder[]
}

/** The case `head` with what the resolvers say of its sessions; a resolver that fails says nothing. */
export async function readCase(
  db: Pick<BoardDb, 'db'>,
  head: ThreadHead,
  r: CaseResolvers,
  o: { reminders?: boolean; entries?: ThreadEntry[] } = {},
): Promise<CaseRead> {
  const entries = o.entries ?? entriesOf(db, head.id)
  const sessions = caseSessions(head, entries)
  const keys = sessions.map(s => s.key)
  const live = keys.length && r.live ? await r.live(keys).catch(() => new Map<string, SessionLive>()) : new Map()
  const reminders =
    keys.length && o.reminders !== false && r.reminders
      ? await Promise.resolve(r.reminders(keys)).catch((): CaseReminder[] => [])
      : []
  return { head, entries, sessions, live, reminders }
}

/**
 * The folder a fresh session of the case starts in (spawn-agent --thread): the folder of a session
 * that held the case (core/work-cases.ts caseHolders: the assignee, then the earlier ones, the most
 * recently assigned first) that still exists, with that session. Never `caller`'s, the session that
 * runs spawn-agent (a coordinator that made the thread or wrote in it works elsewhere), nor that of a
 * session that only wrote, nor a node's (its folder is on that computer). Null when no holder has one.
 */
export function holderFolder(
  c: Pick<CaseRead, 'head' | 'entries' | 'sessions' | 'live'>,
  exists: (dir: string) => boolean,
  caller?: string,
): { cwd: string; session: CaseSession } | null {
  for (const key of caseHolders(c.head, c.entries)) {
    if (key === caller) continue
    const s = c.sessions.find(x => x.key === key)
    const live = c.live.get(key)
    // A node's session ran in that computer's folder: none of this one's.
    if (live?.device) continue
    const cwd = live?.cwd
    if (s && cwd && exists(cwd)) return { cwd, session: s }
  }
  return null
}

/** The nudges for the open cases `session` holds (core/work-cases.ts staleCase). */
export function caseNudges(db: BoardDb, session: string, doingAt: number | undefined, now: number): string[] {
  const out: string[] = []
  for (const h of listThreads(db)) {
    if (h.assignee?.kind !== 'session' || h.assignee.key !== session || !isCase(h)) continue
    const n = staleCase(h, entriesOf(db, h.id), session, doingAt, now)
    if (n) out.push(n)
  }
  return out
}

/**
 * The nudges for `board wait`, `board done` and `board sleep --self`: none, and nothing opened or
 * asked, unless config.json turned cases on and the board has its database. It refuses nothing and
 * never fails the command.
 */
export function nudgesFor(
  cfg: Pick<Config, 'threads'>,
  session: string,
  doingAt: number | undefined,
  now = Date.now(),
): string[] {
  if (!threadsConfig(cfg.threads)?.cases) return []
  let db: BoardDb | null = null
  try {
    db = openDb({ create: false })
    return db ? caseNudges(db, session, doingAt, now) : []
  } catch {
    return []
  } finally {
    db?.close()
  }
}
