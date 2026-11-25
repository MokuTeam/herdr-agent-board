// `board thread …` (#379, docs/design/threads): threads for agents. It reads and writes the board's
// database by itself, so a write is durable the moment it prints ok, with the board running or not;
// the watchers' events go into the schedule, which the board's scheduler delivers. Every write
// prints one line, every command takes --json (an error then is { ok: false, error: <code>,
// message } on stdout, with a non-zero exit). Off unless config.json's `threads` turns it on.
//
//   board thread new [--lane <id>] [--parent <key>] [--to <session>] [--doing] "<title>"
//   board thread post <key> [--status <s>] [--summary "<line>"] [--waiting "<on what>"]
//                           [--file <path>]... [--link <url>]... [--reply <entry>] [--private] ["<text>"]
//   board thread done <key> ["<summary>"]
//   board thread ask <key> "<question for the owner>" [--option "<label>"]... [--recommend <n>] [--default-after <30m|2h>] (the flags: decisions on)
//   board thread set <key> [--title "<t>"] [--assignee <session|none>] [--lane <id>] [--parent <key|none>]
//   board thread show <key> [--last <n>] [--since <n>] [--full]
//   board thread list [--mine | --lane <id> | --all] [--status <s>] [--done]
//   board thread changes [--peek]
//   board thread watch <key> | --lane <id> | --mine  [--what status|asks|all] [--idle] [--wake]
//   board thread watch --owner [--idle] [--wake]   whatever waits on the owner (#434, services/owner-watch.ts)
//   board thread unwatch <key> | --lane <id> | --mine | --owner
//   board thread link <key> | --base
//   board thread open <key>
//   board thread import <task board file> [--lane <id>]
//   board thread share <key> <name|team|channel> [--history]   a request the owner confirms (#394)
//   board thread verdict <key> pass|fail|unsure [--file <report>] "<one line>"   the verifier's alone (#492)
// <key>: a key (atlas-12), the first 8 characters of an id, or a bare number in the session's lane.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { type BoardDb, DbError, openDb } from '../adapters/db.ts'
import {
  childrenOf,
  entriesOf,
  entryCount,
  findEntry,
  findThread,
  getThread,
  listThreads,
  mineIds,
  ThreadError,
  threadsWithRef,
  verifyingThreads,
  watchesOf,
} from '../adapters/work-thread-store.ts'
import {
  type AskSpec,
  askSpec,
  type CardDecision,
  type DecisionsConfig,
  type ReservedDecision,
} from '../core/decisions.ts'
import { KEPT_SUBS } from '../core/node-uplink.ts'
import { nodeConfig, parseNodeKey } from '../core/nodes.ts'
import { OWNER } from '../core/owner-watch.ts'
import { parseTaskFile, TaskFileError } from '../core/thread-import.ts'
import type { Config } from '../core/types.ts'
import { caseBriefText, caseHeadLines, caseSessionViews, isCase, sameRef, sameRefNote } from '../core/work-cases.ts'
import {
  isOpen,
  isThreadStatus,
  isWatchWhat,
  LANE,
  LIST_MAX,
  laneTarget,
  listLine,
  MINE,
  type Party,
  partyName,
  SHOW_LAST,
  sharingOf,
  showText,
  type ThreadHead,
  type ThreadsConfig,
  threadLink,
  threadsConfig,
  type Watch,
  writeLine,
} from '../core/work-threads.ts'
import { importTaskFile } from '../services/thread-import.ts'
import { type CaseResolvers, readCase } from '../services/work-cases.ts'
import { requestShare } from '../services/work-share.ts'
import {
  askOwner,
  changesFor,
  type EventSchedule,
  filePath,
  newThread,
  postEntry,
  setFields,
  type ThreadsCtx,
  unwatch,
  type Written,
  watch,
} from '../services/work-threads.ts'
import { giveVerdict, type SelfAnswer, verdictGate } from '../services/work-verify.ts'
import { callBoard, type NodeCall, type NodeCallAnswer } from './node-call.ts'

export type { NodeCall, NodeCallAnswer }
export { callBoard }

export const THREAD_USAGE = `board thread new [--lane <id>] [--parent <key>] [--to <session>] [--doing] "<title>"
board thread post <key> [--status next|doing|waiting|owner|done|dropped] [--summary "<line>"] [--waiting "<on what>"]
                        [--file <path>]... [--link <url>]... [--reply <entry>] [--private] ["<text>"]
board thread done <key> ["<summary>"] [--file <path>]... [--link <url>]...
board thread ask <key> "<question for the owner>" [--option "<label>"]... [--recommend <n>] [--default-after <30m|2h>] (the flags: decisions on)
board thread set <key> [--title "<t>"] [--assignee <session|none>] [--lane <id>] [--parent <key|none>]
board thread show <key> [--last <n>] [--since <n>] [--full]
board thread list [--mine | --lane <id> | --all] [--status <s>] [--done]
board thread changes [--peek] [--all]
board thread watch <key> | --lane <id> | --mine  [--what status|asks|all] [--idle] [--wake]
board thread watch --owner [--idle] [--wake]
board thread unwatch <key> | --lane <id> | --mine | --owner
board thread link <key> | --base
board thread open <key>
board thread import <task board file> [--lane <id>]
board thread share <key> <name|team|channel> [--history]
  <key>: a key (atlas-12), the first 8 characters of an id, or a bare number in your lane. Every
  command takes --json. A thread's creator hears of its status changes, its assignee of the owner's
  answers: one line, "[board reminder from threads] atlas-13 done: <summary>", never its own changes.
  watch --owner: whatever starts or stops waiting on the owner, any lane, a card's board ask too, as
  "[board reminder from asks] anna asks the owner: <question> · ben: settled"; not your own.
  share asks the owner to share the thread with a teammate's board; on a shared thread every entry
  that is not --private goes to them (or waits for the owner, as a team post of yours would).`

