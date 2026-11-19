// Codex's TUI, started with no config override, joins the shared background server (the app-server
// daemon): the session runs in that process, with its env, not the pane's. herdr's hook then finds
// no HERDR_PANE_ID (the pane never learns the session's id), the board's hooks and `board` in the
// agent's tools do not know the pane, and CODEX_HOME of the tab is ignored. `--no-daemon` runs the
// session in the TUI's own process, with the pane's env (any `-c` override does the same).
import { runTree } from './process.ts'

const found = new Map<string, Promise<boolean>>()

/**
 * The option to start Codex with so the pane's env reaches the session: `['--no-daemon']` when the
 * program takes it (its `--help` lists it) and the line has it not already, else none: a Codex that
 * does not know the option would refuse to start. Asked once per program in a process.
 */
export async function noDaemonArgs(program: readonly string[]): Promise<string[]> {
  if (program.includes('--no-daemon')) return []
  const key = JSON.stringify(program)
  let takes = found.get(key)
  if (!takes) {
    const [exe, ...rest] = program
    takes = runTree(String(exe), [...rest, '--help'], { timeout: 10_000, env: { ...process.env } })
      .then(r => r.code === 0 && /--no-daemon\b/.test(r.stdout))
      .catch(() => false)
    found.set(key, takes)
  }
  return (await takes) ? ['--no-daemon'] : []
}
