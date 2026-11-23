// The agents a new session from the board may start as (the launch request's `agent`): Claude Code
// always, pi when config.json says how to start it (`launch.pi`) or `pi` is on the board's PATH,
// and Antigravity (`agy`) when `launch.agy` is set or `agy` is on PATH. Only the board's own
// launcher (spawn-agent) picks one: `launch.command` and `launch.agent` start what they start, so
// with either set nothing is offered. A start that names no agent is the board's default:
// `launch.default` when the board offers that agent, else Claude Code, as it was before there was
// a choice.
import { AGY_AGENT } from '../agy.ts'
import { t } from '../lang.ts'
import { PI_AGENT } from '../pi.ts'
import type { LaunchSpec } from '../types.ts'
import { typingProblem } from './spawn-args.ts'

export { AGY_AGENT }
export const CLAUDE_AGENT = 'claude'

/** The agents a start can name: herdr's kind for it. */
export type LaunchAgentId = typeof CLAUDE_AGENT | typeof PI_AGENT | typeof AGY_AGENT

/** An agent the new-session window offers: its id for the request, and its name. */
export interface LaunchAgent {
  id: LaunchAgentId
  title: string
}

const CLAUDE_CODE: LaunchAgent = { id: CLAUDE_AGENT, title: 'Claude Code' }
const PI: LaunchAgent = { id: PI_AGENT, title: 'pi' }
const AGY: LaunchAgent = { id: AGY_AGENT, title: 'Antigravity' }

/** Whether config.json says how to start pi (`launch.pi` set to anything but blank). */
export const piConfigured = (spec: LaunchSpec | undefined): boolean => {
  const v = spec?.pi
  return v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())
}

/** Whether config.json says how to start Antigravity (`launch.agy` set to anything but blank). */
export const agyConfigured = (spec: LaunchSpec | undefined): boolean => {
  const v = spec?.agy
  return v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())
}

/**
 * The agents a start may pick, Claude Code first; none when the config's own launcher
 * (`launch.command`, `launch.agent`) starts sessions. `piFound` / `agyFound`: on the board's PATH;
 * asked only when the config does not say how to start that agent.
 */
export function launchAgents(
  spec: LaunchSpec | undefined,
  piFound: () => boolean,
  agyFound: () => boolean = () => false,
): LaunchAgent[] {
  if (spec?.command || spec?.agent) return []
  const offered: LaunchAgent[] = [CLAUDE_CODE]
  if (piConfigured(spec) || piFound()) offered.push(PI)
  if (agyConfigured(spec) || agyFound()) offered.push(AGY)
  return offered
}

/**
 * The agent a start that names none starts as: the one `launch.default` names (`claude`, `pi` or
 * `agy`, in any case) when `offered` has it, else Claude Code. `offered` (launchAgents) is asked
 * only when the setting names another agent than Claude Code, so a board without it looks nothing
 * up.
 */
export function defaultAgent(spec: LaunchSpec | undefined, offered: () => readonly LaunchAgent[]): LaunchAgentId {
  const wanted = typeof spec?.default === 'string' ? spec.default.trim().toLowerCase() : ''
  if (!wanted || wanted === CLAUDE_AGENT) return CLAUDE_AGENT
  return offered().find(a => a.id === wanted)?.id ?? CLAUDE_AGENT
}

/**
 * `launch.pi` from config.json as a list: the program and its arguments, `pi` when it is unset. A
 * string is the program alone, as `launch.claude` reads it. It is typed at the tab's shell prompt,
 * so it must be typable there (spawn-args.ts typingProblem). Throws with what is wrong, in the
 * board's language.
 */
export function piCommand(setting: unknown, win: boolean = process.platform === 'win32'): string[] {
  if (setting === undefined || setting === null || (typeof setting === 'string' && !setting.trim())) return [PI_AGENT]
  const list: unknown = typeof setting === 'string' ? [setting] : setting
  if (
    !Array.isArray(list) ||
    !list.length ||
    !list.every((s): s is string => typeof s === 'string') ||
    !String(list[0]).trim()
  )
    throw new Error(t('launch.err.piCommand'))
  const problem = typingProblem(list, win)
  if (problem) throw new Error(t('launch.err.piTyping', { word: problem.word }))
  return [...list]
}

/**
 * `launch.agy` from config.json as a list: the program and its arguments, `agy` when it is unset.
 * Checked by the same shell typing rules as `launch.pi`.
 */
export function agyCommand(setting: unknown, win: boolean = process.platform === 'win32'): string[] {
  if (setting === undefined || setting === null || (typeof setting === 'string' && !setting.trim())) return [AGY_AGENT]
  const list: unknown = typeof setting === 'string' ? [setting] : setting
  if (
    !Array.isArray(list) ||
    !list.length ||
    !list.every((s): s is string => typeof s === 'string') ||
    !String(list[0]).trim()
  )
    throw new Error(t('launch.err.agyCommand'))
  const problem = typingProblem(list, win)
  if (problem) throw new Error(t('launch.err.agyTyping', { word: problem.word }))
  return [...list]
}
