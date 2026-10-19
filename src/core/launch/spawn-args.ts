// spawn-agent (entrypoints/spawn-agent.ts), the logic without herdr: its command line, the
// command it types into the new tab (a profile's start command, else `launch.claude`), and whether
// text typed into a prompt is still on screen. The board's own launcher
// (services/launch/launcher.ts) uses the same rules.
import { t } from '../lang.ts'
import { checkName } from './names.ts'

export const USAGE =
  'spawn-agent --name <Name> --cwd <folder> [--label <tab label>] [--brief-file <file> | --brief <text>] [--workspace <herdr workspace id>] [--timeout-sec 120] [--session-id <uuid>] [--pane <pane id>] [--profile <id>]'

/** What spawn-agent was asked to start. */
export interface SpawnOptions {
  name: string
  cwd: string
  label?: string
  briefFile?: string
  brief?: string
  workspace?: string
  timeoutSec: number
  sessionId?: string
  pane?: string
  /** The Claude profile to start in, not the one of the agent that runs spawn-agent. */
  profile?: string
  /** The board's start: CLAUDE_CONFIG_DIR for the tab, a folder the board checked. */
  configDir?: string
  /** The board's start: the tab's env as herdr makes it. */
  keepEnv?: boolean
  help?: never
}

export type SpawnArgs = SpawnOptions | { help: true }

type Key = keyof SpawnOptions

// Option names without dashes and case: --brief-file, -BriefFile and -brieffile are one.
const OPTIONS: Record<string, Key> = {
  name: 'name',
  cwd: 'cwd',
  label: 'label',
  brieffile: 'briefFile',
  brief: 'brief',
  workspace: 'workspace',
  timeoutsec: 'timeoutSec',
  sessionid: 'sessionId',
  pane: 'pane',
  profile: 'profile',
  configdir: 'configDir',
  keepenv: 'keepEnv',
  help: 'help',
  h: 'help',
}
const NAME_ERRORS: Record<string, string> = {
  'launch.err.nameEmpty': '--name is empty',
  'launch.err.nameLong': '--name is longer than 60 characters',
  'launch.err.nameChars': '--name has control characters in it',
  'launch.err.nameStart': '--name must not start with - or /',
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The command line as options; throws with what is wrong and the usage. */
export function parseArgs(argv: readonly string[]): SpawnArgs {
  const out: Partial<Record<Key, string>> = {}
  let help = false
  let keepEnv = false
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    const m = /^--?([A-Za-z][A-Za-z-]*)(?:[=:]([\s\S]*))?$/.exec(arg)
    if (!m) throw new Error(`unexpected argument "${arg}". ${USAGE}`)
    const name = (m[1] ?? '').toLowerCase().replace(/-/g, '')
    const key = Object.hasOwn(OPTIONS, name) ? OPTIONS[name] : undefined
    if (!key) throw new Error(`unknown option ${arg.replace(/[=:][\s\S]*$/, '')}. ${USAGE}`)
    if (key === 'help') {
      help = true
      continue
    }
    if (key === 'keepEnv') {
      // A flag: a value given with it (--keep-env=no) would read as one it does not take.
      if (m[2] !== undefined) throw new Error(`${arg.replace(/[=:][\s\S]*$/, '')} takes no value`)
      keepEnv = true
      continue
    }
    let value = m[2]
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      value = String(argv[++i])
    }
    out[key] = value
  }
  if (help) return { help: true }
  if (out.name === undefined) throw new Error(`--name is missing. ${USAGE}`)
  const name = out.name.trim()
  const bad = checkName(name)
  if (bad) throw new Error(NAME_ERRORS[bad] ?? bad)
  if (!out.cwd?.trim()) throw new Error(`--cwd is missing. ${USAGE}`)
  if (out.briefFile !== undefined && out.brief !== undefined) throw new Error('give --brief-file or --brief, not both')
  const timeoutSec = out.timeoutSec === undefined ? 120 : Number(out.timeoutSec)
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0)
    throw new Error(`--timeout-sec must be a number of seconds, not "${out.timeoutSec}"`)
  if (out.sessionId !== undefined && !UUID.test(out.sessionId))
    throw new Error(`--session-id must be a UUID, not "${out.sessionId}"`)
  const { label, briefFile, brief, workspace, sessionId, pane, profile, configDir } = out
  if ([profile !== undefined, configDir !== undefined, keepEnv].filter(Boolean).length > 1)
    throw new Error('give one of --profile, --config-dir and --keep-env')
  return {
    name,
    cwd: out.cwd,
    timeoutSec,
    ...(label !== undefined && { label }),
    ...(briefFile !== undefined && { briefFile }),
    ...(brief !== undefined && { brief }),
    ...(workspace !== undefined && { workspace }),
    ...(sessionId !== undefined && { sessionId }),
    ...(pane !== undefined && { pane }),
    ...(profile !== undefined && { profile }),
    ...(configDir !== undefined && { configDir }),
    ...(keepEnv && { keepEnv }),
  }
}

