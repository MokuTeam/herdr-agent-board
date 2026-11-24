// Shared client helper for CLI commands forwarded from a node to its master over the uplink (#508, #698).
import { UPLINK_REFUSED } from '../core/node-uplink.ts'

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
    | 'spend'
    | 'cats'
    | 'list'
    | 'remind'
    | 'every'
    | 'unschedule'
  argv: string[]
  session: string
  lane: string | null
  /** The files' paths, in the order the command names them. */
  files: string[]
  /** For `board thread verdict` (#675): the pane's session as this node's herdr confirmed it. */
  self?: { key: string } | { why: string }
}

/** What the node's board answered (services/node/uplink.ts CallAnswer); null when it did not. */
export type NodeCallAnswer =
  | { state: 'answered'; code: number; out: string[]; err: string[] }
  | { state: 'kept'; id: string }
  | { state: 'unreachable' }
  | null

/** How long the command waits for its board: the board's own wait (20 s, 10 s for a read) and room. */
const CALL_WAIT_MS = 40_000
/** `board agents` is a read the caller waits on (ListAgents): a hanging board falls back to the local list soon. */
const AGENTS_WAIT_MS = 5_000

/** `POST /api/node/call` on this computer's board; null when no board answers there. */
export const callBoard =
  (port: unknown) =>
  async (body: NodeCall): Promise<NodeCallAnswer> => {
    try {
      const res = await fetch(`http://127.0.0.1:${typeof port === 'number' ? port : 12422}/api/node/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(body.cmd === 'agents' ? AGENTS_WAIT_MS : CALL_WAIT_MS),
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
  port: unknown
  json?: boolean | undefined
  call?: ((body: NodeCall) => Promise<NodeCallAnswer>) | undefined
  out?: ((line: string) => void) | undefined
  err?: ((line: string) => void) | undefined
}

/**
 * Forward a CLI command from a node session to its master via the node's local uplink route,
 * printing the master's output/errors and returning its exit code.
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
  if (!opts.session)
    return fail(
      'no_session',
      `run it from a session: on a node, board ${opts.cmd} goes to the board's computer as a session's`,
    )
  const body: NodeCall = {
    ...(opts.id && { id: opts.id }),
    cmd: opts.cmd,
    argv: opts.argv,
    session: opts.session,
    lane: opts.lane ?? null,
    files: opts.files ?? [],
  }
  const send = opts.call ?? callBoard(opts.port)
  const answer = await send(body)
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
