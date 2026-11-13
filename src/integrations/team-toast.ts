// A team message on the desktop (#355), from the web board's process. Windows: a toast through
// toast.ps1's `team` action (the toast as JSON on stdin), under the board's own app id; a click
// opens claude-pane:team/<thread key>, which toast.ps1 hands to entrypoints/web-open.ts --team: the
// board's window comes up on that thread. macOS: the notification helper the session toasts use
// (integrations/toast-mac.ts), its click to web-open.ts --team. Anywhere else, or a Mac that
// cannot build the helper: herdr's own notification, its words only. Nothing here waits on the
// notification: a program that fails is logged, and the message is in the panel either way.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { notify } from '../adapters/herdr.ts'
import { ROOT } from '../adapters/paths.ts'
import { powershellBin } from '../adapters/secret-sinks.ts'
import { toastAppCurrent, toastBinary } from '../adapters/toast-app.ts'
import { startHelper } from './toast-mac.ts'

/** A team message as a notification shows it. */
export interface TeamToast {
  /** The message's id: a newer toast for it replaces the older. */
  id: string
  /** Its thread's key, which a click opens. */
  thread: string
  /** Who: the name this board knows the sender by. */
  title: string
  /** The start of the text, or a line in the board's language when it is held. */
  body: string
  /** The attribution line: "Team". */
  label: string
}

export interface TeamDesktop {
  show(toast: TeamToast): void
}

const toastScript = (): string => join(ROOT, 'src', 'integrations', 'toast.ps1')
const webOpen = (): string => join(ROOT, 'src', 'entrypoints', 'web-open.ts')
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

function launch(program: string, args: string[], input: string, log: (msg: string) => void): void {
  try {
    const child = spawn(program, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.once('error', err => log(`team notification: ${err.message}`))
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
    child.unref()
  } catch (err) {
    log(`team notification: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const herdrs = (toast: TeamToast, log: (msg: string) => void): void =>
  void notify(toast.title, toast.body).catch(err =>
    log(`team notification: ${err instanceof Error ? err.message : String(err)}`),
  )

export function windowsTeamDesktop(log: (msg: string) => void, bin: string = powershellBin()): TeamDesktop {
  return { show: toast => launch(bin, [...PS_ARGS, toastScript(), 'team'], JSON.stringify(toast), log) }
}

export function macTeamDesktop(log: (msg: string) => void): TeamDesktop {
  return {
    show(toast) {
      // built by the install or a session's first toast: the board's process never builds it
      if (!toastAppCurrent()) return herdrs(toast, log)
      const args = [
        '--title',
        toast.title,
        '--subtitle',
        toast.label,
        '--body',
        toast.body,
        '--id',
        `team-${toast.id}`,
        '--wait',
        '600',
        '--click-exe',
        process.execPath,
        '--click-arg',
        webOpen(),
        '--click-arg',
        '--team',
        '--click-arg',
        toast.thread,
      ]
      void startHelper(toastBinary(), args).then(pid => {
        if (pid === null) herdrs(toast, log)
      })
    },
  }
}

export const herdrTeamDesktop = (log: (msg: string) => void): TeamDesktop => ({ show: toast => herdrs(toast, log) })

/** The desktop's notifications on this platform. */
export function teamDesktop(log: (msg: string) => void, platform: string = process.platform): TeamDesktop {
  if (platform === 'win32' && existsSync(toastScript())) return windowsTeamDesktop(log)
  if (platform === 'darwin') return macTeamDesktop(log)
  return herdrTeamDesktop(log)
}