/**
 * `launch.claude` from config.json as a list: the program and its arguments. Without it,
 * `claude` with `launch.args`, the agent's arguments from before the board had its own launcher.
 */
export function claudeCommand(setting: unknown, args?: unknown): string[] {
  if (setting === undefined || setting === null || setting === '')
    return ['claude', ...(Array.isArray(args) ? args.map(String) : [])]
  const list: unknown = typeof setting === 'string' ? [setting] : setting
  if (
    !Array.isArray(list) ||
    !list.length ||
    !list.every((s): s is string => typeof s === 'string') ||
    !String(list[0]).trim()
  ) {
    throw new Error(
      'launch.claude in the board’s config.json must be a program, or a list of the program and its arguments: ["claude", "--model", "opus"]',
    )
  }
  return list
}

/** Whether the command picks its session itself, so no --session-id may go with it. */
export const choosesSession = (command: readonly string[]): boolean =>
  command.some(a => /^(--session-id|-r|--resume|-c|--continue)(=|$)/.test(a))

// A quote (the typographic ones too, which PowerShell also ends a string at) or a control character.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const UNTYPABLE = /['\u2018-\u201b\u0000-\u001f\u007f-\u009f\u2028\u2029]/
// A word the shell takes as it is; on Windows a program may have backslashes too.
const PLAIN = /^[\w=:./~+-]+$/
const PLAIN_WIN_PROGRAM = /^[\w=:./\\~+-]+$/

/** What keeps argv from being typed by shellLine's rules: the program starts with a dash, or is no
 *  plain word (/^[\w=:./~+-]+$/, backslash too when win), or an argument holds UNTYPABLE. */
export type TypingProblem = { why: 'dash' | 'program' | 'chars'; word: string }

/** The first word of `argv` shellLine cannot type, and why; null when it can type them all. */
export function typingProblem(argv: readonly string[], win: boolean): TypingProblem | null {
  for (const [i, arg] of argv.entries()) {
    const word = String(arg)
    if (i === 0) {
      if (word.startsWith('-')) return { why: 'dash', word }
      if (!PLAIN.test(word) && !(win && PLAIN_WIN_PROGRAM.test(word))) return { why: 'program', word }
    } else if (UNTYPABLE.test(word)) return { why: 'chars', word }
  }
  return null
}

// A shell assignment (NAME=value), and `env` as a program (a path to it, or env.exe, too).
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const ENV_PROGRAM = /^(?:.*[\\/])?env(?:\.exe)?$/i

/**
 * The first word of a profile's start command that sets an environment variable, which in bash
 * would override the folder the board sets for the profile (`--env CLAUDE_CONFIG_DIR=…`): a program
 * that is an assignment (`CLAUDE_CONFIG_DIR=~/.claude-work claude`), an assignment after the
 * program `env` (`env CLAUDE_CONFIG_DIR=/x claude`), or any word that sets CLAUDE_CONFIG_DIR. Null
 * when there is none. Not a rule of `launch.claude`.
 */
