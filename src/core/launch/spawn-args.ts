// spawn-agent (entrypoints/spawn-agent.ts), the logic without herdr: its command line, the
// command it types into the new tab (`launch.claude`), and whether text typed into a prompt is
// still on screen. The board's own launcher (services/launch/launcher.ts) uses the same rules.
import { checkName } from './names.ts'

export const USAGE =
  'spawn-agent --name <Name> --cwd <folder> [--label <tab label>] [--brief-file <file> | --brief <text>] [--workspace <herdr workspace id>] [--timeout-sec 120] [--session-id <uuid>] [--pane <pane id>]'

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
  const { label, briefFile, brief, workspace, sessionId, pane } = out
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

/**
 * A command line for the tab's shell prompt (PowerShell, bash, zsh or fish): plain words as they
 * are, anything else in single quotes, which take it literally (fish too, without a backslash
 * before a quote or another backslash). Refused: a single quote, the typographic ones PowerShell
 * also ends a string at, and control characters. The program cannot be quoted (PowerShell would
 * read a quoted word as a string, not a command), so it must be a plain word: a name on PATH, or
 * a path without spaces (with backslashes only on Windows, where the tab runs PowerShell).
 */
export function shellLine(argv: readonly string[], win = process.platform === 'win32'): string {
  const plain = /^[\w=:./~+-]+$/
  return argv
    .map((arg, i) => {
      const s = String(arg)
      if (i === 0) {
        if (s.startsWith('-')) throw new Error(`launch.claude: the program "${s}" starts with a dash`)
        if (plain.test(s) || (win && /^[\w=:./\\~+-]+$/.test(s))) return s
        throw new Error(
          `launch.claude: "${s}" is typed at the tab's shell prompt, so the program must be a name on PATH or a path without spaces or quotes`,
        )
      }
      if (plain.test(s)) return s
      if (UNTYPABLE.test(s))
        throw new Error(
          `launch.claude: the argument ${JSON.stringify(s)} cannot be typed into a shell as it is (a quote or a control character)`,
        )
      return `'${s}'`
    })
    .join(' ')
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
