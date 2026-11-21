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
  if (child.pid) killTreePid(child.pid)
  else child.kill('SIGKILL')
}

const killPid = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

/**
 * End a program and everything it started, by its pid: also one this process did not start (the
 * ssh a killed board left). Windows: taskkill /T, the program alone if that fails. POSIX: its
 * process group, else the program alone.
 */
export function killTreePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    // By its full path: the board's PATH need not have System32 on it.
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    execFile(taskkill, ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, err => err && killPid(pid))
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      killPid(pid)
    }
  }
}

/**
 * Run a program in this terminal, in the foreground, no shell: its input and output are this
 * process's, and a Ctrl+C that reaches this process too leaves it waiting for the program. In
 * `cwd` when given, else in this process's folder; one it does not start in (the folder gone since
 * it was looked at, or not to be entered) is tried once more in this process's folder, as without
 * `cwd`. What the program exited with (1 when a signal ended it), or the error that kept it from
 * starting. A .cmd Bun would refuse an argument to runs through cmd.exe (throughCmd, Windows).
 */
export function runHere(
  file: string,
  args: string[],
  env?: Record<string, string | undefined>,
  cwd?: string,
): Promise<{ code: number; error: (Error & { code?: unknown }) | null }> {
  return new Promise(res => {
    const wait = (): void => {}
    process.on('SIGINT', wait)
    const start = (dir?: string): void => {
      let over = false
      const done = (code: number, error: (Error & { code?: unknown }) | null = null, unstarted = false): void => {
        if (over) return
        over = true
        if (unstarted && dir) {
          start()
          return
        }
        process.off('SIGINT', wait)
        res({ code, error })
      }
      try {
        const cmd = throughCmd(file, args, env)
        const child = cmd
          ? spawn(cmd.file, cmd.args, {
              stdio: 'inherit',
              windowsVerbatimArguments: true,
              ...(env ? { env } : {}),
              ...(dir ? { cwd: dir } : {}),
            })
          : spawn(file, args, { stdio: 'inherit', ...(env ? { env } : {}), ...(dir ? { cwd: dir } : {}) })
        child.on('error', err => done(127, err, child.pid === undefined))
        child.on('exit', code => done(code ?? 1))
      } catch (err) {
        done(127, err as Error, true)
      }
    }
    start(cwd)
  })
}

// What Bun will not pass to a .bat or .cmd file on Windows (Bun 1.4: these, no other printable
// ASCII), so `board resume --pi` did not start npm's pi.cmd on a session file under a folder with a
// % in its name (#491).
const CMD_REFUSED = /[%"&|<>^]/
// cmd.exe's special characters, each escaped with ^ where it stands.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * One argument on the line cmd.exe runs a .cmd with: quoted as a program reads its command line,
 * then every cmd.exe special character (the quotes too, so cmd never counts one) escaped twice,
 * once for cmd /c and once for the line in the .cmd that hands %* on, as npm's shims and pi.cmd
 * do. A .bat that reads %1 itself would keep one level of carets.
 */
export function cmdArg(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

/** What `cmd.exe /d /s /c` is given to run the .cmd or .bat `file` with `args`, as they are. */
export function cmdLine(file: string, args: readonly string[]): string {
  return `"${[file.replace(CMD_META, '^$1'), ...args.map(cmdArg)].join(' ')}"`
}

const envValue = (env: Record<string, string | undefined>, name: string): string | undefined =>
  Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1]

/**
 * How runHere starts `file` when Bun would refuse it an argument: on Windows, a program that is a
 * .cmd or .bat on the PATH, given an argument with a character Bun does not pass to one, runs
 * through cmd.exe with the arguments escaped for it (#491). Null, the program started as given,
 * everywhere else.
 */
function throughCmd(
  file: string,
  args: string[],
  env: Record<string, string | undefined> | undefined,
): { file: string; args: string[] } | null {
  if (process.platform !== 'win32' || !args.some(a => CMD_REFUSED.test(a))) return null
  // cmd.exe would end the line at a line break and drop the rest: Bun refuses it, as before.
  if (args.some(a => /[\r\n\0]/.test(a))) return null
  const e = env ?? process.env
  const found = Bun.which(file, { PATH: envValue(e, 'PATH') ?? '' })
  if (!found || !/\.(cmd|bat)$/i.test(found)) return null
  const cmd = envValue(e, 'COMSPEC') || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  return { file: cmd, args: ['/d', '/s', '/c', cmdLine(found, args)] }
}

/** Whether a process with this id runs; one this process may not signal (EPERM) runs too. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
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
