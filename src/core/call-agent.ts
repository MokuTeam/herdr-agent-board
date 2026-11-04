// A MokuPilot call agent on the board (#326). MokuPilot starts it outside herdr, as a fork of the
// session a call was started from (or with no conversation at all), and with every hook off, so
// nothing of it reaches the board the usual way. MokuPilot writes one file per call agent while
// it lives, ~/.meeting-copilot/call-agents/<session_id>.json:
//   { format: "mokupilot-call-agent", version: 1, pid, session_id, harness, parent_session_id,
//     config_dir, cwd, started, call: "on" | "after", busy, helpers, updated }
// (the contract: issue #326). Its own task board is the harness's file,
// ~/.agent-boards/<harness>/<session_id>.json (format "agent-board"), which MokuPilot or the
// harness keeps. Pure: what the files say, read by adapters/mokupilot-call.ts.
import type { Item } from './types.ts'

export const CALL_AGENT_FORMAT = 'mokupilot-call-agent'
export const CALL_AGENT_VERSION = 1
export const TASK_BOARD_FORMAT = 'agent-board'
export const TASK_BOARD_VERSION = 1

/** A harness name or a session id that goes into a path: what MokuPilot writes there. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The harnesses MokuPilot runs a call agent in. */
const HARNESSES: ReadonlySet<string> = new Set(['claude', 'pi'])

/** The call runs (`on`), or it ended and the agent stays only to finish its helpers (`after`). */
export type CallPhase = 'on' | 'after'

/** A call agent as its file says. Times in milliseconds. */
export interface CallAgent {
  session: string
  /** claude or pi: whose folder its task board is in. */
  harness: string
  /** The session it is a fork of; '' when MokuPilot started it with no conversation. */
  parent: string
  /** Its CLAUDE_CONFIG_DIR as started; '' for the default folder. */
  configDir: string
  cwd: string
  started: number
  phase: CallPhase
  /** A turn runs. */
  busy: boolean
  /** Its subagents at work as MokuPilot counts them, null when it does not say. */
  helpers: number | null
  updated: number
}

export type CallTaskStatus = 'doing' | 'next' | 'done'

/** An item of its task board, a step of one rolled up into it. */
export interface CallTask {
  id: string
  text: string
  status: CallTaskStatus
  /** Steps under it, done of all. */
  steps?: { done: number; total: number }
}

/** What a call agent's card carries (item.call). */
export interface CallView {
  phase: CallPhase
  /** When the agent started. */
  since: number
  /** The session it is a fork of, or null. */
  parent: string | null
  /** Its helpers at work as MokuPilot counts them: the card's count where its transcript cannot be read. */
  helpers: number | null
  /** Its task board, roots in the board's order. */
  tasks: CallTask[]
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_TASKS = 60
const MAX_TEXT = 200

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const seconds = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v * 1000 : null)
/** A version this reader knows: a newer one changed what the file means. */
const known = (v: unknown, newest: number): boolean =>
  Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= newest

/**
 * The call agent a file says, null for none: not MokuPilot's shape or version, named other than its
 * session (`name`: the file's name without .json), a MokuPilot that is gone, or a start older than
 * a day (or far ahead of `now`).
 */
export function parseCallAgent(
  raw: unknown,
  { name, now, alive }: { name: string; now: number; alive: (pid: number) => boolean },
): CallAgent | null {
  const d = rec(raw)
  if (!d || d.format !== CALL_AGENT_FORMAT || !known(d.version, CALL_AGENT_VERSION)) return null
  const session = str(d.session_id)
  if (!SAFE_NAME.test(session) || session !== name) return null
  const harness = str(d.harness) || 'claude'
  if (!HARNESSES.has(harness)) return null
  const started = seconds(d.started)
  if (started === null || now - started > MAX_AGE_MS || started - now > 60_000) return null
  const pid = d.pid
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !alive(pid as number)) return null
  const helpers = Number.isSafeInteger(d.helpers) && (d.helpers as number) >= 0 ? (d.helpers as number) : null
  return {
    session,
    harness,
    parent: str(d.parent_session_id).trim(),
    configDir: str(d.config_dir),
    cwd: str(d.cwd),
    started,
    phase: d.call === 'after' ? 'after' : 'on',
    busy: d.busy === true,
    helpers,
    updated: Math.max(seconds(d.updated) ?? started, started),
  }
}

const STATUSES: ReadonlySet<unknown> = new Set<CallTaskStatus>(['doing', 'next', 'done'])
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)

/**
 * A task board's items as the card shows them: the roots in the file's order, each step rolled up
 * into its root (a step whose root is not there is a root itself). Empty for a file that is not a
 * task board, or of a newer version than this reader knows.
 */
export function tasksOf(raw: unknown): CallTask[] {
  const d = rec(raw)
  if (!d || d.format !== TASK_BOARD_FORMAT || (d.version !== undefined && !known(d.version, TASK_BOARD_VERSION)))
    return []
  const items: (CallTask & { parentId: string })[] = []
  for (const x of Array.isArray(d.items) ? d.items : []) {
    const r = rec(x)
    const id = str(r?.id)
    const text = oneLine(str(r?.text))
    if (!r || !id || !text || !STATUSES.has(r.status)) continue
    items.push({ id, text, status: r.status as CallTaskStatus, parentId: str(r.parent_id).trim() })
  }
  const roots = new Set(items.filter(i => !i.parentId).map(i => i.id))
  const steps = new Map<string, CallTaskStatus[]>()
  for (const i of items) {
    if (!i.parentId || !roots.has(i.parentId)) continue
    const own = steps.get(i.parentId)
    if (own) own.push(i.status)
    else steps.set(i.parentId, [i.status])
  }
  return items
    .filter(i => !i.parentId || !roots.has(i.parentId))
    .slice(0, MAX_TASKS)
    .map(({ id, text, status }) => {
      const own = steps.get(id)
      if (!own?.length) return { id, text, status }
      // A root shows by its steps: done when all are, at work while one is (MokuPilot's own rule).
      const done = own.filter(s => s === 'done').length
      const shown: CallTaskStatus = done === own.length ? 'done' : own.includes('doing') || done ? 'doing' : status
      return { id, text, status: shown, steps: { done, total: own.length } }
    })
}

/**
 * The board's items with each call agent's card right after its parent's, in the order they came
 * (a call agent whose parent is not on the board stays where it is). The others keep their order.
 * Every item comes out once: one under another call agent goes after that one, and parents that
 * name each other in a ring keep their own places.
 */
export function besideParents<T extends Pick<Item, 'key'> & { call?: Pick<CallView, 'parent'> | null }>(
  items: readonly T[],
): T[] {
  const byKey = new Map(items.map(i => [i.key, i]))
  const parentOf = (i: T): T | undefined =>
    i.call?.parent && i.call.parent !== i.key ? byKey.get(i.call.parent) : undefined
  // Under its parent when its parents lead to a card that has none; in a ring, in its own place.
  const anchored = (i: T): boolean => {
    const seen = new Set<T>()
    for (let at: T | undefined = i; at; at = parentOf(at)) {
      if (seen.has(at)) return false
      seen.add(at)
    }
    return true
  }
  const children = new Map<T, T[]>()
  const top: T[] = []
  for (const it of items) {
    const p = parentOf(it)
    if (p && anchored(it)) children.set(p, [...(children.get(p) ?? []), it])
    else top.push(it)
  }
  const out: T[] = []
  const put = (it: T): void => {
    out.push(it)
    for (const c of children.get(it) ?? []) put(c)
  }
  for (const it of top) put(it)
  return out
}
