// The `launch.command` launcher, the logic without the process: the command from config with its
// values filled in, and what a launcher printed when it worked or failed. services/launch/launcher.ts runs it.
import { t } from '../lang.ts'

export const PLACEHOLDERS = [
  'name',
  'label',
  'cwd',
  'workspace',
  'workspaceLabel',
  'category',
  'message',
  'messageFile',
  'sessionId',
  // The id of a session coming back from the archive, resumed by it; empty for a new one.
  'resume',
  // The Claude profile the session starts in: its id, and its folder (set or inherited).
  'profile',
  'profileDir',
] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

// 'message': the session runs and only its first message is missing.
export type FailureKind = 'launcher' | 'dialog' | 'timeout' | 'folder' | 'worktree' | 'message' | 'other'

type Vars = Partial<Record<string, string | number | null>>

const isPlaceholder = (key: string): key is Placeholder => (PLACEHOLDERS as readonly string[]).includes(key)

const fill = (s: unknown, vars: Vars): string =>
  String(s).replace(/\{(\w+)\}/g, (m, k: string) => {
    if (!isPlaceholder(k)) throw new Error(t('launch.err.placeholder', { name: m }))
    return String(vars[k] ?? '')
  })
const used = (s: unknown): string[] => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1] ?? '')

/** Whether the template uses {key} anywhere. */
export const usesPlaceholder = (template: unknown, key: Placeholder): boolean =>
  (Array.isArray(template) ? template : []).flat().some(s => used(s).includes(key))

/**
 * cmd.exe parses its own command line, so values would meet a shell after all (and Node before
 * 20.12.2 runs .bat and .cmd files through it): a launcher is a program, or a script run by one.
 */
export const isRefusedProgram = (file: string): boolean => /(^|[\\/])cmd(\.exe)?$|\.(bat|cmd)$/i.test(file.trim())

/**
 * `launch.command` with the values filled in: { file, args }. Each element is one argument, a
 * value never splits or joins arguments. A nested array is an optional group, left out when
 * any value it uses is empty: ["-BriefFile", "{messageFile}"]. The executable takes no values.
 */
export function commandArgs(template: unknown, vars: Vars): { file: string; args: string[] } {
  if (!Array.isArray(template) || typeof template[0] !== 'string' || !template[0].trim())
    throw new Error(t('launch.err.command'))
  const file: string = template[0]
  if (used(file).length) throw new Error(t('launch.err.commandValue'))
  if (isRefusedProgram(file)) throw new Error(t('launch.err.commandShell'))
  const args: string[] = []
  for (const part of template.slice(1) as unknown[]) {
    if (Array.isArray(part)) {
      if (!part.every(s => typeof s === 'string')) throw new Error(t('launch.err.command'))
      if (part.flatMap(used).every(k => String(vars[k] ?? '') !== '')) args.push(...part.map(s => fill(s, vars)))
    } else if (typeof part === 'string') args.push(fill(part, vars))
    else throw new Error(t('launch.err.command'))
  }
  return { file, args }
}

/**
 * What a launcher printed when it worked: `pane=<id> name=<name> agent=<herdr name>`, and
 * `kind=<agent kind>` when it started another agent than Claude (spawn-agent: pi), each optional.
 */
export function parseLauncherOutput(stdout: unknown): {
  pane?: string
  agent?: string
  session?: string
  kind?: string
} {
  const out: Record<string, string> = {}
  for (const m of String(stdout ?? '').matchAll(/\b(pane|agent|session|kind)=(\S+)/g)) out[m[1] ?? ''] = m[2] ?? ''
  return out
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/**
 * Why a launcher failed, from what it printed: PowerShell's error view puts the message on the
 * last "| " line, other tools on their last line. The pane, when the text names one.
 */
export function launcherError(stdout: unknown, stderr: unknown): { message: string; pane: string | null } {
  const lines = `${stderr ?? ''}\n${stdout ?? ''}`
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(l => l.trimEnd())
  const err = String(stderr ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  // PowerShell 7: the message follows the ~~~ line under the code, wrapped over "| " lines.
  const marker = err.findLastIndex(l => /^\|\s*~+$/.test(l))
  const barred =
    marker >= 0
      ? err
          .slice(marker + 1)
          .map(l => /^\|\s?(.*)$/.exec(l)?.[1]?.trim())
          .filter(Boolean)
          .join(' ')
      : ''
  // Windows PowerShell: the message first, cut at the console's width, then "At …", "+ …" and
  // CategoryInfo lines.
  const raw = String(stderr ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter(l => l.trim())
  const at = raw.findIndex(l => /^At \S/.test(l))
  const legacy =
    at > 0 && raw.some(l => /^\s*\+ CategoryInfo/.test(l))
      ? raw
          .slice(0, at)
          .reduce((s, l, i, all) => s + (i && (all[i - 1]?.length ?? 0) < 110 ? ' ' : '') + l, '')
          .trim()
      : ''
  const plain = err.filter(l => !/^(At |Line \||\+ |\| |CategoryInfo|FullyQualifiedErrorId|~)/.test(l)).at(-1)
  const message = (barred || legacy || plain || lines.filter(Boolean).at(-1) || '')
    .replace(/^\S+\.ps1\s*:\s*/i, '')
    .replace(/^(Exception|Error|Write-Error|spawn-agent):\s*/i, '')
    .trim()
  const pane = /\b(w[A-Za-z0-9]+:p[A-Za-z0-9]+)\b/.exec(lines.join('\n'))?.[1] ?? null
  return { message, pane }
}

/** What kind of failure it was, for the hint the page shows next to it. */
export function failureKind(message: unknown, code?: string): FailureKind {
  const m = String(message ?? '')
  if (code === 'ENOENT' || code === 'EINVAL') return 'launcher'
  // herdr cannot set the profile's folder for the tab: nothing was started, and a retry would not do better.
  if (/CLAUDE_CONFIG_DIR/.test(m)) return 'launcher'
  // The session runs and only its first message is missing: a retry would start a second one.
  if (/brief did not reach/i.test(m)) return 'message'
  if (/trust|dialog|agent_not_ready|blocked/i.test(m)) return 'dialog'
  if (/did not get ready|timed? ?out|ETIMEDOUT|timeout/i.test(m)) return 'timeout'
  if (/no such folder|not a folder|cannot find path/i.test(m)) return 'folder'
  if (/worktree|branch/i.test(m)) return 'worktree'
  return 'other'
}

/** A short name for the launcher in the window: its script's name, else the program's. */
export function launcherLabel(command: unknown): string {
  if (!Array.isArray(command) || !command.length) return ''
  const script = command.flat().find(s => /\.(ps1|sh|cmd|bat|mjs|cjs|js|py)$/i.test(String(s)) && !/\{/.test(s))
  // Either separator: a config written for Windows still reads right on macOS (path.basename there splits on / only).
  const last =
    String(script ?? command[0])
      .split(/[\\/]/)
      .pop() ?? ''
  return last.replace(/\.(ps1|sh|cmd|bat|mjs|cjs|js|py|exe)$/i, '')
}