export function envSetting(argv: readonly string[]): string | null {
  const program = String(argv[0] ?? '')
  if (ASSIGNMENT.test(program)) return program
  const env = ENV_PROGRAM.test(program)
  for (const arg of argv.slice(1)) {
    const word = String(arg)
    if ((env && ASSIGNMENT.test(word)) || /^CLAUDE_CONFIG_DIR=/i.test(word)) return word
  }
  return null
}

/**
 * A command line for the tab's shell prompt (PowerShell, bash, zsh or fish): plain words as they
 * are, anything else in single quotes, which take it literally (fish too, without a backslash
 * before a quote or another backslash). Refused: a single quote, the typographic ones PowerShell
 * also ends a string at, and control characters. The program cannot be quoted (PowerShell would
 * read a quoted word as a string, not a command), so it must be a plain word: a name on PATH, or
 * a path without spaces (with backslashes only on Windows, `win`, where the tab runs PowerShell).
 */
export function shellLine(argv: readonly string[], win: boolean): string {
  const problem = typingProblem(argv, win)
  if (problem?.why === 'dash') throw new Error(`launch.claude: the program "${problem.word}" starts with a dash`)
  if (problem?.why === 'program')
    throw new Error(
      `launch.claude: "${problem.word}" is typed at the tab's shell prompt, so the program must be a name on PATH or a path without spaces or quotes`,
    )
  if (problem?.why === 'chars')
    throw new Error(
      `launch.claude: the argument ${JSON.stringify(problem.word)} cannot be typed into a shell as it is (a quote or a control character)`,
    )
  return argv
    .map((arg, i) => {
      const s = String(arg)
      return i === 0 || PLAIN.test(s) ? s : `'${s}'`
    })
    .join(' ')
}

/**
 * A profile's start command (its `command` in config.json), typed instead of `launch.claude`: a
 * string split on spaces, or a list of the program and its arguments as it is. None (unset, null,
 * blank) is null. Checked by shellLine's rules (typingProblem), and refused when it sets an
 * environment variable (envSetting): the board sets the profile's folder itself. Throws with what
 * is wrong, in the board's language.
 */
export function profileCommand(value: unknown, win: boolean = process.platform === 'win32'): string[] | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null
  const words: unknown = typeof value === 'string' ? value.split(' ').filter(Boolean) : value
  if (
    !Array.isArray(words) ||
    !words.length ||
    !words.every((w): w is string => typeof w === 'string') ||
    !String(words[0]).trim()
  )
    throw new Error(t('err.profile.commandShape'))
  // Before the typing rules: the owner's alias body (CLAUDE_CONFIG_DIR=$HOME/… command claude) is
  // refused for what it does, not for its `$`.
  const env = envSetting(words)
  if (env !== null) throw new Error(t('err.profile.commandEnv', { word: env }))
  const problem = typingProblem(words, win)
  if (problem?.why === 'dash') throw new Error(t('err.profile.commandDash', { word: problem.word }))
  if (problem?.why === 'program') throw new Error(t('err.profile.commandProgram', { word: problem.word }))
  if (problem?.why === 'chars') throw new Error(t('err.profile.commandChars', { word: JSON.stringify(problem.word) }))
  return [...words]
}

/** A profile's start command as the Profiles panel shows it: one line, '' for none or one it cannot read. */
export function commandText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && value.every((w): w is string => typeof w === 'string')) return value.join(' ')
  return ''
}

/** The program `launch.claude` types (claudeCommand's first word); `claude` when it is unset or not valid. */
export function claudeProgram(setting: unknown, args?: unknown): string {
  try {
    return claudeCommand(setting, args)[0] ?? 'claude'
  } catch {
    return 'claude'
  }
}

/**
 * Whether a line typed into the prompt is still on screen: its first 30 characters but spaces,
 * found on the screen with its spaces and line breaks taken out (a narrow pane wraps it), or a
 * pasted-text chip standing for it.
 */
export function stillTyped(shown: unknown, text: unknown): boolean {
  const squeeze = (s: unknown): string => String(s ?? '').replace(/\s+/g, '')
  const head = squeeze(String(text ?? '').split('\n')[0]).slice(0, 30)
  return (!!head && squeeze(shown).includes(head)) || /Pasted text/.test(String(shown ?? ''))
}
