// A calendar reminder on the desktop (#335), from the web board's process. Windows: a toast through
// toast.ps1's `reminder` action (the reminder as JSON on stdin), with Join (the meeting's link
// itself) or Open, Snooze and At start; its buttons that are not a link come back through the
// claude-pane: protocol as `claude-pane:cal/<act>/<id>` to entrypoints/web-open.ts --reminder.
// macOS: the notification helper the session toasts use (integrations/toast-mac.ts), once it is
// built, its click Join (the link, opened by `open`) or Open; the helper takes no buttons, so
// Snooze is on the page.
// Anywhere else, or a Mac that cannot build the helper: herdr's own notification, its words only.
// Nothing here waits on the notification: a program that fails is logged and the reminder stays
// on the page.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { notify } from '../adapters/herdr.ts'
import { ROOT } from '../adapters/paths.ts'
import { powershellBin } from '../adapters/secret-sinks.ts'
import { toastAppCurrent, toastBinary } from '../adapters/toast-app.ts'
import { startHelper } from './toast-mac.ts'

/** A reminder as a notification shows it, its words already in the board's language. */
export interface ReminderToast {
  id: string
  title: string
  /** When: "in 10 min · 14:30 - 15:00". */
  body: string
  /** Whose calendar: the source's label. */
  whose: string
  join?: string | undefined
  /** When it stops mattering (ms): the toast goes from the notification centre then. */
  expires: number
  labels: { join: string; open: string; snooze: string; start?: string | undefined }
}

export interface ReminderDesktop {
  show(toast: ReminderToast): void
  /** The reminder was acted on elsewhere (the page, another button): its toast goes. */
  clear(id: string): void
}

const toastScript = (): string => join(ROOT, 'src', 'integrations', 'toast.ps1')
const webOpen = (): string => join(ROOT, 'src', 'entrypoints', 'web-open.ts')

/** Runs a program on its own, stdin given, nothing awaited; a failure to start is logged. */
function launch(program: string, args: string[], input: string | null, log: (msg: string) => void): void {
  try {
    const child = spawn(program, args, {
      stdio: [input === null ? 'ignore' : 'pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    child.once('error', err => log(`reminder notification: ${err.message}`))
    if (input !== null) child.stdin?.end(input)
    child.unref()
  } catch (err) {
    log(`reminder notification: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

export function windowsDesktop(log: (msg: string) => void, bin: string = powershellBin()): ReminderDesktop {
  return {
    show(toast) {
      launch(bin, [...PS_ARGS, toastScript(), 'reminder'], JSON.stringify(toast), log)
    },
    clear(id) {
      launch(bin, [...PS_ARGS, toastScript(), 'reminder-clear', id], null, log)
    },
  }
}

export function macDesktop(log: (msg: string) => void): ReminderDesktop {
  return {
    show(toast) {
      const herdrs = () =>
        void notify(toast.title, `${toast.body} · ${toast.whose}`).catch(err =>
          log(`reminder notification: ${err instanceof Error ? err.message : String(err)}`),
        )
      // built by the install or a session's first toast: the board's process never builds it (a
      // build holds it up to two minutes)
      if (!toastAppCurrent()) return herdrs()
      const click = toast.join
        ? ['--click-exe', '/usr/bin/open', '--click-arg', toast.join]
        : ['--click-exe', process.execPath, '--click-arg', webOpen(), '--click-arg', '--reminder']
      const args = [
        '--title',
        toast.title,
        '--subtitle',
        toast.whose,
        '--body',
        toast.body,
        '--id',
        `cal-${toast.id}`,
        '--wait',
        '600',
        ...click,
        ...(toast.join ? [] : ['--click-arg', 'open', '--click-arg', toast.id]),
      ]
      void startHelper(toastBinary(), args).then(pid => {
        if (pid === null) herdrs()
      })
    },
    // the helper's notification stays in the centre until it is clicked or cleared there
    clear() {},
  }
}

export function herdrDesktop(log: (msg: string) => void): ReminderDesktop {
  return {
    show(toast) {
      notify(toast.title, `${toast.body} · ${toast.whose}`).catch(err =>
        log(`reminder notification: ${err instanceof Error ? err.message : String(err)}`),
      )
    },
    clear() {},
  }
}

/** The desktop's notifications on this platform. */
export function reminderDesktop(log: (msg: string) => void, platform: string = process.platform): ReminderDesktop {
  if (platform === 'win32' && existsSync(toastScript())) return windowsDesktop(log)
  if (platform === 'darwin') return macDesktop(log)
  return herdrDesktop(log)
}
