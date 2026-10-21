// The agents a new session from the board may start as (the launch request's `agent`): Claude Code
// always, and pi when config.json says how to start it (`launch.pi`) or `pi` is on the board's
// PATH. Only the board's own launcher (spawn-agent) picks one: `launch.command` and `launch.agent`
// start what they start, so with either set nothing is offered. A start that names no agent is
// Claude Code's, as it was before there was a choice.
import { t } from '../lang.ts'
import { PI_AGENT } from '../pi.ts'
import type { LaunchSpec } from '../types.ts'
import { typingProblem } from './spawn-args.ts'

export const CLAUDE_AGENT = 'claude'

/** The agents a start can name: herdr's kind for it. */
export type LaunchAgentId = typeof CLAUDE_AGENT | typeof PI_AGENT

/** An agent the new-session window offers: its id for the request, and its name. */
export interface LaunchAgent {
  id: LaunchAgentId
  title: string
}

const CLAUDE_CODE: LaunchAgent = { id: CLAUDE_AGENT, title: 'Claude Code' }
const PI: LaunchAgent = { id: PI_AGENT, title: 'pi' }

/** Whether config.json says how to start pi (`launch.pi` set to anything but blank). */
export const piConfigured = (spec: LaunchSpec | undefined): boolean => {
  const v = spec?.pi
  return v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())
}

/**
 * The agents a start may pick, the board's default first; none when the config's own launcher
 * (`launch.command`, `launch.agent`) starts sessions. `piFound`: `pi` is on the board's PATH; asked
 * only when the config does not say how to start it.
 */
export function launchAgents(spec: LaunchSpec | undefined, piFound: () => boolean): LaunchAgent[] {
  if (spec?.command || spec?.agent) return []
  return piConfigured(spec) || piFound() ? [CLAUDE_CODE, PI] : [CLAUDE_CODE]
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
