// A call in MokuPilot (github.com/MokuTeam/MokuPilot) with a fork of a session: its work agent
// goes on from the session's conversation as a fork (claude --resume <id> --fork-session), so it
// knows what the session knows while the session itself stays as it was. The board runs
// MokuPilot's launcher with
//   call --claude-session <id> [--cwd <folder>]
// and MokuPilot does the rest: one already running takes the request, else it starts and calls.
//
// The launcher, from config.json `mokupilot`:
//   false               off
//   { command: [...] }  a program and its first arguments, one argument per element, no shell.
//                       With {session} or {cwd} in it, it is the whole command line, filled in;
//                       a nested array is left out when a value it uses is empty, as in
//                       launch.command. Without them the board adds its own arguments.
//   { dir: "..." }      a MokuPilot checkout: its .venv's Python runs run.py on Windows (what
//                       meet.cmd does: Bun runs no .cmd without a shell), its `meet` elsewhere
//   unset               found on this computer: MokuPilot.exe where its installer puts it
//                       (Windows), else `meet` on PATH, meet.cmd standing for its checkout
// Finding it is adapters/setup-facts.ts mokupilotCommand; starting it, services/mokupilot.ts.
import { t } from './lang.ts'
import type { Item } from './types.ts'

/** A part of a configured command line: an argument, or a group left out when a value it uses is empty. */
export type CommandPart = string | CommandPart[]

/**
 * How to start MokuPilot here: { state: 'ok', configured, file, args, template } (args: what goes
 * before its own; template: a configured command line with placeholders), { state: 'missing',
 * configured, file } (what was looked for), or { state: 'off' }.
 */
export type MokupilotLauncher =
  | { state: 'ok'; configured: boolean; file: string; args: string[]; template?: CommandPart[] | null }
  | { state: 'missing'; configured: boolean; file: string; error?: string }
  | { state: 'off'; configured: true }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACEHOLDERS = ['session', 'cwd']

/** The {names} in a part of a command line. */
export const placeholdersIn = (s: unknown): string[] => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1] ?? '')

/** A session a call can fork: a Claude Code session with its id. */
export const callable = (item: Pick<Item, 'agent' | 'session'> | null | undefined): boolean =>
  item?.agent === 'claude' && UUID.test(String(item?.session ?? ''))

/** The command line for a call with a fork of `session`, in `cwd` when known: { file, args }. */
export function callCommand(
  launcher: { file: string; args: string[]; template?: CommandPart[] | null | undefined },
  { session, cwd = '' }: { session: string; cwd?: string },
): { file: string; args: string[] } {
  if (!launcher.template)
    return {
      file: launcher.file,
      args: [...launcher.args, 'call', '--claude-session', session, ...(cwd ? ['--cwd', cwd] : [])],
    }
  const vars: Record<string, string> = { session, cwd }
  const fill = (s: CommandPart) =>
    String(s).replace(/\{(\w+)\}/g, (m, k: string) => {
      if (!PLACEHOLDERS.includes(k)) throw new Error(t('mokupilot.err.placeholder', { name: m }))
      return String(vars[k] ?? '')
    })
  const args: string[] = []
  for (const part of launcher.template) {
    // An optional group: ["--cwd", "{cwd}"] is left out without a folder.
    if (Array.isArray(part)) {
      if (part.flatMap(placeholdersIn).every(k => String(vars[k] ?? '') !== '')) args.push(...part.map(fill))
    } else args.push(fill(part))
  }
  return { file: launcher.file, args }
}
