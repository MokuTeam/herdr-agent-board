// Running other programs: no shell, and a way to end a program together with everything it started.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * How a program ended. `killed`: the timeout ended it. `error`: it could not start (ENOENT) or
 * failed; `code` is then the error's code (number or a string like 'ENOENT').
 */
export interface RunResult {
  code: number | string
  killed: boolean
  error: (Error & { code?: number | string }) | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  timeout?: number
  env?: Record<string, string | undefined>
  cwd?: string
  /** runTree: written to the program's stdin, which is then closed. */
  input?: string
  /** runTree: ends the program and everything it started, as the timeout does. */
  signal?: AbortSignal | undefined
}

const OUTPUT_LIMIT = 4 << 20

/**
 * Run a launcher: like `run`, but a timeout ends the whole process tree (on Windows a kill
 * reaches only the direct child, and a script's descendants would go on and open a tab after
 * "timed out"). It settles when the launcher exits, not when every pipe closed, so a descendant
 * that kept stdout open cannot hold the launch at "starting".
 */
export function runTree(
  file: string,
  args: string[],
  { timeout, env, cwd, input, signal }: RunOptions = {},
): Promise<RunResult> {
  return new Promise(res => {
    let stdout = ''
    let stderr = ''
    let killed = false
    let error: RunResult['error'] = null
    let settled = false
    let child: ChildProcess
    try {
      child = spawn(file, args, {
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      const e = err as NonNullable<RunResult['error']>
      return res({ code: e.code ?? 1, killed, error: e, stdout, stderr })
    }
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += d
    })
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += d
    })
    let code = 0
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', end)
      res({ code: error ? (error.code ?? 1) : code, killed, error, stdout, stderr })
    }
    const end = (): void => {
      if (killed || settled) return
      killed = true
      killTree(child)
      // Whatever the kill managed, the card does not wait for it long.
      setTimeout(finish, 5000).unref?.()
    }
    const timer = setTimeout(end, timeout)
    if (signal?.aborted) end()
    else signal?.addEventListener('abort', end, { once: true })
    if (input !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
    child.on('error', err => {
      error = err
      finish()
    })
    child.on('exit', (c, signal) => {
      code = c ?? (signal ? 1 : 0)
      clearTimeout(timer)
      // What it printed last may still be on its way; the pipes may also stay open for good.
      setTimeout(finish, 300)
    })
    child.on('close', finish)
  })
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    // By its full path: the board's PATH need not have System32 on it.
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    execFile(taskkill, ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, err => err && child.kill())
  } else {
    try {
      process.kill(-(child.pid as number), 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/** Run a program to its end (no tree kill) with a 15 s default timeout. */
export function run(file: string, args: string[], { timeout = 15_000, env, cwd }: RunOptions = {}): Promise<RunResult> {
  return new Promise(res => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        maxBuffer: OUTPUT_LIMIT,
        ...(env ? { env } : {}),
        ...(cwd ? { cwd } : {}),
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
        res({ code: e ? (e.code ?? 1) : 0, killed: !!e?.killed, error: e, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}
