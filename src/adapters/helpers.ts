// A session's helpers on disk: the subagents, forks, workflow agents and in-process teammates
// Claude Code ran for it. They live beside the session's transcript, in <session id>/subagents/:
//   agent-<id>.jsonl         the helper's own transcript (every line a sidechain)
//   agent-<id>.meta.json     what it is: agentType, description, toolUseId, isFork, name,
//                            requestShape (background | foreground), taskKind
//                            (in_process_teammate), parentAgentId (started by another helper),
//                            finished, stoppedByUser
//   workflows/<run>/agent-<id>.*, journal.jsonl   a workflow run's agents and its progress
// and <session id>/workflows/<run>.json once a run is over (its name, status and totals), with
// the run's script in workflows/scripts/<name>-<run>.js. Nothing here writes.
//
// The board asks for every session on each refresh, so everything is cached by the file's time
// and size: a folder is listed again only when its time changes, a transcript's head and tail are
// read again only when it grew. What the files say is read by core/helpers.ts.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  describe,
  type HeadInfo,
  type Helper,
  type HelperDetail,
  type HelperStatus,
  type Helpers,
  headInfo,
  helperStatus,
  publicHelper,
  type TailInfo,
  tailInfo,
  type WorkflowRun,
} from '../core/helpers.ts'
import type { ConversationTurn } from '../core/transcript.ts'
import { readConversation, readTail } from './claude-home.ts'
import { isRecord } from './json-store.ts'

type Rec = Record<string, unknown>
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// A helper's id as Claude Code names its files: agent-<id>.jsonl, the id letters, digits and dashes.
const AGENT_FILE = /^agent-([A-Za-z0-9-]{1,120})\.jsonl$/
const RUN_DIR = /^wf_[A-Za-z0-9-]{1,80}$/

/** A JSON object, else null (a line half written, or not one). */
function parseLine(text: string): Rec | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** A JSON object, else an empty one. */
const parseRecord = (text: string): Rec => parseLine(text) ?? {}

function readSlice(path: string, start: number, length: number): string {
  const buf = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, length, start)
  } finally {
    closeSync(fd)
  }
  return buf.toString('utf8')
}

/** The first `bytes` of a file, up to its last whole line. */
function readHead(path: string, size: number, bytes: number): string {
  const text = readSlice(path, 0, Math.min(size, bytes))
  return size > bytes ? text.slice(0, text.lastIndexOf('\n') + 1) : text
}

// ---------------------------------------------------------------- the files, cached
interface TranscriptEntry {
  mtimeMs: number
  size: number
  head: HeadInfo
  tail: TailInfo
}
interface Run {
  over: boolean
  name: string
  status?: string
  summary?: string
  startedAt?: number | null
  durationMs?: number | null
  tokens?: number | null
  tools?: number | null
  agents?: number | null
  taskId?: string
}
const dirCache = new Map<string, { mtimeMs: number; names: string[] }>() // folder -> its entries
const metaCache = new Map<string, { mtimeMs: number; meta: Rec }>() // meta file -> what it says
const fileCache = new Map<string, TranscriptEntry>() // transcript -> its head and tail
const runCache = new Map<string, { mtimeMs: number; run: Run }>() // workflow run file -> the run
const countCache = new Map<string, { offset: number; tools: number; seen: Set<string> }>() // transcript -> its count
// A helper that finished and has not changed for a while is looked at again only now and then:
// a board of sessions with a hundred helpers each would stat them all on every refresh otherwise.
const QUIET_MS = 10 * 60_000
const RECHECK_MS = 30_000
const checked = new Map<string, { at: number; status: HelperStatus }>() // transcript -> when its files were last looked at

/** A folder's entries, read again only when the folder's time changes. */
function list(dir: string): string[] {
  const st = statSync(dir, { throwIfNoEntry: false })
  if (!st?.isDirectory()) {
    dirCache.delete(dir)
    return []
  }
  const hit = dirCache.get(dir)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.names
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {}
  dirCache.set(dir, { mtimeMs: st.mtimeMs, names })
  return names
}

