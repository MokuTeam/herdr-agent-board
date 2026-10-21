// Wake's herdr calls, each the command herdr-wake's router.mjs made, behind one interface so the
// wake engine and its pane operations run against an in-memory fake in tests. And the pane's shell
// as `herdr pane process-info` reports it (herdr 0.9.5's schema), named as clearKeyFor takes it.
import {
  agentGet,
  asPane,
  type HerdrAgent,
  type HerdrPane,
  type HerdrSnapshot,
  herdr,
  herdrText,
  snapshot,
} from './herdr.ts'
import { isRecord } from './json-store.ts'

/** A pane's processes: its shell's pid, the foreground ones, and the shell's name (null when herdr does not show it). */
export interface ProcessInfo {
  shellPid: number | null
  foreground: { pid: number; name: string }[]
  shell: string | null
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * A process name as a shell's name: its base name (herdr may give a path, either separator),
 * without a login shell's leading `-`, lower-cased, without `.exe`; null when nothing is left.
 */
function shellName(name: string): string | null {
  const base = (name.split(/[\\/]/).pop() ?? '')
    .replace(/^-+/, '')
    .toLowerCase()
    .replace(/\.exe$/, '')
  return base || null
}

/**
 * `herdr pane process-info --pane <id>`'s answer: `process_info.shell_pid` (a number, else null),
 * the `foreground_processes` with a number `pid` and a string `name`, and the shell, the foreground
 * process whose pid is the shell's. An answer without `process_info` is an error: a pane whose
 * processes are not known is not one to type into.
 */
export function asProcessInfo(answer: unknown): ProcessInfo {
  const info = isRecord(answer) ? answer.process_info : null
  if (!isRecord(info)) throw new Error('herdr pane process-info: no process_info in its answer')
  const shellPid = isNumber(info.shell_pid) ? info.shell_pid : null
  const list = Array.isArray(info.foreground_processes) ? info.foreground_processes : []
  const foreground = list.flatMap(p =>
    isRecord(p) && isNumber(p.pid) && typeof p.name === 'string' ? [{ pid: p.pid, name: p.name }] : [],
  )
  const shell = shellPid === null ? undefined : foreground.find(p => p.pid === shellPid)
  return { shellPid, foreground, shell: shell ? shellName(shell.name) : null }
}

/** What wake asks of herdr and does in its panes. */
export interface WakeHerdr {
  /** `api snapshot` (unknown fields such as `agents` kept). */
  snapshot(): Promise<HerdrSnapshot>
  /** `pane get <pane>`; null when herdr no longer has the pane. */
  pane(pane: string): Promise<HerdrPane | null>
  /** `agent get <pane>`; null when the pane has no agent, or herdr no longer has the pane. */
  agent(pane: string): Promise<HerdrAgent | null>
  /** `pane process-info --pane <pane>`. */
  processInfo(pane: string): Promise<ProcessInfo>
  /** `pane run <pane> <line>`: typed and run. */
  run(pane: string, line: string): Promise<void>
  /** `pane send-keys <pane> <key>`. */
  sendKeys(pane: string, key: string): Promise<void>
  /** `pane send-text <pane> <text>`: typed, not run. */
  sendText(pane: string, text: string): Promise<void>
  /** `pane rename <pane> <label>`, or `pane rename <pane> --clear` for null. */
  rename(pane: string, label: string | null): Promise<void>
  /** `agent prompt <pane> <text>`; a leading `-` gets a space before it (else herdr reads an option). */
  prompt(pane: string, text: string): Promise<void>
  /** `pane read <pane> --source visible`. */
  screen(pane: string): Promise<string>
  /** `agent read <pane> --source recent --lines 40 --ansi`: the input box with its colours. */
  inputBox(pane: string): Promise<string>
}

const codeOf = (err: unknown): unknown => (isRecord(err) ? err.code : undefined)

/** `get`'s answer, or null when herdr says the pane is not there. */
async function unlessGone<T>(get: () => Promise<T>): Promise<T | null> {
  try {
    return await get()
  } catch (err) {
    if (codeOf(err) === 'pane_not_found') return null
    throw err
  }
}

/** WakeHerdr over the herdr CLI (adapters/herdr.ts). */
export const cliWakeHerdr: WakeHerdr = {
  snapshot: () => snapshot(),
  pane: pane =>
    unlessGone(async () => {
      const answer = await herdr(['pane', 'get', pane])
      return isRecord(answer) ? asPane(answer.pane) : null
    }),
  agent: pane => unlessGone(() => agentGet(pane)),
  processInfo: async pane => asProcessInfo(await herdr(['pane', 'process-info', '--pane', pane])),
  run: async (pane, line) => {
    await herdr(['pane', 'run', pane, line])
  },
  sendKeys: async (pane, key) => {
    await herdr(['pane', 'send-keys', pane, key])
  },
  sendText: async (pane, text) => {
    await herdr(['pane', 'send-text', pane, text])
  },
  rename: async (pane, label) => {
    await herdr(['pane', 'rename', pane, label ?? '--clear'])
  },
  prompt: async (pane, text) => {
    await herdr(['agent', 'prompt', pane, /^-/.test(text) ? ` ${text}` : text])
  },
  screen: pane => herdrText(['pane', 'read', pane, '--source', 'visible']),
  inputBox: pane => herdrText(['agent', 'read', pane, '--source', 'recent', '--lines', '40', '--ansi']),
}
