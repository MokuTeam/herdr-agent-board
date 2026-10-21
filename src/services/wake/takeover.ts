// The takeover of the separate herdr-wake plugin (#119, Migration): "Switch over…" on the board,
// and the same once at wake's first start after the plugin was removed by hand (no uninstall then).
// In this order: its config.json and sleeping list copied into the board's state folder (herdr's
// uninstall may take its folders), (1) its config taken over into the `wake` section (at the first
// start, which nobody asked for, the reaper and Telegram left off), (2) its sleeping list of the last
// 7 days into wake's session file (wake's own entries kept), (3) its wakeCommand's launcher
// named when it is not launch.claude's (call 25), (4) the plugin uninstalled (removed already counts
// as done), (5) its hooks moved to wake's in every profile that has them (each settings.json backed
// up first, under a name no backup has; core/wake/takeover.ts, adapters/hook-settings.ts), (6) its
// tg-router workspace closed when nothing but shells and sidebar panes is in it, (7) wake turned on
// and started, unless its router still holds the port (said instead: the new wake could not take
// it), (8) herdr key bindings to its actions named with their new names (call 26). Its config and
// state folders are left as they are. The marker (`wake-takeover.json`: what it did and took over)
// is written before the start, so the start it makes takes nothing over again; with a marker there,
// only sessions the old plugin saw since are taken over. At the first start it is marked unseen:
// the panel and board doctor say what it did until the panel has shown it. Each step is a line of
// `did` and of the log.
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { configFile, type EditResult, readConfigFile, takeOverWake } from '../../adapters/config-file.ts'
import { asSnapshot, type HerdrSnapshot } from '../../adapters/herdr.ts'
import { moveOldHooksIn } from '../../adapters/hook-settings.ts'
import { ROOT, stateDir } from '../../adapters/paths.ts'
import { inheritedProfileDir, loadProfiles } from '../../adapters/profiles.ts'
import { herdrWakeConfigFile } from '../../adapters/resume-report.ts'
import { herdrConfigFile, readText } from '../../adapters/setup-facts.ts'
import { oldRouterAt } from '../../adapters/wake-api.ts'
import {
  boardPaneNow,
  readWakeSessions,
  readWakeTakeover,
  saveWakeSessions,
  wakeSessionsFile,
  wakeTakeoverFile,
  writeWakeTakeover,
} from '../../adapters/wake-files.ts'
import { t } from '../../core/lang.ts'
import { sameDir } from '../../core/launch/names.ts'
import { defaultProfileDir } from '../../core/profiles.ts'
import { boardFiles } from '../../core/setup.ts'
import { type WakeConfig, wakeConfig } from '../../core/wake/config.ts'
import { asWakeSessions, type WakeSessions } from '../../core/wake/sessions.ts'
import { launcherNote, oldActionBindings, takeOverConfig, takeOverSessions } from '../../core/wake/takeover.ts'
import type { Switched, SwitchResult, SwitchSummary } from '../../core/wake/view.ts'
import { oldPluginInstalled, workspaceOf } from './start.ts'

type Herdr = <T = unknown>(args: string[], timeoutMs?: number) => Promise<T>
type Env = Record<string, string | undefined>

export interface TakeoverOptions {
  herdr: Herdr
  /** The home folder: ~/.claude.json, the default profile, the profiles found there. */
  home: string
  /** Where the old plugin's folders and herdr's config.toml are (APPDATA, LOCALAPPDATA), and CLAUDE_CONFIG_DIR. */
  env: Env
  log(text: string): void
}

