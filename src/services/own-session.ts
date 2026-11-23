// Which session runs a command (the board command's ownSession, entrypoints/cli.ts, and spawn-agent
// --thread, services/launch/case-caller.ts): one reading for both. A root Codex by its thread id when
// herdr says its pane runs Codex under that id; a Claude session by CLAUDE_CODE_SESSION_ID; else the
// agent herdr says runs in this pane, by its session or `pane-<id>`. Null outside any, and for a
// Codex child that cannot tell its own session.
import type { readCard as readCardFn } from '../adapters/cards.ts'
import type { HerdrPane } from '../adapters/herdr.ts'
import { AGY_AGENT } from '../core/agy.ts'
import { CODEX_AGENT } from '../core/codex.ts'

type Env = Readonly<Record<string, string | undefined>>

/** A real Claude child has a new id; a root Codex can carry the Claude id its hook recorded. */
export function codexCallerOf(env: Env, readCard: typeof readCardFn): boolean {
  const codex = env.CODEX_THREAD_ID
  if (!codex) return false
  const claude = env.CLAUDE_CODE_SESSION_ID
  return !claude || readCard(codex)?.codexParentClaude === claude
}

/** A Codex child inherits its parent's pane env; only the reported root session owns its card. */
export function codexSessionOf(
  p: HerdrPane | undefined,
  env: Env,
): { key: string; cwd: string; pane: string | undefined; name: string } | null {
  if (p?.agent !== CODEX_AGENT) return null
  const own = env.CODEX_THREAD_ID
  const pane = env.HERDR_PANE_ID
  if (own && p.agent_session?.value === own)
    return { key: own, cwd: p.cwd ?? '', pane, name: p.terminal_title_stripped || own.slice(0, 8) }
  throw new Error('cannot tell which Codex session this is: use its herdr pane, or pass --session')
}

/** A real Claude child has a new id; a root Antigravity session can carry the Claude id its hook recorded. */
export function agyCallerOf(env: Env, readCard: typeof readCardFn): boolean {
  const agy = env.ANTIGRAVITY_CONVERSATION_ID
  if (!agy) return false
  const claude = env.CLAUDE_CODE_SESSION_ID
  return !claude || readCard(agy)?.agyParentClaude === claude
}

/** An Antigravity subagent inherits its parent's pane env; only the reported root conversation owns its card. */
export function agySessionOf(
  p: HerdrPane | undefined,
  env: Env,
): { key: string; cwd: string; pane: string | undefined; name: string } | null {
  if (p?.agent !== AGY_AGENT) return null
  const own = env.ANTIGRAVITY_CONVERSATION_ID
  const pane = env.HERDR_PANE_ID
  if (own && p.agent_session?.value === own)
    return { key: own, cwd: p.cwd ?? '', pane, name: p.terminal_title_stripped || own.slice(0, 8) }
  throw new Error('cannot tell which Antigravity session this is: use its herdr pane, or pass --session')
}

/** The session running this command, { key, name }, or null outside one. */
export async function ownSessionOf(deps: {
  env: Env
  paneOf: (pane: string) => Promise<HerdrPane | undefined>
  readCard: typeof readCardFn
  /** A Claude session's name as the board knows it. */
  nameOf: (key: string) => string | undefined
}): Promise<{ key: string; name: string } | null> {
  const { env } = deps
  const own = env.CLAUDE_CODE_SESSION_ID
  const pane = env.HERDR_PANE_ID
  let p: HerdrPane | undefined
  try {
    if (pane) p = await deps.paneOf(pane)
  } catch {}
  if (codexCallerOf(env, deps.readCard)) {
    try {
      const codex = codexSessionOf(p, env)
      if (codex) return { key: codex.key, name: codex.name }
      if (!p) return null
    } catch {
      return null
    }
  }
  if (agyCallerOf(env, deps.readCard)) {
    try {
      const agy = agySessionOf(p, env)
      if (agy) return { key: agy.key, name: agy.name }
      if (!p) return null
    } catch {
      return null
    }
  }
  const key = own || (p?.agent ? (p.agent_session?.value ?? `pane-${pane}`) : null)
  if (!key) return null
  const name = (own && deps.nameOf(own)) || p?.terminal_title_stripped || key.slice(0, 8)
  return { key, name }
}
