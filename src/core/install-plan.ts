// What the install action writes, worked out without touching a file: the SessionStart /
// UserPromptSubmit hooks, the status line and (on request) the desktop notification hooks in
// Claude Code's settings.json, and the `board` and `spawn-agent` shims for ~/.local/bin. The
// entrypoint (entrypoints/install.ts) reads, backs up and writes; core/setup.ts checks the result.

export interface InstallPaths {
  bun: string
  hook: string
  statusline: string
  cli: string
  /** spawn-agent's entrypoint. */
  spawn: string
  /** The notification script (integrations/toast.ps1). */
  toast: string
  binDir: string
}

type Settings = Record<string, unknown>

// Ours, from any version: main wrote `node "…agent-board…\src\hook.mjs"` (this branch, until the
// entrypoints moved, `bun "…"`); now `"<bun>" "…agent-board…/src/entrypoints/hook.ts"`. The file
// name comes right after a separator, so `…/prehook.mjs` is someone else's.
const OUR_HOOK = /agent-board.*[\\/](hook\.mjs|entrypoints[\\/]hook\.ts)/
const OUR_STATUS_LINE = /agent-board.*[\\/](statusline\.mjs|entrypoints[\\/]statusline\.ts)/
const OUR_TOAST = /agent-board.*[\\/]toast\.ps1/
export const BOARD_EVENTS = ['SessionStart', 'UserPromptSubmit'] as const
/** The notification hooks: the event and its matcher. */
export const TOAST_EVENTS = [
  ['Stop', null],
  ['Notification', 'permission_prompt|elicitation_dialog'],
  ['PreToolUse', 'AskUserQuestion'],
] as const

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const commandOf = (v: unknown): string => (isRecord(v) && typeof v.command === 'string' ? v.command : '')

/** A path in double quotes, with forward slashes: one word for sh (Git Bash too) and for Claude Code. */
export const quote = (path: string): string => `"${path.replace(/\\/g, '/')}"`

/** Whether a hook or status line command is one an install of the board wrote. */
export function isOurCommand(command: string): boolean {
  return OUR_HOOK.test(command) || OUR_STATUS_LINE.test(command)
}

/** A path for comparing: forward slashes, no trailing one, lower case. */
export const normPath = (p: unknown): string =>
  String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()

export type CommandTest = (command: string) => boolean

/**
 * Which hook commands are the board's: by the file they run, in a folder named like the board
 * or this copy's own.
 */
export function ourCommands(files: Pick<InstallPaths, 'hook' | 'statusline' | 'toast'>): {
  hook: CommandTest
  line: CommandTest
  toast: CommandTest
} {
  const runs =
    (file: string, re: RegExp): CommandTest =>
    command =>
      re.test(command) || (!!file && normPath(command).includes(normPath(file)))
  return {
    hook: runs(files.hook, OUR_HOOK),
    line: runs(files.statusline, OUR_STATUS_LINE),
    toast: runs(files.toast, OUR_TOAST),
  }
}

/** The notification hook's command: Windows PowerShell runs the script. */
export const toastCommand = (file: string): string => `powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`

/** Every hook command of an event, with its entry's matcher. */
export function commandsOf(settings: unknown, event: string): { command: string; matcher: unknown }[] {
  const hooks = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks : {}
  const list = hooks[event]
  return (Array.isArray(list) ? list : []).flatMap((entry: unknown) =>
    isRecord(entry) && Array.isArray(entry.hooks)
      ? entry.hooks.map((h: unknown) => ({ command: commandOf(h), matcher: entry.matcher ?? null }))
      : [],
  )
}

const bunCommand = (bun: string, script: string): string => `${quote(bun)} ${quote(script)}`

/**
 * The event's hook list without our earlier hooks (`isOurs`), then `entry` when there is one. An
 * entry left with no hooks goes (as main did); anything not shaped like a hook entry is someone
 * else's and stays.
 */
function withOurHook(list: unknown, entry: unknown, isOurs: CommandTest, replaced: string[]): unknown[] {
  const entries = list ?? []
  if (!Array.isArray(entries)) throw new Error('settings.json: a hook event is not a list; left as it was')
  const kept: unknown[] = []
  for (const e of entries) {
    const hooks: unknown = isRecord(e) ? (e.hooks ?? []) : undefined
    if (!isRecord(e) || !Array.isArray(hooks)) {
      kept.push(e)
      continue
    }
    const left = hooks.filter((hook: unknown) => {
      const ours = isOurs(commandOf(hook))
      if (ours) replaced.push(commandOf(hook))
      return !ours
    })
    if (left.length) kept.push({ ...e, hooks: left })
  }
  if (entry) kept.push(entry)
  return kept
}

