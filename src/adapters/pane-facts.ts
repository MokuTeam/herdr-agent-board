// What `board doctor` reports of herdr's panes (#243, core/pane-report.ts), read from this computer:
// herdr's snapshot, what runs in each pane (`herdr pane process-info`, a few at a time), the memory
// of each pane's processes (its own and every one it started) from the process table (PowerShell's
// on Windows, `ps` on Linux and macOS: working set or resident size), and the panes wake keeps a
// sleeper in (its session file and pi's). Only `board doctor` asks: nothing here runs on its own.
import type { PaneFacts, PaneHeld } from '../core/pane-report.ts'
import { paneProcesses, snapshot } from './herdr.ts'
import { run } from './process.ts'
import { peekPiSleepers, peekWakeSessions } from './wake-files.ts'

/** A process: its pid, its parent's, its memory in bytes, and its program's name (lower case, no folder, no `.exe`). */
export interface MemRow {
  pid: number
  ppid: number
  bytes: number
  name: string
}

/** How many `herdr pane process-info` run at once. */
const AT_ONCE = 8

/** Interactive shells a pane starts with. */
const SHELLS = new Set(['pwsh', 'powershell', 'cmd', 'bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'nu'])
/** Windows' console hosts, which a console program may have under it: not something run in the pane. */
const CONSOLE_HOSTS = new Set(['conhost', 'openconsole'])

const programName = (name: string): string =>
  (name.trim().split(/[\\/]/).pop() ?? '')
    .replace(/^-+/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()

/** The process table with each process's memory and name; null when it cannot be read. */
async function memoryTable(): Promise<MemRow[] | null> {
  const win = process.platform === 'win32'
  const r = win
    ? await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $($_.Name)" }',
      ])
    : await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss=', '-o', 'comm='])
  if (r.error || r.code !== 0) return null
  return asMemoryTable(r.stdout, win ? 1 : 1024)
}

/**
 * The table's lines, `<pid> <ppid> <memory> <name>` each, the memory in `unit` bytes (PowerShell's
 * working set in bytes, `ps`'s resident size in KiB); null when none reads.
 */
export function asMemoryTable(text: string, unit: number): MemRow[] | null {
  const rows: MemRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m)
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), bytes: Number(m[3]) * unit, name: programName(m[4] ?? '') })
  }
  return rows.length ? rows : null
}

/** Whether `root` is a shell with nothing started under it (Windows' console host aside); null when the table has no `root`. */
export function bareShell(table: readonly MemRow[], root: number): boolean | null {
  const own = table.find(r => r.pid === root)
  if (!own) return null
  return SHELLS.has(own.name) && !table.some(r => r.ppid === root && r.pid !== root && !CONSOLE_HOSTS.has(r.name))
}

/** The memory of `root` and every process under it, by the table; null when the table has no `root`. */
export function treeBytes(table: readonly MemRow[], root: number): number | null {
  const own = table.find(r => r.pid === root)
  if (!own) return null
  let bytes = 0
  const seen = new Set<number>()
  for (const queue = [root]; queue.length; ) {
    const pid = queue.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const r of table) {
      if (r.pid === pid) bytes += r.bytes
      else if (r.ppid === pid) queue.push(r.pid)
    }
  }
  return bytes
}

/** `fn` for each item, at most `n` at once, the answers in the items' order. */
async function pooled<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

/** What herdr's panes hold; null when herdr does not answer. `wakeOn`: the board's wake runs and keeps the sleepers. */
export async function paneFacts(wakeOn: boolean): Promise<PaneFacts | null> {
  const snap = await snapshot().catch(() => null)
  if (!snap) return null
  const [infos, table] = await Promise.all([
    pooled(snap.panes, AT_ONCE, p => paneProcesses(p.pane_id).catch(() => null)),
    memoryTable().catch(() => null),
  ])
  const held = new Map<string, PaneHeld>()
  snap.panes.forEach((p, i) => {
    const info = infos[i]
    // herdr's foreground list does not show a program the shell started on Windows: the table does.
    held.set(p.pane_id, {
      bare: info && table ? bareShell(table, info.shell) : null,
      bytes: info && table ? treeBytes(table, info.shell) : null,
    })
  })
  let sleepers: Set<string> | null = null
  if (wakeOn) {
    sleepers = new Set()
    for (const [pane, s] of Object.entries(peekWakeSessions())) if (s.slept_at && !s.freed) sleepers.add(pane)
    for (const s of Object.values(peekPiSleepers())) sleepers.add(s.pane)
  }
  return { panes: snap.panes, held, sleepers }
}
