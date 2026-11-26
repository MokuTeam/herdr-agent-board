// spawn-agent's gate (#815, core/spawn-limits.ts): before a session starts another one, the limits
// of this computer's config.json are checked against the ledger (adapters/spawn-ledger.ts) and the
// start is written there; once it ran, the session it became.
//
// Only a session's start is gated: spawn-agent run with a session's identity in its env (the
// session's own pane, or the CLI child the board's MCP runs for a caller it names) and asking for a
// new session (not --resume, not --pane, not a Workdesk worker). The owner's starts (no identity,
// a plain terminal, every launcher the board runs) never come here. herdr is asked only when the
// answer depends on it: a limit on running sessions or on depth the caller would reach if every
// session it started still ran. A refusal is one line, and a question on the caller's card, so the
// owner sees it instead of the session failing quietly. A ledger that cannot be used lets the start
// through. It guards against runaway starts; a process that drops its identity is the owner.
import { readCard, writeCard } from '../../adapters/cards.ts'
import { type HerdrPane, snapshot } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { readSpawns, reserveSpawn, settleSpawn } from '../../adapters/spawn-ledger.ts'
import { t } from '../../core/lang.ts'
import type { SpawnOptions } from '../../core/launch/spawn-args.ts'
import {
  type Alive,
  childOfLine,
  kept,
  needsAlive,
  type SpawnParty,
  type SpawnVerdict,
  spawnLimitsOf,
  spawnVerdict,
} from '../../core/spawn-limits.ts'
import type { Config, Item } from '../../core/types.ts'
import { agyCallerOf, codexCallerOf } from '../own-session.ts'
import { caseCaller } from './case-caller.ts'

type Env = Readonly<Record<string, string | undefined>>

/** The starts that are gated: a new session (not a resume, a start in a pane, nor a Workdesk worker). */
export const gated = (o: SpawnOptions): boolean => o.resume === undefined && o.pane === undefined && !o.workdeskWorker

/**
 * The session spawn-agent runs for, as its env names it: a root Codex or Antigravity session by its
 * own id, as the board command reads it (services/own-session.ts), else a Claude session by its id;
 * a pane alone only while pi runs in it (PI_CODING_AGENT). Null outside any: the owner, a plain
 * terminal included.
 */
export function callerParty(env: Env, card: typeof readCard = readCard): SpawnParty | null {
  const codex = codexCallerOf(env, card) ? env.CODEX_THREAD_ID : ''
  const agy = !codex && agyCallerOf(env, card) ? env.ANTIGRAVITY_CONVERSATION_ID : ''
  const session = codex || agy || env.CLAUDE_CODE_SESSION_ID || ''
  const pane = env.HERDR_PANE_ID || ''
  if (!session && !(pane && env.PI_CODING_AGENT)) return null
  return { ...(session && { session }), ...(pane && { pane }) }
}

export interface GateDeps {
  env: Env
  cfg: Config
  now?: number
  /** The ledger's file (tests). */
  file?: string
  /** herdr's panes now. */
  panes?: () => Promise<HerdrPane[]>
  /** The board's cards, for sessions on other devices; null when the board does not answer. */
  items?: () => Promise<Item[] | null>
  /** Put the refusal on the caller's card as a question for the owner. */
  ask?: (text: string) => Promise<void>
  /** A line on what went wrong with the ledger itself (the start goes ahead unchecked). */
  log?: (line: string) => void
}

export interface SpawnGate {
  /** The start ran (spawn-agent's line, and what it knows of the session) or did not (null). */
  settle(line: string | null, child?: SpawnParty): void
}

const herdrPanes = async (): Promise<HerdrPane[]> => (await snapshot()).panes

