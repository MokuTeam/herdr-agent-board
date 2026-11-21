// The master's queue of starts that wait for room (#504, docs/design/nodes 8.3):
// `<state>/nodes/queue.json`, so a start that waits survives a restart of the master (launches
// themselves live in memory). At most 50 entries; each names the master that accepted it
// (`nodes.id`), and a board reads back only its own, leaving another's as it found them. Written
// through the locked JSON writer, 0600: a start's first message is in it.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Blocker, Task } from '../core/placement.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { nodesDir } from './node-store.ts'

/** At most this many starts wait (8.3). */
export const QUEUE_MAX = 50

/** Where a start's folder comes from on a node (6.4), as the placer worked it out on the master. */
export type NodeSource =
  | { kind: 'repo'; url: string; ref: string; subdir: string; worktree: { branch: string } | null }
  | { kind: 'path'; cwd: string; worktree: { branch: string } | null }

export interface QueueEntry {
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
}

interface QueueFile {
  version: 1
  entries: QueueEntry[]
}

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
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
  isRecord(v.task)
const isQueueFile = (v: unknown): v is QueueFile => isRecord(v) && v.version === 1 && Array.isArray(v.entries)

export interface NodeQueue {
  /** This master's entries, oldest first; what is not an entry is left out. */
  read(master: string): QueueEntry[]
  /** Adds or replaces an entry; false when 50 of its master's wait already. */
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
        // Another master's entries (a board renamed, say) do not count against this one's 50.
        if (others.filter(e => isEntry(e) && e.master === entry.master).length >= QUEUE_MAX) {
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
