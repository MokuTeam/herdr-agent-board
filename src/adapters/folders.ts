// Folders for the new-session window's picker: where browsing starts and what is inside a folder.
import type { Dirent, Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { resolvePath } from './files.ts'
import { gitInfo } from './git.ts'

// A path someone typed can be a share that is offline: no file-system call on it may hold the
// board up. Each one gives up after `ms` and says so (SLOW).
export const SLOW = Symbol('slow')
export const within = <T>(promise: Promise<T>, ms: number): Promise<T | typeof SLOW> =>
  Promise.race([promise, new Promise<typeof SLOW>(r => setTimeout(r, ms, SLOW).unref?.())])
export const statOf = (path: string, ms = 2000): Promise<Stats | null | typeof SLOW> =>
  within(
    stat(path).catch(() => null),
    ms,
  )

export interface Root {
  name: string
  path: string
}

let rootsCache: { at: number; list: Root[] } = { at: 0, list: [] }

/** Where browsing starts: home, and every drive on Windows. */
export async function roots(): Promise<Root[]> {
  if (Date.now() - rootsCache.at < 30_000) return rootsCache.list
  const drives = process.platform === 'win32' ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'] : []
  const found = await Promise.all(
    drives.map(async (l): Promise<Root | null> => {
      const st = await statOf(`${l}:\\`, 400)
      return st && st !== SLOW && st.isDirectory() ? { name: `${l}:`, path: `${l}:\\` } : null
    }),
  )
  const list: Root[] = [
    { name: '~', path: homedir() },
    ...(process.platform === 'win32' ? found.filter((r): r is Root => r !== null) : [{ name: '/', path: '/' }]),
  ]
  rootsCache = { at: Date.now(), list }
  return list
}

const SYSTEM_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  '$windows.~bt',
  '$windows.~ws',
  'config.msi',
  'recovery',
])

export interface DirListing {
  path: string
  exists: boolean
  dir?: boolean
  slow?: boolean
  roots?: Root[]
  entries?: string[]
  truncated?: boolean
  parent?: string
  sep?: string
  error?: string | null
  git?: { root: string; branch: string } | null
}

const isDir = (st: Stats | null | typeof SLOW | undefined): boolean => !!st && st !== SLOW && st.isDirectory()

/**
 * The subfolders of a folder (only folders), for the picker's columns and completion; '' lists
 * the roots. `git` also tells the checkout the folder is in, for the worktree option. `slow`:
 * the folder did not answer in time (an offline share), which is not the same as missing.
 */
export async function listDirs(raw: unknown, { git = false }: { git?: boolean } = {}): Promise<DirListing> {
  if (!String(raw ?? '').trim()) return { path: '', exists: true, dir: true, roots: await roots(), entries: [] }
  const { path } = resolvePath(raw)
  if (!path) return { path: String(raw), exists: false }
  const st = await statOf(path)
  if (st === SLOW) return { path, exists: false, slow: true }
  if (!st) return { path, exists: false }
  if (!st.isDirectory()) return { path, exists: true, dir: false }
  let entries: string[] = []
  let error: string | null = null
  try {
    const dirents = await within(readdir(path, { withFileTypes: true }), 4000)
    if (dirents === SLOW) throw Object.assign(new Error('slow'), { code: 'SLOW' })
    const linked = await Promise.all(
      dirents.map(
        async (d: Dirent) => d.isDirectory() || (d.isSymbolicLink() && isDir(await statOf(join(path, d.name), 1000))),
      ),
    )
    entries = dirents
      .filter((_, i) => linked[i] === true)
      .map(d => d.name)
      .filter(n => !SYSTEM_DIRS.has(n.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    error = e.code === 'EPERM' || e.code === 'EACCES' ? 'denied' : e.code === 'SLOW' ? 'slow' : e.message
  }
  const up = dirname(path)
  const out: DirListing = {
    path,
    exists: true,
    dir: true,
    entries: entries.slice(0, 2000),
    truncated: entries.length > 2000,
    parent: up !== path ? up : '',
    sep,
    error,
  }
  if (git) out.git = await gitInfo(path)
  return out
}
