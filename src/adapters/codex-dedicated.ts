// A CODEX_HOME of its own for the Codex sessions herdr runs (install.ts --codex-home). The global
// ~/.codex belongs to Codex Desktop too, so the board's hooks go in this folder only. What Codex
// must share with the global one is linked, never copied: a copy of auth.json lets two rotating
// refresh tokens drift apart, and a copy of config.toml loses later edits. Codex writes through a
// link (config.toml, checked with codex 0.169 features enable), so its trust entries land in the
// shared file. Hooks, sessions and the rest stay the dedicated folder's own.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the dedicated folder goes when --codex-home names none. */
export const defaultCodexHome = (home = homedir()): string => join(home, '.config', 'herdr', 'codex')

const SHARED = ['auth.json', 'config.toml', 'AGENTS.md'] as const
// Folders that stay real so the board can add its own files: one link per entry of the global one.
const FOLDERS = ['skills', 'rules'] as const

// Codex's sandbox (workspace-write) cannot reach herdr's socket or the board's state folder, so
// `board` and `spawn-agent` fail there with EPERM. A rule that allows them runs them outside the
// sandbox without a prompt; it is a file of its own, so the user's default.rules is not touched.
export const RULES_FILE = 'agent-board.rules'
const RULES = `# agent-board: board and spawn-agent need herdr's socket and the board's state, outside the sandbox.
prefix_rule(pattern=["board"], decision="allow")
prefix_rule(pattern=["spawn-agent"], decision="allow")
`
// Only for a master (install.ts --codex-master): it messages and reads the sessions it coordinates.
// Nothing else of herdr: send-keys, pane and tab commands stay behind Codex's own approval.
const MASTER_RULES = `# agent-board --codex-master: a master messages and reads other sessions.
prefix_rule(pattern=["herdr", "agent", ["prompt", "read", "list", "get"]], decision="allow")
`

const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * `dir` made ready: the shared files and folders of `source` linked in where `dir` has none, and
 * `skills/` and `rules/` real folders with a link per entry of `source`'s (the board's own skills
 * and its rules are written there as files; `master`: with the master's too). Returns what was linked and what could not be (no right to link, as on Windows
 * without developer mode); nothing there is replaced.
 */
export function prepareCodexHome(
  dir: string,
  source: string,
  { master = false }: { master?: boolean } = {},
): { linked: string[]; failed: string[] } {
  if (join(dir) === join(source)) throw new Error('the dedicated Codex home is the global one')
  for (const folder of FOLDERS) mkdirSync(join(dir, folder), { recursive: true })
  const linked: string[] = []
  const failed: string[] = []
  const link = (from: string, to: string, name: string): void => {
    if (!existsSync(from) || present(to)) return
    try {
      symlinkSync(from, to)
      linked.push(name)
    } catch {
      failed.push(name)
    }
  }
  for (const name of SHARED) link(join(source, name), join(dir, name), name)
  for (const folder of FOLDERS)
    try {
      for (const entry of readdirSync(join(source, folder)))
        link(join(source, folder, entry), join(dir, folder, entry), join(folder, entry))
    } catch {} // None there, or none readable: the dedicated folder has the board's own.
  const rules = join(dir, 'rules', RULES_FILE)
  let had: string | null = null
  try {
    had = readFileSync(rules, 'utf8')
  } catch {}
  const wanted = master ? RULES + MASTER_RULES : RULES
  if (had !== wanted) writeFileSync(rules, wanted)
  return { linked, failed }
}
