// Calls from nodes (#508, docs/design/nodes 5, 6.2, 10 item 5 and "Trust"): for each online link
// (services/nodes/links.ts) the master holds the node's `GET /api/node/uplink` open, takes each call
// its sessions made and posts the result back (services/node/uplink.ts is the node's side).
//
// - Only `board thread` and `board send` (#619) (core/node-uplink.ts UPLINK_COMMANDS); anything else is answered with 126
//   and a line, whatever the node sends. Only a session's: a call with no session would be the
//   owner's, and nothing an owner does comes up a link (#224). Neither `open` (the master's own
//   window) nor `share` (the owner confirms it) is run for a node.
// - Run in this process by thread-cli's own entry (entrypoints/thread-cli.ts threadCmd), as the node's
//   session: its prefixed key (core/nodes.ts nodeKey) and the lane its card has in the aggregate,
//   whatever lane the node says; the node's word only when the master has no card of it.
// - A file the call names is asked of the node by its number, checked against the size and the
//   SHA-256 the call gave, within a thread post's limits, and put under the device's folder; the
//   argument names that copy, from which the post copies it into the thread's files as any post's.
// - A write's call id seen before is answered with the result stored then and not run again: the
//   device's ledger (adapters/node-store.ts seenCall), the last 500 ids. So a call kept on the node
//   while the master was away, and sent again on every stream until its result got through, runs
//   once. A file the node could not give for the link's sake (it went away meanwhile) leaves the
//   call unanswered: the node sends it again on the next stream.
// - One session's calls run one after another, in the order they came; another session's do not
//   wait for them.
// Made by server/app.ts only once config.json has `nodes`.
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDeviceStore, type DeviceStore } from '../../adapters/node-store.ts'
import { pace } from '../../adapters/pacing.ts'
import { takeEvents } from '../../core/event-stream.ts'
import {
  fileTooBig,
  isCallId,
  KEPT_SUBS,
  NOT_FROM_NODE,
  RESULT_LINE_MAX,
  RESULT_LINES_MAX,
  refused,
  UPLINK_COMMANDS,
  type UplinkCall,
  type UplinkFile,
  type UplinkResult,
  uplinkCallOf,
} from '../../core/node-uplink.ts'
import { nodeKey, nodesConfig } from '../../core/nodes.ts'
import type { Config, Item } from '../../core/types.ts'
import { safeName } from '../../core/upload-name.ts'
import { FILE_MAX_BYTES, FILES_MAX, type Party, threadsConfig } from '../../core/work-threads.ts'
import type { ThreadCmdContext } from '../../entrypoints/thread-cli.ts'
import type { Known } from '../case-sessions.ts'
import type { NodeLinks } from './links.ts'

export interface UplinkRunner {
  close(): Promise<void>
}

export interface UplinkRunnerOptions {
  links: Pick<NodeLinks, 'link' | 'onChange'>
  /** A node's card by its prefixed key, from the aggregate. */
  find(key: string): Item | undefined
  /** The board's cards, this computer's and the nodes', for `--to` and `--assignee`. */
  items(): Item[]
  /**
   * Case files (#488): the cards a case's sessions are read from, a device not heard now marked as
   * its offline copy (services/case-sessions.ts caseItems); `items` when not given.
   */
  caseItems?: () => readonly Known[]

  /** The live config: `threads` and `port` are read at each call. */
  cfg: Config
  log(text: string): void
  store?: DeviceStore
  /** Tests: the command's entry (entrypoints/thread-cli.ts threadCmd by default). */
  run?: (argv: readonly string[], ctx: ThreadCmdContext) => Promise<number>
}

/** A stream that ended is asked for again after this long (paced), while the link is online. */
const AGAIN_MS = 2000
/** A door that has no uplink (a node on an older commit) is asked again after this long (paced). */
const NONE_MS = 60_000
/** A file within this long; a result posted within this long. */
const FILE_MS = 60_000
const POST_MS = 10_000
/** A result's lines past this many characters are cut, so its body stays within what the door takes. */
const RESULT_CHARS = 4 << 20
/** The most characters of one event: a call is far smaller. */
const MOST_EVENT_CHARS = 1 << 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** What a node says, as it goes into a line: printable, and short. */
const said = (v: string): string => v.replace(/\p{Cc}/gu, ' ').slice(0, 64)
const failed = (line: string): UplinkResult => ({ code: 1, out: [], err: [line] })

/**
 * The result as the node takes it (core/node-uplink.ts uplinkResultOf): each line at most
 * RESULT_LINE_MAX characters, RESULT_CHARS in all and RESULT_LINES_MAX lines with a last one saying
 * how many were left out.
 */
