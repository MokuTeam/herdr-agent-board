// The board's HTTP MCP (#813, epic #812): the tools a session of any agent kind uses instead of the
// `board` command, at `/mcp` on the board's loopback port (server/routes/mcp.ts). Each call is the
// command itself (entrypoints/cli.ts, or spawn-agent.ts for `spawn`) run as a child of the board,
// so a master and a node answer it exactly as they answer the command: on a node what goes to the
// master goes up the same uplink and relay, with the same refusal when the master is away.
//
// Who calls is read per call, not when the server starts (#630): the client names its herdr pane
// (X-Board-Pane) or its session (X-Board-Session), and the child gets that in the variables the
// command reads its own session from (HERDR_PANE_ID, CLAUDE_CODE_SESSION_ID), with the board's own
// taken out. A pane resolves to the session herdr says runs in it now, as the command resolves it.
// No caller: the owner, as the command run outside a session.
//
// The tool list is fixed and short: it is part of every session's cached prefix.
import { join } from 'node:path'
import {
  Bad,
  jsonRpcServer,
  readArgv,
  str,
  TOOLS as THREAD_TOOLS,
  type ThreadRun,
  type ToolAnswer,
  targetWord,
  toToolAnswer,
  word,
  writeArgv,
} from './mcp.ts'

/** Who a call is from, as its client said; null: nobody named (the owner). */
export interface Caller {
  /** The herdr pane the session runs in. */
  pane?: string
  /** The session's key. */
  session?: string
  /** The folder the child runs in: the session's, when the board knows it. */
  cwd?: string
}

/** What one call runs: the board command or spawn-agent, with these arguments. */
export interface BoardRun {
  program: 'board' | 'spawn-agent'
  argv: string[]
}

export type Runner = (run: BoardRun, caller: Caller | null) => Promise<ThreadRun>

const CARD_OPS = ['doing', 'ask', 'wait', 'done', 'cat'] as const
const SCHEDULE_OPS = ['remind', 'every', 'list', 'unschedule'] as const
const AGENT_KINDS = ['claude', 'pi', 'agy', 'codex'] as const
/** As the stdio server's brief limit would be on a command line: Windows takes 32 K characters in all. */
const BRIEF_MAX = 16_000