/** What the usage says more while verified done is on (#492). */
export const VERIFY_USAGE = `verified done (#492):
board thread new [--lane <id>] [--to <session>] --verify [--accept "<check>"]... "<title>"
board thread post <key> --accept "<check>"
board thread set <key> --verify on|off
board thread verdict <key> pass|fail|unsure [--file <report>] "<one line>"
  On a thread with --verify, a session's done is held until a verifier the board starts checks it
  against the --accept lines; only that verifier gives the verdict, a pass with its report as --file.`

/** What the usage says more while case files are on (#488). */
export const CASES_USAGE = `case files (#488):
board thread new [--lane <id>] [--ref <ticket id or link>] "<title>"
board thread set <key> --ref <r|none>
board thread list --ref <r>                    the threads with that reference, closed ones too
board thread post <key> --state "<where it stands, what is next, what it waits on>"
board thread done <key> --state "<where it stands>" ["<summary>"]
board thread brief <key>                       the case for a fresh session: state, sessions, files, last entries
  A state keeps its lines (2,000 characters, 30 lines); it stays on this board, as the reference and
  the sessions do. spawn-agent --thread <key> starts a new session from the brief and gives it the thread.`

/** The usage, with the case files' lines while they are on. */
const usageText = (cfg: ThreadsConfig | null): string =>
  [THREAD_USAGE, ...(cfg?.cases ? [CASES_USAGE] : []), ...(cfg?.verify ? [VERIFY_USAGE] : [])].join('\n')

/** The flags each command takes: with a value, and bare. `--json` and `--help` go with every one. */
const FLAGS: Record<string, { values: readonly string[]; bare: readonly string[] }> = {
  new: { values: ['--lane', '--parent', '--to'], bare: ['--doing'] },
  post: { values: ['--status', '--summary', '--waiting', '--file', '--link', '--reply'], bare: ['--private'] },
  done: { values: ['--summary', '--file', '--link', '--reply'], bare: ['--private'] },
  // --option, --recommend, --default-after: decisions (#487), only while they are on (parseArgs).
  ask: { values: ['--option', '--recommend', '--default-after'], bare: [] },
  set: { values: ['--title', '--assignee', '--lane', '--parent'], bare: [] },
  show: { values: ['--last', '--since'], bare: ['--full'] },
  list: { values: ['--lane', '--status'], bare: ['--mine', '--all', '--done'] },
  changes: { values: [], bare: ['--peek', '--all'] },
  watch: { values: ['--lane', '--what'], bare: ['--mine', '--owner', '--idle', '--wake'] },
  unwatch: { values: ['--lane'], bare: ['--mine', '--owner'] },
  link: { values: [], bare: ['--base'] },
  open: { values: [], bare: [] },
  import: { values: ['--lane'], bare: ['--todos'] },
  share: { values: [], bare: ['--history'] },
}
const EVERY = ['--json', '--help']
// Decisions' flags on `ask` (#487).
const DECISION_FLAGS = ['--option', '--recommend', '--default-after']
/** The words without decisions' flags and their values before a lone `--` (#781): the question's own. */
function withoutDecisionFlags(args: readonly string[]): string[] {
  const out: string[] = []
  const cut = args.indexOf('--')
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if ((cut < 0 || i < cut) && DECISION_FLAGS.includes(a)) {
      i++
      continue
    }
    out.push(a)
  }
  return out
}

/** The flags case files add (#488), only while they are on: off, every command takes what it took. */
const CASE_FLAGS: Record<string, { values: readonly string[]; bare: readonly string[] }> = {
  new: { values: ['--ref'], bare: [] },
  set: { values: ['--ref'], bare: [] },
  list: { values: ['--ref'], bare: [] },
  post: { values: ['--state'], bare: [] },
  done: { values: ['--state'], bare: [] },
  brief: { values: [], bare: [] },
}

/** The flags and the command verified done adds (#492), only while threads.verify is on: off, every command takes what it took. */
const VERIFY_FLAGS: Record<string, { values: readonly string[]; bare: readonly string[] }> = {
  new: { values: ['--accept'], bare: ['--verify'] },
  post: { values: ['--accept'], bare: [] },
  set: { values: ['--verify'], bare: [] },
  verdict: { values: ['--file'], bare: [] },
}

function flagsOf(
  sub: string,
  cases: boolean,
  verify = false,
): { values: readonly string[]; bare: readonly string[] } | undefined {
  const own = FLAGS[sub]
  const more = [cases ? CASE_FLAGS[sub] : undefined, verify ? VERIFY_FLAGS[sub] : undefined].filter(
    (m): m is { values: readonly string[]; bare: readonly string[] } => !!m,
  )
  if (!more.length) return own
  return {
    values: [...(own?.values ?? []), ...more.flatMap(m => m.values)],
    bare: [...(own?.bare ?? []), ...more.flatMap(m => m.bare)],
  }
}

class Usage extends ThreadError {
  constructor(message: string) {
    super('usage', message)
  }
}

interface Args {
  words: string[]
  one(flag: string): string | undefined
  all(flag: string): string[]
  has(flag: string): boolean
}

/**
 * The words and flags of `board thread <sub> …`. A flag the command does not take is refused, so a
 * mistyped one never turns into text; text that starts with `--` goes after a lone `--`.
 */
