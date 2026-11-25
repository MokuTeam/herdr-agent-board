// Shared client helper for CLI commands forwarded from a node to its master over the uplink (#508, #698).
import { randomUUID } from 'node:crypto'
import type { CardDecision } from '../core/decisions.ts'
import { SPAWN_FOLLOW_MAX_SEC } from '../core/launch/spawn-node.ts'
import { NODE_CLI_PATH, OWNER_CLI_COMMANDS, RELAY_ERRORS } from '../core/master-relay.ts'
import { isRememberedCall, UPLINK_REFUSED, uplinkResultOf } from '../core/node-uplink.ts'

/** A command on a node as it goes to the node's board (services/node/uplink.ts call). */
export interface NodeCall {
  /** A write that can wait carries an id of its own: the same call tried again is one call. */
  id?: string
  cmd:
    | 'thread'
    | 'send'
    | 'agents'
    | 'time'
    | 'cal'
    | 'team'
    | 'decisions'
    | 'journal'
    | 'presence'
    | 'away'
    | 'cats'
    | 'list'
    | 'remind'
    | 'every'
    | 'unschedule'
    | 'spawn'
    | 'ask'
  argv: string[]
  session: string
  lane: string | null
  /** The files' paths, in the order the command names them. */
  files: string[]
  /** For `board thread verdict` (#675): the pane's session as this node's herdr confirmed it. */
  self?: { key: string } | { why: string }
  /** For `board team post|reply --session <target>` (#698): session was named explicitly with --session. */
  claimed?: boolean
}

/** What the node's board answered (services/node/uplink.ts CallAnswer); null when it did not. */
export type NodeCallAnswer =
  | { state: 'answered'; code: number; out: string[]; err: string[]; decision?: CardDecision }
  | { state: 'kept'; id: string }
  | { state: 'unreachable' }
  | null

/** How long the command waits for its board: kept/slow uplink waits (20-35 s) and room. */
const CALL_WAIT_MS = 45_000
/** `board agents` is a read the caller waits on (ListAgents): a hanging board falls back to the local list soon. */
const AGENTS_WAIT_MS = 5_000
/** spawn-agent's start (#760): the master follows it up to SPAWN_FOLLOW_MAX_SEC, the node's board waits past that. */
const SPAWN_WAIT_MS = (SPAWN_FOLLOW_MAX_SEC + 40) * 1000

/** Nothing listens on the port: the call never reached a board. */
const refusedConnection = (err: unknown): boolean =>
  err instanceof Error &&
  /ConnectionRefused|ECONNREFUSED|Unable to connect/i.test(`${(err as { code?: unknown }).code ?? ''} ${err.message}`)

/** `POST /api/node/call` on this computer's board; null when no board answers there. */
export const callBoard =
  (port: unknown) =>
  async (body: NodeCall): Promise<NodeCallAnswer> => {
    try {
      const res = await fetch(`http://127.0.0.1:${typeof port === 'number' ? port : 12422}/api/node/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(
          body.cmd === 'agents' ? AGENTS_WAIT_MS : body.cmd === 'spawn' ? SPAWN_WAIT_MS : CALL_WAIT_MS,
        ),
      })
      if (!res.ok) {
        await res.body?.cancel()
        return { state: 'answered', code: 1, out: [], err: [`the board on this computer answered HTTP ${res.status}`] }
      }
      return (await res.json()) as NodeCallAnswer
    } catch (err) {
      // The board took the call and never answered: it may be kept there, so this is no "not sent".
      if (err instanceof Error && err.name === 'TimeoutError')
        return { state: 'answered', code: 1, out: [], err: ['the board on this computer did not answer in time'] }
      // spawn-agent's start (#760): a board that took it and dropped the line may have sent it on.
      if (body.cmd === 'spawn' && !refusedConnection(err))
        return {
          state: 'answered',
          code: 1,
          out: [],
          err: ['the board on this computer dropped the start: see the board before starting it again'],
        }
      return null
    }
  }

/**
 * `POST /api/node-cli` on this computer's board (#780): a terminal's command with no session, which
 * the board relays to its master as the owner's (core/master-relay.ts). Null when no board answers.
 */
/** What a sessionless terminal sends up (#780, core/master-relay.ts ownerCliOf). */
export interface OwnerCallBody {
  cmd: string
  argv: string[]
  /** The lane the terminal's folder maps to here, for board time's default client. */
  lane?: string
}

export const callBoardAsOwner =
  (port: unknown) =>
  async (body: OwnerCallBody): Promise<NodeCallAnswer> => {
    try {
      const res = await fetch(`http://127.0.0.1:${typeof port === 'number' ? port : 12422}${NODE_CLI_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_WAIT_MS),
      })
      const value: unknown = await res.json().catch(() => null)
      const reply = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
      if (res.status === 503 && reply.error === RELAY_ERRORS.offline) return { state: 'unreachable' }
      const result = res.ok ? uplinkResultOf(value) : null
      if (result) return { state: 'answered', ...result }
      // The relay keys every call as a write: an answer that never came may or may not have run.
      if (reply.error === RELAY_ERRORS.unknown || reply.error === RELAY_ERRORS.timeout)
        return {
          state: 'answered',
          code: 1,
          out: [],
          err: ["the board's computer did not answer in time: for a change, check before running it again"],
        }
      const why =
        typeof reply.message === 'string' ? reply.message : `the board on this computer answered HTTP ${res.status}`
      return { state: 'answered', code: 1, out: [], err: [why] }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError')
        return { state: 'answered', code: 1, out: [], err: ['the board on this computer did not answer in time'] }
      return null
    }
  }