export interface SwitchOptions extends TakeoverOptions {
  /** `herdr plugin uninstall herdr-wake` (Switch over…); not at wake's first start, where it is gone already. */
  uninstall: boolean
  /**
   * The takeover at wake's first start, which nobody asked for: the reaper and Telegram left off,
   * and the marker says it is unseen, so the panel and board doctor tell what it did.
   */
  firstStart?: boolean
  /** Step 7's start: the board's wake's start, past the held record. None at wake's first start, which goes on itself. */
  start?: () => EditResult | Promise<EditResult>
  /** The old plugin's router on a port: its pid, or null (adapters/wake-api.ts oldRouterAt by default). */
  oldRouter?: (port: number) => Promise<number | null>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const OLD_PLUGIN = 'herdr-wake'
/** The old router's workspace, which the board's wake does not reuse. */
const OLD_WORKSPACE = 'tg-router'
/** herdr's uninstall may take a while (it stops the plugin's panes). */
const UNINSTALL_MS = 60_000
/** The old router's port when its config.json names none. */
const OLD_PORT = 12421
/** How long the old router has to go once its plugin is uninstalled and its workspace closed, asked this often. */
const ROUTER_GONE_MS = 5000
const ROUTER_LOOK_MS = 250
/** How long the old router has to answer one look. */
const ROUTER_ANSWER_MS = 1000

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const firstLine = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split(/\r?\n/).find(line => line.trim()) ?? 'unknown error'

/** The separate plugin's config and state folders, as its router.mjs finds them outside herdr. */
export function oldWakeFolders(env: Env, home: string): { config: string; state: string } {
  return {
    config: dirname(herdrWakeConfigFile(env, home)),
    state: join(env.LOCALAPPDATA || join(home, '.local', 'state'), 'herdr', 'plugins', OLD_PLUGIN),
  }
}

/** A JSON file as read, a BOM taken off: none, there but not JSON (`broken`), or its value. */
function readJsonFile(file: string): { value: unknown; broken: boolean } {
  let text: string
  try {
    text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  } catch {
    return { value: null, broken: false }
  }
  try {
    return { value: JSON.parse(text), broken: false }
  } catch {
    return { value: null, broken: true }
  }
}

/** The files of `files` that are there, copied into a new folder `<stateDir>/herdr-wake-takeover-<at>`; the folder, or null with none. */
function copyAside(files: string[], at: number): string | null {
  const there = files.filter(file => existsSync(file))
  if (!there.length) return null
  let folder = join(stateDir(), `herdr-wake-takeover-${at}`)
  for (let n = 1; existsSync(folder); n++) folder = join(stateDir(), `herdr-wake-takeover-${at}-${n}`)
  mkdirSync(folder, { recursive: true })
  for (const file of there) copyFileSync(file, join(folder, basename(file)), constants.COPYFILE_EXCL)
  return folder
}

/** Every Claude profile folder the board knows (shown or hidden), the default one too, each once. */
function profileDirs(o: TakeoverOptions): string[] {
  const dirs: string[] = []
  const all = [
    defaultProfileDir(o.home),
    ...loadProfiles({ home: o.home, shownDir: inheritedProfileDir(o.env, o.home) }).map(p => p.dir),
  ]
  for (const dir of all) if (!dirs.some(d => sameDir(d, dir))) dirs.push(dir)
  return dirs
}

/**
 * Step 6: each workspace labelled tg-router closed when nothing but shells and sidebar panes is in
 * it (no agent), none of them the board's pane (board.json's, or this process's), and it is not the
 * board's nor wake's workspace by its label.
 */
async function closeOldWorkspace(o: TakeoverOptions, say: (line: string) => void): Promise<void> {
  let snap: HerdrSnapshot
  try {
    snap = asSnapshot(await o.herdr(['api', 'snapshot']))
  } catch (err) {
    say(`tg-router: not looked at, herdr did not answer: ${firstLine(err)}`)
    return
  }
  const raw = readConfigFile()
  const labels = [
    typeof raw?.workspace === 'string' && raw.workspace ? raw.workspace : 'Board',
    wakeConfig(raw?.wake).workspace,
  ]
  const boardPane = boardPaneNow()
  const own = o.env.HERDR_PANE_ID
  for (const ws of snap.workspaces.filter(w => w.label === OLD_WORKSPACE)) {
    const panes = snap.panes.filter(p => workspaceOf(snap, p) === ws.workspace_id)
    const kept =
      labels.includes(OLD_WORKSPACE) ||
      panes.some(p => p.agent || p.pane_id === boardPane || (!!own && p.pane_id === own))
    if (kept) {
      say('tg-router: left open, something else is in it')
      continue
    }
    try {
      await o.herdr(['workspace', 'close', ws.workspace_id])
      say('tg-router: closed')
    } catch (err) {
      say(`tg-router: not closed: ${firstLine(err)}`)
    }
  }
}

/** The old router's port: its config.json's, else its default. */
const oldPortOf = (old: unknown): number => {
  const port = record(old)?.port
  return Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535 ? Number(port) : OLD_PORT
}

/**
 * The old router on one of `ports` once it had ROUTER_GONE_MS to go (its plugin uninstalled, its
 * workspace closed): the port and its process, or null when none answers there.
 */
async function oldRouterLeft(o: SwitchOptions, ports: number[]): Promise<{ port: number; pid: number } | null> {
  const at = o.oldRouter ?? ((port: number) => oldRouterAt(port, ROUTER_ANSWER_MS))
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms))
  for (const port of ports) {
    let pid = await at(port)
    for (let waited = 0; pid !== null && waited < ROUTER_GONE_MS; waited += ROUTER_LOOK_MS) {
      await sleep(ROUTER_LOOK_MS)
      pid = await at(port)
    }
    if (pid !== null) return { port, pid }
  }
  return null
}

