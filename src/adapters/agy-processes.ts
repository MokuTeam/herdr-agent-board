// Antigravity CLI (`agy`) foreground process lookup, for putting an `agy` session to sleep (#631):
// reads `agy`'s pid and command line from `herdr pane process-info --pane <pane>` so wake can
// preserve session flags such as `--dangerously-skip-permissions` when resuming.
import { isAgyProgram } from '../core/wake/agy.ts'
import { herdr } from './herdr.ts'
import { isRecord } from './json-store.ts'

/** `agy` as it runs in a pane: its pid and its command line. */
export interface AgyProcess {
  pid: number
  argv: string[]
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/**
 * `agy` in `herdr pane process-info`'s answer: the foreground process that is `agy`, by its name
 * or its command line's first word; the foreground group's leader when it is one of them, else
 * the first. null when none is.
 */
export function agyProcessOf(answer: unknown): AgyProcess | null {
  const info = isRecord(answer) ? answer.process_info : null
  if (!isRecord(info) || !Array.isArray(info.foreground_processes)) return null
  const found: AgyProcess[] = []
  for (const p of info.foreground_processes) {
    if (!isRecord(p) || !isNumber(p.pid)) continue
    const argv = Array.isArray(p.argv) ? p.argv.filter((a): a is string => typeof a === 'string') : []
    if (isAgyProgram(p.name) || isAgyProgram(argv[0])) found.push({ pid: p.pid, argv })
  }
  return found.find(p => p.pid === info.foreground_process_group_id) ?? found[0] ?? null
}

/** `agy` in the pane, as herdr shows it now; null when no `agy` runs in its foreground. */
export async function agyProcessIn(pane: string): Promise<AgyProcess | null> {
  return agyProcessOf(await herdr(['pane', 'process-info', '--pane', pane]))
}
