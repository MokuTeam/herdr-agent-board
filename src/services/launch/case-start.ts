// spawn-agent --thread <key> (#488, case files): a fresh Claude session picks a case up from its brief
// (core/work-cases.ts caseBriefText) instead of a large sleeper being woken. Before anything starts:
// case files on, the thread found, not a mirrored one, agents may write. The session gets an id of
// its own up front, so the brief can tell it that it holds the case and who held it before; it
// starts in --cwd, else in the folder of a session that held the case (services/work-cases.ts
// holderFolder), never the caller's; once it runs under that id it becomes the assignee, written as
// the one who ran spawn-agent (its session, else the owner). A closed thread is said, not refused.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { openDb } from '../../adapters/db.ts'
import { findThread, getThread, ThreadError } from '../../adapters/work-thread-store.ts'
import type { SpawnOptions } from '../../core/launch/spawn-args.ts'
import { isMirrored } from '../../core/thread-import.ts'
import type { Config } from '../../core/types.ts'
import { caseBriefText, caseSessions, freeName } from '../../core/work-cases.ts'
import { isOpen, type Party, partyName, threadLink, threadsConfig } from '../../core/work-threads.ts'
import { type CaseResolvers, holderFolder, readCase } from '../work-cases.ts'
import { filePath, setFields } from '../work-threads.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CaseStart {
  /** The options to start with: the folder, the session id and the brief filled in. */
  options: SpawnOptions
  key: string
  /** Lines for stderr, after the key: where the folder came from, a thread that is closed. */
  notes: string[]
  /** Who holds the case before the start ("nobody" for none): it stays there when no session comes up. */
  heldBy: string
  /** Makes the started session the thread's assignee; the words for the output. */
  assign(session: string | null, name: string): string
}

/** What the session is told before the case's brief. */
export function casePreface(key: string): string {
  return [
    `You pick up the case in thread ${key}: it is given to you. What the board knows of it follows.`,
    `Report in the thread (board thread post ${key} ...), and before you stop or wait, write where it stands: board thread post ${key} --state "<where it stands, what is next, what it waits on>".`,
  ].join('\n')
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Reads the case and fills in the options; throws with the reason before anything starts. */
export async function prepareCaseStart(
  o: SpawnOptions,
  deps: {
    cfg: Pick<Config, 'threads' | 'port'>
    resolvers: CaseResolvers
    /** Who runs spawn-agent: its session, else the owner. */
    actor: Party
    now?: number
    exists?: (dir: string) => boolean
  },
): Promise<CaseStart> {
  const word = o.thread ?? ''
  const cfg = threadsConfig(deps.cfg.threads)
  if (!cfg?.cases) throw new Error('--thread needs case files: "threads": { "cases": true } in config.json')
  if (deps.actor.kind === 'session' && !cfg.agents)
    throw new Error("threads are the owner's on this board: agents do not write to them")
  const now = deps.now ?? Date.now()
  const base = `http://127.0.0.1:${typeof deps.cfg.port === 'number' ? deps.cfg.port : 12422}/`
  const db = openDb({ create: false })
  if (!db) throw new Error(`no thread "${word}" on this board: it has no threads yet`)
  let brief: string
  let cwd = o.cwd
  const notes: string[] = []
  let key: string
  let name = o.name
  let heldBy = 'nobody'
  const sessionId = o.sessionId ?? randomUUID()
  const caller = deps.actor.kind === 'session' ? deps.actor.key : undefined
  try {
    let head: ReturnType<typeof findThread>
    try {
      head = findThread(db, word, null, true)
    } catch (err) {
      throw new Error(err instanceof ThreadError ? err.message : String(err))
    }
    key = head.key
    if (isMirrored(head)) throw new Error(`${key} is a copy of a pi task board: start its work there`)
    if (!isOpen(head.status)) notes.push(`is ${head.status}: the session starts on it all the same`)
    const c = await readCase(db, head, deps.resolvers)
    if (head.assignee)
      heldBy = (head.assignee.kind === 'session' && c.live.get(head.assignee.key)?.name) || partyName(head.assignee)
    if (!cwd.trim()) {
      const found = holderFolder(c, deps.exists ?? isDir, caller)
      if (!found)
        throw new Error(
          `no session that held ${key} has a folder that still exists (the one running spawn-agent does not count): pass --cwd <folder>`,
        )
      cwd = found.cwd
      const live = c.live.get(found.session.key)
      notes.push(
        `starts in ${cwd}, the folder of ${live?.name || found.session.name || found.session.key.slice(0, 8)} (${found.session.key})`,
      )
    }
    // --name not given: the thread's own key, whatever word named it (ATLAS-1, an id's prefix, #1),
    // then key-2, key-3 while a session up or asleep has that name, so a message by name finds one.
    if (o.name === o.thread) {
      const taken = deps.resolvers.names
        ? await deps.resolvers.names().catch(() => new Set<string>())
        : new Set<string>()
      name = freeName(key, taken)
    }
    // The brief as the new session will find the case: given to it, the one before named as such.
    const you: Party = { kind: 'session', key: sessionId, name }
    const given = { ...head, assignee: you }
    const parent = head.parent ? getThread(db, head.parent) : null
    brief = caseBriefText({
      head: given,
      entries: c.entries,
      sessions: caseSessions(given, c.entries).filter(s => s.key !== sessionId),
      you: sessionId,
      live: c.live,
      reminders: c.reminders,
      link: threadLink(base, key),
      now,
      fileAt: f => filePath(f.ref),
      keyOfId: id => getThread(db, id)?.key ?? id.slice(0, 8),
      parentKey: parent?.key ?? null,
    })
  } finally {
    db.close()
  }
  const task =
    o.briefFile !== undefined
      ? readFileSync(o.briefFile, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
      : (o.brief ?? '').trim()
  const { briefFile: _file, ...rest } = o
  const options: SpawnOptions = {
    ...rest,
    name,
    cwd,
    sessionId,
    brief: [casePreface(key), brief, ...(task ? [`Your task:\n${task}`] : [])].join('\n\n'),
  }
  return {
    options,
    key,
    notes,
    heldBy,
    assign(session, name) {
      const id = session && UUID.test(session) ? session : sessionId
      const db2 = openDb({ create: false })
      if (!db2) return `${key} not assigned: the board's database is gone`
      try {
        const head = findThread(db2, key, null, true)
        const w = setFields({ db: db2, cfg, actor: deps.actor, now: Date.now(), ownerHolds: true }, head, {
          assignee: { kind: 'session', key: id, name },
        })
        return `${w.head.key} assigned to ${partyName(w.head.assignee)}`
      } catch (err) {
        return `${key} NOT assigned (${err instanceof Error ? err.message : String(err)}): give it by hand with board thread set ${key} --assignee ${id}`
      } finally {
        db2.close()
      }
    },
  }
}