/** "Switch over…" (o.uninstall), or the takeover at wake's first start; see the head of this file. */
export async function switchOver(o: SwitchOptions): Promise<SwitchResult> {
  const at = (o.now ?? Date.now)()
  const did: string[] = []
  const say = (line: string): void => {
    did.push(line)
    o.log(`takeover: ${line}`)
  }
  /** Why it stopped: in the log as it came, to the panel in the board's words (`said`: already). */
  const failed = (error: string, said = false): SwitchResult => {
    o.log(`takeover: stopped: ${error}`)
    return { ok: false, error: said ? error : t('err.switchOver', { error }) }
  }
  /** What it took over, as the wake section has it now, with the sleeping sessions it took over. */
  const summaryOf = (asleep: number): SwitchSummary => {
    const now = wakeConfig(readConfigFile()?.wake)
    return {
      reaper: now.reaper.enabled ? 'on' : 'off',
      minutes: now.reaper.idleMinutes,
      excluded: now.reaper.exclude.length,
      telegram: now.telegram === 'auto',
      asleep,
    }
  }
  /** The marker: what it did so far and took over; at the first start, unseen until the panel shows it. */
  const mark = (taken: Omit<Switched, 'did'>): void => {
    try {
      writeWakeTakeover({ at, did: [...did], ...taken, ...(o.firstStart && { unseen: true }) })
    } catch (err) {
      o.log(`takeover: its marker could not be written: ${firstLine(err)}`)
    }
  }

  // Nothing is changed while the board's config.json does not read: the wake section goes there.
  const board = readConfigFile()
  if (!board && existsSync(configFile())) return failed(`${configFile()} does not read as JSON; nothing was taken over`)
  const folders = oldWakeFolders(o.env, o.home)
  const oldConfigFile = join(folders.config, 'config.json')
  const oldSessionsFile = join(folders.state, 'sessions.json')
  const marker = readWakeTakeover()

  try {
    const copied = copyAside([oldConfigFile, oldSessionsFile], at)
    if (copied) say(`copied: herdr-wake's config and sleeping list to ${copied}`)
  } catch (err) {
    return failed(
      `herdr-wake's config and sleeping list could not be copied: ${firstLine(err)}; nothing was taken over`,
    )
  }

  // 1. Its config into the wake section. The switch stays the board's: an `enabled` of its own is not
  // taken. At the first start (nobody asked) the reaper and Telegram are left off.
  const old = readJsonFile(oldConfigFile)
  if (old.broken) say(`config: ${oldConfigFile} does not read as JSON; left where it is, not taken over`)
  else {
    const { enabled: _switch, ...fields } = takeOverConfig(
      old.value,
      readJsonFile(join(o.home, '.claude.json')).value,
      { switches: !o.firstStart },
    )
    if (!Object.keys(fields).length) say('config: nothing to take over')
    else {
      const r = takeOverWake(fields)
      if (!r.ok) return failed(r.error)
      say(`config: ${Object.keys(fields).join(', ')} into the wake section of ${configFile()}`)
    }
  }
  if (o.firstStart)
    say('reaper and Telegram: left off at wake’s first start; turn them on in Settings → Sleep and wake…')

  // 2. Its sleeping list into wake's session file, only what the old plugin saw or put to sleep
  // within 7 days (an older entry's pane id may be another pane's now): wake's own entry for a pane
  // stays; after an earlier takeover, only the sessions the old plugin saw or put to sleep since.
  const theirs = readJsonFile(oldSessionsFile)
  let ours: WakeSessions
  try {
    ours = readWakeSessions(wakeSessionsFile(), o.log)
  } catch (err) {
    return failed(`${wakeSessionsFile()}: ${firstLine(err)}`)
  }
  const recent = takeOverSessions(theirs.value, defaultProfileDir(o.home), at)
  const older = Object.keys(asWakeSessions(theirs.value) ?? {}).length - Object.keys(recent).length
  const added = Object.entries(recent).filter(
    ([pane, e]) => !Object.hasOwn(ours, pane) && (!marker || Math.max(e.seen_at, e.slept_at ?? 0) > marker.at),
  )
  if (added.length) {
    try {
      saveWakeSessions({ ...ours, ...Object.fromEntries(added) })
    } catch (err) {
      return failed(`${wakeSessionsFile()} could not be written: ${firstLine(err)}`)
    }
  }
  const asleep = added.filter(([, e]) => e.slept_at !== undefined).length
  say(
    theirs.broken
      ? `sleeping sessions: ${oldSessionsFile} does not read as JSON; left where it is, none taken over`
      : `sleeping sessions: ${added.length} taken over (${asleep} asleep)${added.length ? ` from ${oldSessionsFile}` : ''}${older > 0 ? `; ${older} not seen for 7 days left out` : ''}`,
  )

  // 3. Its launcher, when it is not the board's: said, launch.claude not changed.
  const launcher = launcherNote(record(old.value)?.wakeCommand, record(board?.launch)?.claude)
  if (launcher)
    say(`launcher: herdr-wake woke sessions with ${launcher.old}; the board starts them with ${launcher.now}`)

  // 4. The plugin itself, after its config and list are safe (its uninstall may take its folders).
  if (o.uninstall) {
    let installed: boolean
    try {
      installed = await oldPluginInstalled(o)
    } catch (err) {
      return failed(`herdr plugin list: ${firstLine(err)}`)
    }
    if (installed) {
      // What herdr prints for it is not read: whether the plugin is gone after it is.
      let why = ''
      try {
        await o.herdr(['plugin', 'uninstall', OLD_PLUGIN], UNINSTALL_MS)
      } catch (err) {
        why = firstLine(err)
      }
      let still = true
      try {
        still = await oldPluginInstalled(o)
      } catch (err) {
        why ||= firstLine(err)
      }
      if (still) return failed(`herdr plugin uninstall herdr-wake: ${why || 'it is still installed'}`)
      say('herdr-wake: uninstalled')
    } else say('herdr-wake: not installed (removed by hand)')
  } else say('herdr-wake: not installed (removed by hand)')

  // 5. Its hooks to wake's, in every profile that has them; the others are not written.
  const paths = { bun: process.execPath, wakeHook: boardFiles(ROOT).wakeHook }
  for (const dir of profileDirs(o)) {
    const r = moveOldHooksIn(dir, paths)
    if (r.moved) say(`hooks: moved to wake's in ${r.file}; the file as it was is ${r.backup}`)
    else if (r.error) say(`hooks: ${r.error}`)
  }

  // 6. Its workspace.
  await closeOldWorkspace(o, say)

  // 7. Wake on (when it was turned off), the marker, and wake's start. Not while the old router still
  // holds a port (its pane left open): the new wake could not take it, and the board would not
  // know which wake answers there; said, and Switch over… again once it is closed.
  if (!wakeConfig(readConfigFile()?.wake).enabled) {
    const r = takeOverWake({ enabled: true })
    say(r.ok ? 'wake: turned on' : `wake: not turned on: ${r.error}`)
  }
  if (o.start) {
    const ports = [wakeConfig(readConfigFile()?.wake).port, oldPortOf(old.value)]
    const left = await oldRouterLeft(o, [...new Set(ports)])
    if (left) return failed(t('err.oldRouter', left), true)
  }
  // herdr key bindings to its actions (step 8), read now for the marker; config.toml not changed.
  const bindings = oldActionBindings(readText(herdrConfigFile(o.env, o.home)))
  mark({ summary: summaryOf(asleep), launcher, bindings })
  if (o.start) {
    const r = await o.start()
    say(r.ok ? 'wake: started' : `wake: not started: ${r.error}`)
  }

  // 8. herdr key bindings to its actions, with their new names.
  for (const b of bindings) say(`key binding: ${b.key ? `${b.key} ` : ''}${b.old} → ${b.now}`)
  const taken = { summary: summaryOf(asleep), launcher, bindings }
  mark(taken)
  return { ok: true, did, ...taken }
}

/**
 * Wake's first start after the old plugin was removed by hand (not held): the takeover without the
 * uninstall, with the reaper and Telegram left off and its marker unseen (switchOver firstStart),
 * once (no marker yet) and only when the old plugin's config or state folder is there.
 * Nothing of it there: no herdr call, no file read but those two looks. Never throws; a takeover
 * that stops is logged and the start goes on. The wake section as it is after it, or null when it
 * did not run.
 */
export async function takeOverAtFirstStart(o: TakeoverOptions): Promise<WakeConfig | null> {
  if (existsSync(wakeTakeoverFile())) return null
  const folders = oldWakeFolders(o.env, o.home)
  if (!existsSync(folders.config) && !existsSync(folders.state)) return null
  try {
    if (!(await switchOver({ ...o, uninstall: false, firstStart: true })).ok) return null
  } catch (err) {
    o.log(`takeover: stopped: ${firstLine(err)}`)
    return null
  }
  return wakeConfig(readConfigFile()?.wake)
}
