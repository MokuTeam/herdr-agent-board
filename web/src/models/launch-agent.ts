// The agent a new session starts as (src/core/launch/agents.ts): the Agent row of the new-session
// window, shown when the board offers more than one (Claude Code and pi), the one it starts on, and
// what the start sends. It starts on the board's default (`launch.default`); a failed launch started
// again, or a draft the user picked one in, on that one while the board still offers it. With one
// agent offered, or none (a launcher of the config's own), the window and what it sends are as
// before there was a choice.
import type { LauncherInfo } from './launch.ts'

/** An agent the board offers: its id for the request, and its name. */
export interface AgentOption {
  id: string
  title: string
}

/** The Agent row as drawn: offered with two or more agents, the picked one pressed. */
export interface AgentRow {
  offered: boolean
  options: (AgentOption & { pressed: boolean })[]
}

export const NO_AGENT_ROW: AgentRow = { offered: false, options: [] }

/** The board offers a choice: two agents or more. */
export const offersAgents = (offered: readonly AgentOption[]): boolean => offered.length >= 2

/**
 * The agent the window starts on: `again` (a failed launch's, a draft's) when the board offers it,
 * else the board's default when it offers that, else the first it offers; null with no choice.
 */
export function agentStart(
  again: string | null | undefined,
  offered: readonly AgentOption[],
  standard: string,
): string | null {
  if (!offersAgents(offered)) return null
  const has = (id: string | null | undefined): id is string => !!id && offered.some(a => a.id === id)
  if (has(again)) return again
  if (has(standard)) return standard
  return offered[0]?.id ?? null
}

export function agentRow(picked: string | null, offered: readonly AgentOption[]): AgentRow {
  if (!offersAgents(offered) || picked === null) return NO_AGENT_ROW
  return { offered: true, options: offered.map(a => ({ id: a.id, title: a.title, pressed: a.id === picked })) }
}

/** What a start sends: the picked agent while the board offers a choice of it; nothing otherwise. */
export const agentBody = (picked: string | null, offered: readonly AgentOption[]): { agent?: string } =>
  picked !== null && offersAgents(offered) && offered.some(a => a.id === picked) ? { agent: picked } : {}

/** The line under the title names the picked agent when the board's own launcher starts it. */
export const launcherFor = (launcher: LauncherInfo, picked: string | null): LauncherInfo =>
  picked !== null && launcher.kind === 'herdr' ? { kind: 'herdr', agent: picked } : launcher