export function parseArgs(
  sub: string,
  rest: readonly string[],
  cases = false,
  o: { decisions?: boolean; verify?: boolean } = {},
): Args {
  const flags = flagsOf(sub, cases, o.verify)
  // Decisions off (#487): `ask` takes no value flag, as on main, so what it prints is main's.
  const known = (sub === 'ask' && !o.decisions ? undefined : flags) ?? { values: [], bare: [] }
  const words: string[] = []
  const values = new Map<string, string[]>()
  const bare = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--') {
      words.push(...rest.slice(i + 1))
      break
    }
    if (known.values.includes(a)) {
      const v = rest[i + 1]
      if (v === undefined) throw new Usage(`${a} needs a value`)
      values.set(a, [...(values.get(a) ?? []), v])
      i++
    } else if (known.bare.includes(a) || EVERY.includes(a)) bare.add(a)
    else if (a.startsWith('--') && flags)
      throw new Usage(`board thread ${sub} does not take ${a} (put -- before text that starts with --)`)
    else words.push(a)
  }
  return { words, one: f => values.get(f)?.at(-1), all: f => values.get(f) ?? [], has: f => bare.has(f) }
}

export interface ThreadCmdContext {
  /** `node`: this board is a node, and every command goes to its master (#508). */
  cfg: Pick<Config, 'threads' | 'port' | 'node'>
  /** Who runs it: the session (its card key and name), or the owner outside one. */
  actor: Party
  /** The session's lane (its card's category, else the folder's), null outside one. */
  lane: string | null
  /** A session on the board by its name, pane or key, for --to and --assignee; null when none is. */
  findSession: (word: string) => Promise<Party | null>
  /** A session on the board by its key alone (an imported item's owner_id); null when none has it. */
  sessionByKey?: (key: string) => Promise<Party | null>
  /**
   * The session that runs the command itself, never the one --session names, as herdr confirms it
   * for the pane it runs in, or why it could not (services/work-verify.ts paneSelf): a verdict is
   * the verifier's own (#492). Absent (a node's forwarded call): no verdict.
   */
  self?: () => Promise<SelfAnswer>
  /** Puts the question on the session's card, as `board ask` does; with decisions on (#487), its decision too, whose line it returns. */
  setAsk?: (
    question: string,
    decision?: {
      spec: AskSpec
      thread: { id: string; key: string; ask?: string }
      reserved?: ReservedDecision | undefined
    },
  ) => unknown
  /**
   * Decisions (#487): the question's id and default taken before the thread's question is written
   * (refused at the session's schedule cap with nothing written); `releaseAsk` gives it back.
   */
  reserveAsk?: (spec: AskSpec) => Promise<ReservedDecision | undefined>
  releaseAsk?: (reserved: ReservedDecision) => void | Promise<void>
  /**
   * On a node (#781): puts the question on the session's card with the decision its master holds for
   * it, so the master's board and this one show its options; `setAsk` without it.
   */
  setNodeAsk?: (question: string, decision: CardDecision) => void
  /** Whether the session it writes as is the one running the command (`--session` names another). */
  own?: () => Promise<boolean>
  /** config.json's `decisions` (#487), read: null while off. */
  decisions?: DecisionsConfig | null
  /** Raises the board's window on the thread `key` (#392: its page opens it); its address, or why not. */
  openBoard?: (key: string) => Promise<{ ok: true; url: string } | { ok: false; error: string }>
  /** `--idle`, which the `board` command takes out of the words for every command. */
  idle?: boolean
  out?: (line: string) => void
  /** Where an error goes without --json (stderr). */
  err?: (line: string) => void
  now?: number
  /** The tests' database, schedule and state folder. */
  db?: BoardDb
  schedule?: EventSchedule
  state?: string
  /**
   * An entry of a shared thread goes to the peers (#394): the running board sends it and says how
   * it went; null while no board answers (it goes when the board runs).
   */
  sendOut?: (thread: string, entry: string) => Promise<SentLine | null>
  /** On a node (#508): hands the call to this node's board, `POST /api/node/call`; the tests' stand-in. */
  call?: (body: NodeCall) => Promise<NodeCallAnswer>
  /** Case files (#488): what the board knows of sessions now, and their reminders; asked only for a case's sessions. */
  cases?: CaseResolvers
}

/**
 * Where the files of `board thread <sub> <rest>` are among `rest`: the value of each `--file`
 * of a post or a done, as parseArgs reads them (a value of another flag and text after a lone `--`
 * are none). The master rewrites these to its copies of the node's files (services/nodes/uplink.ts).
 * The value flags of case files (#488) count too, whether the board has them on or not: a state or a
 * reference that reads like `--file` is a value, and a board with cases off refuses the flag itself.
 */
export function fileArgs(sub: string, rest: readonly string[]): number[] {
  const known = flagsOf(sub, true, true)
  if (!known?.values.includes('--file')) return []
  const at: number[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--') break
    if (!known.values.includes(a)) continue
    if (i + 1 >= rest.length) break
    if (a === '--file') at.push(i + 1)
    i++
  }
  return at
}

/** What the board answered a send of a shared entry (routes/threads.ts sendReply). */
export interface SentLine {
  out: string
  reason?: string
  detail?: string
  why?: string
  error?: string
}

/** A send's answer in words, after a write's `ok · <key> · <status>`. */
export function sentWords(r: SentLine | null): string {
  if (!r) return 'saved, goes out when the board runs'
  if (r.out === 'sent') return 'sent'
  if (r.out === 'held') return `held for the owner: ${r.reason ?? 'held'}${r.detail ? ` (${r.detail})` : ''}`
  if (r.out === 'confirm') return "waits for the owner's passkey on the board"
  if (r.out === 'queued') return `saved, goes out later${r.why ? `: ${r.why}` : ''}`
  if (r.out === 'refused') return `not sent: ${r.error ?? 'refused'}`
  return r.out
}

const intOf = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined
  if (!/^\d{1,9}$/.test(v)) throw new Usage(`${flag} takes a number`)
  return Number(v)
}

