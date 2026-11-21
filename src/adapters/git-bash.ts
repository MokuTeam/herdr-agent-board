// Git Bash's argument conversion, for the commands whose sh shim turns it off (core/install-plan.ts
// GIT_BASH_PATHS, #490, #532): they get their arguments as typed and convert their own folder and
// file options here, with Git's cygpath, as Git Bash would have.
import { drivePath } from '../core/launch/spawn-args.ts'

/**
 * Whether the sh shim started this command under Git Bash with the conversion off. Takes both of
 * its variables out of process.env, so a child started with node:child_process or with
 * `env: process.env` does not inherit them. Bun.spawn without an env of its own still passes the
 * environment Bun started with (Bun 1.4.3), so a child of these commands started that way passes
 * `env: process.env`. Call it once, before anything is started.
 */
export function takeGitBashArgs(): boolean {
  const on = process.env.AGENT_BOARD_PATHCONV === '1'
  if (on) {
    delete process.env.AGENT_BOARD_PATHCONV
    delete process.env.MSYS2_ARG_CONV_EXCL
  }
  return on
}

/** Git Bash's Windows form of these paths (cygpath -m); without cygpath, at least its drive paths. */
export function cygpath(paths: string[]): string[] {
  try {
    const r = Bun.spawnSync(['cygpath', '-m', '--', ...paths], { stderr: 'ignore' })
    const out = r.stdout.toString().split(/\r?\n/).slice(0, paths.length)
    if (r.exitCode === 0 && out.length === paths.length) return out
  } catch {}
  return paths.map(drivePath)
}
