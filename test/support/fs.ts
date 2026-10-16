import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SYMLINK_SKIP_REASON = 'symlinks need Developer Mode or admin on Windows'

/** Whether this OS lets us create symlinks (EPERM on Windows without Developer Mode), probed once. */
function probeSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'board-symlink-probe-'))
  try {
    symlinkSync(dir, join(dir, 'link'))
    return true
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EPERM') return false
    throw err
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
export const canSymlink: boolean = probeSymlinks()
