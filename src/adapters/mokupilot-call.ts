// A MokuPilot call in progress on this computer (#276), for presence (core/presence.ts): while a
// call runs, MokuPilot keeps call.json in its state folder, `{ "pid": <its process>, "started":
// <unix seconds> }`, and takes it away when the call ends. A file whose process is gone (MokuPilot
// ended mid-call without taking it away) or older than a day says no call; one that could not be
// read (held by another program a moment) says nothing.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type CallAgent, type CallTask, parseCallAgent, SAFE_NAME, tasksOf } from '../core/call-agent.ts'
import type { MokupilotCall } from '../core/presence.ts'
import { isAlive } from './process.ts'

const stateFolder = (home = homedir()): string => join(home, '.meeting-copilot')
export const callFile = (home = homedir()): string => join(stateFolder(home), 'call.json')

/** Whether MokuPilot keeps its state on this computer: it has run here. */
export const mokupilotHere = (home = homedir()): boolean => existsSync(stateFolder(home))

const MAX_CALL_MS = 24 * 60 * 60 * 1000

export interface CallOptions {
  file?: string
  now?: () => number
  alive?: (pid: number) => boolean
}

/**
 * The call in progress (its id: its process and start), null for none, undefined when the file is
 * there but could not be read.
 */
export function callInProgress({
  file = callFile(),
  now = Date.now,
  alive = isAlive,
}: CallOptions = {}): MokupilotCall | null | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { pid, started } = raw as Record<string, unknown>
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null
  if (typeof started !== 'number' || !Number.isFinite(started)) return null
  const age = now() - started * 1000
  if (age < -60_000 || age > MAX_CALL_MS || !alive(pid as number)) return null
  return { id: `${pid}:${started}`, started: started * 1000 }
}

// The call agents MokuPilot runs (#326, core/call-agent.ts): one file each in call-agents/ of its
// state folder, while the agent lives. Where MokuPilot never ran, the folder is not there and the
// board reads nothing more.
export const callAgentsFolder = (home = homedir()): string => join(stateFolder(home), 'call-agents')

export interface CallAgentsOptions {
  folder?: string
  now?: () => number
  alive?: (pid: number) => boolean
}

/** The call agents alive now, each as its file says; none without the folder. A file that cannot be read is left out. */
export function callAgents({
  folder = callAgentsFolder(),
  now = Date.now,
  alive = isAlive,
}: CallAgentsOptions = {}): CallAgent[] {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  const at = now()
  const out: CallAgent[] = []
  for (const file of names) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue
    try {
      const agent = parseCallAgent(JSON.parse(readFileSync(join(folder, file), 'utf8')), {
        name: file.slice(0, -'.json'.length),
        now: at,
        alive,
      })
      if (agent) out.push(agent)
    } catch {} // half-written or held by another program a moment: the next refresh reads it
  }
  return out
}

/** Where the harnesses keep their agents' task boards: AGENT_BOARDS_DIR, else ~/.agent-boards. */
export const taskBoardsFolder = (home = homedir()): string =>
  process.env.AGENT_BOARDS_DIR?.trim() || join(home, '.agent-boards')

/** A call agent's task board (core/call-agent.ts tasksOf): empty when it has none or it cannot be read. */
export function taskBoard(agent: Pick<CallAgent, 'harness' | 'session'>, folder = taskBoardsFolder()): CallTask[] {
  if (!SAFE_NAME.test(agent.harness) || !SAFE_NAME.test(agent.session)) return []
  try {
    return tasksOf(JSON.parse(readFileSync(join(folder, agent.harness, `${agent.session}.json`), 'utf8')))
  } catch {
    return []
  }
}
