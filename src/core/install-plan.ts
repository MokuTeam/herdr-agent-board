// What the install action writes, worked out without touching a file: the SessionStart /
// UserPromptSubmit hooks and the status line in Claude Code's settings.json, and the `board`
// shims for ~/.local/bin. The entrypoint (entrypoints/install.ts) reads, backs up and writes.

export interface InstallPaths {
  bun: string
  hook: string
  statusline: string
  cli: string
  binDir: string
}

type Settings = Record<string, unknown>

// Ours, from any version: main wrote `node "…agent-board…\src\hook.mjs"` (this branch, until the
// entrypoints moved, `bun "…"`); now `"<bun>" "…agent-board…/src/entrypoints/hook.ts"`. The file
// name comes right after a separator, so `…/prehook.mjs` is someone else's.
const OUR_HOOK = /agent-board.*[\\/](hook\.mjs|entrypoints[\\/]hook\.ts)/
const OUR_STATUS_LINE = /agent-board.*[\\/](statusline\.mjs|entrypoints[\\/]statusline\.ts)/
const EVENTS = ['SessionStart', 'UserPromptSubmit'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const commandOf = (v: unknown): string => (isRecord(v) && typeof v.command === 'string' ? v.command : '')

/** A path in double quotes, with forward slashes: one word for sh (Git Bash too) and for Claude Code. */
export const quote = (path: string): string => `"${path.replace(/\\/g, '/')}"`

/** Whether a hook or status line command is one an install of the board wrote. */
export function isOurCommand(command: string): boolean {
  return OUR_HOOK.test(command) || OUR_STATUS_LINE.test(command)
}

const bunCommand = (bun: string, script: string): string => `${quote(bun)} ${quote(script)}`

/**
 * The event's hook list without our earlier hooks, then ours. An entry left with no hooks goes
 * (as main did); anything not shaped like a hook entry is someone else's and stays.
 */
function withOurHook(list: unknown, command: string, replaced: string[]): unknown[] {
  const entries = list ?? []
  if (!Array.isArray(entries)) throw new Error('settings.json: a hook event is not a list; left as it was')
  const kept: unknown[] = []
  for (const entry of entries) {
    const hooks: unknown = isRecord(entry) ? (entry.hooks ?? []) : undefined
    if (!isRecord(entry) || !Array.isArray(hooks)) {
      kept.push(entry)
      continue
    }
    const left = hooks.filter((hook: unknown) => {
      const ours = OUR_HOOK.test(commandOf(hook))
      if (ours) replaced.push(commandOf(hook))
      return !ours
    })
    if (left.length) kept.push({ ...entry, hooks: left })
  }
  kept.push({ hooks: [{ type: 'command', command, timeout: 10 }] })
  return kept
}

/** What install writes into settings.json; `statusLineSet`: the status line is ours now. */
export interface SettingsPlan {
  settings: Settings
  replaced: string[]
  statusLineSet: boolean
}

/**
 * settings.json (parsed; undefined when there is none) with our hooks and status line in place
 * of any earlier ones of ours. A status line someone else set stays. `replaced` lists the
 * commands of ours that went. The input is not changed.
 */
export function planSettings(settings: unknown, paths: InstallPaths): SettingsPlan {
  if (settings !== undefined && !isRecord(settings))
    throw new Error('settings.json is not a JSON object; left as it was')
  const next: Settings = structuredClone(settings ?? {})
  const hooks = next.hooks ?? {}
  if (!isRecord(hooks)) throw new Error('settings.json: "hooks" is not an object; left as it was')
  next.hooks = hooks
  const replaced: string[] = []
  for (const event of EVENTS) hooks[event] = withOurHook(hooks[event], bunCommand(paths.bun, paths.hook), replaced)
  // Claude Code's own numbers for the board (usage windows, context fill). A status line someone
  // else set stays; the board then reads the usagebar cache, if there is one.
  const line = commandOf(next.statusLine)
  const statusLineSet = !next.statusLine || OUR_STATUS_LINE.test(line)
  if (statusLineSet) {
    if (next.statusLine) replaced.push(line)
    next.statusLine = { type: 'command', command: bunCommand(paths.bun, paths.statusline) }
  }
  return { settings: next, replaced, statusLineSet }
}

/**
 * The .cmd shim. cmd.exe reads a batch file in the console's code page (866, 437, ...), so a path
 * that is not ASCII (a Windows user name in Cyrillic, under which Bun itself lives) only resolves
 * under UTF-8: the script switches to 65001 around the call, then puts the code page back and
 * passes Bun's exit code on. Written as UTF-8 without a BOM, with CRLF line ends.
 */
const cmdShim = (bun: string, cli: string): string =>
  [
    '@rem agent-board',
    '@setlocal',
    `@for /f "tokens=2 delims=:." %%c in ('chcp') do @set "AB_CP=%%c"`,
    '@chcp 65001 >nul',
    `@"${bun}" "${cli}" %*`,
    '@set "AB_RC=%errorlevel%"',
    '@chcp %AB_CP% >nul',
    '@exit /b %AB_RC%',
    '',
  ].join('\r\n')

/** The `board` command for ~/.local/bin: a sh script for Git Bash, macOS and Linux, a .cmd for PowerShell and cmd. */
export function planShims(paths: InstallPaths): { board: string; 'board.cmd': string } {
  return {
    board: `#!/bin/sh\n# agent-board\nexec ${bunCommand(paths.bun, paths.cli)} "$@"\n`,
    'board.cmd': cmdShim(paths.bun, paths.cli),
  }
}
