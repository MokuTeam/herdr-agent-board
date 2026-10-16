import { symlinkSync } from 'node:fs'

export const SYMLINK_SKIP_REASON = 'symlinks need Developer Mode or admin on Windows'

/** Creates a symlink; false when the OS refuses it (EPERM on Windows without Developer Mode). */
export function symlinkOrSkip(target: string, path: string): boolean {
  try {
    symlinkSync(target, path)
    return true
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EPERM') return false
    throw err
  }
}
