// macOS notifications carrying the agent's own words, the counterpart of integrations/toast.ps1:
// entrypoints/toast.ts runs it as a Claude Code hook (Stop, Notification, PreToolUse
// AskUserQuestion) and, when a notification is clicked, as `toast.ts click <pane id>`.
//
// A hook posts one notification per pane, titled "<workspace> · <session>" (its subtitle says
// what it is: finished, needs attention, asks), and skips the pane when it is focused in herdr and
// its terminal is the foreground app, as herdr itself does. The notification is shown by a small
// app built from toast-mac.swift: macOS shows notifications only for an app LaunchServices knows,
// so the install, or else the first toast, builds it into the state folder and the user is asked
// once to allow it. Without the Command Line Tools it cannot be built: that is written down, the
// hooks show herdr's own notification and do not try again until the install does.
//
// A click goes to the board first (entrypoints/web-open.ts --pane: its window comes up on that
// session's sheet), else to herdr: the pane's agent, its tab, and the terminal app the session ran
// in. Nothing here runs a shell: the helper takes a program and its arguments.
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { type HerdrSnapshot, herdr, notify, snapshot } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { ROOT, stateDir } from '../adapters/paths.ts'

const DOT = '·'
const APP_ID = 'com.mokuteam.agent-board.toast.cb'
const APP_NAME = 'Claude'
/** herdr gives a pane's id out again after it starts over: nothing else is taken for one. */
const PANE_ID = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
/** How long the helper stays to catch a click (it holds no state: the click runs a fresh process). */
const WAIT_SEC = 600

export const isPaneId = (pane: string): boolean => PANE_ID.test(pane)

// ------------------------------------------------------------------ the words of a notification

