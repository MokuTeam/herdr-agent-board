// The board's own files: its state folder, its config folder and the folder of a tunnel key the
// owner points to outside the state folder. Through the tunnel, the routes that read a file by a
// path the request names refuse these, but for the state folder's `uploads`. Pure: the paths come
// already made real (adapters/own-files.ts).
import { posix, win32 } from 'node:path'

/** Real paths: what is under `allowed` is let through, else what is under `refused` is the board's own. */
export interface OwnFolders {
  refused: string[]
  allowed: string[]
}

/**
 * Windows: a UNC or device path (\\x\y, //x/y, \\?\…, \\.\…, \??\…), or a ':' past the drive
 * letter (an NTFS stream). Such a path can name the board's folders in another spelling
 * (\\localhost\C$\…), and a UNC path makes Windows reach out to that server.
 */
export function oddWindowsPath(path: string): boolean {
  if (/^[\\/]{2}|^[\\/]\?\?[\\/]/.test(path)) return true
  return path.includes(':', /^[A-Za-z]:/.test(path) ? 2 : 0)
}

/** The path as compared: normalized, no trailing separator but a root's, lower case where the file system ignores case. */
function comparable(path: string, platform: string): string {
  const win = platform === 'win32'
  let p = win ? win32.normalize(path) : posix.normalize(path)
  const sep = win ? '\\' : '/'
  while (p.endsWith(sep) && p.length > 1 && !(win && /^[A-Za-z]:\\$/.test(p))) p = p.slice(0, -1)
  return win || platform === 'darwin' ? p.toLowerCase() : p
}

/** `path` is `folder` or inside it: whole segments only, case ignored on win32 and darwin, both separators on win32. */
export function underFolder(path: string, folder: string, platform: string): boolean {
  if (!path || !folder) return false
  const p = comparable(path, platform)
  const f = comparable(folder, platform)
  const sep = platform === 'win32' ? '\\' : '/'
  return p === f || p.startsWith(f.endsWith(sep) ? f : f + sep)
}

/** Under an allowed folder: no; under a refused one: yes. */
export function isOwnFile(realPath: string, folders: OwnFolders, platform: string): boolean {
  if (folders.allowed.some(folder => underFolder(realPath, folder, platform))) return false
  return folders.refused.some(folder => underFolder(realPath, folder, platform))
}
