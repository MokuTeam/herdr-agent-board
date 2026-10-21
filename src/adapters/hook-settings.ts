// A Claude profile folder's settings.json, as far as the board goes there: read it, write the
// board's hooks and status line into it (core/install-plan.ts planSettings, a backup next to it
// first; wake's hooks too while wake is on), and tell whether this copy's hooks are in it, wake's
// too, and herdr's own Claude hook (and whether the script it runs is there). The takeover of the
// separate herdr-wake plugin moves its hooks to wake's here, after a backup no later write
// replaces. Nothing else in the folder is read or written: no credentials, no .claude.json.
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOARD_EVENTS,
  commandsOf,
  type InstallPaths,
  normPath,
  ourCommands,
  planSettings,
  type WakeHooksState,
  wakeHooksState,
  withWakeHooks,
} from '../core/install-plan.ts'
import { type HerdrHookFacts, herdrHookScript } from '../core/setup.ts'
import { withoutOldHooks } from '../core/wake/takeover.ts'
import { isRecord, replaceFile } from './json-store.ts'

/** settings.json as read: its text (null when there is none), parsed (null when none or broken), and what is wrong with it. */
export interface SettingsRead {
  file: string
  text: string | null
  settings: unknown
  error: string
}

/**
 * What installing into one folder did; `error` says why not, when not. `wakeHooks`, only when
 * installed with wake on: `added` (wake's hooks are in), `old` (the separate herdr-wake plugin's
 * are there, so none of ours).
 */
export interface InstallOutcome {
  file: string
  ok: boolean
  error: string
  statusLineSet: boolean
  toast: boolean
  wakeHooks?: 'added' | 'old'
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
 * not a JSON object, is left as it was. `wake`: wake is on (its hooks go in too).
 */
export function installInto(
  dir: string,
  paths: InstallPaths & { wakeHook: string },
  { toast, create = false, wake = false }: { toast?: boolean | undefined; create?: boolean; wake?: boolean } = {},
): InstallOutcome {
  const file = join(dir, 'settings.json')
  const failed = (error: string): InstallOutcome => ({ file, ok: false, error, statusLineSet: false, toast: false })
  if (!create && !isFolder(dir)) return failed('the folder is not there')
  const read = readSettings(dir)
  if (read.error) return failed(`${file} is ${read.error}`)
  try {
    const plan = planSettings(read.text === null ? undefined : read.settings, paths, { toast, wake })
    if (read.text !== null) copyFileSync(file, `${file}.bak-agent-board`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(plan.settings, null, 2)}\n`)
    return {
      file,
      ok: true,
      error: '',
      statusLineSet: plan.statusLineSet,
      toast: plan.toast,
      ...(wake && { wakeHooks: plan.oldWake ? 'old' : 'added' }),
    }
  } catch (err) {
    return failed(messageOf(err))
  }
}

/** What the takeover did in one profile's settings.json. */
export interface HooksMoved {
  file: string
  /** The old plugin's hooks are out and wake's in. */
  moved: boolean
  /** The copy of settings.json as it was, made before it changed. */
  backup?: string
  /** Why its hooks were not moved; settings.json is left as it was. */
  error?: string
}

/** The takeover's backup of a settings.json: `.bak-wake-takeover`, then `-1`, `-2`… (one never written over). */
const TAKEOVER_BACKUP = 'bak-wake-takeover'

/** A copy of `file` under the first backup name not taken: an earlier backup is never written over. */
function backupOnce(file: string): string {
  for (let n = 0; n < 1000; n++) {
    const copy = `${file}.${TAKEOVER_BACKUP}${n ? `-${n}` : ''}`
    try {
      copyFileSync(file, copy, constants.COPYFILE_EXCL)
      return copy
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) throw err
    }
  }
  throw new Error(`no free name for a backup of ${file}`)
}

/**
 * The separate herdr-wake plugin's hooks in <dir>/settings.json moved to wake's (core/wake/takeover.ts
 * withoutOldHooks, core/install-plan.ts withWakeHooks), in one write, after a backup of the file as
 * it was (backupOnce). A settings.json without them is not written, nor one that does not parse
 * (said only when it names herdr-wake), nor one that could not be backed up first.
 */
export function moveOldHooksIn(dir: string, paths: { bun: string; wakeHook: string }): HooksMoved {
  const read = readSettings(dir)
  const file = read.file
  if (read.text === null) return { file, moved: false }
  if (read.error)
    return read.text.includes('herdr-wake')
      ? { file, moved: false, error: `${file} is ${read.error}; left as it was` }
      : { file, moved: false }
  const { settings, removed } = withoutOldHooks(read.settings)
  if (!removed.length || !isRecord(settings)) return { file, moved: false }
  let backup: string
  try {
    backup = backupOnce(file)
  } catch (err) {
    return { file, moved: false, error: `${file} could not be backed up (${messageOf(err)}); left as it was` }
  }
  try {
    replaceFile(file, `${JSON.stringify(withWakeHooks(settings, paths), null, 2)}\n`)
  } catch (err) {
    return { file, moved: false, backup, error: `${file} could not be written: ${messageOf(err)}` }
  }
  return { file, moved: true, backup }
}

// Wake's hooks per settings.json: read again only when its modification time (or this copy) changed.
const wakeSeen = new Map<string, { mtimeMs: number; wakeHook: string; state: WakeHooksState }>()

/**
 * What <dir>/settings.json has of wake's hooks (core/install-plan.ts wakeHooksState): both of this
 * copy's (`in`), the separate herdr-wake plugin's (`old`), or not both (`missing`, no file too);
 * cached by the file's mtime.
 */
export function wakeHooksIn(dir: string, wakeHook: string): WakeHooksState {
  const file = join(dir, 'settings.json')
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    wakeSeen.delete(file)
    return 'missing'
  }
  const last = wakeSeen.get(file)
  if (last && last.mtimeMs === mtimeMs && last.wakeHook === wakeHook) return last.state
  const state = wakeHooksState(readSettings(dir).settings, wakeHook)
  wakeSeen.set(file, { mtimeMs, wakeHook, state })
  return state
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
