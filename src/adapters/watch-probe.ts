// A watch's probe run (#486, core/watches.ts): the command in a shell, in the session's folder, in
// the board's own environment, with its timeout ending the whole process tree (process.ts runTree,
// which also keeps the window hidden on Windows: no console flashes for a run).
//
// The shell: `/bin/sh -c` on macOS and Linux. On Windows Git Bash's bash.exe `-c`, the shell Claude
// Code's Bash tool runs, so a probe an agent tried there runs the same: CLAUDE_CODE_GIT_BASH_PATH
// when it names one, else Git's usual folders, else the one beside git.exe on PATH. Never
// System32's bash.exe (WSL's): a probe would run in another system. No Git Bash: no probe.
import { existsSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import type { ProbeRun } from '../core/watches.ts'
import { type RunResult, runTree } from './process.ts'

type Env = Record<string, string | undefined>

export interface ProbeShellOpts {
  env?: Env
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  which?: (name: string) => string | null
}

/** The shell a probe runs in: its file, or why there is none. */
export function probeShell(o: ProbeShellOpts = {}): { file: string } | { error: string } {
  const { env = process.env, platform = process.platform, exists = existsSync } = o
  if (platform !== 'win32') return exists('/bin/sh') ? { file: '/bin/sh' } : { error: 'no /bin/sh on this computer' }
  const which = o.which ?? ((name: string) => Bun.which(name, { PATH: env.PATH ?? env.Path ?? '' }))
  const system = (env.SystemRoot || env.windir || 'C:\\Windows').toLowerCase()
  const git = which('git')
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    // git.exe in Git\cmd, Git\bin or Git\mingw64\bin: bash.exe is in Git\bin.
    git && win32.join(win32.dirname(git), '..', 'bin', 'bash.exe'),
    git && win32.join(win32.dirname(git), '..', '..', 'bin', 'bash.exe'),
  ]
  for (const c of candidates) {
    if (!c) continue
    const file = win32.normalize(c)
    if (file.toLowerCase().startsWith(system)) continue
    if (exists(file)) return { file }
  }
  return {
    error: 'no Git Bash found (probes run in Git Bash on Windows; CLAUDE_CODE_GIT_BASH_PATH can name its bash.exe)',
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * One run of `cmd` in `cwd`, ended after `timeoutMs`. Its input is closed at once, so a command
 * that asks for something does not wait out the timeout. `id` goes into its environment as
 * BOARD_WATCH_ID.
 */
export async function runProbe(cmd: string, cwd: string | undefined, timeoutMs: number, id = ''): Promise<ProbeRun> {
  const shell = probeShell()
  if ('error' in shell) return { code: 'ENOSHELL', killed: false, stdout: '', stderr: '', error: shell.error }
  if (!cwd || !isDir(cwd))
    return {
      code: 'ENOENT',
      killed: false,
      stdout: '',
      stderr: '',
      error: cwd ? `the folder ${cwd} is not there` : 'the session has no folder',
    }
  const r = await runTree(shell.file, ['-c', cmd], {
    cwd,
    timeout: timeoutMs,
    input: '',
    env: { ...process.env, BOARD_WATCH_ID: id },
  })
  return probeRunOf(r)
}

/**
 * A run as a probe's: one a signal ended (an OOM kill, a crash), or that failed to start, is an
 * error in words, never the exit 1 that runTree reads for it ("nothing yet"). The timeout's own end
 * stays `killed`.
 */
export function probeRunOf(r: RunResult): ProbeRun {
  const run = { code: r.code, killed: r.killed, stdout: r.stdout, stderr: r.stderr }
  if (r.killed) return run
  if (r.signal) return { ...run, error: `ended by ${r.signal}` }
  if (r.error) return { ...run, error: `could not start (${String(r.error.code ?? r.error.message)})` }
  return run
}
