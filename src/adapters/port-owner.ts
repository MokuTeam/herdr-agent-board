// Which process listens on a port of this computer, from the system (#356): netstat and
// PowerShell's Win32_Process on Windows, lsof (or ss) and ps on macOS and Linux. Asked
// only by `board doctor` and by the board command when the board's port answered something that is
// not this install's board; core/board-port.ts reads the answer. BOARD_POWERSHELL_BIN_PATH names
// another PowerShell (tests).
import { readFileSync, readlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { win32 } from 'node:path'
import type { PortOwner, ServerSays } from '../core/board-port.ts'
import { isRecord } from './json-store.ts'
import { boardFile } from './paths.ts'
import { run } from './process.ts'

const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/** Whether anything accepts a TCP connection on 127.0.0.1:`port` (no process is asked). */
export function listening(port: number, ms = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect({ host: '127.0.0.1', port })
    const done = (v: boolean) => {
      clearTimeout(timer)
      s.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done(false), ms)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

async function getJson(port: number, path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) })
    const body: unknown = await res.json()
    return isRecord(body) && body.board === 'agent-board' ? body : null
  } catch {
    return null
  }
}

/** What the server on the port says of itself: /api/hello's version and /api/process's folder. */
export async function serverSays(port: number): Promise<ServerSays> {
  const [hello, proc] = await Promise.all([getJson(port, '/api/hello'), getJson(port, '/api/process')])
  return {
    version: hello ? String(hello.version ?? '') : null,
    root: proc && typeof proc.root === 'string' ? proc.root : null,
  }
}

/** The pid board.json names: the terminal board this install ran last. */
export function savedBoardPid(): number | null {
  try {
    const v: unknown = JSON.parse(readFileSync(boardFile(), 'utf8'))
    return isRecord(v) && isPid(v.pid) ? v.pid : null
  } catch {
    return null
  }
}

/** The pid that listens on `port` in `netstat -ano -p TCP`'s table: a line whose local address ends in the port and whose foreign one is a wildcard (the state word is in the system's language, so it is not read). */
export function listenerIn(netstat: string, port: number): number | null {
  for (const line of netstat.split(/\r?\n/)) {
    const [proto, local, foreign, ...more] = line.trim().split(/\s+/)
    if (proto !== 'TCP' || !local?.endsWith(`:${port}`) || !/^(?:0\.0\.0\.0|\[::\]):0$/.test(foreign ?? '')) continue
    const pid = Number(more.at(-1))
    if (isPid(pid)) return pid
  }
  return null
}

const WINDOWS_INFO = (pid: number): string =>
  [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    'if ($p) {',
    "  $s = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { $null }",
    '  [pscustomobject]@{ command = $p.CommandLine; started = $s } | ConvertTo-Json -Compress',
    '}',
  ].join('\n')

/** `[[dd-]hh:]mm:ss`, as ps prints a process's elapsed time, in ms. */
export function elapsedMs(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!m) return null
  const [, d = '0', h = '0', min = '0', s = '0'] = m
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000
}

/** A program of Windows' own, by its full path: the board command may run with a PATH that lacks System32. */
const system32 = (...parts: string[]): string =>
  win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts)

async function windowsPid(port: number): Promise<number | null> {
  const r = await run(system32('NETSTAT.EXE'), ['-ano', '-p', 'TCP'], { timeout: 10_000 })
  return listenerIn(r.stdout, port)
}

async function windowsInfo(pid: number): Promise<Omit<PortOwner, 'pid'>> {
  const ps = process.env.BOARD_POWERSHELL_BIN_PATH || system32('WindowsPowerShell', 'v1.0', 'powershell.exe')
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_INFO(pid)], { timeout: 15_000 })
  try {
    const v: unknown = JSON.parse(r.stdout.trim())
    if (!isRecord(v)) throw new Error('no process')
    const started = typeof v.started === 'string' ? Date.parse(v.started) : Number.NaN
    return {
      command: typeof v.command === 'string' ? v.command : null,
      cwd: null,
      startedAt: Number.isFinite(started) ? started : null,
    }
  } catch {
    return { command: null, cwd: null, startedAt: null }
  }
}

async function unixPid(port: number): Promise<number | null> {
  const l = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 5000 })
  const fromLsof = Number(l.stdout.trim().split(/\s+/)[0])
  if (isPid(fromLsof)) return fromLsof
  const s = await run('ss', ['-Hltnp', `sport = :${port}`], { timeout: 5000 })
  const fromSs = Number(/pid=(\d+)/.exec(s.stdout)?.[1])
  return isPid(fromSs) ? fromSs : null
}

async function unixCwd(pid: number): Promise<string | null> {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {}
  const r = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000 })
  const line = r.stdout.split('\n').find(l => l.startsWith('n'))
  return line ? line.slice(1) : null
}

async function unixInfo(pid: number): Promise<Omit<PortOwner, 'pid'>> {
  const ps = await run('ps', ['-o', 'etime=', '-o', 'command=', '-p', String(pid)], { timeout: 5000 })
  const m = /^\s*(\S+)\s+(.*)$/.exec(ps.stdout.split('\n')[0] ?? '')
  const ms = m ? elapsedMs(m[1] as string) : null
  return {
    command: m ? (m[2] as string).trim() : null,
    cwd: await unixCwd(pid),
    startedAt: ms === null ? null : Date.now() - ms,
  }
}

/**
 * The process listening on `port` (any address), or null when none is, or the system does not say.
 * Its command line, folder and start are asked only when `known` does not already vouch for the
 * pid (board.json's): on Windows that is the slow part, PowerShell.
 */
export async function portOwner(
  port: number,
  known: (pid: number) => boolean = () => false,
  platform = process.platform,
): Promise<PortOwner | null> {
  const pid = platform === 'win32' ? await windowsPid(port) : await unixPid(port)
  if (pid === null) return null
  if (known(pid)) return { pid, command: null, cwd: null, startedAt: null }
  return { pid, ...(platform === 'win32' ? await windowsInfo(pid) : await unixInfo(pid)) }
}
