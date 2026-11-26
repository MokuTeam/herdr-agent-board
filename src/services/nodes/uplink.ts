// Calls from nodes (#508, docs/design/nodes 5, 6.2, 10 item 5 and "Trust"): for each online link
// (services/nodes/links.ts) the master holds the node's `GET /api/node/uplink` open, takes each call
// its sessions made and posts the result back (services/node/uplink.ts is the node's side).
//
// - Only allowlisted shared-state and cross-session commands (#508, #619, #628, #644, #698;
//   core/node-uplink.ts UPLINK_COMMANDS); anything else is answered with 126 and a line, whatever
//   the node sends. Only a session's here: a terminal with no session is the owner's, whose few
//   commands come up the master relay instead (#780, ownerCall: core/master-relay.ts NODE_CLI_PATH; the
//   thread reads since #797). Owner-only subcommands (such as `thread open`, `thread share`,
//   `thread import`, `team join`, `team watch`, `team listen`, `team loop <peer> <n>`) are refused.
// - Run in this process by each command's own entry (entrypoints/thread-cli.ts threadCmd,
//   entrypoints/time-cli.ts timeCmd, core/agent-send.ts), as the node's session: its prefixed key
//   (core/nodes.ts nodeKey) and the lane its card has in the aggregate, whatever lane the node says;
//   the node's word only when the master has no card of it.
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
import { hostname } from 'node:os'
import { join } from 'node:path'
import { readCard } from '../../adapters/cards.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { createDeviceStore, type DeviceStore } from '../../adapters/node-store.ts'
import { pace } from '../../adapters/pacing.ts'
import { currentPresence, setPresence } from '../../adapters/presence-store.ts'
import { addEntry, getEntry, listEntries, removeEntry } from '../../adapters/schedule-store.ts'
import { formatListLines } from '../../core/board-list.ts'
import { categoryInfo } from '../../core/categories.ts'
import {
  type CardDecision,
  cardDecisionOf,
  DecisionError,
  decisionsConfig,
  durationWords,
} from '../../core/decisions.ts'
import { takeEvents } from '../../core/event-stream.ts'
import { t } from '../../core/lang.ts'
import { OWNER_THREAD_SUBS } from '../../core/master-relay.ts'
import {
  fileTooBig,
  isCallId,
  isRememberedCall,
  NOT_FROM_NODE,
  RESULT_LINE_MAX,
  RESULT_LINES_MAX,
  refused,
  teamRefusal,
  UPLINK_COMMANDS,
  type UplinkCall,
  type UplinkFile,
  type UplinkResult,
  uplinkCallOf,
} from '../../core/node-uplink.ts'
import { nodeKey, nodesConfig, parseNodeKey } from '../../core/nodes.ts'
import {
  isPresenceState,
  type Presence,
  type PresenceSource,
  type PresenceState,
  presenceConfig,
  presenceLine,
} from '../../core/presence.ts'
import {
  clip,
  formatEveryOk,
  formatRemindOk,
  parseEveryRest,
  parseRemindRest,
  scheduleParts,
  stamp,
  waitsPart,
} from '../../core/schedule-cli.ts'
import { teamConfig } from '../../core/team.ts'
import type { Actor } from '../../core/time.ts'
import type { Config, Item } from '../../core/types.ts'
import { safeName } from '../../core/upload-name.ts'
import { scheduleZone } from '../../core/when.ts'
import { FILE_MAX_BYTES, FILES_MAX, type Party, threadsConfig } from '../../core/work-threads.ts'
import type { CalCmdContext } from '../../entrypoints/cal-cli.ts'
import type { ThreadCmdContext } from '../../entrypoints/thread-cli.ts'
import type { TimeCmdContext } from '../../entrypoints/time-cli.ts'
import type { Known } from '../case-sessions.ts'
import type { CaseResolvers } from '../work-cases.ts'
import type { NodeLinks } from './links.ts'
import type { SpawnFromDeps } from './spawn-from.ts'