function fit(r: UplinkResult): UplinkResult {
  let left = RESULT_CHARS
  let room = RESULT_LINES_MAX - 1
  const cut = (lines: string[]): { kept: string[]; dropped: number } => {
    const kept: string[] = []
    for (const whole of lines) {
      const line = whole.length > RESULT_LINE_MAX ? whole.slice(0, RESULT_LINE_MAX) : whole
      if (line.length > left || room <= 0) break
      left -= line.length + 1
      room--
      kept.push(line)
    }
    return { kept, dropped: lines.length - kept.length }
  }
  const out = cut(r.out)
  const err = cut(r.err)
  if (!out.dropped && !err.dropped) return { code: r.code, out: out.kept, err: err.kept }
  const more = out.dropped + err.dropped
  return {
    code: r.code,
    out: out.kept,
    err: [...err.kept, `${more} more lines left out: too long to send to the node`],
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

export function createUplinkRunner(o: UplinkRunnerOptions): UplinkRunner {
  const store = o.store ?? createDeviceStore()
  const following = new Map<string, { ac: AbortController; done: Promise<void> }>()
  /** Per device and session, its calls one after another. */
  const chains = new Map<string, Promise<void>>()
  let closed = false

  const online = (id: string): boolean => o.links.link(id)?.state().state === 'online'

  function changed(id: string): void {
    if (closed) return
    const held = following.get(id)
    if (online(id)) {
      // One that is still ending (the link was away a moment) gives way to a new one.
      if (!held || held.ac.signal.aborted) follow(id)
    } else held?.ac.abort()
  }

  function follow(id: string): void {
    const ac = new AbortController()
    const done = (async () => {
      while (!closed && !ac.signal.aborted && online(id)) {
        const link = o.links.link(id)
        if (!link) break
        let wait = AGAIN_MS
        try {
          const res = await link.fetch('/api/node/uplink', { signal: ac.signal })
          if (res.status === 404) wait = NONE_MS
          if (!res.ok || !res.body) await res.body?.cancel()
          else await read(id, res.body, ac.signal)
        } catch (err) {
          if (!ac.signal.aborted) o.log(`node ${id}: the uplink: ${messageOf(err)}`)
        }
        if (closed || ac.signal.aborted) break
        await sleep(Math.round(wait * pace()), ac.signal)
      }
    })().finally(() => {
      if (following.get(id)?.ac === ac) following.delete(id)
    })
    following.set(id, { ac, done })
  }

  async function read(id: string, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const stop = (): void => void reader.cancel().catch(() => {})
    signal.addEventListener('abort', stop, { once: true })
    let rest = ''
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done || signal.aborted) return
        const got = takeEvents(rest + decoder.decode(next.value, { stream: true }))
        rest = got.rest
        if (rest.length > MOST_EVENT_CHARS)
          return o.log(`node ${id}: a call larger than the board takes: the uplink dropped`)
        for (const e of got.events) if (e.name === 'call') took(id, e.data)
      }
    } catch (err) {
      if (!signal.aborted) o.log(`node ${id}: the uplink: ${messageOf(err)}`)
    } finally {
      signal.removeEventListener('abort', stop)
      reader.releaseLock()
    }
  }

  function took(id: string, data: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      raw = null
    }
    const call = uplinkCallOf(raw)
    const callId = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
    if (!call && !isCallId(callId)) {
      o.log(`node ${id}: a call that is not one: left out`)
      return
    }
    const chain = `${id}\u0000${call?.session ?? ''}`
    const next = (chains.get(chain) ?? Promise.resolve()).then(() =>
      call ? handle(id, call) : answer(id, callId as string, refused('a call the board does not take')),
    )
    const tail = next.catch(err => o.log(`node ${id}: a call: ${messageOf(err)}`))
    chains.set(chain, tail)
    void tail.then(() => {
      if (chains.get(chain) === tail) chains.delete(chain)
    })
  }

  async function handle(id: string, call: UplinkCall): Promise<void> {
    // Only a write is kept on the node and so sent again: only a write's result is remembered.
    // `board send` (#619) is not kept on the node, but its result is remembered here: the node sends a
    // call again on every stream while its command waits, and a message must not be queued twice.
    const kept = (call.cmd === 'thread' || call.cmd === 'threads') && KEPT_SUBS.has(call.argv[0] ?? '')
    const remembered = kept || call.cmd === 'send'
    let result = remembered ? store.seenCall(id, call.id) : null
    if (!result) {
      const ran = await runCall(id, call)
      // A file the link could not bring: the node sends the call again on its next stream.
      if (!ran) return
      result = fit(ran)
      if (remembered)
        try {
          store.rememberCall(id, call.id, result)
        } catch (err) {
          o.log(`node ${id}: the uplink's ledger: ${messageOf(err)}`)
        }
    }
    await answer(id, call.id, result)
  }

  /** The result to the node; one that does not get through is sent again when the node sends the call again. */
  async function answer(id: string, callId: string, result: UplinkResult): Promise<void> {
    const link = o.links.link(id)
    if (!link) return
    try {
      const res = await link.fetch(`/api/node/uplink/${callId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(POST_MS),
      })
      if (!res.ok) o.log(`node ${id}: a result not taken: HTTP ${res.status}`)
      await res.body?.cancel()
    } catch (err) {
      o.log(`node ${id}: a result not sent: ${messageOf(err)}`)
    }
  }

  /**
   * The file `f` of the call, from the node, checked, under `folder`: its path there, why not, or null
   * when the link could not bring it (the node away, an answer of its that is not the file's), to
   * be tried again with the call.
   */
  async function pull(
    id: string,
    callId: string,
    f: UplinkFile,
    folder: string,
  ): Promise<string | { error: string } | null> {
    const link = o.links.link(id)
    if (!link) return null
    let res: Response
    try {
      res = await link.fetch(`/api/node/uplink/${callId}/file/${f.n}`, { signal: AbortSignal.timeout(FILE_MS) })
    } catch (err) {
      o.log(`node ${id}: a file of call ${callId}: ${messageOf(err)}`)
      return null
    }
    if (res.status === 404) {
      await res.body?.cancel()
      return { error: `${f.name}: the node did not give it` }
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      o.log(`node ${id}: a file of call ${callId}: HTTP ${res.status}`)
      return null
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for await (const chunk of res.body) {
        size += chunk.length
        if (size > f.size || size > FILE_MAX_BYTES) return { error: `${f.name}: larger than the node said` }
        chunks.push(chunk)
      }
    } catch (err) {
      // The link went while the file came: tried again with the call.
      o.log(`node ${id}: a file of call ${callId}: ${messageOf(err)}`)
      return null
    }
    const bytes = Buffer.concat(chunks)
    if (bytes.length !== f.size || createHash('sha256').update(bytes).digest('hex') !== f.sha256)
      return { error: `${f.name}: not the file the node named` }
    mkdirSync(folder, { recursive: true })
    const path = join(folder, safeName(f.name))
    writeFileSync(path, bytes)
    return path
  }

  /** The call run, or null when a file it names could not be had for now. */
  async function runCall(id: string, call: UplinkCall): Promise<UplinkResult | null> {
    if (!UPLINK_COMMANDS.has(call.cmd))
      return refused(`board ${said(call.cmd)} is not taken from a node: only board thread, board send and board agents`)
    if (!call.session) return refused("only a session's board thread, board send or board agents is taken from a node")
    if (call.cmd === 'send') return sendFrom(id, call)
    if (call.cmd === 'agents') return agentsFrom(id, call)
    const sub = call.argv[0] ?? 'help'
    const not = Object.hasOwn(NOT_FROM_NODE, sub) ? NOT_FROM_NODE[sub] : undefined
    if (not) return refused(not)
    let key: string
    try {
      key = nodeKey(id, call.session)
    } catch {
      return refused('not a session of the node')
    }
    const item = o.find(key)
    // The card's lane, whatever the node says; the node's word only for a session with no card here.
    const lane = item?.category || call.lane || null
    const name = item?.name || item?.autoName || call.session.slice(0, 8)
    const folder = join(store.dir(id), 'uplink', call.id)
    try {
      const { fileArgs, threadCmd } = await import('../../entrypoints/thread-cli.ts')
      const argv = [...call.argv]
      const at = fileArgs(sub, argv.slice(1)).map(i => i + 1)
      // More files than a post takes: the post itself says so, before any is asked of the node.
      if (at.length <= FILES_MAX)
        for (const [i, pos] of at.entries()) {
          const f = call.files.find(x => x.n === i)
          if (!f) return failed(`${argv[pos]}: the node did not send it`)
          const big = fileTooBig(f.name, f.size)
          if (big) return failed(big)
          const path = await pull(id, call.id, f, join(folder, String(i)))
          if (path === null) return null
          if (typeof path !== 'string') return failed(path.error)
          argv[pos] = path
        }
      const out: string[] = []
      const err: string[] = []
      const actor: Party = { kind: 'session', key, name }
      // Case files (#488): a case's sessions as this board's cards have them, when it has cases on.
      const cases = threadsConfig(o.cfg.threads)?.cases
        ? await (async () => {
            const { liveOf, namesOf, remindersOf } = await import('../case-sessions.ts')
            return {
              live: async (keys: readonly string[]) => liveOf(keys, o.caseItems?.() ?? o.items()),
              reminders: remindersOf,
              names: async () => namesOf(o.items()),
            }
          })()
        : undefined
      const code = await (o.run ?? threadCmd)(argv, {
        cfg: { threads: o.cfg.threads, port: o.cfg.port },
        actor,
        lane,
        idle: false,
        findSession: async word => findSession(word),
        out: l => out.push(l),
        err: l => err.push(l),
        sendOut: (thread, entry) => sendOut(thread, entry),
        ...(cases && { cases }),
      })
      return { code, out, err }
    } catch (err) {
      return failed(messageOf(err))
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /**
   * `board send <name|key> "<text>"` in a session of the node (#619, core/agent-send.ts): queued here
   * for the card it names, signed with the node's session. A node reaches this computer's sessions
   * and its own, never another node's (design 10, "Trust"): those are not even named to it.
   */
  async function sendFrom(id: string, call: UplinkCall): Promise<UplinkResult> {
    let key: string
    try {
      key = nodeKey(id, call.session)
    } catch {
      return refused('not a session of the node')
    }
    const item = o.find(key)
    const [to = '', ...words] = call.argv
    const { planSend, targetsOf } = await import('../../core/agent-send.ts')
    const plan = planSend({
      targets: targetsOf(o.items()).filter(t => t.device === null || t.device === id),
      to,
      message: words.join(' '),
      from: { key, name: item?.name || item?.autoName || '', device: id },
      own: nodesConfig(o.cfg.nodes)?.id ?? '',
      now: Date.now(),
    })
    if ('error' in plan) return failed(plan.error)
    try {
      const { addEntry } = await import('../../adapters/schedule-store.ts')
      addEntry(plan.entry)
    } catch (err) {
      return failed(`the board could not take the message: ${messageOf(err)}`)
    }
    return { code: 0, out: [plan.line], err: [] }
  }

  /**
   * `board agents [--json]` in a session of the node (#628, core/agent-send.ts): lists the cards
   * this node is allowed to reach — the master's sessions and this node's own, never another node's.
   */
  async function agentsFrom(id: string, call: UplinkCall): Promise<UplinkResult> {
    let key: string
    try {
      key = nodeKey(id, call.session)
    } catch {
      return refused('not a session of the node')
    }
    const { agentViewsOf, formatAgentLines, targetsOf } = await import('../../core/agent-send.ts')
    const targets = targetsOf(o.items()).filter(t => t.device === null || t.device === id)
    // One view a line (#639): a result's line is cut at RESULT_LINE_MAX, which one array of a
    // few hundred cards would pass; the lines joined are the same JSON array.
    if (call.argv.includes('--json')) {
      const views = agentViewsOf(targets, { selfKey: key }).map(v => JSON.stringify(v))
      return { code: 0, out: ['[', ...views.map((v, i) => (i < views.length - 1 ? `${v},` : v)), ']'], err: [] }
    }
    const own = nodesConfig(o.cfg.nodes)?.id ?? ''
    const lines = formatAgentLines(targets, { selfKey: key, own })
    return { code: 0, out: lines.length ? lines : ['no sessions on the board'], err: [] }
  }

  /** A session on the board by its name, pane or key, as `board thread` finds one on this computer. */
  function findSession(word: string): Party | null {
    const w = word.toLowerCase()
    const items = o
      .items()
      .filter(i => [i.name, i.autoName, i.pane, i.session, i.key].some(v => v && v.toLowerCase() === w))
    if (items.length > 1)
      throw new Error(
        `"${word}" names ${items.length} sessions (${items.map(i => i.pane || i.key).join(', ')}): give its pane`,
      )
    const [item] = items
    if (item) return { kind: 'session', key: item.key, name: item.name || item.autoName || item.key.slice(0, 8) }
    return UUID.test(word) || /^pane-\S+$/.test(word) ? { kind: 'session', key: word, name: word.slice(0, 8) } : null
  }

  /** An entry of a shared thread, sent by this board as `board thread` on this computer has it sent (#394). */
  async function sendOut(thread: string, entry: string): Promise<{ out: string; why?: string } | null> {
    const port = Number(o.cfg.port) || 12422
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/threads/${encodeURIComponent(thread)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify({ op: 'send', entry }),
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 428) return { out: 'confirm' }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (body && typeof body.out === 'string') return body as unknown as { out: string }
      return res.status === 409 ? { out: 'queued', why: 'sharing is off on the board' } : null
    } catch {
      return null
    }
  }

  const off = o.links.onChange(changed)

  return {
    async close() {
      closed = true
      off()
      const held = [...following.values()]
      for (const f of held) f.ac.abort()
      await Promise.all(held.map(f => f.done))
    },
  }
}
