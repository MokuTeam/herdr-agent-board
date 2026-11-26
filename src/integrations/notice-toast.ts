// Plain board notices on the desktop (#897): Windows via toast.ps1 (`notice`), macOS via
// toast-mac, elsewhere via herdr's notification. Nothing here waits on the notification.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { notify } from '../adapters/herdr.ts'
import { ROOT } from '../adapters/paths.ts'
import { powershellBin } from '../adapters/secret-sinks.ts'
import { toastAppCurrent, toastBinary } from '../adapters/toast-app.ts'
import { startHelper } from './toast-mac.ts'

export interface NoticeToast {
  id: string
  title: string
  body: string
}

export interface NoticeDesktop {
  show(toast: NoticeToast): void
}

const toastScript = (): string => join(ROOT, 'src', 'integrations', 'toast.ps1')
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

function launch(program: string, args: string[], input: string, log: (msg: string) => void): void {
  try {
    const child = spawn(program, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.once('error', err => log(`notice notification: ${err.message}`))
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
    child.unref()
  } catch (err) {
    log(`notice notification: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const herdrs = (toast: NoticeToast, log: (msg: string) => void): void =>
  void notify(toast.title, toast.body).catch(err =>
    log(`notice notification: ${err instanceof Error ? err.message : String(err)}`),
  )

export function windowsNoticeDesktop(log: (msg: string) => void, bin: string = powershellBin()): NoticeDesktop {
  return { show: toast => launch(bin, [...PS_ARGS, toastScript(), 'notice'], JSON.stringify(toast), log) }
}

export function macNoticeDesktop(log: (msg: string) => void): NoticeDesktop {
  return {
    show(toast) {
      if (!toastAppCurrent()) return herdrs(toast, log)
      const args = ['--title', toast.title, '--body', toast.body, '--id', toast.id, '--wait', '600']
      void startHelper(toastBinary(), args).then(pid => {
        if (pid === null) herdrs(toast, log)
      })
    },
  }
}

export const herdrNoticeDesktop = (log: (msg: string) => void): NoticeDesktop => ({
  show: toast => herdrs(toast, log),
})

/** The desktop's notice presenter on this platform. */
export function noticeDesktop(log: (msg: string) => void, platform: string = process.platform): NoticeDesktop {
  if (platform === 'win32' && existsSync(toastScript())) return windowsNoticeDesktop(log)
  if (platform === 'darwin') return macNoticeDesktop(log)
  return herdrNoticeDesktop(log)
}
