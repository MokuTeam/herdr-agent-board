// A Claude profile folder's settings.json, as far as the board goes there: read it, write the
// board's hooks and status line into it (core/install-plan.ts planSettings, a backup next to it
// first), and tell whether this copy's hooks are in it, and herdr's own Claude hook (and whether
// the script it runs is there). Nothing else in the folder is read or written: no credentials, no
// .claude.json.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOARD_EVENTS,
  commandsOf,
  type InstallPaths,
  normPath,
  ourCommands,
  planSettings,
} from '../core/install-plan.ts'
import { type HerdrHookFacts, herdrHookScript } from '../core/setup.ts'

/** settings.json as read: its text (null when there is none), parsed (null when none or broken), and what is wrong with it. */
export interface SettingsRead {
  file: string
  text: string | null
  settings: unknown
  error: string
}

/** What installing into one folder did; `error` says why not, when not. */
export interface InstallOutcome {
  file: string
  ok: boolean
  error: string
  statusLineSet: boolean
  toast: boolean
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** <dir>/settings.json, a BOM taken off (Windows PowerShell writes one). */
export function readSettings(dir: string): SettingsRead {
  const file = join(dir, 'settings.json')
  let text: string | null = null
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return { file, text, settings: null, error: '' }
  }
  try {
    return { file, text, settings: JSON.parse(text), error: '' }
  } catch (err) {
    // Only where it broke: the parser's message may quote the file around it, and this goes to the page.
    const at = /position \d+/.exec(messageOf(err))
    return { file, text, settings: null, error: `not valid JSON${at ? ` (${at[0]})` : ''}` }
  }
}

/**
 * planSettings into <dir>/settings.json, backup to settings.json.bak-agent-board first; a folder
 * that is not there is created only with `create`. A settings.json that does not parse, or is
 * not a JSON object, is left as it was.
 */
export function installInto(
  dir: string,
  paths: InstallPaths,
  { toast, create = false }: { toast?: boolean | undefined; create?: boolean } = {},
): InstallOutcome {
  const file = join(dir, 'settings.json')
  const failed = (error: string): InstallOutcome => ({ file, ok: false, error, statusLineSet: false, toast: false })
  if (!create && !isFolder(dir)) return failed('the folder is not there')
  const read = readSettings(dir)
  if (read.error) return failed(`${file} is ${read.error}`)
  try {
    const plan = planSettings(read.text === null ? undefined : read.settings, paths, { toast })
    if (read.text !== null) copyFileSync(file, `${file}.bak-agent-board`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(plan.settings, null, 2)}\n`)
    return { file, ok: true, error: '', statusLineSet: plan.statusLineSet, toast: plan.toast }
  } catch (err) {
    return failed(messageOf(err))
  }
}

// The last answer per settings.json: read again only when its modification time (or this copy) changed.
const seen = new Map<string, { mtimeMs: number; hook: string; installed: boolean }>()

/** Both board events have a hook of this copy in <dir>/settings.json; cached by the file's mtime. */
export function hooksInstalled(dir: string, files: Pick<InstallPaths, 'hook' | 'statusline' | 'toast'>): boolean {
  const file = join(dir, 'settings.json')
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    seen.delete(file)
    return false
  }
  const last = seen.get(file)
  if (last && last.mtimeMs === mtimeMs && last.hook === files.hook) return last.installed
  const { settings } = readSettings(dir)
  // As the setup check has it (core/setup.ts): the board's hook, running this copy's file.
  const ours = ourCommands(files)
  const here = normPath(files.hook)
  const installed = BOARD_EVENTS.every(event =>
    commandsOf(settings, event).some(c => ours.hook(c.command) && normPath(c.command).includes(here)),
  )
  seen.set(file, { mtimeMs, hook: files.hook, installed })
  return installed
}

/** herdr's own Claude hook in these settings (core/setup.ts herdrHookScript): the script it runs, and whether that file is there. */
export function herdrHookOf(settings: unknown): HerdrHookFacts {
  const script = herdrHookScript(settings)
  return { script, found: !!script && existsSync(script) }
}

// The script herdr's hook runs, per settings.json: read again only when its modification time changed.
const herdrSeen = new Map<string, { mtimeMs: number; script: string | null }>()

/**
 * herdr's own Claude hook is in <dir>/settings.json and the script it runs is there; settings.json
 * cached by its mtime, the script looked for each time.
 */
export function herdrHookInstalled(dir: string): boolean {
  const file = join(dir, 'settings.json')
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    herdrSeen.delete(file)
    return false
  }
  let last = herdrSeen.get(file)
  if (!last || last.mtimeMs !== mtimeMs) {
    last = { mtimeMs, script: herdrHookScript(readSettings(dir).settings) }
    herdrSeen.set(file, last)
  }
  return !!last.script && existsSync(last.script)
}
