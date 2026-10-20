// The board's own files on this PC (core/own-files.ts): the folders as real paths, and the check
// the tunnel listener's routes ask before they read a file by a path the request names. Real paths
// on both sides, so a link, a junction, another case or an 8.3 short name is seen for what it is.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { isOwnFile, type OwnFolders, oddWindowsPath, underFolder } from '../core/own-files.ts'
import { tunnelConfig } from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'
import { configDir, stateDir, uploadsDir } from './paths.ts'

/** realpathSync.native of the path, or of its nearest existing parent with the rest joined back. */
export function realOrNearest(path: string): string {
  const full = resolve(path)
  const rest: string[] = []
  for (let at = full; ; ) {
    try {
      return join(realpathSync.native(at), ...rest)
    } catch {
      // missing, or not to be made real (a file in the middle, a NUL): its parent says where it is
      const up = dirname(at)
      if (up === at) return full
      rest.unshift(basename(at))
      at = up
    }
  }
}

/** The key's path as ssh reads it: `~` is the home folder, a relative path is from the working folder. */
const keyFile = (key: string): string => resolve(/^~(?=$|[\\/])/.test(key) ? homedir() + key.slice(1) : key)

/** The key's folder as a real path; on a share, as it is (what is under it is refused as a UNC path anyway, without a call to that server). */
function keyFolder(key: string): string {
  const folder = dirname(keyFile(key))
  return process.platform === 'win32' && oddWindowsPath(folder) ? folder : realOrNearest(folder)
}

/** Two real paths name the same folder. */
const same = (a: string, b: string): boolean =>
  underFolder(a, b, process.platform) && underFolder(b, a, process.platform)

/**
 * refused: real stateDir(), configDir(), and the key's folder when tunnel.key is set and outside
 * stateDir(); allowed: real uploadsDir(), while it is the state folder's own `uploads` and no link
 * elsewhere. A folder not made yet counts by its resolved path.
 */
export function ownFolders(cfg: Config): OwnFolders {
  const state = realOrNearest(stateDir())
  const refused = [state, realOrNearest(configDir())]
  const { key } = tunnelConfig(cfg.tunnel)
  if (key) {
    const folder = keyFolder(key)
    if (!underFolder(folder, state, process.platform)) refused.push(folder)
  }
  const uploads = realOrNearest(uploadsDir())
  const allowed = same(uploads, join(state, relative(stateDir(), uploadsDir()))) ? [uploads] : []
  return { refused, allowed }
}

/**
 * Whether `target` is one of the board's own files. On win32 a UNC, device or stream path is,
 * before any file-system call (one on a UNC path would reach that server); so is a path whose
 * real path is one (a mapped network drive can name the board's folders as \\localhost\C$\…).
 * The folders are read at each call: config.json can change.
 */
export function ownFileCheck(cfg: Config, platform: string = process.platform): (target: string) => boolean {
  const odd = (path: string): boolean => platform === 'win32' && oddWindowsPath(path)
  return target => {
    if (odd(target)) return true
    const full = resolve(target)
    if (odd(full)) return true
    const real = realOrNearest(full)
    return odd(real) || isOwnFile(real, ownFolders(cfg), platform)
  }
}