function readMeta(path: string): Rec {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return {}
  const hit = metaCache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.meta
  let meta: Rec = {}
  try {
    meta = parseRecord(readFileSync(path, 'utf8'))
  } catch {}
  metaCache.set(path, { mtimeMs: st.mtimeMs, meta })
  return meta
}

/** Head and tail of a helper's transcript, read again only when the file changed. */
function readTranscript(path: string): TranscriptEntry | null {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return null
  const hit = fileCache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
  // The head does not change once the prompt is in it.
  let head: HeadInfo | null = hit?.head?.prompt ? hit.head : null
  if (!head) {
    for (const bytes of [64 << 10, 1 << 20]) {
      head = headInfo(readHead(path, st.size, bytes))
      if (head.prompt || bytes >= st.size) break
    }
  }
  // Big tool results and request records can fill the end: widen the window until a message shows.
  let tail: TailInfo | null = null
  for (const bytes of [64 << 10, 1 << 20, 4 << 20]) {
    tail = tailInfo(readTail(path, st.size, bytes))
    if ((tail.last !== 'none' && tail.tokens != null) || bytes >= st.size) break
  }
  const entry: TranscriptEntry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    head: head ?? headInfo(''),
    tail: tail ?? tailInfo(''),
  }
  fileCache.set(path, entry)
  return entry
}

const counting = new Map<string, Promise<number>>() // transcript -> the count that runs

/**
 * How many tool calls a transcript holds, counted on from where the last count stopped, in
 * chunks and without holding the server up (a helper's transcript can be hundreds of MB). `skip`
 * is the call that started it: a fork's transcript begins with its parent's. One count at a time
 * per file.
 */
export function countTools(path: string, skip: string | null = null): Promise<number> {
  const prev = counting.get(path) ?? Promise.resolve(0)
  const next = prev.then(
    () => count(path, skip),
    () => count(path, skip),
  )
  counting.set(path, next)
  next
    .finally(() => {
      if (counting.get(path) === next) counting.delete(path)
    })
    .catch(() => {})
  return next
}

async function count(path: string, skip: string | null): Promise<number> {
  const st = await stat(path).catch(() => null)
  if (!st) return 0
  let c = countCache.get(path)
  if (!c || st.size < c.offset) c = { offset: 0, tools: 0, seen: new Set() }
  countCache.set(path, c)
  if (st.size <= c.offset) return c.tools
  const fh = await open(path, 'r')
  try {
    let carry = Buffer.alloc(0)
    let pos = c.offset
    while (pos < st.size) {
      const want = Math.min(4 << 20, st.size - pos)
      const chunk = Buffer.alloc(want)
      const { bytesRead } = await fh.read(chunk, 0, want, pos)
      if (!bytesRead) break
      pos += bytesRead
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const last = buf.lastIndexOf(10)
      // A line longer than 64 MB (a pasted screenshot) is no tool call: skipped, not held.
      if (last < 0) {
        carry = buf.length > 64 << 20 ? Buffer.alloc(0) : buf
        continue
      }
      for (let at = buf.indexOf('"tool_use"'); at >= 0 && at < last; at = buf.indexOf('"tool_use"', at)) {
        const start = buf.lastIndexOf(10, at) + 1
        const end = buf.indexOf(10, at)
        at = end + 1
        const o = parseLine(buf.toString('utf8', start, end))
        const content = isRecord(o?.message) ? o.message.content : null
        if (o?.type !== 'assistant' || !Array.isArray(content)) continue
        for (const raw of content) {
          const b = isRecord(raw) ? raw : null
          const id = typeof b?.id === 'string' ? b.id : ''
          if (b?.type !== 'tool_use' || id === skip || c.seen.has(id)) continue
          c.seen.add(id)
          c.tools++
        }
      }
      carry = Buffer.from(buf.subarray(last + 1))
    }
    // A line still being written is counted next time, whole.
    c.offset = pos - carry.length
  } finally {
    await fh.close()
  }
  return c.tools
}