/** The board's cards as GET /api/board gives them, within 1.5 s; null when it does not answer. */
const boardItems = (cfg: Config) => async (): Promise<Item[] | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${Number(cfg.port) || 12422}/api/board`, {
      signal: AbortSignal.timeout(1500),
    })
    const body: unknown = await res.json()
    return res.ok && isRecord(body) && Array.isArray(body.items) ? (body.items as Item[]) : null
  } catch {
    return null
  }
}

/** The refusal as the caller's question, unless its card already asks the owner something. */
async function askOwner(text: string): Promise<void> {
  const caller = await caseCaller()
  if (caller.kind !== 'session') return
  const card = readCard(caller.key)
  if (card?.ask || card?.decision) return
  writeCard(caller.key, { ask: text, askSince: Date.now(), by: 'agent' })
}

/** A key or a session id as another device names it, without its `@<device>:`. */
const bare = (s: string | null | undefined): string => (s ?? '').replace(/^@[^:]+:/, '')

/** Whether sessions run now, by herdr's panes here and (for another device's) the board's cards. */
function aliveOf(panes: HerdrPane[] | null, items: Item[] | null): Alive {
  return p => {
    if (p.pane?.startsWith('@')) {
      const sid = p.session ? bare(p.session) : ''
      return (
        !!items &&
        !!sid &&
        items.some(i => !!i.device && !i.sleeping && (bare(i.key) === sid || bare(i.session) === sid))
      )
    }
    if (!panes) return false
    if (p.pane) {
      const hp = panes.find(x => x.pane_id === p.pane)
      const sid = hp?.agent_session?.value
      return !!hp?.agent && (!p.session || !sid || sid === p.session)
    }
    return !!p.session && panes.some(x => !!x.agent && x.agent_session?.value === p.session)
  }
}

/** The text of the question on the caller's card, in the board's language. */
export const askText = (v: Extract<SpawnVerdict, { ok: false }>, name: string): string =>
  t(`spawn.ask.${v.rule}`, { name, n: v.count, limit: v.limit })

/**
 * The gate for one start: null when it is not a session's (nothing is written), a gate to settle
 * once the start ran. Throws with the one line when the limits refuse it.
 */
export async function gateSpawn(o: SpawnOptions, d: GateDeps): Promise<SpawnGate | null> {
  if (!gated(o)) return null
  const caller = callerParty(d.env)
  if (!caller) return null
  const limits = spawnLimitsOf(d.cfg.spawnLimits)
  const now = d.now ?? Date.now()
  let alive: Alive = () => true
  let asked = false
  /** herdr (and, for another device's sessions, the board) asked once. */
  const consult = async (): Promise<void> => {
    asked = true
    const panes = await (d.panes ?? herdrPanes)().catch(() => null)
    const remote = readSpawns(d.file).some(e => e.by.pane?.startsWith('@') || e.child?.pane?.startsWith('@'))
    const items = remote ? await (d.items ?? boardItems(d.cfg))().catch(() => null) : null
    alive = aliveOf(panes, items)
  }
  // With every session taken as running: a start that passes then passes whatever herdr says.
  if (needsAlive(limits, kept(readSpawns(d.file), now), caller, now)) await consult()
  /** The start checked and written under the ledger's lock; null when the ledger cannot be used. */
  const reserve = () => {
    try {
      return reserveSpawn(caller, o.name, now, entries => spawnVerdict(limits, entries, caller, now, alive), d.file)
    } catch (err) {
      // A ledger that cannot be read or written never stops a start: it goes ahead unchecked.
      d.log?.(`limits not checked: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
  let r = reserve()
  // Another session's start came in meanwhile: what herdr says may still let it through.
  if (r && !r.verdict.ok && !asked && (r.verdict.rule === 'children' || r.verdict.rule === 'depth')) {
    await consult()
    r = reserve()
  }
  if (!r) return null
  const { verdict, id } = r
  if (!verdict.ok) {
    try {
      await (d.ask ?? askOwner)(askText(verdict, o.name))
    } catch {}
    throw new Error(verdict.line)
  }
  if (id === null) return null
  return {
    settle(line, child) {
      try {
        settleSpawn(id, line === null ? null : { ...childOfLine(line), ...child }, d.file)
      } catch {}
    },
  }
}
