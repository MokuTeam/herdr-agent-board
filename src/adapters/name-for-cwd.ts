// A pane's name from a script of the user's own (#307): `~/.local/bin/herdr-name-for-cwd <cwd>`,
// or the path in env BOARD_NAME_FOR_CWD, prints the herdr name a pane in that folder goes by. One
// setup has it; the board asks it only after a restart, which leaves the pane without its name.
// No script: nothing runs, the same as without this file.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How long the script has to print the name. */
const SCRIPT_MS = 5000

/** The script's path, or null when there is none. */
export function nameScript(): string | null {
  const path = process.env.BOARD_NAME_FOR_CWD || join(homedir(), '.local', 'bin', 'herdr-name-for-cwd')
  return existsSync(path) ? path : null
}

/**
 * The name the script prints for `cwd`: its first line that is not blank, trimmed, without control
 * characters. '' when it prints nothing, exits with an error, or takes longer than SCRIPT_MS (a
 * child of its own that keeps the output open does not hold the restart either).
 */
export async function nameForCwd(script: string, cwd: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const child = Bun.spawn([script, cwd], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const late = new Promise<null>(resolve => {
      timer = setTimeout(() => {
        child.kill()
        resolve(null)
      }, SCRIPT_MS)
    })
    const done = Promise.all([new Response(child.stdout).text(), child.exited])
    const r = await Promise.race([done, late])
    if (r === null || r[1] !== 0) return ''
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips
    return (r[0].split(/\r?\n/).find(l => l.trim()) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}
