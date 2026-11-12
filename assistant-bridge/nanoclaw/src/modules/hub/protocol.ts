// The frames between the assistant bridge and its NanoClaw module (#384, design 3.3): one JSON
// object per line over a unix socket, mode 0600. The bridge holds the hub; the module lives in
// NanoClaw's host process and is the only one that writes into NanoClaw's sessions.
//
// This file has no imports so that it can be copied as it is into the NanoClaw module
// (assistant-bridge/nanoclaw/src/modules/hub/protocol.ts); a test keeps the two copies the same.

export const BRIDGE_PROTOCOL = 1

/** The longest line either side reads; a longer one is dropped and the connection closed. */
export const MAX_LINE = 64 * 1024

/**
 * A place in NanoClaw a hub message can go: one of the host assistant's topics, by NanoClaw's own
 * thread id for it. The inbox is one of them; which one is the bridge's business (its config).
 * Phase 3 adds `group:<agent group id>`.
 */
export type Location = `host:${string}`

/** A topic of the host assistant as the module sees it: NanoClaw's thread id and the name the bot recorded. */
export interface Topic {
  id: string
  name?: string
}

/** `hub_send`'s arguments, as the agent gave them. */
export interface SendArgs {
  /** A hub thread's ref: 8 or more characters of a topic's id, `team`, or `general:<peer name>`. */
  thread?: string
  /** A peer's roster name, for a new topic (with `title`) or that pair's general (without). */
  to?: string
  title?: string
  text: string
  /** The ref of the message answered (8 or more characters of its id). */
  replyTo?: string
}

/** `hub_inbox`'s arguments. */
export interface InboxArgs {
  thread?: string
  full?: boolean
}

/** What the module sends. `from` of a call is the session that wrote it, never the agent's words. */
export type ModuleFrame =
  | { t: 'hello'; v: number; topics: Topic[] }
  | { t: 'confirm'; id: string }
  | { t: 'call'; req: string; from: Location; op: 'send'; args: SendArgs }
  | { t: 'call'; req: string; from: Location; op: 'inbox'; args: InboxArgs }

/**
 * What the bridge sends. `deliver`, `schedule` and `notice` each carry an id the module confirms
 * once it has done it; the bridge sends again whatever is unconfirmed when the module says hello,
 * so the module treats a second frame with the same id as done (a row id already written).
 * - `deliver`: write one inbound row into the location's session; `trigger: 1` wakes it.
 * - `schedule`: write one row due at `when` (ISO time), which wakes the session then.
 * - `notice`: a line for the owner, sent to the location's Telegram topic as the bot.
 * - `result`: the answer to a `call`, one line for the agent.
 */
export type BridgeFrame =
  | { t: 'welcome'; v: number }
  | { t: 'deliver'; id: string; at: Location; trigger: 0 | 1; text: string }
  | { t: 'schedule'; id: string; at: Location; when: string; text: string }
  | { t: 'notice'; id: string; at: Location; text: string }
  | { t: 'result'; req: string; ok: boolean; text: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isId = (v: unknown): v is string => isStr(v) && v.length >= 1 && v.length <= 200

const printable = (s: string): boolean => [...s].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)

export const isLocation = (v: unknown): v is Location =>
  isStr(v) && v.length > 5 && v.length <= 200 && v.startsWith('host:') && printable(v)

function readJson(line: string): Record<string, unknown> | null {
  if (line.length > MAX_LINE) return null
  try {
    const v: unknown = JSON.parse(line)
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

function readSendArgs(v: unknown): SendArgs | null {
  if (!isRecord(v) || !isStr(v.text)) return null
  const out: SendArgs = { text: v.text }
  for (const k of ['thread', 'to', 'title', 'replyTo'] as const) {
    if (v[k] === undefined) continue
    const x = v[k]
    if (!isStr(x)) return null
    out[k] = x
  }
  return out
}

function readInboxArgs(v: unknown): InboxArgs | null {
  if (v === undefined) return {}
  if (!isRecord(v)) return null
  const out: InboxArgs = {}
  if (v.thread !== undefined) {
    if (!isStr(v.thread)) return null
    out.thread = v.thread
  }
  if (v.full !== undefined) {
    if (typeof v.full !== 'boolean') return null
    out.full = v.full
  }
  return out
}

/** A module frame's shape, or null. */
export function parseModuleFrame(line: string): ModuleFrame | null {
  const v = readJson(line)
  if (!v) return null
  switch (v.t) {
    case 'hello': {
      if (typeof v.v !== 'number' || !Array.isArray(v.topics)) return null
      const topics: Topic[] = []
      for (const t of v.topics) {
        if (!isRecord(t) || !isId(t.id)) return null
        topics.push(isStr(t.name) ? { id: t.id, name: t.name } : { id: t.id })
      }
      return { t: 'hello', v: v.v, topics }
    }
    case 'confirm':
      return isId(v.id) ? { t: 'confirm', id: v.id } : null
    case 'call': {
      if (!isId(v.req) || !isLocation(v.from)) return null
      if (v.op === 'send') {
        const args = readSendArgs(v.args)
        return args ? { t: 'call', req: v.req, from: v.from, op: 'send', args } : null
      }
      if (v.op === 'inbox') {
        const args = readInboxArgs(v.args)
        return args ? { t: 'call', req: v.req, from: v.from, op: 'inbox', args } : null
      }
      return null
    }
    default:
      return null
  }
}

/** A bridge frame's shape, or null. */
export function parseBridgeFrame(line: string): BridgeFrame | null {
  const v = readJson(line)
  if (!v) return null
  switch (v.t) {
    case 'welcome':
      return typeof v.v === 'number' ? { t: 'welcome', v: v.v } : null
    case 'deliver':
      return isId(v.id) && isLocation(v.at) && (v.trigger === 0 || v.trigger === 1) && isStr(v.text)
        ? { t: 'deliver', id: v.id, at: v.at, trigger: v.trigger, text: v.text }
        : null
    case 'schedule':
      return isId(v.id) && isLocation(v.at) && isStr(v.when) && !Number.isNaN(Date.parse(v.when)) && isStr(v.text)
        ? { t: 'schedule', id: v.id, at: v.at, when: v.when, text: v.text }
        : null
    case 'notice':
      return isId(v.id) && isLocation(v.at) && isStr(v.text) ? { t: 'notice', id: v.id, at: v.at, text: v.text } : null
    case 'result':
      return isId(v.req) && typeof v.ok === 'boolean' && isStr(v.text)
        ? { t: 'result', req: v.req, ok: v.ok, text: v.text }
        : null
    default:
      return null
  }
}

/** One frame as a line. */
export const encodeFrame = (f: ModuleFrame | BridgeFrame): string => `${JSON.stringify(f)}\n`

/**
 * Splits what came in on a socket into lines, keeping the unfinished tail. Returns null when the
 * tail grows past MAX_LINE without a newline (the peer is broken; close the connection).
 */
export function takeLines(buffer: string, chunk: string): { lines: string[]; rest: string } | null {
  const all = buffer + chunk
  const parts = all.split('\n')
  const rest = parts.pop() ?? ''
  if (rest.length > MAX_LINE) return null
  return { lines: parts.filter(l => l.trim() !== ''), rest }
}
