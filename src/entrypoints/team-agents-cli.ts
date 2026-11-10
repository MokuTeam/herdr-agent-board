// `board team post | reply | assign | release | listen` (#216): a session's side of agents talking
// through the team hub. Every one asks the running board (its /api/team routes); the board decides
// what goes out without a person and marks whatever comes this way as an agent's. Loaded only by
// `board team`, so no other board command pays for it.
import { isRecord } from '../adapters/json-store.ts'
import { printable } from '../core/team.ts'
import { heldWhy, refusedWhy, resolveThreadRef, splitKey, TEAM } from '../core/team-agents.ts'

export const AGENT_USAGE =
  'board team post <name|peer-id|team> [--new "<title>"] [--link <url>] "<text>" | board team reply <thread> "<text>" | board team assign <thread> <session> | board team release <thread> | board team listen [off]'

export interface SessionWord {
  key: string
  name?: string
}

interface Ctx {
  webPort: number
  /** The roster as the running board has it. */
  roster: unknown[]
  /** The session running this command (--session: the caller's word). */
  self: () => Promise<SessionWord>
  /** A session on the board by its name, pane or key. */
  find: (word: string) => Promise<SessionWord>
}

const BOARD_DOWN = 'the board does not run: open it first (herdr plugin action invoke agent-board.open)'

async function call(webPort: number, path: string, body?: unknown): Promise<{ status: number; reply: unknown }> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${webPort}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error(BOARD_DOWN)
  }
  return { status: res.status, reply: await res.json().catch(() => null) }
}

const peersOf = (roster: unknown[]): { peer: string; name: string }[] =>
  roster
    .filter(isRecord)
    .filter(p => typeof p.peer === 'string' && typeof p.name === 'string')
    .map(p => ({ peer: String(p.peer), name: String(p.name) }))

async function threadKeyOf(ctx: Ctx, word: string): Promise<string> {
  const { reply } = await call(ctx.webPort, '/api/team/threads')
  const threads = isRecord(reply) && Array.isArray(reply.threads) ? reply.threads.filter(isRecord) : []
  const r = resolveThreadRef(
    word,
    threads.map(t => ({
      key: String(t.key),
      scope: String(t.scope),
      id: String(t.id),
      peerName: typeof t.peerName === 'string' ? t.peerName : null,
    })),
    peersOf(ctx.roster),
  )
  if (!r.ok) throw new Error(printable(r.error))
  return r.key
}

/** Who a scope is called here: `the team`, or the pair's peer by name. */
function whoOf(ctx: Ctx, scope: string): string {
  if (scope === TEAM) return 'the team'
  return printable(peersOf(ctx.roster).find(p => p.peer === scope)?.name ?? 'them')
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined) throw new Error(`usage: ${AGENT_USAGE}`)
  args.splice(i, 2)
  return v
}

/** A post's answer from the board, said in a line; throws on a refusal. */
function said(reply: unknown, status: number, who: string): string {
  if (!isRecord(reply)) throw new Error(`the board answered ${status}`)
  if (reply.ok !== true) throw new Error(`not sent: ${refusedWhy(String(reply.error ?? status))}`)
  if (reply.sent === false)
    return `held · ${heldWhy(String(reply.reason), who, typeof reply.detail === 'string' ? reply.detail : undefined)}; the draft waits for the owner in the Team panel`
  const key = String(reply.thread ?? '')
  const id = splitKey(key)?.id ?? ''
  const skipped =
    Array.isArray(reply.skipped) && reply.skipped.length
      ? ` (not to ${reply.skipped.join(', ')}: their key changed)`
      : ''
  const ref = id && id !== 'general' ? ` in thread ${id.slice(0, 8)}` : ''
  return printable(
    `ok · sent to ${who}${ref}${skipped}; an answer comes back to this session as a board reminder from team`,
  )
}

export async function teamAgents(op: string, args: string[], ctx: Ctx): Promise<string> {
  const rest = [...args]
  if (op === 'listen') {
    if (rest.length > 1 || (rest[0] !== undefined && rest[0] !== 'off')) throw new Error(`usage: ${AGENT_USAGE}`)
    const session = rest[0] === 'off' ? null : await ctx.self()
    const { status, reply } = await call(ctx.webPort, '/api/team/listen', { session })
    if (!isRecord(reply) || reply.ok !== true) throw new Error(`the board answered ${status}`)
    return session
      ? 'ok · this session is the listener: it hears of new threads and of threads no session here handles'
      : 'ok · no listener: what comes in waits in the Team panel'
  }
  if (op === 'post') {
    const title = flag(rest, '--new')
    const link = flag(rest, '--link')
    if (rest.length !== 2 || (link !== undefined && title === undefined)) throw new Error(`usage: ${AGENT_USAGE}`)
    const [who = '', text = ''] = rest
    let to: string
    if (who.toLowerCase() === TEAM) to = TEAM
    else {
      const r = resolveThreadRef(who, [], peersOf(ctx.roster))
      if (!r.ok) throw new Error(printable(r.error))
      to = splitKey(r.key)?.scope ?? ''
    }
    const session = await ctx.self()
    const thread = title !== undefined ? { title, ...(link !== undefined && { link }) } : undefined
    const { status, reply } = await call(ctx.webPort, '/api/team/post', {
      to,
      text,
      session,
      ...(thread && { thread }),
    })
    return said(reply, status, whoOf(ctx, to))
  }
  if (op === 'reply') {
    if (rest.length !== 2) throw new Error(`usage: ${AGENT_USAGE}`)
    const key = await threadKeyOf(ctx, rest[0] ?? '')
    const parts = splitKey(key)
    if (!parts) throw new Error('no such thread')
    const session = await ctx.self()
    const { status, reply } = await call(ctx.webPort, '/api/team/post', {
      to: parts.scope,
      text: rest[1] ?? '',
      session,
      thread: { id: parts.id },
    })
    return said(reply, status, whoOf(ctx, parts.scope))
  }
  if (op === 'assign' || op === 'release') {
    if (rest.length !== (op === 'assign' ? 2 : 1)) throw new Error(`usage: ${AGENT_USAGE}`)
    const key = await threadKeyOf(ctx, rest[0] ?? '')
    const session = op === 'assign' ? await ctx.find(rest[1] ?? '') : null
    const { status, reply } = await call(ctx.webPort, `/api/team/threads/${key}/${op}`, session ? { session } : {})
    if (isRecord(reply) && reply.ok === true)
      return op === 'assign'
        ? printable(`ok · ${session?.name ?? session?.key ?? ''} handles that thread now`)
        : 'ok · the listener handles that thread now'
    const error = isRecord(reply) ? String(reply.error ?? status) : String(status)
    throw new Error(
      error === 'lane'
        ? "that session's lane is not shared with them: ask the owner, who can share it in the Team panel"
        : `not done: ${refusedWhy(error)}`,
    )
  }
  throw new Error(`usage: ${AGENT_USAGE}`)
}