/** Runs `board thread <rest>`; the exit code. */
export async function threadCmd(rest: readonly string[], ctx: ThreadCmdContext): Promise<number> {
  const out = ctx.out ?? ((line: string) => console.log(line))
  // --json among the flags; after a lone -- it is text.
  const flags = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  const json = flags.includes('--json')
  let db: BoardDb | null = null
  const cfg = threadsConfig(ctx.cfg.threads)
  try {
    const [sub = 'help', ...args] = rest
    // --help or -h among the flags (#305); after a lone -- it is text too.
    if (sub === 'help' || flags.includes('--help') || flags.includes('-h')) {
      if (json) out(JSON.stringify({ ok: true, usage: usageText(cfg) }))
      else out(usageText(cfg))
      return 0
    }
    // On a node every command goes to the master, which holds the threads (#508): this computer's
    // database is not opened. Without `node` the command runs here, as it always has.
    // Decisions (#781): a question with options goes too, and the master holds it.
    if (nodeConfig(ctx.cfg.node)) return await forward(sub, args, ctx, out, json)
    const a = parseArgs(sub, args, !!cfg?.cases, { decisions: !!ctx.decisions, verify: !!cfg?.verify })
    const base = `http://127.0.0.1:${typeof ctx.cfg.port === 'number' ? ctx.cfg.port : 12422}/`

    // How MokuPilot finds the board (9.1): its address and whether threads are on, on or off.
    if (sub === 'link' && a.has('--base')) {
      const on = !!cfg
      // day_watches: a day's watches follow it to its next conversation (#461), so MokuPilot skips its watch-again step.
      if (json) out(JSON.stringify({ ok: true, url: base, threads: on, agents: !!cfg?.agents, day_watches: true }))
      else out(`${base} · threads ${on ? 'on' : 'off'}`)
      return 0
    }
    if (!cfg) throw new ThreadError('off', 'threads are off')
    db = ctx.db ?? openDb({ create: true })
    if (!db) throw new ThreadError('db', 'no database')
    const now = ctx.now ?? Date.now()
    // A lane id as categories have them, whatever case config.json wrote it in.
    const lane = ctx.lane ? ctx.lane.toLowerCase() : null
    // A running verifier's session id is no session's to read (#492): it is what a verdict is told by.
    const self = ctx.actor.kind === 'session' ? ctx.actor.key : ''
    const said = cfg.verify && self ? (line: string) => out(hideVerifiers(db as BoardDb, line, self)) : out
    const run = new Run(db, cfg, { ...ctx, lane }, a, base, now, said, json)
    await run.dispatch(sub)
    return 0
  } catch (err) {
    const code = err instanceof ThreadError ? err.code : err instanceof DbError ? `db_${err.problem}` : 'failed'
    const message = err instanceof Error ? err.message : String(err)
    if (json) out(JSON.stringify({ ok: false, error: code, message }))
    else (ctx.err ?? console.error)(code === 'usage' ? `${message}\n${usageText(cfg)}` : message)
    return 1
  } finally {
    if (db && !ctx.db) db.close()
  }
}

/**
 * `board thread <sub> …` on a node (#508): handed to this node's board, which keeps it for the master
 * and waits for its answer (services/node/uplink.ts); what the master printed is printed here. A write
 * that can wait and got no answer in time is kept, and the command says so and succeeds; anything
 * else that got none fails, saying the board's computer is not reachable.
 */
async function forward(
  sub: string,
  args: readonly string[],
  ctx: ThreadCmdContext,
  out: (line: string) => void,
  json: boolean,
): Promise<number> {
  const err = ctx.err ?? ((line: string) => console.error(line))
  const fail = (code: string, message: string): number => {
    if (json) out(JSON.stringify({ ok: false, error: code, message }))
    else err(message)
    return 1
  }
  const actor = ctx.actor
  if (actor.kind !== 'session')
    return fail(
      'no_session',
      "run it from a session: on a node, board thread goes to the board's computer as a session's",
    )
  const argv = [sub, ...args]
  // The board command takes --idle out of every command's words: watch gets it back.
  if (ctx.idle && sub === 'watch' && !args.includes('--idle')) {
    const dash = argv.indexOf('--')
    argv.splice(dash < 0 ? argv.length : dash, 0, '--idle')
  }
  // Paths as this session meant them: the board that reads them runs in another folder.
  const files = fileArgs(sub, args).map(i => resolve(args[i] as string))
  // The verifier's pane identity (#675), asked of this node's herdr only for `verdict`.
  const self =
    sub === 'verdict' && ctx.self
      ? await ctx.self().catch((e: unknown) => ({ why: e instanceof Error ? e.message : String(e) }))
      : undefined
  const body: NodeCall = {
    ...(KEPT_SUBS.has(sub) && { id: randomUUID() }),
    cmd: 'thread',
    argv,
    session: actor.key,
    lane: ctx.lane,
    files,
    ...(self && { self }),
  }
  const answer = await (ctx.call ?? callBoard(ctx.cfg.port))(body)
  if (!answer) return fail('board', 'the board does not run on this computer: nothing was sent')
  // The question on this session's card, as a local ask puts it there; the card rides to the master,
  // with the decision the master holds for it when it asked with options (#781).
  const answered = answer.state === 'answered' ? (answer.decision ?? null) : null
  const asked = (): void => {
    if (sub !== 'ask') return
    const question = withoutDecisionFlags(args)
      .filter(a => a !== '--json' && a !== '--')
      .slice(1)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!question) return
    if (answered && ctx.setNodeAsk) ctx.setNodeAsk(question, answered)
    else ctx.setAsk?.(question)
  }
  if (answer.state === 'answered') {
    for (const line of answer.out) out(line)
    for (const line of answer.err) err(line)
    if (answer.code === 0) asked()
    return answer.code
  }
  if (answer.state === 'kept') {
    asked()
    if (json) out(JSON.stringify({ ok: true, kept: true, id: answer.id }))
    else out("kept, goes to the board's computer when it is reachable")
    return 0
  }
  return fail('unreachable', "the board's computer is not reachable")
}