export interface UplinkRunner {
  /**
   * A sessionless terminal's command on node `device` (#780), relayed as the owner's
   * (core/master-relay.ts NODE_CLI_PATH): run here as the owner, as on this computer.
   */
  ownerCall(device: string, call: { cmd: string; argv: string[]; lane?: string }): Promise<UplinkResult>
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
  frozen?: () => boolean
  store?: DeviceStore
  /** The running web board's port, for team and shared-thread calls. */
  webPort?: () => number
  /** Live presence setter from the running board's PresenceService. */
  setPresence?: (state: PresenceState, from: PresenceSource) => { presence: Presence; changed: boolean }
  /** Tests: the command's entry (entrypoints/thread-cli.ts threadCmd by default). */
  run?: (argv: readonly string[], ctx: ThreadCmdContext) => Promise<number>
  /** Tests: `board time`'s entry (entrypoints/time-cli.ts timeCmd by default). */
  runTime?: (argv: readonly string[], ctx: TimeCmdContext) => Promise<number>
  /** Tests: `board cal`'s entry (entrypoints/cal-cli.ts calCmd by default). */
  runCal?: (argv: readonly string[], ctx: CalCmdContext) => Promise<number>
  /** Tests: `board team`'s entry. */
  runTeam?: (argv: readonly string[], ctx: { key: string; name: string; lane: string | null }) => Promise<UplinkResult>
  /** Tests: `board decisions`'s entry. */
  runDecisions?: (words: readonly string[], now: number, out: (line: string) => void) => void
  /**
   * spawn-agent's start from a node's session (#760, spawn-from.ts): this board's launches, profiles
   * and herdr. Absent: such a call is refused, and the node starts the session itself.
   */
  spawn?: Pick<SpawnFromDeps, 'start' | 'profiles' | 'workspaces' | 'herdrName' | 'dismiss'> & {
    /** Tests: the board's payload; `GET /api/board` on the web port by default. */
    payload?: SpawnFromDeps['payload']
  }
  /** Tests: `board journal`'s entry. */
  runJournal?: (
    args: readonly string[],
    ctx: { cfg: Config; out: (l: string) => void; err: (l: string) => void },
  ) => number
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

/** What a question with options adds to its line, as a local `board ask` says it (entrypoints/decisions-cli.ts). */
const decisionLine = (id: string, defaultAt: number | null, defaultMs: number | null | undefined): string =>
  `decision ${id}${defaultAt !== null && defaultMs ? ` · default in ${durationWords(defaultMs)}` : ''}`

/** The decision this board holds on its copy of a node session's card (#781), when it is `id`. */
function heldDecision(key: string, id: string): CardDecision | null {
  const d = cardDecisionOf(readCard(key)?.decision)
  return d?.id === id ? d : null
}

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
  const decision = r.decision ? { decision: r.decision } : {}
  if (!out.dropped && !err.dropped) return { code: r.code, out: out.kept, err: err.kept, ...decision }
  const more = out.dropped + err.dropped
  return {
    code: r.code,
    out: out.kept,
    err: [...err.kept, `${more} more lines left out: too long to send to the node`],
    ...decision,
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
    if (o.frozen?.()) return
    // Only a write is kept on the node and so sent again: only a write's result is remembered.
    // Non-kept writes (`send`, `time`/`cal`/`team`/`presence`/`remind`/`every`/`unschedule`) are
    // remembered here by call id so a retry after a stream hiccup never writes twice.
    const remembered = isRememberedCall(call.cmd, call.argv)
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

  /** The web port of this master board. */
  const webPort = (): number => o.webPort?.() || Number(o.cfg.port) || 12422

  /** Resolve a node session's prefixed key, card, lane and display name, or null when invalid. */
  function sessionOf(
    id: string,
    session: string,
  ): { key: string; item: Item | undefined; lane: string | null; name: string } | null {
    let key: string
    try {
      key = nodeKey(id, session)
    } catch {
      return null
    }
    const item = o.find(key)
    const lane = item?.category || null
    const name = item?.name || item?.autoName || session.slice(0, 8)
    return { key, item, lane, name }
  }

  /**
   * Items a node's session reaches (#772, epic #763): every machine's of this board, the master's and
   * each paired device's, as a session on the master reaches them. The caller is still checked to be
   * a session of the node that sent the call; a Team peer is no device and reaches none of these.
   */
  const visibleItems = (): Item[] => o.items()

  /** The devices among `targets` whose link is not online now, for `board agents` to say so. */
  const offlineOf = (targets: readonly { device: string | null }[]): Set<string> =>
    new Set(targets.flatMap(t => (t.device && !online(t.device) ? [t.device] : [])))

  /** Resolve a session on the board by key, unprefixed node session key, session, pane, or name. */
  function findVisibleSession(word: string): Item {
    const w = word.toLowerCase()
    const vis = visibleItems()
    const matches = (i: Item, fields: readonly ('key' | 'session' | 'pane' | 'name' | 'autoName')[]): boolean =>
      fields.some(f => {
        const v = i[f]
        return typeof v === 'string' && v.toLowerCase() === w
      }) ||
      (fields.includes('key') && parseNodeKey(i.key)?.key.toLowerCase() === w)
    let hits = vis.filter(i => matches(i, ['key', 'session', 'pane']))
    if (!hits.length) hits = vis.filter(i => matches(i, ['name', 'autoName']))
    if (hits.length > 1)
      throw new Error(
        `"${word}" names ${hits.length} sessions (${hits.map(i => i.pane || i.key).join(', ')}): give its pane or key`,
      )
    const [hit] = hits
    if (!hit) throw new Error(`no session "${word}" on the board`)
    return hit
  }

  /** Pull file 0 of a call into `folder` and rewrite `argv[pos]`; returns `'ok'`, an error result, or null on link drop. */
  async function pullArgFile(
    id: string,
    call: UplinkCall,
    argv: string[],
    pos: number,
    folder: string,
  ): Promise<'ok' | UplinkResult | null> {
    const f = call.files.find(x => x.n === 0)
    if (!f) return failed(`${argv[pos]}: the node did not send it`)
    const big = fileTooBig(f.name, f.size, call.cmd)
    if (big) return failed(big)
    const path = await pull(id, call.id, f, join(folder, '0'))
    if (path === null) return null
    if (typeof path !== 'string') return failed(path.error)
    argv[pos] = path
    return 'ok'
  }

  /** The call run, or null when a file it names could not be had for now. */
  async function runCall(id: string, call: UplinkCall): Promise<UplinkResult | null> {
    if (!UPLINK_COMMANDS.has(call.cmd))
      return refused(`board ${said(call.cmd)} is not taken from a node: run it on the board's computer`)
    if (!call.session) return refused("only a session's command is taken from a node")
    switch (call.cmd) {
      case 'send':
        return sendFrom(id, call)
      case 'agents':
        return agentsFrom(id, call)
      case 'time':
        return timeFrom(id, call)
      case 'cal':
        return calFrom(id, call)
      case 'team':
        return teamFrom(id, call)
      case 'decisions':
        return decisionsFrom(id, call)
      case 'journal':
        return journalFrom(id, call)
      case 'presence':
      case 'away':
        return presenceFrom(id, call)
      case 'cats':
        return catsFrom(id, call)
      case 'list':
        return listFrom(id, call)
      case 'remind':
      case 'every':
        return scheduleWriteFrom(id, call)
      case 'unschedule':
        return unscheduleFrom(id, call)
      case 'schedule':
        return scheduleFrom(id, call)
      case 'spawn':
        return spawnCall(id, call)
      case 'ask':
        return askFrom(id, call)
    }
    const sub = call.argv[0] ?? 'help'
    const not = Object.hasOwn(NOT_FROM_NODE, sub) ? NOT_FROM_NODE[sub] : undefined
    if (not) return refused(not)
    const who = sessionOf(id, call.session)
    if (!who) return refused('not a session of the node')
    const { key, name } = who
    const lane = who.lane || call.lane || null
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
          const big = fileTooBig(f.name, f.size, call.cmd)
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
      const cases = await casesNow()
      const verdictSelf =
        sub === 'verdict' && call.self
          ? 'why' in call.self
            ? async () => ({ why: (call.self as { why: string }).why })
            : async () => {
                try {
                  return { key: nodeKey(id, (call.self as { key: string }).key) }
                } catch {
                  return { why: 'not a session of the node' }
                }
              }
          : undefined
      // Decisions (#781): a node session's own question with options is held here, for its prefixed key.
      const decided = sub === 'ask' ? await threadDecisions(key, name, lane) : null
      const code = await (o.run ?? threadCmd)(argv, {
        cfg: { threads: o.cfg.threads, port: o.cfg.port },
        actor,
        lane,
        idle: false,
        ...(decided?.ctx ?? {}),
        findSession: async word => findSession(word),
        out: l => out.push(l),
        err: l => err.push(l),
        sendOut: (thread, entry) => sendOut(thread, entry),
        ...(verdictSelf && { self: verdictSelf }),
        ...(cases && { cases }),
      })
      const decision = code === 0 ? decided?.asked() : null
      return { code, out, err, ...(decision && { decision }) }
    } catch (err) {
      return failed(messageOf(err))
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /**
   * `board thread ask` of a node's session with decisions on here (#781): the question's id and
   * default reserved and written for its prefixed key, as a local `board thread ask` does for this
   * computer's; `asked` gives what the node puts on its own card. Null while decisions are off.
   */
  async function threadDecisions(
    key: string,
    name: string,
    lane: string | null,
  ): Promise<{ ctx: Partial<ThreadCmdContext>; asked(): CardDecision | null } | null> {
    const on = decisionsConfig(o.cfg.decisions)
    if (!on) return null
    const svc = await import('../decisions.ts')
    let id: string | null = null
    const ctx: Partial<ThreadCmdContext> = {
      decisions: on,
      // The call is the session's own: the node sends only its own key.
      own: async () => true,
      // Options make it a decision here; a plain question stays the node card's ask alone, as before.
      reserveAsk: async spec =>
        spec.options.length ? svc.reserveDecision({ key, name, spec, now: Date.now(), device: true }) : undefined,
      releaseAsk: reserved => svc.releaseDecision(reserved),
      setAsk: (question, d) => {
        if (!d?.spec.options.length) return undefined
        const r = svc.withDecisionsDb(db =>
          svc.askDecision(db, {
            key,
            name,
            lane,
            spec: d.spec,
            ask: question,
            thread: d.thread,
            now: Date.now(),
            device: true,
            ...(d.reserved && { reserved: d.reserved }),
          }),
        )
        id = r.id
        return decisionLine(r.id, r.defaultAt, d.spec.defaultMs)
      },
    }
    return { ctx, asked: () => (id ? heldDecision(key, id) : null) }
  }

  /**
   * `board ask "<q>" --option ...` in a session of the node (#781): the question with its options
   * held here for the session's prefixed key (this board's copy of its card's ask and decision, the
   * record, the default in this board's schedule); the node puts the decision it gets back on its own
   * card. The words as the node's `board` had them: the flags, then after a lone `--` the text.
   */
  async function askFrom(id: string, call: UplinkCall): Promise<UplinkResult> {
    const who = sessionOf(id, call.session)
    if (!who) return refused('not a session of the node')
    const on = decisionsConfig(o.cfg.decisions)
    if (!on) return failed("decisions are off on the board's computer: ask without --option")
    const cut = call.argv.indexOf('--')
    const before = cut < 0 ? call.argv : call.argv.slice(0, cut)
    const after = cut < 0 ? [] : call.argv.slice(cut + 1)
    try {
      const { parseAsk } = await import('../../core/decisions.ts')
      const svc = await import('../decisions.ts')
      const spec = parseAsk(before, after, on)
      const lane = who.lane || call.lane || null
      const r = svc.withDecisionsDb(db =>
        svc.askDecision(db, {
          key: who.key,
          name: who.name,
          lane,
          spec,
          ask: spec.question,
          now: Date.now(),
          device: true,
        }),
      )
      const decision = heldDecision(who.key, r.id)
      return {
        code: 0,
        out: [` · ${decisionLine(r.id, r.defaultAt, spec.defaultMs)}`],
        err: [],
        ...(decision && { decision }),
      }
    } catch (err) {
      return failed(messageOf(err))
    }
  }

  /**
   * `board send <name|key> "<text>"` in a session of the node (#619, core/agent-send.ts): queued here
   * for the card it names, signed with the node's session. Any machine's session of the board, as from
   * this computer (#772): the scheduler sends it through the target's node as any entry for its key.
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
    const own = nodesConfig(o.cfg.nodes, hostname())?.id ?? ''
    const plan = planSend({
      targets: targetsOf(visibleItems(), own),
      to,
      message: words.join(' '),
      from: { key, name: item?.name || item?.autoName || '', device: id },
      own,
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
   * `board agents [--json]` in a session of the node (#628, core/agent-send.ts): every machine's
   * sessions of the board (#772), a device whose link is not online now marked as such.
   */
  async function agentsFrom(id: string, call: UplinkCall): Promise<UplinkResult> {
    let key: string
    try {
      key = nodeKey(id, call.session)
    } catch {
      return refused('not a session of the node')
    }
    const { agentViewsOf, formatAgentLines, targetsOf } = await import('../../core/agent-send.ts')
    const own = nodesConfig(o.cfg.nodes, hostname())?.id ?? ''
    const targets = targetsOf(visibleItems(), own)
    const offline = offlineOf(targets)
    // One view a line (#639): a result's line is cut at RESULT_LINE_MAX, which one array of a
    // few hundred cards would pass; the lines joined are the same JSON array.
    if (call.argv.includes('--json')) {
      const views = agentViewsOf(targets, { selfKey: key, offline }).map(v => JSON.stringify(v))
      return { code: 0, out: ['[', ...views.map((v, i) => (i < views.length - 1 ? `${v},` : v)), ']'], err: [] }
    }
    const lines = formatAgentLines(targets, { selfKey: key, own, offline, now: Date.now() })
    return { code: 0, out: lines.length ? lines : ['no sessions on the board'], err: [] }
  }

  /**
   * `board time …` in a session of the node (#644): runs against this board's own database and
   * config as the node's session (its prefixed key, and its card's lane on the master when one
   * exists). `import` pulls its file through the uplink so a node never reads a path on the master.
   */
  async function timeFrom(id: string, call: UplinkCall): Promise<UplinkResult | null> {
    let key: string
    try {
      key = nodeKey(id, call.session)
    } catch {
      return refused('not a session of the node')
    }
    const item = o.find(key)
    const lane = item?.category || call.lane || null
    const name = item?.name || item?.autoName || call.session.slice(0, 8)
    const actor: Actor = { key, name }
    const { node: _node, ...masterCfg } = o.cfg
    const folder = join(store.dir(id), 'uplink', call.id)
    const out: string[] = []
    try {
      const { timeCmd, timeImportFileArg } = await import('../../entrypoints/time-cli.ts')
      const argv = [...call.argv]
      if ((argv[0] ?? 'list') === 'import') {
        const pos = timeImportFileArg(argv.slice(1))
        if (pos >= 0) {
          const pulled = await pullArgFile(id, call, argv, pos + 1, folder)
          if (pulled !== 'ok') return pulled
        }
      }
      const code = await (o.runTime ?? timeCmd)(argv, {
        cfg: masterCfg as Config,
        actor,
        lane,
        // Split multi-line JSON/CSV outputs so fit() checks per line instead of slicing a 64 KB blob.
        out: l => out.push(...l.split('\n')),
      })
      return { code, out, err: [] }
    } catch (err) {
      return { code: 1, out, err: messageOf(err).split('\n') }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /** `board cal …` in a session of the node (#698): runs against the master's calendar DB and config. */
  async function calFrom(id: string, call: UplinkCall): Promise<UplinkResult | null> {
    const who = sessionOf(id, call.session)
    if (!who) return refused('not a session of the node')
    const { node: _node, ...masterCfg } = o.cfg
    const folder = join(store.dir(id), 'uplink', call.id)
    const out: string[] = []
    const err: string[] = []
    try {
      const { calCmd, calPushFileArg } = await import('../../entrypoints/cal-cli.ts')
      const argv = [...call.argv]
      if ((argv[0] ?? 'list') === 'push') {
        const pos = calPushFileArg(argv.slice(1))
        if (pos < 0) return refused('board cal push from a node needs --file <events.json>')
        const pulled = await pullArgFile(id, call, argv, pos + 1, folder)
        if (pulled !== 'ok') return pulled
      }
      const code = await (o.runCal ?? calCmd)(argv, {
        cfg: masterCfg as Config,
        actor: { key: who.key, name: who.name },
        out: l => out.push(...l.split('\n')),
        err: l => err.push(...l.split('\n')),
      })
      return { code, out, err }
    } catch (e) {
      return { code: 1, out, err: [...err, ...messageOf(e).split('\n')] }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /** `board team …` in a session of the node (#698): runs against the master's team service; refuses owner-setup/stream ops. */
  async function teamFrom(id: string, call: UplinkCall): Promise<UplinkResult | null> {
    const who = sessionOf(id, call.session)
    if (!who) return refused('not a session of the node')
    const why = teamRefusal(call.argv)
    if (why) return refused(why)
    const [op = '', ...more] = call.argv
    const agentOp = ['post', 'reply', 'react', 'thread', 'drafts', 'assign', 'release', 'listen', 'loop'].includes(op)
    const inboxOp = op === 'inbox'
    const folder = join(store.dir(id), 'uplink', call.id)
    try {
      const { AGENT_USAGE, teamAgents, teamDraftTo, teamFileArg, teamHeaderLine, teamRosterLines } = await import(
        '../../entrypoints/team-agents-cli.ts'
      )
      if (op === 'draft' ? more.length !== 2 : !agentOp && !inboxOp && (op !== 'roster' || more.length))
        return failed(`usage: ${AGENT_USAGE}`)
      const argv = [...call.argv]
      if (op === 'post' || op === 'reply') {
        const filePos = teamFileArg(op, argv.slice(1))
        if (filePos >= 0) {
          const pulled = await pullArgFile(id, call, argv, filePos + 1, folder)
          if (pulled !== 'ok') return pulled
        }
      }
      if (o.runTeam) return await o.runTeam(argv, { key: who.key, name: who.name, lane: who.lane })
      if (!teamConfig(o.cfg.team))
        return {
          code: 0,
          out: [
            'team is off (no "team" in config.json; `board team join <invite> --hub <url> --name <name>` turns it on)',
          ],
          err: [],
        }
      const port = webPort()
      let res: Response
      try {
        res = await fetch(`http://127.0.0.1:${port}/api/team`, { signal: AbortSignal.timeout(3000) })
      } catch {
        return failed('the board does not run: open it first (herdr plugin action invoke agent-board.open)')
      }
      const view: unknown = await res.json().catch(() => undefined)
      if (!isRecord(view) || !Array.isArray(view.roster)) return failed('the board does not run the team: restart it')
      if (op === 'roster') return { code: 0, out: teamRosterLines(view), err: [] }
      if (op === 'draft') {
        const line = await teamDraftTo(port, view.roster, argv[1] ?? '', argv[2] ?? '')
        return { code: 0, out: [teamHeaderLine(view), line], err: [] }
      }
      if (inboxOp) {
        const { teamInbox } = await import('../../entrypoints/team-inbox-cli.ts')
        const out = await teamInbox(argv.slice(1), { webPort: port, roster: view.roster })
        return { code: 0, out: out.split('\n'), err: [] }
      }
      const line = await teamAgents(op, argv.slice(1), {
        webPort: port,
        roster: view.roster,
        hideFilePaths: true,
        self: async () => ({
          key: who.key,
          ...(who.name && { name: who.name }),
          ...(call.claimed && { claimed: true }),
        }),
        find: async word => {
          const item = findVisibleSession(word)
          return { key: item.key, ...(item.name && { name: item.name }) }
        },
      })
      return { code: 0, out: line.split('\n'), err: [] }
    } catch (e) {
      return failed(messageOf(e))
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /** `board decisions [--done] [--json]` in a session of the node (#698). */
  async function decisionsFrom(id: string, call: UplinkCall): Promise<UplinkResult> {
    if (!sessionOf(id, call.session)) return refused('not a session of the node')
    return decisionsRun(call.argv)
  }

  /** `board decisions [--done] [--json]` here, for a node's session or its owner. */
  async function decisionsRun(argv: readonly string[]): Promise<UplinkResult> {
    const json = argv.includes('--json')
    if (!decisionsConfig(o.cfg.decisions)) {
      const msg = 'decisions are off on this board (config.json "decisions")'
      return json ? { code: 1, out: [JSON.stringify({ ok: false, error: 'off', message: msg })], err: [] } : failed(msg)
    }
    const out: string[] = []
    try {
      const { decisionsCommand } = await import('../../entrypoints/decisions-cli.ts')
      ;(o.runDecisions ?? decisionsCommand)(argv, Date.now(), l => out.push(...l.split('\n')))
      return { code: 0, out, err: [] }
    } catch (e) {
      const msg = messageOf(e)
      if (json)
        return {
          code: 1,
          out: [JSON.stringify({ ok: false, error: e instanceof DecisionError ? e.code : 'failed', message: msg })],
          err: [],
        }
      return failed(msg)
    }
  }

  /** `board journal …` in a session of the node (#698). */
  async function journalFrom(id: string, call: UplinkCall): Promise<UplinkResult> {
    if (!sessionOf(id, call.session)) return refused('not a session of the node')
    return journalRun(call.argv)
  }

  /** `board journal …` here, for a node's session or its owner. */
  async function journalRun(argv: readonly string[]): Promise<UplinkResult> {
    const { node: _node, ...masterCfg } = o.cfg
    const out: string[] = []
    const err: string[] = []
    try {
      const { journalCmd } = await import('../../entrypoints/journal-cli.ts')
      const code = (o.runJournal ?? journalCmd)(argv, {
        cfg: masterCfg as Config,
        out: l => out.push(...l.split('\n')),
        err: l => err.push(...l.split('\n')),
      })
      return { code, out, err }
    } catch (e) {
      return { code: 1, out, err: [...err, ...messageOf(e).split('\n')] }
    }
  }

  /** `board presence [here|away|call]` and `board away [on|off]` in a session of the node (#698). */
  async function presenceFrom(id: string, call: UplinkCall): Promise<UplinkResult> {
    if (!sessionOf(id, call.session)) return refused('not a session of the node')
    return presenceRun(call.cmd, call.argv, 'agent')
  }

  /** `board presence …` and `board away …` here: a node's session switches as an agent, its owner's terminal as the CLI. */
  function presenceRun(cmd: string, argv: readonly string[], from: PresenceSource): UplinkResult {
    const word = (argv[0] ?? '').toLowerCase()
    const state: PresenceState | null =
      cmd === 'away'
        ? word === '' || word === 'on'
          ? 'away'
          : word === 'off'
            ? 'here'
            : null
        : word === ''
          ? null
          : isPresenceState(word)
            ? word
            : null
    if (argv.length > 1 || (word && !state))
      return failed(cmd === 'away' ? 'usage: board away [on|off]' : 'usage: board presence [here|away|call]')
    if (!presenceConfig(o.cfg.presence)) {
      if (!state)
        return {
          code: 0,
          out: ['presence is off (no "presence" in config.json; Settings → Presence turns it on)'],
          err: [],
        }
      return failed(t('err.presenceOff'))
    }
    if (!state) return { code: 0, out: [presenceLine(currentPresence())], err: [] }
    const { presence: p, changed } = (o.setPresence ?? ((st, fr) => setPresence(st, 'user', fr)))(state, from)
    return { code: 0, out: [`ok · ${changed ? '' : 'already '}${p.state}`], err: [] }
  }

  /** `board cats` in a session of the node (#698): master categories without leaking master filesystem paths. */
  function catsFrom(id: string, call: UplinkCall): UplinkResult {
    if (!sessionOf(id, call.session)) return refused('not a session of the node')
    return catsRun()
  }

  function catsRun(): UplinkResult {
    const known = o.cfg.categories.map(c => `${c.id} (${categoryInfo(o.cfg, c.id).title})`).join(', ')
    return { code: 0, out: [`${known}. A new id makes a new lane.`], err: [] }
  }

  /** `board list` in a session of the node (#698): every machine's sessions (#772), without free-text notes. */
  function listFrom(id: string, call: UplinkCall): UplinkResult {
    if (!sessionOf(id, call.session)) return refused('not a session of the node')
    return { code: 0, out: formatListLines(visibleItems(), o.cfg, { now: Date.now(), includeNote: false }), err: [] }
  }

  /** `board remind` / `board every` aimed at another session from a node (#698). */
  function scheduleWriteFrom(id: string, call: UplinkCall): UplinkResult {
    const who = sessionOf(id, call.session)
    if (!who) return refused('not a session of the node')
    const dashes = call.argv.indexOf('--')
    const before = dashes < 0 ? [...call.argv] : call.argv.slice(0, dashes)
    const si = before.indexOf('--session')
    const targetWord = si >= 0 ? before[si + 1] : undefined
    if (si < 0 || !targetWord) return refused(`board ${call.cmd} from a node requires --session <target>`)
    const cleanBefore = before.filter((_, i) => i !== si && i !== si + 1)
    const restArgv = dashes < 0 ? cleanBefore : [...cleanBefore, ...call.argv.slice(dashes)]
    try {
      const targetItem = findVisibleSession(targetWord)
      const now = Date.now()
      const isMasterTarget = !parseNodeKey(targetItem.key)
      const from = targetItem.key !== who.key ? { key: who.key, name: who.name } : undefined
      // The owner's clock (#806), whichever computer this master runs on.
      const zone = scheduleZone(o.cfg.time)
      if (call.cmd === 'remind') {
        const parsed = parseRemindRest(restArgv, now, { zone })
        const e = addEntry({
          key: targetItem.key,
          name: targetItem.name || targetItem.autoName || '',
          ...(isMasterTarget && targetItem.pane && { pane: targetItem.pane }),
          ...(isMasterTarget && targetItem.cwd && { cwd: targetItem.cwd }),
          ...(parsed.idle && { idle: true }),
          ...(from && { from }),
          text: parsed.text,
          at: parsed.at,
          next: parsed.at,
          by: 'agent',
        })
        return { code: 0, out: [formatRemindOk(e.id, parsed.at, now, parsed.idle, parsed.text, '', zone)], err: [] }
      }
      const parsed = parseEveryRest(restArgv, now, { zone })
      const e = addEntry({
        key: targetItem.key,
        name: targetItem.name || targetItem.autoName || '',
        ...(isMasterTarget && targetItem.pane && { pane: targetItem.pane }),
        ...(isMasterTarget && targetItem.cwd && { cwd: targetItem.cwd }),
        ...(parsed.idle && { idle: true }),
        ...(from && { from }),
        text: parsed.text,
        cron: parsed.cron.expr,
        next: parsed.next,
        by: 'agent',
      })
      return {
        code: 0,
        out: [formatEveryOk(e.id, parsed.cron.expr, parsed.next, now, parsed.idle, parsed.text, '', zone)],
        err: [],
      }
    } catch (e) {
      return failed(messageOf(e))
    }
  }

  /** spawn-agent's start from a node's session (#760): placed by this board (spawn-from.ts). */
  async function spawnCall(id: string, call: UplinkCall): Promise<UplinkResult> {
    const who = sessionOf(id, call.session)
    if (!who) return refused('not a session of the node')
    const s = o.spawn
    if (!s) return refused('spawn-agent is not taken from a node by this board')
    const payload =
      s.payload ??
      (async (): Promise<Record<string, unknown> | null> => {
        try {
          const res = await fetch(`http://127.0.0.1:${webPort()}/api/board`, { signal: AbortSignal.timeout(5000) })
          const body: unknown = await res.json()
          return res.ok && isRecord(body) ? body : null
        } catch {
          return null
        }
      })
    const { spawnFrom } = await import('./spawn-from.ts')
    return spawnFrom(id, { key: who.key, item: who.item, lane: who.lane || call.lane || null }, call, {
      cfg: o.cfg,
      start: s.start,
      payload,
      profiles: s.profiles,
      online: online,
      workspaces: s.workspaces,
      herdrName: s.herdrName,
      ...(s.dismiss && { dismiss: s.dismiss }),
      // Sent again before it was answered (this board started over meanwhile): not a second start.
      taken: () => {
        try {
          store.rememberCall(id, call.id, {
            code: 1,
            out: [],
            err: ["the board's computer took this start already: see the board before starting it again"],
          })
        } catch (err) {
          o.log(`node ${id}: the uplink's ledger: ${messageOf(err)}`)
        }
      },
    })
  }

  /**
   * `board unschedule <id>` from a node (#698): removes an entry belonging to or created by the calling
   * node session. `all` (#806): every entry this board holds for that session (its key here is
   * `@<node>:<session>`), as `board unschedule all` on the node removes its own there.
   */
  function unscheduleFrom(id: string, call: UplinkCall): UplinkResult {
    const who = sessionOf(id, call.session)
    if (!who) return refused('not a session of the node')
    const raw = call.argv[0] ?? ''
    if (!raw) return failed('usage: board unschedule <id>')
    if (raw.toLowerCase() === 'all') {
      const mine = listEntries().filter(e => e.key === who.key)
      const n = mine.filter(e => removeEntry(e.id)).length
      return {
        code: 0,
        out: [`ok · removed ${n} ${n === 1 ? 'entry' : 'entries'} held by the board's computer`],
        err: [],
      }
    }
    const entryId = raw.toLowerCase()
    const existing = getEntry(entryId)
    if (!existing) return failed(`no entry "${raw}"; see board schedule`)
    if (existing.key !== who.key && existing.from?.key !== who.key)
      return refused("cannot unschedule another session's entry from a node")
    const removed = removeEntry(entryId)
    if (!removed) return failed(`no entry "${raw}"; see board schedule`)
    return {
      code: 0,
      out: [
        `ok · removed ${removed.id} (${removed.cron ? `every "${removed.cron}"` : stamp(removed.next)}${removed.name ? `, ${removed.name}` : ''}): ${clip(removed.text)}`,
      ],
      err: [],
    }
  }

  /**
   * `board schedule` from a node (#806): the entries this board holds for the calling session (its
   * key here is `@<node>:<session>`: a handover brought them, or another session set them for it),
   * a line each as the node lists its own, on the owner's clock. Nothing of other sessions.
   */
  function scheduleFrom(id: string, call: UplinkCall): UplinkResult {
    const who = sessionOf(id, call.session)
    if (!who) return refused('not a session of the node')
    const now = Date.now()
    const zone = scheduleZone(o.cfg.time)
    const out = listEntries()
      .filter(e => e.key === who.key)
      .map(e =>
        [...scheduleParts(e, now, zone), waitsPart(e, zone), e.text ? clip(e.text, 80) : '']
          .filter(Boolean)
          .join(' · '),
      )
    return { code: 0, out, err: [] }
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
    const port = webPort()
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

  /** Case files (#488): a case's sessions as this board's cards have them, while it has cases on. */
  async function casesNow(): Promise<CaseResolvers | undefined> {
    if (!threadsConfig(o.cfg.threads)?.cases) return undefined
    const { liveOf, namesOf, remindersOf } = await import('../case-sessions.ts')
    return {
      live: async (keys: readonly string[]) => liveOf(keys, o.caseItems?.() ?? o.items()),
      reminders: remindersOf,
      names: async () => namesOf(o.items()),
    }
  }

  /**
   * A sessionless terminal's command on node `id` (#780): the owner's, as `board …` outside a session
   * on this computer runs it. A file the command names stays on the node: those run in a session.
   */
  async function ownerCall(id: string, call: { cmd: string; argv: string[]; lane?: string }): Promise<UplinkResult> {
    if (!o.links.link(id)) return refused('not a device of this board')
    const { node: _node, ...masterCfg } = o.cfg
    const argv = [...call.argv]
    const sub = argv[0] ?? 'list'
    const out: string[] = []
    const err: string[] = []
    try {
      switch (call.cmd) {
        case 'time': {
          if (sub === 'import') return refused('board time import from a node runs in a session: its file goes with it')
          const { timeCmd } = await import('../../entrypoints/time-cli.ts')
          const code = await (o.runTime ?? timeCmd)(argv, {
            cfg: masterCfg as Config,
            actor: 'user',
            // The lane the terminal's folder maps to on the node, as `board time` there takes it (#780).
            lane: call.lane ?? null,
            out: l => out.push(...l.split('\n')),
          })
          return fit({ code, out, err })
        }
        case 'cal': {
          if (sub === 'push') return refused('board cal push from a node runs in a session: its file goes with it')
          const { calCmd } = await import('../../entrypoints/cal-cli.ts')
          const code = await (o.runCal ?? calCmd)(argv, {
            cfg: masterCfg as Config,
            actor: 'user',
            out: l => out.push(...l.split('\n')),
            err: l => err.push(...l.split('\n')),
          })
          return fit({ code, out, err })
        }
        case 'thread': {
          // The reads alone (#797): a write is a session's, which goes up as one.
          if (!OWNER_THREAD_SUBS.has(sub))
            return refused(`board thread ${said(sub)} from a node's terminal runs in a session`)
          const { threadCmd } = await import('../../entrypoints/thread-cli.ts')
          const cases = await casesNow()
          const code = await (o.run ?? threadCmd)(argv, {
            cfg: { threads: o.cfg.threads, port: o.cfg.port },
            actor: { kind: 'owner' },
            lane: null,
            idle: false,
            findSession: async word => findSession(word),
            out: l => out.push(l),
            err: l => err.push(l),
            ...(cases && { cases }),
          })
          return fit({ code, out, err })
        }
        case 'journal':
          return fit(await journalRun(argv))
        case 'decisions':
          return fit(await decisionsRun(argv))
        case 'presence':
        case 'away':
          return presenceRun(call.cmd, argv, 'cli')
        case 'cats':
          return catsRun()
      }
      return refused(`board ${said(call.cmd)} is not taken from a node's terminal: run it in a session`)
    } catch (e) {
      return fit({ code: 1, out, err: [...err, ...messageOf(e).split('\n')] })
    }
  }

  const off = o.links.onChange(changed)

  return {
    ownerCall,
    async close() {
      closed = true
      off()
      const held = [...following.values()]
      for (const f of held) f.ac.abort()
      await Promise.all(held.map(f => f.done))
    },
  }
}
