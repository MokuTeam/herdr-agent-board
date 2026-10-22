// pi's processes, for putting a pi session to sleep (#178): which process in a pane is pi and with
// what command line (herdr's `pane process-info`), every process it started (the process table:
// its MCP servers hold most of its memory), stopping them all, and the Claude account folder its
// bridge runs with (its CLAUDE_CONFIG_DIR, where the OS lets a process's environment be read).
import { readFileSync } from 'node:fs'
import { isPiProgram } from '../core/wake/pi.ts'
import { herdr } from './herdr.ts'
import { isRecord } from './json-store.ts'
import { run } from './process.ts'

/** A process and its parent, as the process table has them. */
export interface ProcRow {
  pid: number
  ppid: number
}

/** The OS's side: the process table, signals, and whether a process still runs. Faked in tests. */
export interface ProcSys {
  /** Every process with its parent; throws when the table cannot be read. */
  table(): Promise<ProcRow[]>
  /** Sends the signal; false when there was no such process. */
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean
  alive(pid: number): boolean
}

/** pi as it runs in a pane: its pid and its command line. */
export interface PiProcess {
  pid: number
  argv: string[]
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/**
 * pi in `herdr pane process-info`'s answer: the foreground process that is pi, by its name or its
 * command line's first word; the foreground group's leader when it is one of them (the shell ran
 * pi), else the first. null when none is.
 */
export function piProcessOf(answer: unknown): PiProcess | null {
  const info = isRecord(answer) ? answer.process_info : null
  if (!isRecord(info) || !Array.isArray(info.foreground_processes)) return null
  const pis: PiProcess[] = []
  for (const p of info.foreground_processes) {
    if (!isRecord(p) || !isNumber(p.pid)) continue
    const argv = Array.isArray(p.argv) ? p.argv.filter((a): a is string => typeof a === 'string') : []
    if (isPiProgram(p.name) || isPiProgram(argv[0])) pis.push({ pid: p.pid, argv })
  }
  return pis.find(p => p.pid === info.foreground_process_group_id) ?? pis[0] ?? null
}

/** pi in the pane, as herdr shows it now; null when no pi runs in its foreground. */
export async function piProcessIn(pane: string): Promise<PiProcess | null> {
  return piProcessOf(await herdr(['pane', 'process-info', '--pane', pane]))
}

/** Every process below `root` in the table, children before their own children; root not among them. */
export function descendants(rows: readonly ProcRow[], root: number): number[] {
  const children = new Map<number, number[]>()
  for (const { pid, ppid } of rows) {
    if (pid === ppid) continue
    const list = children.get(ppid) ?? []
    list.push(pid)
    children.set(ppid, list)
  }
  const out: number[] = []
  const seen = new Set<number>([root])
  for (let queue = [root]; queue.length; ) {
    const next: number[] = []
    for (const pid of queue)
      for (const child of children.get(pid) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        out.push(child)
        next.push(child)
      }
    queue = next
  }
  return out
}

/** The clock, for tests. */
export interface StopTiming {
  sleep(ms: number): Promise<void>
  now(): number
}

/** How long pi has to leave on SIGTERM, and then what it started. */
export const PI_EXIT_MS = 15_000
export const REST_EXIT_MS = 5000
const POLL_MS = 200

async function gone(sys: ProcSys, pids: readonly number[], ms: number, t: StopTiming): Promise<boolean> {
  for (const deadline = t.now() + ms; ; await t.sleep(POLL_MS)) {
    if (!pids.some(pid => sys.alive(pid))) return true
    if (t.now() >= deadline) return false
  }
}

/**
 * Stops `root` (pi) and every process it started: the tree is read first, as pi's children are
 * handed to another parent once it is gone. pi gets SIGTERM and PI_EXIT_MS to leave on its own
 * (it ends its MCP servers itself), SIGKILL after that; whatever of the tree is still there then
 * gets SIGTERM, and SIGKILL after REST_EXIT_MS. What still runs at the end is returned (`left`),
 * and so is a table that could not be read (`table: false`: only pi was stopped).
 */
export async function stopTree(
  sys: ProcSys,
  root: number,
  t: StopTiming,
  o: { piExitMs?: number; restExitMs?: number } = {},
): Promise<{ left: number[]; tree: number[]; table: boolean }> {
  let tree: number[] = []
  let table = true
  try {
    tree = descendants(await sys.table(), root)
  } catch {
    table = false
  }
  sys.signal(root, 'SIGTERM')
  if (!(await gone(sys, [root], o.piExitMs ?? PI_EXIT_MS, t))) sys.signal(root, 'SIGKILL')
  const rest = tree.filter(pid => sys.alive(pid))
  for (const pid of rest) sys.signal(pid, 'SIGTERM')
  if (rest.length && !(await gone(sys, rest, o.restExitMs ?? REST_EXIT_MS, t)))
    for (const pid of rest) if (sys.alive(pid)) sys.signal(pid, 'SIGKILL')
  await gone(sys, [root, ...tree], 1000, t)
  return { left: [root, ...tree].filter(pid => sys.alive(pid)), tree, table }
}

/** `ps` on Linux and macOS, PowerShell's process list on Windows: `<pid> <ppid>` a line. */
async function readTable(): Promise<ProcRow[]> {
  const r =
    process.platform === 'win32'
      ? await run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ])
      : await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid='])
  if (r.error || r.code !== 0) throw new Error(`the process table could not be read: ${r.stderr || r.error?.message}`)
  const rows: ProcRow[] = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (isNumber(pid) && ppid !== undefined && Number.isInteger(ppid)) rows.push({ pid, ppid })
  }
  if (!rows.length) throw new Error('the process table came back empty')
  return rows
}

/** The OS's processes, for real. */
export const realProcSys: ProcSys = {
  table: readTable,
  signal(pid, sig) {
    try {
      process.kill(pid, sig)
      return true
    } catch {
      return false
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
}

/**
 * The CLAUDE_CONFIG_DIR a process runs with, from its environment: '' when it has none; null when
 * its environment cannot be read (only Linux shows it, in /proc, and only to its owner).
 */
export function claudeConfigDirOf(pid: number, platform = process.platform): string | null {
  if (platform !== 'linux') return null
  let env: string
  try {
    env = readFileSync(`/proc/${pid}/environ`, 'latin1')
  } catch {
    return null
  }
  const entry = env.split('\0').find(e => e.startsWith('CLAUDE_CONFIG_DIR='))
  return entry === undefined ? '' : Buffer.from(entry.slice('CLAUDE_CONFIG_DIR='.length), 'latin1').toString('utf8')
}