/** A workflow run: its name and how it went, from the run file once it is over, else its script. */
function readRun(sessionDir: string, run: string): Run {
  const file = join(sessionDir, 'workflows', `${run}.json`)
  const st = statSync(file, { throwIfNoEntry: false })
  if (st) {
    const hit = runCache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.run
    let d: Rec = {}
    try {
      d = parseRecord(readFileSync(file, 'utf8'))
    } catch {}
    const r: Run = {
      over: true,
      name: String(d.workflowName ?? '').slice(0, 120),
      status: String(d.status ?? ''),
      summary: clip(String(d.summary ?? ''), 300),
      startedAt: Number(d.startTime) || null,
      durationMs: Number(d.durationMs) || null,
      tokens: Number(d.totalTokens) || null,
      tools: Number(d.totalToolCalls) || null,
      agents: Number(d.agentCount) || null,
      taskId: String(d.taskId ?? ''),
    }
    runCache.set(file, { mtimeMs: st.mtimeMs, run: r })
    return r
  }
  // Still running: the script's file is named <workflow name>-<run>.js.
  const script = list(join(sessionDir, 'workflows', 'scripts')).find(n => n.endsWith(`-${run}.js`))
  return { over: false, name: script ? script.slice(0, -(run.length + 4)) : '' }
}

export interface ProcessState {
  /** The session's Claude process runs. */
  alive?: boolean
  /** Since when (ms), or null. */
  since?: number | null
}

/**
 * Every helper of the session whose transcript is `transcript`, newest first, and its workflow
 * runs: { helpers: [...], workflows: [...] }. `alive` and `since` say whether the session's
 * Claude process runs and since when (core/helpers.ts helperStatus).
 */