export interface ForwardNodeCallOptions {
  cmd: NodeCall['cmd']
  argv: string[]
  session: string | null
  lane?: string | null | undefined
  files?: string[] | undefined
  id?: string | undefined
  claimed?: boolean | undefined
  port: unknown
  json?: boolean | undefined
  call?: ((body: NodeCall) => Promise<NodeCallAnswer>) | undefined
  /** Outside a session (#780): the owner's call; callBoardAsOwner by default. */
  callOwner?: ((body: OwnerCallBody) => Promise<NodeCallAnswer>) | undefined
  out?: ((line: string) => void) | undefined
  err?: ((line: string) => void) | undefined
}

/**
 * Forward a CLI command from a node session to its master via the node's local uplink route,
 * printing the master's output/errors and returning its exit code. Outside a session, a command the
 * master takes from the owner (OWNER_CLI_COMMANDS) goes up the relay as the owner's (#780).
 */
export async function forwardNodeCall(opts: ForwardNodeCallOptions): Promise<number> {
  const out = opts.out ?? ((line: string) => console.log(line))
  const err = opts.err ?? ((line: string) => console.error(line))
  const json = opts.json === true
  const fail = (code: string, message: string, exit = 1): number => {
    if (json) out(JSON.stringify({ ok: false, error: code, message }))
    else err(message)
    return exit
  }
  if (!opts.session && !OWNER_CLI_COMMANDS.has(opts.cmd))
    return fail(
      'no_session',
      `run it from a session: on a node, board ${opts.cmd} goes to the board's computer as a session's`,
    )
  let answer: NodeCallAnswer
  if (!opts.session)
    answer = await (opts.callOwner ?? callBoardAsOwner(opts.port))({
      cmd: opts.cmd,
      argv: opts.argv,
      ...(opts.lane && { lane: opts.lane }),
    })
  else {
    const id = opts.id ?? (isRememberedCall(opts.cmd, opts.argv) ? randomUUID() : undefined)
    const body: NodeCall = {
      ...(id && { id }),
      cmd: opts.cmd,
      argv: opts.argv,
      session: opts.session,
      lane: opts.lane ?? null,
      files: opts.files ?? [],
      ...(opts.claimed !== undefined && { claimed: opts.claimed }),
    }
    answer = await (opts.call ?? callBoard(opts.port))(body)
  }
  if (!answer) return fail('board', 'the board does not run on this computer: nothing was sent')
  if (answer.state === 'answered') {
    if (answer.code === UPLINK_REFUSED && answer.err.some(l => /is not taken from a node/i.test(l)))
      return fail(
        'master_outdated',
        `board ${opts.cmd} is not supported by the board's computer yet: update the master board to a newer version`,
      )
    if (json && answer.code !== 0 && !answer.out.length && answer.err.length)
      return fail(
        answer.code === UPLINK_REFUSED ? 'refused' : 'failed',
        answer.err.join('\n'),
        answer.code === UPLINK_REFUSED ? UPLINK_REFUSED : 1,
      )
    for (const line of answer.out) out(line)
    for (const line of answer.err) err(line)
    return answer.code
  }
  if (answer.state === 'kept') {
    if (json) out(JSON.stringify({ ok: true, kept: true, id: answer.id }))
    else out("kept, goes to the board's computer when it is reachable")
    return 0
  }
  return fail('unreachable', "the board's computer is not reachable")
}