/** `line` with the session id of every verifier running now replaced, but the reader's own. */
function hideVerifiers(db: BoardDb, line: string, self: string): string {
  let out = line
  for (const h of verifyingThreads(db)) {
    const key = h.verify?.run?.key
    if (!key || key === self) continue
    out = out.replaceAll(key, 'hidden')
    // A node verifier's key is `@<device>:<uuid>`: hide its raw session id too (#675).
    const raw = parseNodeKey(key)?.key
    if (raw) out = out.replaceAll(raw, 'hidden')
  }
  return out
}

class Run {
  constructor(
    readonly db: BoardDb,
    readonly cfg: ThreadsConfig,
    readonly ctx: ThreadCmdContext,
    readonly a: Args,
    readonly base: string,
    readonly now: number,
    readonly out: (line: string) => void,
    readonly json: boolean,
  ) {}

  get write(): ThreadsCtx {
    return {
      db: this.db,
      cfg: this.cfg,
      actor: this.ctx.actor,
      now: this.now,
      ...(this.ctx.schedule && { schedule: this.ctx.schedule }),
      ...(this.ctx.state && { state: this.ctx.state }),
      // Outside a session the command writes as the owner; on a shared thread that waits for the
      // owner's Send on the page (#394), since any program can run the command.
      ownerHolds: true,
    }
  }

  thread(word: string | undefined): ThreadHead {
    if (!word) throw new Usage('which thread? give its key')
    return findThread(this.db, word, this.ctx.lane)
  }

  /** The session running it, for what only a session has (watches, changes). */
  session(): { key: string; name: string } {
    const p = this.ctx.actor
    if (p.kind !== 'session') throw new ThreadError('no_session', 'run it from a session, or pass --session')
    return { key: p.key, name: p.name }
  }

  async party(word: string, flag: string): Promise<Party | null> {
    if (word.toLowerCase() === 'none') return null
    const p = await this.ctx.findSession(word)
    if (!p) throw new ThreadError('no_session', `${flag}: no session "${word}" on the board`)
    return p
  }

  /** A write's one line, or its JSON; an entry of a shared thread is sent first (#394), and how it went said. */
  async wrote(w: Written, extra: string[] = []): Promise<void> {
    const sent =
      w.entry.out === 'queued'
        ? await (this.ctx.sendOut?.(w.head.id, w.entry.id) ?? Promise.resolve(null)).catch(() => null)
        : w.entry.out === 'held'
          ? { out: 'held', reason: "the owner's own: send it from the board's page" }
          : undefined
    if (this.json)
      this.out(
        JSON.stringify({
          ok: true,
          thread: w.head,
          entry: w.entry,
          told: w.told.length,
          untold: w.untold,
          ...(sent !== undefined && { out: sent?.out ?? 'queued', ...(sent && { sent }) }),
          ...(w.sameRef && { sameRef: w.sameRef }),
        }),
      )
    else
      this.out(
        writeLine(w.head, [
          ...extra,
          ...(sent !== undefined ? [sentWords(sent)] : []),
          ...(w.untold ? [`${w.untold} watching not told: they read board thread changes`] : []),
          ...sameRefNote(w.sameRef),
        ]),
      )
  }

