// claude-tg (#119): Claude Code with this herdr tab's Telegram topic in TG_KEY, the routing key
// tg-mcp takes in its X-Cwd header, as herdr-wake's launchers had it, but without Node: the key
// comes from `board tg-key` (core/wake/topics.ts keyFor), else the folder. A sh script for Git
// Bash, Linux and macOS and a .cmd for PowerShell and cmd, both on PATH in ~/.local/bin:
//   claude-tg --dangerously-skip-permissions        claude-tg --resume <session id>
// Their first comment line marks them ours: herdr-wake's ("herdr-wake: ") and the board's
// ("agent-board: ") are replaced, anything else never. Pure: adapters/launchers.ts writes them.

/** The first comment line of a launcher of ours, herdr-wake's or the board's. */
export const LAUNCHER_MARK = /^(#|rem|\/\/) (herdr-wake|agent-board): /m

export type LauncherName = 'claude-tg' | 'claude-tg.cmd'
export const LAUNCHER_NAMES: readonly LauncherName[] = ['claude-tg', 'claude-tg.cmd']

const ABOUT = "claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)"

/** 'claude-tg' (sh) and 'claude-tg.cmd': the key from `board tg-key`, else the folder; first comment line `agent-board: claude-tg, …`. */
export function launcherFiles(): Record<LauncherName, string> {
  return {
    // The key is worked out by the board, then the shell is replaced by Claude.
    'claude-tg': [
      '#!/bin/sh',
      `# agent-board: ${ABOUT}`,
      'TG_KEY="$(board tg-key 2>/dev/null)"',
      '[ -n "$TG_KEY" ] || TG_KEY="$(pwd)"',
      'export TG_KEY',
      'exec claude "$@"',
      '',
    ].join('\n'),
    // No path in it, which cmd.exe would read in the console's code page; no delayed expansion,
    // so a ! in a key stays. CRLF.
    'claude-tg.cmd': [
      '@echo off',
      `rem agent-board: ${ABOUT}`,
      'setlocal DisableDelayedExpansion',
      'set "TG_KEY="',
      'for /f "usebackq delims=" %%k in (`board tg-key 2^>nul`) do set "TG_KEY=%%k"',
      'if not defined TG_KEY set "TG_KEY=%CD%"',
      'claude %*',
      '',
    ].join('\r\n'),
  }
}

/**
 * Which launchers to write, from what is there now (null: no file). `foreign`: a file without our
 * mark, never written. A refresh (`onlyWhereThere`, the install) writes only over a launcher of
 * ours already there; an Install (the panel) writes both, or none at all while one is someone
 * else's. Either way only those that differ from the board's.
 */
export function launcherPlan(
  there: Record<LauncherName, string | null>,
  o: { onlyWhereThere: boolean },
): { write: LauncherName[]; foreign: LauncherName[] } {
  const files = launcherFiles()
  const foreign = LAUNCHER_NAMES.filter(name => {
    const text = there[name]
    return text !== null && !LAUNCHER_MARK.test(text)
  })
  if (!o.onlyWhereThere && foreign.length) return { write: [], foreign }
  const write = LAUNCHER_NAMES.filter(name => {
    const text = there[name]
    if (foreign.includes(name) || (o.onlyWhereThere && text === null)) return false
    return text !== files[name]
  })
  return { write, foreign }
}
