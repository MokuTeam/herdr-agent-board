// The macOS notification app in the board's state folder: where it is, and whether it is built and
// current with its source, or why its last build failed. integrations/toast-mac.ts builds and runs
// it; the setup check (adapters/setup-facts.ts) reads its state from here.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from './json-store.ts'
import { ROOT, stateDir } from './paths.ts'

export const toastAppDir = (): string => join(stateDir(), 'toast')
export const toastApp = (): string => join(toastAppDir(), 'ClaudeToast.app')
export const toastBinary = (): string => join(toastApp(), 'Contents', 'MacOS', 'ClaudeToast')
export const toastSource = (): string => join(ROOT, 'src', 'integrations', 'toast-mac.swift')

/** Written when a build fails: for which version of the source, and why. A hook does not try that source again. */
export const toastFailedFile = (): string => join(toastAppDir(), 'build-failed.json')

/** When toast-mac.swift last changed (-1 when it is not there): the version of the app's source. */
export function toastSourceStamp(): number {
  try {
    return statSync(toastSource()).mtimeMs
  } catch {
    return -1
  }
}

/** Why the last build failed, while that holds for the source as it is now; null otherwise. */
export function toastBuildFailure(): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(toastFailedFile(), 'utf8'))
    if (isRecord(value) && value.source === toastSourceStamp() && typeof value.reason === 'string') return value.reason
  } catch {}
  return null
}

/** Built, and not older than its source: what a hook uses as it is. */
export function toastAppCurrent(): boolean {
  try {
    if (!existsSync(toastBinary()) || !existsSync(join(toastApp(), 'Contents', 'Info.plist'))) return false
    return statSync(toastBinary()).mtimeMs >= statSync(toastSource()).mtimeMs
  } catch {
    return false
  }
}

/** For the doctor: whether the app is there and current, and why its last build failed (for this source). */
export function toastAppState(): { built: boolean; failed?: string } {
  const failed = toastBuildFailure()
  return failed === null ? { built: toastAppCurrent() } : { built: toastAppCurrent(), failed }
}