  async dispatch(sub: string): Promise<void> {
    const a = this.a
    switch (sub) {
      case 'new': {
        const title = a.words.join(' ')
        if (!title.trim()) throw new Usage('usage: board thread new [--lane <id>] "<title>"')
        const lane = a.one('--lane') ?? this.ctx.lane
        if (!lane)
          throw new ThreadError('no_lane', 'this session has no lane: board cat <id> first, or give --lane <id>')
        const parentWord = a.one('--parent')
        const parent = parentWord ? this.thread(parentWord) : null
        const toWord = a.one('--to')
        const to = toWord ? await this.party(toWord, '--to') : null
        const ref = a.one('--ref')
        const accept = a.all('--accept')
        const w = newThread(this.write, {
          lane,
          title,
          parent,
          to,
          doing: a.has('--doing'),
          ...(ref !== undefined && { ref }),
          ...(a.has('--verify') && { verify: true }),
          ...(accept.length && { accept }),
        })
        return this.wrote(w, w.head.assignee ? [partyName(w.head.assignee)] : [])
      }
      case 'post':
      case 'done': {
        const [key, ...words] = a.words
        const head = this.thread(key)
        const text = words.join(' ')
        const status = sub === 'done' ? 'done' : a.one('--status')
        if (status !== undefined && !isThreadStatus(status))
          throw new Usage(`--status is next, doing, waiting, owner, done or dropped, not "${status}"`)
        const reply = a.one('--reply')
        const files = a.all('--file')
        // done's words are its summary, unless --summary gives one: then they are a note.
        const summary = sub === 'done' && a.one('--summary') === undefined && text ? text : a.one('--summary')
        const note = sub === 'done' && a.one('--summary') === undefined ? '' : text
        const waiting = a.one('--waiting')
        const state = a.one('--state')
        const w = postEntry(this.write, head, {
          ...(state !== undefined && { state }),
          text: note,
          ...(status && { status }),
          ...(summary !== undefined && { summary }),
          ...(waiting !== undefined && { waitingOn: waiting }),
          files,
          links: a.all('--link'),
          ...(reply && { replyTo: findEntry(this.db, head.id, reply).id }),
          ...(a.has('--private') && { private: true }),
          ...(a.all('--accept').length && { accept: a.all('--accept') }),
          ...(sub === 'post' && this.write.actor.kind === 'owner' && { directOwner: true }),
        })
        const n = w.entry.files?.length ?? 0
        return this.wrote(w, n ? [`${n} ${n === 1 ? 'file' : 'files'}`] : [])
      }
      case 'ask': {
        const [key, ...words] = a.words
        const question = words.join(' ')
        // Decisions (#487): the flags only while they are on (parseArgs refuses them as main does while off).
        const decisions = this.ctx.decisions ?? null
        const spec = decisions
          ? askSpec(question, a.all('--option'), a.one('--recommend'), a.one('--default-after'), decisions)
          : null
        const head = this.thread(key)
        const session = this.ctx.actor.kind === 'session'
        // Options and a default only on the session's own question: its default would be typed in as
        // if that session had asked (another one's, through --session, asks without them).
        if (spec && (spec.options.length || spec.defaultMs) && this.ctx.own && !(await this.ctx.own()))
          throw new ThreadError(
            'decisions',
            "--option and --default-after are for the session's own question: ask for another session without them",
          )
        // The default goes into the schedule before the thread's question is written, as `board ask`
        // does: at the session's cap nothing is written, and the open question keeps its buttons.
        const reserved = spec && session ? await this.ctx.reserveAsk?.(spec) : undefined
        let w: ReturnType<typeof askOwner>
        try {
          w = askOwner(this.write, head, question)
        } catch (err) {
          if (reserved) await this.ctx.releaseAsk?.(reserved)
          throw err
        }
        // What the decision adds to the line ("decision <id> · default in 2 h"), when there is one.
        const extra = session
          ? await this.ctx.setAsk?.(
              w.head.waitingOn,
              spec ? { spec, thread: { id: w.head.id, key: w.head.key, ask: w.entry.id }, reserved } : undefined,
            )
          : undefined
        return this.wrote(w, typeof extra === 'string' && extra ? [extra] : [])
      }
      case 'set': {
        const head = this.thread(a.words[0])
        const assignee = a.one('--assignee')
        const parent = a.one('--parent')
        const title = a.one('--title')
        const lane = a.one('--lane')
        const ref = a.one('--ref')
        const verify = a.one('--verify')
        if (verify !== undefined && verify !== 'on' && verify !== 'off')
          throw new Usage(`--verify is on or off, not "${verify}"`)
        const w = setFields(this.write, head, {
          ...(ref !== undefined && { ref: ref.trim().toLowerCase() === 'none' ? null : ref }),
          ...(verify !== undefined && { verify: verify === 'on' }),
          ...(title !== undefined && { title }),
          ...(assignee !== undefined && { assignee: await this.party(assignee, '--assignee') }),
          ...(lane !== undefined && { lane }),
          ...(parent !== undefined && {
            parent: parent.toLowerCase() === 'none' ? null : this.thread(parent),
          }),
        })
        return this.wrote(w, w.head.assignee ? [partyName(w.head.assignee)] : [])
      }
      case 'show':
        return this.show()
      case 'brief':
        // Case files (#488); off, no such command, as before.
        if (!this.cfg.cases) throw new Usage(`no command "board thread ${sub}"`)
        return this.brief()
      case 'list':
        return this.list()
      case 'changes':
        return this.changes()
      case 'watch':
      case 'unwatch':
        return this.watch(sub === 'watch')
      case 'link': {
        const head = this.thread(a.words[0])
        const url = threadLink(this.base, head.key)
        if (this.json) this.out(JSON.stringify({ ok: true, key: head.key, url }))
        else this.out(url)
        return
      }
      case 'open': {
        const head = this.thread(a.words[0])
        const url = threadLink(this.base, head.key)
        const r = this.ctx.openBoard
          ? await this.ctx.openBoard(head.key)
          : { ok: false as const, error: 'cannot open the board' }
        if (this.json) this.out(JSON.stringify({ ok: r.ok, key: head.key, url, ...(!r.ok && { message: r.error }) }))
        else this.out(r.ok ? `ok · ${head.key} · ${url}` : `${r.error} · ${head.key} · ${url}`)
        return
      }
      case 'import':
        return this.importFile()
      case 'share': {
        // Only the owner shares (11.2): from here it is a request, which the owner confirms on the board.
        const [key, ...words] = a.words
        const head = this.thread(key)
        const to = words.join(' ').trim()
        if (!to) throw new Usage('usage: board thread share <key> <name|team|channel> [--history]')
        const w = requestShare(this.write, head, to, a.has('--history'))
        if (this.json) this.out(JSON.stringify({ ok: true, thread: w.head, asked: to }))
        else this.out(`ok · ${w.head.key} · share with ${to} asked: the owner confirms on the board`)
        return
      }
      case 'verdict': {
        // Verified done off: no such command, as on main.
        if (!this.write.cfg.verify) throw new Usage(`no command "board thread ${sub}"`)
        const [key, outcome, ...words] = a.words
        const head = this.thread(key)
        if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'unsure')
          throw new Usage(`usage: board thread verdict <key> pass|fail|unsure [--file <report>] "<one line>"`)
        // Refused for what needs no herdr first: verification off, none running, another session.
        verdictGate(this.write, head)
        const self = await this.ctx.self?.().catch((err: unknown) => ({
          why: err instanceof Error ? err.message : String(err),
        }))
        const w = giveVerdict(this.write, head, {
          outcome,
          line: words.join(' '),
          files: a.all('--file'),
          self: self ?? null,
        })
        return this.wrote(w, [`verdict ${outcome}`])
      }
      default:
        throw new Usage(`no command "board thread ${sub}"`)
    }
  }

  /** `brief <key>` (#488): the case for a fresh session, without a model (core/work-cases.ts caseBriefText). */
  async brief(): Promise<void> {
    const head = this.thread(this.a.words[0])
    if (this.a.words.length > 1) throw new Usage('usage: board thread brief <key>')
    const c = await readCase(this.db, head, this.ctx.cases ?? {})
    const parent = head.parent ? getThread(this.db, head.parent) : null
    const text = caseBriefText({
      head,
      entries: c.entries,
      sessions: c.sessions,
      live: c.live,
      reminders: c.reminders,
      link: threadLink(this.base, head.key),
      now: this.now,
      fileAt: f => filePath(f.ref, this.ctx.state),
      keyOfId: id => getThread(this.db, id)?.key ?? id.slice(0, 8),
      parentKey: parent?.key ?? null,
    })
    if (this.json)
      this.out(
        JSON.stringify({
          ok: true,
          key: head.key,
          thread: head,
          sessions: caseSessionViews(c.sessions, c.live),
          reminders: c.reminders,
          text,
        }),
      )
    else this.out(text)
  }

  async show(): Promise<void> {
    const head = this.thread(this.a.words[0])
    const full = this.a.has('--full')
    const since = intOf(this.a.one('--since'), '--since')
    const last = intOf(this.a.one('--last'), '--last')
    const entries =
      since !== undefined
        ? entriesOf(this.db, head.id, { since, shared: sharingOf(head) !== null })
        : full && last === undefined
          ? entriesOf(this.db, head.id)
          : entriesOf(this.db, head.id, { last: last ?? SHOW_LAST })
    const total = entryCount(this.db, head.id)
    const kids = childrenOf(this.db, head.id)
    const parent = head.parent ? getThread(this.db, head.parent) : null
    const link = threadLink(this.base, head.key)
    // Case files (#488): a case's reference, state and sessions in the head, while they are on; a
    // thread that is no case is shown as before, and nobody is asked where its sessions are.
    const c =
      this.cfg.cases && isCase(head) ? await readCase(this.db, head, this.ctx.cases ?? {}, { reminders: false }) : null
    if (this.json) {
      this.out(
        JSON.stringify({
          ok: true,
          thread: head,
          ...(c && {
            case: { sessions: caseSessionViews(c.sessions, c.live) },
          }),
          link,
          parent: parent?.key ?? null,
          children: kids.map(k => ({ key: k.key, status: k.status, title: k.title })),
          entries: entries.map(e => ({
            ...e,
            ...(e.files && { files: e.files.map(f => ({ ...f, path: filePath(f.ref, this.ctx.state) })) }),
          })),
          earlier: Math.max(0, total - entries.length),
        }),
      )
      return
    }
    this.out(
      showText(head, entries, {
        now: this.now,
        link,
        parentKey: parent?.key ?? null,
        children: { done: kids.filter(k => k.status === 'done').length, all: kids.length },
        earlier: Math.max(0, total - entries.length),
        keyOfId: id => getThread(this.db, id)?.key ?? id.slice(0, 8),
        fileAt: f => filePath(f.ref, this.ctx.state),
        full,
        ...(sharingOf(head) && { shared: true }),
        ...(c && { caseLines: caseHeadLines(head, c.sessions, c.live, this.now) }),
        ...(head.proposed?.verify && !head.verify?.run && { verifiers: verifyingThreads(this.db).length }),
      }),
    )
  }

  list(): void {
    const a = this.a
    const status = a.one('--status')
    if (status !== undefined && !isThreadStatus(status))
      throw new Usage(`--status is next, doing, waiting, owner, done or dropped, not "${status}"`)
    const ref = a.one('--ref')
    const closed = a.has('--done') || ref !== undefined || (status !== undefined && !isOpen(status))
    const all = a.has('--all')
    let heads: ThreadHead[]
    if (ref !== undefined) {
      // Case files (#488): a reference names few threads, so closed ones are listed too, from every lane unless --lane says one.
      const lane = a.one('--lane')?.toLowerCase()
      heads = threadsWithRef(this.db).filter(
        h =>
          !!h.ref &&
          sameRef(ref, h.ref) &&
          (!lane || h.lane === lane) &&
          (status === undefined || h.status === status) &&
          (!a.has('--mine') || (h.assignee?.kind === 'session' && h.assignee.key === this.session().key)),
      )
    } else if (a.has('--mine')) {
      const me = this.session()
      const watched = watchesOf(this.db, me.key)
        .map(w => w.target)
        .filter(t => t !== MINE && t !== OWNER && !t.startsWith('lane:'))
      const ids = [...new Set([...mineIds(this.db, me.key), ...watched])]
      heads = listThreads(this.db, { ids, closed, ...(status && { status }) })
    } else {
      const lane = a.one('--lane') ?? (all ? undefined : (this.ctx.lane ?? undefined))
      heads = listThreads(this.db, { ...(lane && { lane }), closed, ...(status && { status }) })
    }
    // Open ones first, then the closed ones asked for; the newest change first within each.
    heads.sort((x, y) => Number(!isOpen(x.status)) - Number(!isOpen(y.status)) || y.updatedAt - x.updatedAt)
    const shown = all ? heads : heads.slice(0, LIST_MAX)
    const more = heads.length - shown.length
    if (this.json) {
      this.out(JSON.stringify({ ok: true, threads: shown, more }))
      return
    }
    if (!shown.length) {
      this.out(closed ? 'no threads' : 'no open threads')
      return
    }
    // A shared thread's row says so (#394): its summary may be a teammate's words, data like the rest.
    for (const h of shown) this.out(sharingOf(h) ? `${listLine(h)} · shared` : listLine(h))
    if (more > 0) this.out(`and ${more} more (--all)`)
  }

  changes(): void {
    const me = this.session()
    const all = this.a.has('--all')
    // More than a screen: the newest are shown and nothing is marked read, so none is lost.
    const r = changesFor(this.write, me.key, { peek: this.a.has('--peek'), shown: all ? Infinity : LIST_MAX })
    const shown = all ? r.changes : r.changes.slice(0, LIST_MAX)
    const more = r.changes.length - shown.length
    if (this.json) {
      this.out(
        JSON.stringify({
          ok: true,
          changes: shown.map(c => ({ thread: c.head, entries: c.entries, status: c.status })),
          more,
          read: r.moved,
          since: r.since,
          rev: r.rev,
        }),
      )
      return
    }
    if (!shown.length) {
      this.out('nothing new since you last asked')
      return
    }
    for (const c of shown) this.out(`${listLine(c.head)} · +${c.entries}`)
    if (more > 0)
      this.out(`and ${more} more: board thread changes --all lists them all; none is marked read until then`)
  }

  /** `import <file>` (#393, 13.1): a task board's items as threads, again and again without doubles. */
  async importFile(): Promise<void> {
    const a = this.a
    if (a.has('--todos'))
      throw new ThreadError('later', 'board thread import --todos comes with the to-do points as threads (#395)')
    const path = a.words[0]
    if (!path || a.words.length > 1) throw new Usage('usage: board thread import <task board file> [--lane <id>]')
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      throw new ThreadError('file', `${path}: no such file`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new ThreadError('format', `${path}: not JSON`)
    }
    let file: ReturnType<typeof parseTaskFile>
    try {
      const at = resolve(path)
      file = parseTaskFile(raw, { harness: basename(dirname(at)), session: basename(at).replace(/\.json$/i, '') })
    } catch (err) {
      if (err instanceof TaskFileError) throw new ThreadError('format', `${path}: ${err.message}`)
      throw err
    }
    const lane = a.one('--lane') ?? this.ctx.lane
    if (!lane) throw new ThreadError('no_lane', 'this session has no lane: board cat <id> first, or give --lane <id>')
    // Each owner_id looked up once on the board, before the write.
    const owners = new Map<string, Party>()
    for (const id of new Set(file.items.map(i => i.owner?.id ?? '').filter(Boolean))) {
      const p = await this.ctx.sessionByKey?.(id).catch(() => null)
      if (p) owners.set(id, p)
    }
    const r = importTaskFile(this.write, file, { lane, sessionOf: key => owners.get(key) ?? null })
    // An entry on a shared thread is sent now, as a post's is (#557); the board sends what is left.
    const sent: { thread: string; entry: string; out: string }[] = []
    for (const s of r.shared) {
      const line =
        s.out === 'queued'
          ? await (this.ctx.sendOut?.(s.thread, s.entry) ?? Promise.resolve(null)).catch(() => null)
          : null
      sent.push({ thread: s.thread, entry: s.entry, out: line?.out ?? s.out })
    }
    const from = `${file.harness}/${file.session.slice(0, 8)}`
    if (this.json) {
      this.out(
        JSON.stringify({
          ok: true,
          harness: file.harness,
          session: file.session,
          created: r.created,
          updated: r.updated,
          dropped: r.dropped,
          unchanged: r.unchanged,
          skipped: r.skipped,
          keys: r.keys,
          told: r.told.length,
          untold: r.untold,
          ...(sent.length && { shared: sent }),
        }),
      )
      return
    }
    const count = (out: string): number => sent.filter(s => s.out === out).length
    const parts = [
      ...(r.created.length ? [`${r.created.length} new`] : []),
      ...(r.updated.length ? [`${r.updated.length} updated`] : []),
      ...(r.unchanged ? [`${r.unchanged} unchanged`] : []),
      ...(r.skipped ? [`${r.skipped} skipped`] : []),
      ...(count('sent') ? [`${count('sent')} sent to the peers`] : []),
      ...(count('held') ? [`${count('held')} held for the owner`] : []),
      ...(sent.length - count('sent') - count('held')
        ? [`${sent.length - count('sent') - count('held')} go out when the board sends`]
        : []),
      ...(r.untold ? [`${r.untold} watching not told: they read board thread changes`] : []),
    ]
    this.out(['ok', from, ...(parts.length ? parts : ['no items'])].join(' · '))
  }

  watch(on: boolean): void {
    const a = this.a
    const me = this.session()
    const lane = a.one('--lane')
    if (lane !== undefined && !LANE.test(lane.toLowerCase())) throw new Usage(`"${lane}" is not a lane id`)
    // What waits on the owner is one target of its own: never beside a thread, a lane or --mine.
    if (a.has('--owner') && (a.has('--mine') || lane !== undefined || a.words.length || a.one('--what') !== undefined))
      throw new Usage(`usage: board thread ${on ? 'watch --owner [--idle] [--wake]' : 'unwatch --owner'}`)
    const target = a.has('--owner')
      ? OWNER
      : a.has('--mine')
        ? MINE
        : lane !== undefined
          ? laneTarget(lane.toLowerCase())
          : a.words[0]
            ? this.thread(a.words[0]).id
            : ''
    if (!target)
      throw new Usage(`usage: board thread ${on ? 'watch' : 'unwatch'} <key> | --lane <id> | --mine | --owner`)
    const named =
      target === OWNER
        ? 'what waits on the owner'
        : target === MINE
          ? 'your threads'
          : target.startsWith('lane:')
            ? `lane ${target.slice(5)}`
            : null
    const label = named ?? getThread(this.db, target)?.key ?? target
    if (!on) {
      const n = unwatch(this.write, me.key, target)
      if (this.json) this.out(JSON.stringify({ ok: true, removed: n }))
      else this.out(n ? `ok · ${label} · not watched` : `${label} was not watched`)
      return
    }
    const what = a.one('--what') ?? 'status'
    if (!isWatchWhat(what)) throw new Usage(`--what is status, asks or all, not "${what}"`)
    const w: Watch = watch(this.write, {
      session: this.ctx.actor,
      target,
      what,
      idle: a.has('--idle') || !!this.ctx.idle,
      wake: a.has('--wake'),
    })
    if (this.json) this.out(JSON.stringify({ ok: true, watch: w }))
    else
      this.out(
        [
          'ok',
          label,
          target === OWNER ? 'watched' : `watched: ${w.what}`,
          ...(w.idle ? ['when free'] : []),
          ...(w.wake ? ['wakes you'] : []),
        ].join(' · '),
      )
  }
}