/**
 * What install writes into settings.json; `statusLineSet`: the status line is ours now; `toast`:
 * the notification hooks are on.
 */
export interface SettingsPlan {
  settings: Settings
  replaced: string[]
  statusLineSet: boolean
  toast: boolean
}

/**
 * settings.json (parsed; undefined when there is none) with our hooks and status line in place
 * of any earlier ones of ours. A status line someone else set stays. The notification hooks go
 * in when `toast` is true and out when it is false; left as they are (pointed at this copy) when
 * it is undefined. `replaced` lists the commands of ours that went. The input is not changed.
 */
export function planSettings(
  settings: unknown,
  paths: InstallPaths,
  { toast }: { toast?: boolean | undefined } = {},
): SettingsPlan {
  if (settings !== undefined && !isRecord(settings))
    throw new Error('settings.json is not a JSON object; left as it was')
  const next: Settings = structuredClone(settings ?? {})
  const hooks = next.hooks ?? {}
  if (!isRecord(hooks)) throw new Error('settings.json: "hooks" is not an object; left as it was')
  next.hooks = hooks
  const ours = ourCommands(paths)
  const replaced: string[] = []
  const hook = { hooks: [{ type: 'command', command: bunCommand(paths.bun, paths.hook), timeout: 10 }] }
  for (const event of BOARD_EVENTS) hooks[event] = withOurHook(hooks[event], hook, ours.hook, replaced)
  // Desktop notifications: Windows PowerShell shows them, in the background (async), so Claude does not wait.
  const had = TOAST_EVENTS.some(([event]) => commandsOf(settings, event).some(c => ours.toast(c.command)))
  const withToast = toast ?? had
  const notify = { type: 'command', command: toastCommand(paths.toast), timeout: 30, async: true }
  for (const [event, matcher] of TOAST_EVENTS) {
    // Nothing of ours can be in what is not a list, and nothing is added: it stays as it is.
    if (!withToast && !Array.isArray(hooks[event])) continue
    const entry = withToast && { ...(matcher && { matcher }), hooks: [notify] }
    const list = withOurHook(hooks[event], entry, ours.toast, replaced)
    if (list.length) hooks[event] = list
    else delete hooks[event]
  }
  // Claude Code's own numbers for the board (usage windows, context fill). A status line someone
  // else set stays; the board then reads the usagebar cache, if there is one.
  const line = commandOf(next.statusLine)
  const statusLineSet = !next.statusLine || ours.line(line)
  if (statusLineSet) {
    if (next.statusLine) replaced.push(line)
    next.statusLine = { type: 'command', command: bunCommand(paths.bun, paths.statusline) }
  }
  return { settings: next, replaced, statusLineSet, toast: withToast }
}

const MARK = 'agent-board'

/**
 * The .cmd shim. cmd.exe reads a batch file in the console's code page (866, 437, ...), so a path
 * that is not ASCII (a Windows user name in Cyrillic, under which Bun itself lives) only resolves
 * under UTF-8: the script switches to 65001 around the call, then puts the code page back and
 * passes Bun's exit code on. Written as UTF-8 without a BOM, with CRLF line ends.
 */
const cmdShim = (bun: string, script: string): string =>
  [
    `@rem ${MARK}`,
    '@setlocal',
    `@for /f "tokens=2 delims=:." %%c in ('chcp') do @set "AB_CP=%%c"`,
    '@chcp 65001 >nul',
    `@"${bun}" "${script}" %*`,
    '@set "AB_RC=%errorlevel%"',
    '@chcp %AB_CP% >nul',
    '@exit /b %AB_RC%',
    '',
  ].join('\r\n')

const shShim = (bun: string, script: string): string => `#!/bin/sh\n# ${MARK}\nexec ${bunCommand(bun, script)} "$@"\n`

/**
 * The `board` and `spawn-agent` commands for ~/.local/bin: a sh script for Git Bash, macOS and
 * Linux, a .cmd for PowerShell and cmd.
 */
export function planShims(paths: InstallPaths): {
  board: string
  'board.cmd': string
  'spawn-agent': string
  'spawn-agent.cmd': string
} {
  return {
    board: shShim(paths.bun, paths.cli),
    'board.cmd': cmdShim(paths.bun, paths.cli),
    'spawn-agent': shShim(paths.bun, paths.spawn),
    'spawn-agent.cmd': cmdShim(paths.bun, paths.spawn),
  }
}

/**
 * The script a command file of ours runs (the board's `"<bun>" "<script>"`, or main's
 * `node "<script>"`), or null for a file that is not ours.
 */
export function shimTarget(text: unknown): string | null {
  const s = String(text ?? '')
  if (!s.includes(MARK)) return null
  return /(?:\bnode|"[^"\r\n]*")\s+"([^"\r\n]+)"/.exec(s)?.[1] ?? null
}