export function helpersOf(
  transcript: string | null | undefined,
  { alive = false, since = null }: ProcessState = {},
): Helpers {
  if (!transcript?.endsWith('.jsonl')) return { helpers: [], workflows: [] }
  const sessionDir = transcript.slice(0, -'.jsonl'.length)
  const subagents = join(sessionDir, 'subagents')
  const helpers: Helper[] = []
  const addOne = (dir: string, name: string, workflow: { run: string } | null): void => {
    const m = AGENT_FILE.exec(name)
    if (!m?.[1]) return
    const id = m[1]
    const path = join(dir, name)
    const metaPath = join(dir, `agent-${id}.meta.json`)
    const last = checked.get(path)
    const cached = fileCache.get(path)
    const quiet =
      !!cached &&
      !!last &&
      !['running', 'idle'].includes(last.status) &&
      Date.now() - cached.mtimeMs > QUIET_MS &&
      Date.now() - last.at < RECHECK_MS
    const file = quiet ? cached : readTranscript(path)
    if (!file) return
    const meta = quiet ? (metaCache.get(metaPath)?.meta ?? {}) : readMeta(metaPath)
    const h = describe(id, meta, workflow)
    const status = helperStatus({ meta, tail: file.tail, kind: h.kind, alive, since, mtimeMs: file.mtimeMs })
    checked.set(path, { at: quiet && last ? last.at : Date.now(), status })
    helpers.push({
      ...h,
      status,
      startedAt: file.head.startedAt,
      endedAt: file.tail.endedAt ?? file.mtimeMs,
      activity: file.mtimeMs,
      prompt: file.head.prompt,
      from: file.head.from,
      now: status === 'running' ? file.tail.now : null,
      after: status === 'running' && !file.tail.now ? file.tail.after : '',
      waiting: status === 'running' ? (file.tail.waiting ?? 0) : 0, // background tasks it waits for
      tokens: file.tail.tokens,
      result: ['done', 'idle', 'failed'].includes(status) ? file.tail.result : '',
      path,
    })
  }
  // A file that goes away or cannot be read between the listing and the read: that helper is
  // left out of this refresh, not the whole board.
  const add = (dir: string, name: string, workflow: { run: string } | null): void => {
    try {
      addOne(dir, name, workflow)
    } catch {}
  }
  const names = list(subagents)
  for (const name of names) add(subagents, name, null)
  // A helper whose turn is over while an agent it started still works is at work too: that
  // agent's notification wakes it.
  // Over again until nothing changes: a grandchild at work keeps its grandparent at work too.
  for (let changed = true; changed; ) {
    changed = false
    for (const h of helpers) {
      if (h.status !== 'done' || h.kind === 'teammate') continue
      const kids = helpers.filter(k => k.parent === h.id && k.status === 'running').length
      if (kids) {
        Object.assign(h, { status: 'running', waiting: h.waiting + kids, result: '' })
        changed = true
      }
    }
  }
  const workflows: WorkflowRun[] = []
  if (names.includes('workflows')) {
    for (const run of list(join(subagents, 'workflows'))) {
      if (!RUN_DIR.test(run)) continue
      const dir = join(subagents, 'workflows', run)
      const before = helpers.length
      for (const name of list(dir)) add(dir, name, { run })
      const own = helpers.slice(before)
      const info = readRun(sessionDir, run)
      const journal = statSync(join(dir, 'journal.jsonl'), { throwIfNoEntry: false })
      const touched = Math.max(journal?.mtimeMs ?? 0, ...own.map(h => h.activity))
      const status: HelperStatus = info.over
        ? info.status === 'completed'
          ? 'done'
          : info.status === 'failed'
            ? 'failed'
            : 'stopped'
        : alive && !(since && touched < since)
          ? 'running'
          : 'stopped'
      // An agent the run left running when it ended did not get further.
      if (status !== 'running') for (const h of own) if (h.status === 'running') h.status = 'stopped'
      workflows.push({
        id: run,
        name: info.name,
        status,
        summary: info.summary ?? '',
        startedAt:
          info.startedAt ??
          Math.min(...own.map(h => h.startedAt ?? Number.POSITIVE_INFINITY).filter(Number.isFinite), touched),
        endedAt: info.over && info.startedAt && info.durationMs ? info.startedAt + info.durationMs : touched,
        activity: touched,
        tokens: info.tokens ?? null,
        tools: info.tools ?? null,
        agents: info.agents ?? own.length,
        taskId: info.taskId ?? '',
      })
    }
  }
  helpers.sort((a, b) => (b.startedAt ?? b.activity) - (a.startedAt ?? a.activity))
  workflows.sort((a, b) => b.startedAt - a.startedAt)
  return { helpers, workflows }
}

/**
 * One helper of the session for its window: what it is and how it stands, how many tool calls it
 * made, and its conversation (the same turns as a session's, sidechain lines included). Null
 * when the session has no helper with that id: the id only picks one of the session's own files.
 */
export async function helperDetail(
  transcript: string | null | undefined,
  id: string,
  opts: ProcessState = {},
): Promise<HelperDetail<ConversationTurn> | null> {
  const { helpers, workflows } = helpersOf(transcript, opts)
  const h = helpers.find(x => x.id === id)
  if (!h) return null
  return {
    helper: { ...publicHelper(h), tools: await countTools(h.path, h.toolUseId), prompt: h.prompt },
    workflow: h.workflow ? (workflows.find(w => w.id === h.workflow) ?? null) : null,
    conversation: readConversation(h.path, 80, { sidechain: true }),
  }
}

/** For tests: forget what was read. */
export function clearHelperCache(): void {
  for (const c of [dirCache, metaCache, fileCache, runCache, countCache, checked]) c.clear()
}
