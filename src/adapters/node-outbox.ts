// The outbox on a node (#508, docs/design/nodes 5, 10 item 5, 21.3 item 7): the calls its sessions
// make to the master, one file per call in `<state>/node/outbox/<id>.json`, mode 0600 (a call
// carries the text of a post), and the files it names copied beside it, `<id>/<n>`, as they were
// when the command ran: a file the agent changes or removes while the master is away still goes as
// it was posted. Written before the command waits, removed with its copies once the master has
// answered (or, for a call that is not kept, once the command gave up). A call waits here for "the
// master", not for a connection: whichever master's stream opens next takes it.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCallId, type UplinkFile, type UplinkSelf } from '../core/node-uplink.ts'
import { isRecord, replaceFile } from './json-store.ts'
import { nodeDir } from './node-store.ts'

/** A call as the outbox keeps it: what goes up the link, and where its files are on this node. */
export interface OutboxCall {
  id: string
  cmd: string
  argv: string[]
  session: string
  lane: string | null
  /** The files the call registered, each with its copy's path here, which never leaves this node. */
  files: (UplinkFile & { path: string })[]
  /** For `board thread verdict` (#675): the pane's session as the node's herdr confirmed it. */
  self?: UplinkSelf
  /** For `board team post|reply --session <target>` (#698): session was named explicitly with --session. */
  claimed?: boolean
  /** A write that waits for the master (core/node-uplink.ts KEPT_SUBS). */
  keep: boolean
  at: number
}

export interface Outbox {
  /** A file of the call `id`, kept as its number `n` (mode 0600); the copy's path. */
  copy(id: string, n: number, bytes: Uint8Array): string
  write(call: OutboxCall): void
  read(id: string): OutboxCall | null
  /** Every call waiting, oldest first. */
  list(): OutboxCall[]
  remove(id: string): void
}

const isText = (v: unknown): v is string => typeof v === 'string'

function callOf(v: unknown): OutboxCall | null {
  if (!isRecord(v) || !isCallId(v.id) || !isText(v.cmd) || !Array.isArray(v.argv) || !v.argv.every(isText)) return null
  if (!isText(v.session) || (v.lane !== null && !isText(v.lane)) || !Array.isArray(v.files)) return null
  if (typeof v.at !== 'number' || typeof v.keep !== 'boolean') return null
  if (v.claimed !== undefined && typeof v.claimed !== 'boolean') return null
  const files = v.files.filter(
    (f): f is OutboxCall['files'][number] =>
      isRecord(f) &&
      Number.isInteger(f.n) &&
      isText(f.name) &&
      isText(f.path) &&
      Number.isSafeInteger(f.size) &&
      isText(f.sha256),
  )
  if (files.length !== v.files.length) return null
  let self: UplinkSelf | undefined
  if (v.self !== undefined && v.self !== null) {
    if (!isRecord(v.self)) return null
    const hasKey = Object.hasOwn(v.self, 'key') && v.self.key !== undefined
    const hasWhy = Object.hasOwn(v.self, 'why') && v.self.why !== undefined
    if (hasKey === hasWhy) return null
    if (hasKey) {
      if (!isText(v.self.key) || !v.self.key) return null
      self = { key: v.self.key }
    } else {
      if (!isText(v.self.why) || !v.self.why) return null
      self = { why: v.self.why }
    }
  }
  return {
    id: v.id,
    cmd: v.cmd,
    argv: v.argv,
    session: v.session,
    lane: v.lane,
    files,
    ...(self && { self }),
    ...(v.claimed !== undefined && { claimed: v.claimed }),
    keep: v.keep,
    at: v.at,
  }
}

export function createOutbox({ dir = join(nodeDir(), 'outbox') }: { dir?: string } = {}): Outbox {
  /** Where the call `id` keeps its files; throws on an id that is not one, so no path leaves the folder. */
  const folderOf = (id: string): string => {
    if (!isCallId(id)) throw new Error(`not a call id: ${JSON.stringify(id)}`)
    return join(dir, id)
  }
  const fileOf = (id: string): string => `${folderOf(id)}.json`
  const read = (id: string): OutboxCall | null => {
    try {
      return callOf(JSON.parse(readFileSync(fileOf(id), 'utf8')))
    } catch {
      return null
    }
  }
  return {
    copy(id, n, bytes) {
      const at = folderOf(id)
      mkdirSync(at, { recursive: true })
      const path = join(at, String(n))
      writeFileSync(path, bytes, { mode: 0o600 })
      return path
    },
    write(call) {
      mkdirSync(dir, { recursive: true })
      replaceFile(fileOf(call.id), JSON.stringify(call), undefined, 0o600)
    },
    read,
    list() {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return []
      }
      return names
        .filter(n => n.endsWith('.json'))
        .map(n => (isCallId(n.slice(0, -5)) ? read(n.slice(0, -5)) : null))
        .filter((c): c is OutboxCall => c !== null)
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    },
    remove(id) {
      rmSync(fileOf(id), { force: true })
      rmSync(folderOf(id), { recursive: true, force: true })
    },
  }
}