/** Markdown as one line of plain text, at most `max` characters: what a notification can show. */
export function plainText(text: unknown, max: number): string {
  let t = String(text ?? '')
  if (!t.trim()) return ''
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  t = t.replace(/\*\*|__|`/g, '')
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  t = t.replace(/^\s*>\s?/gm, '')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  t = t.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t
}

/** What the event says, as { kind, text, subtitle }; null for an event the board says nothing about. */
export function toastMessage(
  payload: Record<string, unknown>,
): { kind: string; text: string; subtitle: string } | null {
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : ''
  const textOf = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (event === 'Stop')
    return { kind: 'stop', text: textOf(payload.last_assistant_message), subtitle: 'claude finished' }
  if (event === 'Notification') {
    // idle_prompt ("waiting for your input") only repeats what the Stop toast said.
    const kind = textOf(payload.notification_type)
    if (kind !== 'permission_prompt' && kind !== 'elicitation_dialog') return null
    return { kind: 'attention', text: textOf(payload.message), subtitle: 'claude needs attention' }
  }
  if (event === 'PreToolUse') {
    if (payload.tool_name !== 'AskUserQuestion') return null
    const input = isRecord(payload.tool_input) ? payload.tool_input : {}
    const first = Array.isArray(input.questions) ? input.questions[0] : null
    const question = isRecord(first) ? textOf(first.question) : ''
    return { kind: 'ask', text: question, subtitle: 'claude asks' }
  }
  return null
}

/** "<workspace> · <session>", from herdr's snapshot; the folder's name when the pane is gone. */
export function toastTitle(snap: HerdrSnapshot | null, paneId: string, cwd = ''): string {
  const pane = snap?.panes.find(p => p.pane_id === paneId)
  if (!pane) return cwd ? basename(cwd) : APP_NAME
  const label = (v: unknown): string => (typeof v === 'string' ? v : '')
  const workspace = label(snap?.workspaces.find(w => w.workspace_id === pane.workspace_id)?.label)
  const tab = label(snap?.tabs.find(t => t.tab_id === pane.tab_id)?.label)
  const title = label(pane.terminal_title_stripped)
  const topic = title && title !== 'Claude Code' ? title : tab
  return [workspace, topic].filter(Boolean).join(` ${DOT} `) || APP_NAME
}

// ------------------------------------------------------------------ the app that shows them

const appDir = (): string => join(stateDir(), 'toast')
export const toastApp = (): string => join(appDir(), 'ClaudeToast.app')
const toastBinary = (): string => join(toastApp(), 'Contents', 'MacOS', 'ClaudeToast')
const toastSource = (): string => join(ROOT, 'src', 'integrations', 'toast-mac.swift')

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${APP_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>ClaudeToast</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`

/** Runs a program without a shell; whether it exited 0. Builds go through one, so a test can stand in. */
type Runner = (program: string, args: string[], timeoutMs?: number) => boolean

function run(program: string, args: string[], timeoutMs = 120_000): boolean {
  try {
    execFileSync(program, args, { stdio: 'ignore', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

export interface BuildOptions {
  run?: Runner
  platform?: string
}

export interface EnsureOptions extends BuildOptions {
  /** Build although the last build of this very source failed: a hook does not, the install does. */
  retry?: boolean
}

/** Written when a build fails: for which version of the source, and why. A hook does not try that source again. */
const failedFile = (): string => join(appDir(), 'build-failed.json')

/** When toast-mac.swift last changed (-1 when it is not there): the version of the app's source. */
function sourceStamp(): number {
  try {
    return statSync(toastSource()).mtimeMs
  } catch {
    return -1
  }
}

/** Why the last build failed, while that holds for the source as it is now; null otherwise. */
function failureOfSource(): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(failedFile(), 'utf8'))
    if (isRecord(value) && value.source === sourceStamp() && typeof value.reason === 'string') return value.reason
  } catch {}
  return null
}

function buildFailed(reason: string): null {
  try {
    mkdirSync(appDir(), { recursive: true })
    writeFileSync(failedFile(), JSON.stringify({ source: sourceStamp(), reason }))
  } catch {}
  return null
}

/** Built, and not older than its source: what a hook uses as it is. */
function builtIsCurrent(): boolean {
  try {
    if (!existsSync(toastBinary()) || !existsSync(join(toastApp(), 'Contents', 'Info.plist'))) return false
    return statSync(toastBinary()).mtimeMs >= statSync(toastSource()).mtimeMs
  } catch {
    return false
  }
}

/**
 * Builds the notification app from toast-mac.swift (swiftc, then an ad-hoc signature and
 * LaunchServices' registration), or null when it cannot be: no Command Line Tools, or swiftc or
 * codesign failing, which is written down (failedFile) with its reason.
 */
export function buildToastApp({ run: runner = run, platform = process.platform }: BuildOptions = {}): string | null {
  if (platform !== 'darwin') return null
  // /usr/bin/swiftc exists without the tools, and running it opens the system's dialog to install them.
  if (!runner('xcode-select', ['-p'], 5_000)) return buildFailed('the Command Line Tools are not installed')
  const app = toastApp()
  const binary = toastBinary()
  // Built beside the binary and renamed over it: a hook that runs meanwhile never gets a half-written one.
  const part = `${binary}.${process.pid}.part`
  mkdirSync(dirname(binary), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), INFO_PLIST)
  const built = runner('swiftc', [
    '-O',
    '-swift-version',
    '5',
    '-o',
    part,
    toastSource(),
    '-framework',
    'AppKit',
    '-framework',
    'UserNotifications',
  ])
  if (!built) {
    rmSync(part, { force: true })
    return buildFailed('swiftc failed')
  }
  renameSync(part, binary)
  if (!runner('codesign', ['-s', '-', '--force', '--deep', app])) {
    // Not left behind: an unsigned binary newer than its source would count as built.
    rmSync(binary, { force: true })
    return buildFailed('codesign failed')
  }
  runner(LSREGISTER, ['-f', app], 15_000)
  rmSync(failedFile(), { force: true })
  return app
}

/**
 * The app, built or rebuilt when this copy's source is newer; null when it cannot be built. A source
 * that failed to build is not tried again (each hook would prompt and wait for nothing) until it
 * changes, or `retry` says to: the install passes it.
 */
export function ensureToastApp(options: EnsureOptions = {}): string | null {
  if (builtIsCurrent()) return toastApp()
  if (!options.retry && failureOfSource() !== null) return null
  return buildToastApp(options)
}

/** For the doctor: whether the app is there and current, and why its last build failed (for this source). */
export function toastAppState(): { built: boolean; failed?: string } {
  const failed = failureOfSource()
  return failed === null ? { built: builtIsCurrent() } : { built: builtIsCurrent(), failed }
}

/** The frontmost app's bundle path, as the helper sees it ('' when it cannot tell). */
export function frontmostApp(): string {
  const binary = toastBinary()
  if (!existsSync(binary)) return ''
  try {
    return execFileSync(binary, ['--frontmost'], { encoding: 'utf8', timeout: 5_000 }).trim()
  } catch {
    return ''
  }
}

/** The bundle of a program's path ("/Applications/iTerm.app/Contents/MacOS/iTerm2" -> "/Applications/iTerm.app"). */
export function appBundleOf(command: string): string {
  return /^(.*\.app)\/Contents\/MacOS\//.exec(command.trim())?.[1] ?? ''
}

/**
 * The app the terminal runs in: the first ancestor of `pid` whose program lives in a bundle. A hook
 * runs inside the session's pane, so its parent chain leads there (shell, herdr, terminal app).
 */
export function terminalAppOf(pid: number, ps: (pid: number) => string = psLine): string {
  let current = pid
  for (let i = 0; i < 20 && current > 1; i++) {
    const line = ps(current).trim()
    if (!line) return ''
    const [parentText, ...rest] = line.split(/\s+/)
    const app = appBundleOf(rest.join(' '))
    if (app) return app
    const parent = Number(parentText)
    if (!Number.isInteger(parent) || parent === current) return ''
    current = parent
  }
  return ''
}

function psLine(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3_000,
    })
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ showing one

/** Where a click lands when herdr, not the board, takes it: the pane's tab and the terminal's app. */
interface PaneRecord {
  tab?: string
  app?: string
  at: number
}

const recordFile = (pane: string): string => join(appDir(), `pane-${pane.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
const pidFile = (pane: string): string => join(appDir(), `pane-${pane.replace(/[^A-Za-z0-9_-]/g, '_')}.pid`)

function paneRecord(pane: string): PaneRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(recordFile(pane), 'utf8'))
    return isRecord(value) ? (value as unknown as PaneRecord) : null
  } catch {
    return null
  }
}

/** The program a pid runs, as ps names it (its full path on macOS); '' when there is no such process. */
function commOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000 }).trim()
  } catch {
    return ''
  }
}

/**
 * Ends the helper of this pane's earlier notification: the new one replaces it in the centre. The
 * pid file outlives the helper and the system hands a pid out again, so the process is signalled
 * only while it still runs our helper; the file goes either way.
 */
export function endEarlier(
  pane: string,
  ps: (pid: number) => string = commOf,
  kill: (pid: number) => void = pid => process.kill(pid),
): void {
  const file = pidFile(pane)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const pid = Number(text.trim())
  try {
    if (Number.isInteger(pid) && pid > 0) {
      const program = ps(pid)
      if (program.includes(toastBinary()) || program.endsWith('/ClaudeToast')) kill(pid)
    }
  } catch {}
  try {
    rmSync(file, { force: true })
  } catch {}
}

export interface Toast {
  pane: string
  title: string
  subtitle: string
  body: string
  tab?: string | null
  app?: string | null
}

/**
 * Starts the helper apart from this process: its pid, or null when it could not run. A program that
 * is missing or not allowed to run says so with an 'error' a moment after spawn; one the system
 * cannot execute, or an argument with a NUL byte, throws at once.
 */
function startHelper(program: string, args: string[]): Promise<number | null> {
  return new Promise(resolve => {
    try {
      const child = spawn(program, args, { detached: true, stdio: 'ignore' })
      child.once('error', () => resolve(null))
      child.once('spawn', () => {
        child.unref()
        resolve(child.pid ?? null)
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * Shows the notification, or herdr's own (`fallback`) when this computer cannot build the app (an
 * older macOS, no Swift toolchain) or the app will not start: that one's click goes to the pane in
 * herdr, not to the board.
 */
export async function showToast(
  toast: Toast,
  fallback: (title: string, body: string) => Promise<void> = notify,
): Promise<void> {
  const herdrsOwn = (): Promise<void> =>
    fallback(toast.title, [toast.subtitle, toast.body].filter(Boolean).join(' — ')).catch(() => {})
  const helper = ensureToastApp()
  if (!helper) return herdrsOwn()
  endEarlier(toast.pane)
  const script = join(ROOT, 'src', 'entrypoints', 'toast.ts')
  const args = [
    '--title',
    toast.title,
    '--subtitle',
    toast.subtitle,
    '--body',
    toast.body,
    '--id',
    toast.pane,
    '--wait',
    String(WAIT_SEC),
    '--click-exe',
    process.execPath,
    '--click-arg',
    script,
    '--click-arg',
    'click',
    '--click-arg',
    toast.pane,
  ]
  const pid = await startHelper(toastBinary(), args)
  if (pid === null) return herdrsOwn()
  mkdirSync(appDir(), { recursive: true })
  writeFileSync(recordFile(toast.pane), JSON.stringify({ tab: toast.tab ?? '', app: toast.app ?? '', at: Date.now() }))
  writeFileSync(pidFile(toast.pane), String(pid))
}

// ------------------------------------------------------------------ a click

/**
 * A click: the board shows that session (its window comes up on the sheet) when it runs and has
 * it; else herdr goes to the pane, and the terminal app comes to the front. Nothing for anything
 * that is not a pane id.
 */
export async function clickThrough(pane: string): Promise<number> {
  if (!isPaneId(pane)) return 0
  const open = join(ROOT, 'src', 'entrypoints', 'web-open.ts')
  if (existsSync(open)) {
    const result = Bun.spawnSync([process.execPath, open, '--pane', pane], { stdout: 'ignore', stderr: 'ignore' })
    if (result.exitCode === 0) return 0
  }
  const record = paneRecord(pane)
  let focused = false
  try {
    await herdr(['agent', 'focus', pane], 5_000)
    focused = true
  } catch {}
  if (!focused && record?.tab) {
    try {
      await herdr(['tab', 'focus', record.tab], 5_000)
    } catch {}
  }
  if (record?.app) spawn('open', ['-a', record.app], { detached: true, stdio: 'ignore' }).unref()
  return 0
}

// ------------------------------------------------------------------ the hook

async function readStdin(): Promise<Record<string, unknown>> {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  try {
    const value: unknown = JSON.parse(data || '{}')
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/** The last assistant text in a transcript, for a Stop payload that came without its words. */
export function lastAssistantText(file: string, read: (file: string) => string = tailOf): string {
  const lines = read(file).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]?.includes('"type":"assistant"')) continue
    try {
      const entry: unknown = JSON.parse(lines[i] ?? '')
      if (!isRecord(entry) || entry.type !== 'assistant' || entry.isSidechain) continue
      const message = isRecord(entry.message) ? entry.message : {}
      const content = Array.isArray(message.content) ? message.content : []
      const texts = content.flatMap(part =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
      )
      if (texts.length) return texts.join('\n')
    } catch {}
  }
  return ''
}

/** The end of a file: transcripts grow to megabytes, and only the last reply is read. */
function tailOf(file: string): string {
  try {
    const fd = openSync(file, 'r')
    try {
      const size = statSync(file).size
      const length = Math.min(size, 512 * 1024)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * A Claude Code hook in a herdr pane: posts the notification unless this pane is the one the user
 * looks at. `force` skips that check, for trying it out from the focused pane.
 */
export async function hookToast({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (process.platform !== 'darwin') return
  if (process.env.HERDR_ENV !== '1') return
  const paneId = process.env.HERDR_PANE_ID ?? ''
  if (!isPaneId(paneId)) return
  const payload = await readStdin()
  if (typeof payload.agent_id === 'string' && payload.agent_id) return
  const message = toastMessage(payload)
  if (!message) return

  const snap = await snapshot().catch(() => null)
  const pane = snap?.panes.find(p => p.pane_id === paneId) ?? null
  // A headless `claude -p` started from inside this pane is not the pane's agent: stay quiet.
  const hosted = typeof pane?.agent_session?.value === 'string' ? pane.agent_session.value : ''
  const session = typeof payload.session_id === 'string' ? payload.session_id : ''
  if (hosted && session && hosted !== session) return

  const app = terminalAppOf(process.pid)
  if (!force && snap && pane && snap.focused_pane_id === pane.pane_id && app && frontmostApp() === app) return

  let text = message.text
  if (!text && typeof payload.transcript_path === 'string') text = lastAssistantText(payload.transcript_path)
  const body = plainText(text, 300) || (message.kind === 'stop' ? 'finished' : '')
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
  await showToast({
    pane: paneId,
    title: toastTitle(snap, paneId, cwd),
    subtitle: message.subtitle,
    body,
    tab: typeof pane?.tab_id === 'string' ? pane.tab_id : null,
    app,
  })
}
