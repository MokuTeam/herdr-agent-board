// The master's queue of starts that wait for room or are on their way to a node (#504, #588,
// docs/design/nodes 8.3): `<state>/nodes/queue.json`, so a start that waits or has not been
// acknowledged by a node yet survives a restart of the master (launches themselves live in
// memory). At most 50 waiting entries (in-flight syncing/sent entries do not count toward or block
// at 50); each names the master that accepted it (`nodes.id`), and a board reads back only its
// own, leaving another's as it found them. Written through the locked JSON writer, 0600: a start's
// first message is in it.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GitIdentity } from '../core/git-access.ts'
import type { Blocker, Task } from '../core/placement.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { nodesDir } from './node-store.ts'

/** At most this many starts wait (8.3). */
export const QUEUE_MAX = 50

/**
 * Where a start's folder comes from on a node (6.4), as the placer worked it out on the master. A
 * repository's `identity` is the author git gives in the master's checkout (#611); absent when it
 * gives none.
 */
export type NodeSource =
  | {
      kind: 'repo'
      url: string
      ref: string
      subdir: string
      worktree: { branch: string } | null
      identity?: GitIdentity
    }
  | { kind: 'path'; cwd: string; worktree: { branch: string } | null }

export interface QueueEntry {
  by?: string
  /** The launch's id on the master's board. */
  id: string
  /** The session id it starts with, wherever it goes: a node's identity of the start. */
  session: string
  /** `nodes.id` of the master that accepted it. */
  master: string
  at: number
  /** The checked request (services/launch/request.ts LaunchRequest), as the placer kept it. */
  request: Record<string, unknown>
  task: Task
  /** null: a start that may only run at its origin, this computer. */
  source: NodeSource | null
  /** What it waits on, for its card after a restart. */
  wait?: Blocker
  /** The node whose profile is being synced before the launch request (#588). */
  syncing?: string
  /** The node `POST /api/node/launch` was sent to without an acknowledgement yet (#588). */
  sent?: string
  /** When `POST /api/node/launch` was sent to `sent` (ms, #588). */
  sentAt?: number
  /** True when the start must use `session` as an exact Claude session id (a verifier, #675). */
  exactSession?: true
  /** spawn-agent --trust (#798): the board that runs it answers the folder-trust dialog. */
  trust?: true
}

interface QueueFile {
  version: 1
  entries: QueueEntry[]
}

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const optionalDevice = (v: unknown): boolean => v === undefined || (typeof v === 'string' && v.length > 0)
const optionalAt = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v))
const inFlight = (e: QueueEntry): boolean => e.sent !== undefined || e.syncing !== undefined
const isEntry = (v: unknown): v is QueueEntry =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  typeof v.session === 'string' &&
  SESSION.test(v.session) &&
  typeof v.master === 'string' &&
  typeof v.at === 'number' &&
  isRecord(v.request) &&
  typeof v.request.name === 'string' &&
  typeof v.request.cwd === 'string' &&
  isRecord(v.task) &&
  optionalDevice(v.syncing) &&
  optionalDevice(v.sent) &&
  optionalAt(v.sentAt) &&
  (v.by === undefined || typeof v.by === 'string') &&
  (v.trust === undefined || v.trust === true)
const isQueueFile = (v: unknown): v is QueueFile => isRecord(v) && v.version === 1 && Array.isArray(v.entries)

export interface NodeQueue {
  /** This master's entries, oldest first; what is not an entry is left out. */
  read(master: string): QueueEntry[]
  /** Adds or replaces an entry; false when 50 waiting entries of its master wait already (in-flight entries never count or fail here). */
  put(entry: QueueEntry): boolean
  remove(id: string): void
}

export function createNodeQueue({ file = join(nodesDir(), 'queue.json') }: { file?: string } = {}): NodeQueue {
  const change = (fn: (entries: QueueEntry[]) => QueueEntry[] | null): void => {
    mkdirSync(dirname(file), { recursive: true })
    updateJson<QueueFile>(
      file,
      cur => {
        const entries = cur?.entries ?? []
        const next = fn(entries)
        return next === null ? undefined : { version: 1, entries: next }
      },
      isQueueFile,
      { mode: 0o600 },
    )
  }
  return {
    read(master) {
      const cur = readJson(file, isQueueFile)
      return (cur?.entries ?? []).filter(isEntry).filter(e => e.master === master)
    },
    put(entry) {
      let ok = true
      change(entries => {
        const others = entries.filter(e => !(isEntry(e) && e.id === entry.id))
        // Another master's entries and in-flight starts do not count against this master's 50 waiting slots.
        if (
          !inFlight(entry) &&
          others.filter(e => isEntry(e) && e.master === entry.master && !inFlight(e)).length >= QUEUE_MAX
        ) {
          ok = false
          return null
        }
        return [...others, entry]
      })
      return ok
    },
    remove(id) {
      change(entries =>
        entries.some(e => isEntry(e) && e.id === id) ? entries.filter(e => !(isEntry(e) && e.id === id)) : null,
      )
    },
  }
}