/** The tools (#813). Small on purpose: every session that has the server carries this text. */
export const HTTP_TOOLS = [
  {
    name: 'card',
    description:
      'Your card on the board: doing (what you work on now), ask (needs the owner; options, recommend, default_after), wait (blocked outside the chat; probe: a read-only command the board runs until it exits 0), done (finished), cat (your lane). Returns the line `board` prints.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: CARD_OPS },
        text: { type: 'string', description: 'doing, ask, wait, done: the text; cat: the title of a new lane' },
        lane: { type: 'string', description: 'cat: the lane id' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'ask: answers' },
        recommend: { type: 'integer', minimum: 1, maximum: 4, description: 'ask: the recommended option' },
        default_after: { type: 'string', description: 'ask: 30m, 2h; needs recommend' },
        probe: { type: 'string', description: 'wait: the command' },
        every: { type: 'string', description: 'wait with probe: 10m' },
        timeout: { type: 'string', description: 'wait with probe: 20s' },
        silence: { type: 'string', description: 'wait with probe: 3d' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'schedule',
    description:
      'Prompts the board types into your session later, waking it if it sleeps: remind (once), every (cron), list, unschedule. Returns the lines `board` prints.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: SCHEDULE_OPS },
        when: { type: 'string', description: 'remind: in 30m, at 15:30, tomorrow 9:00, fri 17:00' },
        cron: { type: 'string', description: 'every: 5 fields, e.g. 0 9 * * 1-5' },
        text: { type: 'string', description: 'remind, every: an instruction to yourself' },
        idle: { type: 'boolean', description: 'remind, every: wait until the session is free' },
        id: { type: 'string', description: 'unschedule: an entry id, or all' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'agents',
    description:
      'The sessions on the board (every agent kind, running and sleeping, on every device): list, or send one a message, typed in once it is free; the reply comes back as a board reminder.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'send'] },
        to: { type: 'string', description: 'send: a name, "Name [ref]" or key from list' },
        message: { type: 'string', description: 'send: the text' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  ...THREAD_TOOLS,
  {
    name: 'spawn',
    description:
      'Start a new agent session in a new herdr tab, placed by the board as spawn-agent places it. Returns the line spawn-agent prints.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        cwd: { type: 'string', description: 'its folder' },
        brief: { type: 'string', description: 'its first message' },
        profile: { type: 'string', description: 'a Claude profile id' },
        device: { type: 'string', description: 'a device id, or local' },
        agent: { type: 'string', enum: AGENT_KINDS },
        trust: { type: 'boolean', description: 'answer the folder-trust dialog with Yes' },
      },
      required: ['name', 'cwd'],
      additionalProperties: false,
    },
  },
  {
    name: 'cal',
    description: "The owner's schedule across every calendar, read only (`board cal list`).",
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'today, tomorrow, 2026-11-20' },
        from: { type: 'string' },
        to: { type: 'string' },
        days: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
] as const

/**
 * A value that goes before the command's `--`: never one that reads as a flag (`--session` there
 * would name another caller) and nothing that splits a line.
 */
function flagValue(v: unknown, name: string): string | undefined {
  const s = str(v, name)?.trim()
  if (s === undefined || s === '') return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a value on the command line is one line
  if (s.startsWith('-') || /[\x00-\x1f\x7f]/.test(s)) throw new Bad(`${name}: "${s}" is not a value for ${name}`)
  return s
}

/** Text after the `--`: any words; blank is none. */
function textOf(v: unknown, name = 'text'): string | undefined {
  const s = str(v, name)
  return s?.trim() ? s : undefined
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Bad(what)
  return v
}

function cardArgv(a: Record<string, unknown>): string[] {
  const op = a.op
  const text = textOf(a.text)
  if (op === 'doing') return ['doing', '--', need(text, 'doing needs text')]
  if (op === 'done') return ['done', ...(text ? ['--', text] : [])]
  if (op === 'cat')
    return ['cat', need(word(a.lane, 'lane'), 'cat needs lane: a lane id'), ...(text ? ['--', text] : [])]
  if (op === 'ask') {
    const options = a.options === undefined ? [] : a.options
    if (!Array.isArray(options)) throw new Bad('options must be a list of answers')
    const labels = options.map(o => need(flagValue(o, 'option'), 'an option is blank'))
    const recommend = a.recommend
    if (recommend !== undefined && (typeof recommend !== 'number' || !Number.isSafeInteger(recommend) || recommend < 1))
      throw new Bad('recommend must be the number of an option')
    const after = flagValue(a.default_after, 'default_after')
    return [
      'ask',
      ...labels.flatMap(l => ['--option', l]),
      ...(recommend !== undefined ? ['--recommend', String(recommend)] : []),
      ...(after ? ['--default-after', after] : []),
      '--',
      need(text, 'ask needs text: the question'),
    ]
  }
  if (op === 'wait') {
    const probe = flagValue(a.probe, 'probe')
    const more = (['every', 'timeout', 'silence'] as const).flatMap(k => {
      const v = flagValue(a[k], k)
      if (v !== undefined && !probe) throw new Bad(`${k} goes with probe`)
      return v === undefined ? [] : [`--${k}`, v]
    })
    return [
      'wait',
      ...(probe ? ['--probe', probe, ...more] : []),
      '--',
      need(text, 'wait needs text: what you wait for'),
    ]
  }
  throw new Bad(`op is ${CARD_OPS.join(', ')}`)
}

function scheduleArgv(a: Record<string, unknown>): string[] {
  const op = a.op
  const idle = a.idle === true ? ['--idle'] : []
  if (op === 'remind') {
    const when = need(str(a.when, 'when')?.trim() || undefined, 'remind needs when: in 30m, at 15:30, tomorrow 9:00')
    const words = when.split(/\s+/).map(w => flagValue(w, 'when') as string)
    return ['remind', ...idle, ...words, '--', need(textOf(a.text), 'remind needs text')]
  }
  if (op === 'every') {
    const cron = need(flagValue(a.cron, 'cron'), 'every needs cron: 5 fields')
    return ['every', ...idle, cron, '--', need(textOf(a.text), 'every needs text')]
  }
  if (op === 'list') return ['schedule']
  if (op === 'unschedule') return ['unschedule', need(word(a.id, 'id'), 'unschedule needs id: an entry id, or all')]
  throw new Bad(`op is ${SCHEDULE_OPS.join(', ')}`)
}

function agentsArgv(a: Record<string, unknown>): string[] {
  if (a.op === 'list') return ['agents']
  if (a.op === 'send') {
    const to = need(targetWord(a.to, 'to'), 'send needs to: a session name or key')
    return ['send', '--', to, need(textOf(a.message, 'message'), 'send needs message: the text to send')]
  }
  throw new Bad('op is list or send')
}

function spawnArgv(a: Record<string, unknown>): string[] {
  const name = need(str(a.name, 'name')?.trim() || undefined, 'spawn needs name')
  const cwd = need(str(a.cwd, 'cwd')?.trim() || undefined, 'spawn needs cwd: its folder')
  const brief = textOf(a.brief, 'brief')
  if (brief && brief.length > BRIEF_MAX) throw new Bad(`brief is longer than ${BRIEF_MAX} characters`)
  const agent = str(a.agent, 'agent')
  if (agent !== undefined && !(AGENT_KINDS as readonly string[]).includes(agent))
    throw new Bad(`agent is ${AGENT_KINDS.join(', ')}`)
  const profile = word(a.profile, 'profile')
  const device = word(a.device, 'device')
  return [
    '--name',
    name,
    '--cwd',
    cwd,
    ...(brief ? ['--brief', brief] : []),
    ...(profile ? ['--profile', profile] : []),
    ...(device ? ['--device', device] : []),
    ...(agent ? ['--agent', agent] : []),
    ...(a.trust === true ? ['--trust'] : []),
  ]
}

function calArgv(a: Record<string, unknown>): string[] {
  const days = a.days
  if (days !== undefined && (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1))
    throw new Bad('days must be a whole number')
  const out = ['cal', 'list']
  for (const k of ['day', 'from', 'to'] as const) {
    const v = flagValue(a[k], k)
    if (v !== undefined) out.push(`--${k}`, v)
  }
  if (days !== undefined) out.push('--days', String(days))
  return out
}

/** What a call of `name` runs; a Bad for a call that cannot run. */
export function toolRun(name: unknown, args: Record<string, unknown>): BoardRun {
  const board = (argv: string[]): BoardRun => ({ program: 'board', argv })
  switch (name) {
    case 'card':
      return board(cardArgv(args))
    case 'schedule':
      return board(scheduleArgv(args))
    case 'agents':
      return board(agentsArgv(args))
    case 'threads':
      return board(['thread', ...readArgv(args)])
    case 'thread':
      return board(['thread', ...writeArgv(args)])
    case 'spawn':
      return { program: 'spawn-agent', argv: spawnArgv(args) }
    case 'cal':
      return board(calArgv(args))
    default:
      throw new Bad(`no tool "${String(name)}": ${HTTP_TOOLS.map(t => t.name).join(', ')}`)
  }
}

export interface HttpMcp {
  /** One JSON-RPC message from `caller`; the answer to send, or null for a notification. */
  handle(text: string, caller: Caller | null): Promise<string | null>
}

export function createHttpMcp(o: { version: string; run: Runner }): HttpMcp {
  return {
    handle(text, caller) {
      return jsonRpcServer({
        version: o.version,
        tools: HTTP_TOOLS,
        async call(name, args): Promise<ToolAnswer> {
          let run: BoardRun
          try {
            run = toolRun(name, args)
          } catch (err) {
            if (err instanceof Bad) return { content: [{ type: 'text', text: err.message }], isError: true }
            throw err
          }
          return toToolAnswer(await o.run(run, caller))
        },
      }).handle(text)
    },
  }
}

/**
 * The variables the command reads its caller from: the board's own go (it may run in a pane, in a
 * Claude profile, or under Git Bash's argument conversion), the caller's come in.
 */
const CALLER_ENV = [
  'CLAUDE_CODE_SESSION_ID',
  'HERDR_PANE_ID',
  'HERDR_TAB_ID',
  'HERDR_WORKSPACE_ID',
  'CODEX_THREAD_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
  'CLAUDE_CONFIG_DIR',
  'AGENT_BOARD_PATHCONV',
  'MSYS2_ARG_CONV_EXCL',
] as const

/** The child's environment for `caller`. */
export function callerEnv(
  base: Readonly<Record<string, string | undefined>>,
  caller: Caller | null,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v
  for (const k of CALLER_ENV) delete env[k]
  if (caller?.pane) env.HERDR_PANE_ID = caller.pane
  if (caller?.session) env.CLAUDE_CODE_SESSION_ID = caller.session
  return env
}

const PROGRAM_FILE = { board: 'cli.ts', 'spawn-agent': 'spawn-agent.ts' } as const
/** How long a call may run: spawn-agent waits for its session up to 120 s on its own. */
const RUN_MS = { board: 120_000, 'spawn-agent': 180_000 } as const
/** The most of a child's output kept, per stream. */
const OUT_MAX = 256 * 1024

const linesOf = (text: string): string[] => {
  const t = text.length > OUT_MAX ? `${text.slice(0, OUT_MAX)}\n(cut at ${OUT_MAX} characters)` : text
  return t.split(/\r?\n/).filter(l => l.trim() !== '')
}

/** The runner of the board's server: the command as a child of this Bun, in the caller's env. */
export function childRunner(o: {
  root: string
  env: () => Readonly<Record<string, string | undefined>>
  /** The child's folder when the caller's is not known. */
  cwd: string
  exists: (dir: string) => boolean
  runMs?: Partial<Record<BoardRun['program'], number>>
}): Runner {
  return async (run, caller) => {
    const file = join(o.root, 'src', 'entrypoints', PROGRAM_FILE[run.program])
    const cwd = caller?.cwd && o.exists(caller.cwd) ? caller.cwd : o.cwd
    const ms = o.runMs?.[run.program] ?? RUN_MS[run.program]
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn([process.execPath, file, ...run.argv], {
        cwd,
        env: callerEnv(o.env(), caller),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch (err) {
      return { code: 1, out: [], err: [err instanceof Error ? err.message : String(err)] }
    }
    let late = false
    const timer = setTimeout(() => {
      late = true
      proc.kill()
    }, ms)
    try {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const code = await proc.exited
      const errs = linesOf(err)
      if (late) errs.push(`no answer in ${Math.round(ms / 1000)} s: stopped`)
      return { code: late ? 1 : code, out: linesOf(out), err: errs }
    } finally {
      clearTimeout(timer)
    }
  }
}
