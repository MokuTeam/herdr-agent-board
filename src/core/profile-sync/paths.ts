// Paths in the profile sync (the board-on-own-server spec's "Next step: syncing the Claude
// profiles"): Claude's name for a project's folder under projects/, a path as each side writes
// it, a project on one side paired with its clone on the other by git remote, and the paths the
// files carry (`cwd` in a transcript, history.jsonl's `project`) moved to the other side's. Pure:
// the page shows the pairs from it too.

/** A side's system, as process.platform names it. */
export type Platform = string

/** A project's path on the source moved to the target's (a pair). */
export interface Move {
  from: string
  to: string
}

/** Claude's own: a folder name under projects/ is cut here, and a hash of the path goes after it. */
export const MAX_FOLDER = 200

/** Claude's short hash of a long path: 32-bit, as a positive number in base 36. */
export function shortHash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

/**
 * Claude's folder under projects/ for a project's path, as Claude names it: every character but
 * a-z, A-Z and 0-9 is a `-` (C:\migo\x is C--migo-x, /home/agent/x is -home-agent-x; each letter
 * of another alphabet one `-` too); past 200 characters it is cut, and a hash of the path follows.
 */
export function projectFolder(path: string): string {
  const name = path.replace(/[^a-zA-Z0-9]/g, '-')
  return name.length <= MAX_FOLDER ? name : `${name.slice(0, MAX_FOLDER)}-${shortHash(path)}`
}

/** A Windows path as Windows writes it: C:\a\b, from C:/a/b or Git Bash's /c/a/b too. */
export function winPath(p: string): string {
  const bash = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  const s = bash ? `${(bash[1] as string).toUpperCase()}:${bash[2] ?? '/'}` : p
  return s.replace(/\//g, '\\')
}

/** A path as a side of `platform` writes it. */
export const nativePath = (p: string, platform: Platform): string => (platform === 'win32' ? winPath(p) : p)

/** A path for comparing: as written there, forward slashes, no trailing one, lower case on Windows. */
export function pathKey(p: string, platform: Platform): string {
  const n = nativePath(p, platform)
    .replace(/\\/g, '/')
    .replace(/(.)\/+$/, '$1')
  return platform === 'win32' ? n.toLowerCase() : n
}

/** What follows `root` in `p` ('/' between its parts): '' for root itself; null when `p` is not inside it. */
export function under(p: string, root: string, platform: Platform): string | null {
  const a = pathKey(p, platform)
  const b = pathKey(root, platform)
  if (a === b) return ''
  const inside = b.endsWith('/') ? a.startsWith(b) : a.startsWith(`${b}/`)
  if (!inside) return null
  return nativePath(p, platform)
    .replace(/\\/g, '/')
    .slice(b.length + (b.endsWith('/') ? 0 : 1))
}

/** `rest` ('/' between its parts) below `root`, as a side of `platform` writes it. */
export function joinPath(root: string, rest: string, platform: Platform): string {
  if (rest === '') return root
  const sep = platform === 'win32' ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rest.split('/').join(sep)}`
}

/** A path on the source as the target writes it, by the first move it is inside of (the longest first); null outside them all. */
export function moved(p: string, moves: readonly Move[], from: Platform, to: Platform): string | null {
  for (const m of moves) {
    const rest = under(p, m.from, from)
    if (rest !== null) return joinPath(m.to, rest, to)
  }
  return null
}

/** Moves with the longest source path first, so a project inside another is moved by its own pair. */
export const byDepth = (moves: readonly Move[]): Move[] => [...moves].sort((a, b) => b.from.length - a.from.length)

/**
 * A git remote for comparing: host and path, lower case, without scheme, user, port, `.git` or a
 * trailing slash; git@github.com:a/b.git and https://github.com/a/b are one. A remote on a disk
 * (a path, file://) is none: it names no clone on the other side.
 */
export function remoteKey(url: string | null | undefined): string | null {
  const u = (url ?? '').trim()
  if (!u || /^file:/i.test(u) || /^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('/') || u.startsWith('.')) return null
  const tidy = (host: string, path: string): string | null => {
    const p = path
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .replace(/^\/+/, '')
    return host && p ? `${host.toLowerCase()}/${p.toLowerCase()}` : null
  }
  const url1 = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u)
  if (url1) return tidy(url1[1] as string, url1[2] as string)
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(u)
  return scp ? tidy(scp[1] as string, scp[2] as string) : null
}

/** A project folder of a profile as its side found it. */
export interface ProjectFact {
  profile: string
  folder: string
  /** Its path, from its transcripts' `cwd` or .claude.json; null when neither names it. */
  path: string | null
  /** git: a clone (or inside one); plain: a folder, no git; gone: not there; unknown: no path. */
  state: 'git' | 'plain' | 'gone' | 'unknown'
  remote: string | null
  /** The clone's top folder, when in one. */
  top: string | null
  /** A worktree of a clone, not the clone itself. */
  worktree: boolean
  files: number
  bytes: number
}

/** A clone a side has (the server: found under the board's user's home; a PC: its projects' own). */
export interface CloneFact {
  path: string
  remote: string
}

export interface Pair {
  profile: string
  folder: string
  from: string
  to: string
  /** The folder's name on the target: Claude's for `to`, or the one already there for it. */
  toFolder: string
  how: 'remote' | 'owner' | 'same'
}

export type UnpairedWhy = 'unknown' | 'gone' | 'noRemote' | 'noClone' | 'worktree' | 'taken' | 'left'

export interface Unpaired {
  profile: string
  folder: string
  path: string | null
  why: UnpairedWhy
  files: number
  bytes: number
}

/** The key of a project folder: `<profile>/<folder>`. */
export const projectKey = (p: { profile: string; folder: string }): string => `${p.profile}/${p.folder}`

/** The folder a target path gets: one already there for it (a long one with its hash), else Claude's name. */
export function folderFor(to: string, there: readonly string[]): string {
  const name = projectFolder(to)
  if (name.length <= MAX_FOLDER || there.includes(name)) return name
  const prefix = `${name.slice(0, MAX_FOLDER)}-`
  return there.find(f => f.startsWith(prefix)) ?? name
}

/**
 * Each source project paired with its place on the target: the path the owner gave (null: left
 * out); else the target's clone with the same remote (the project's place inside its clone kept);
 * else the same path, when the target has a project there. A worktree goes only where the owner
 * gives it a path (its clone's own folder is the clone's). Two projects for one folder: the first
 * keeps it. The rest are listed, with why.
 */
export function pairProjects(o: {
  source: { platform: Platform; projects: readonly ProjectFact[] }
  target: {
    platform: Platform
    projects: readonly ProjectFact[]
    clones: readonly CloneFact[]
    /** The target's project folders, by profile. */
    folders: Readonly<Record<string, readonly string[]>>
  }
  given: Readonly<Record<string, string | null>>
}): { pairs: Pair[]; unpaired: Unpaired[] } {
  const { source, target, given } = o
  const clones = new Map<string, string[]>()
  const addClone = (path: string, remote: string | null): void => {
    const key = remoteKey(remote)
    if (!key) return
    const list = clones.get(key) ?? []
    if (!list.some(p => pathKey(p, target.platform) === pathKey(path, target.platform))) list.push(path)
    clones.set(key, list)
  }
  for (const c of target.clones) addClone(c.path, c.remote)
  for (const p of target.projects) if (p.top && !p.worktree) addClone(p.top, p.remote)
  for (const list of clones.values()) list.sort((a, b) => a.length - b.length || a.localeCompare(b))
  const targetPaths = new Set(target.projects.flatMap(p => (p.path ? [pathKey(p.path, target.platform)] : [])))

  const pairs: Pair[] = []
  const unpaired: Unpaired[] = []
  const taken = new Set<string>()
  const ordered = [...source.projects].sort(
    (a, b) => Number(a.worktree) - Number(b.worktree) || (a.path ?? '').localeCompare(b.path ?? ''),
  )
  for (const p of ordered) {
    const key = projectKey(p)
    const left = (why: UnpairedWhy): void => {
      unpaired.push({ profile: p.profile, folder: p.folder, path: p.path, why, files: p.files, bytes: p.bytes })
    }
    let to: string | null = null
    let how: Pair['how'] = 'remote'
    if (key in given) {
      const g = given[key] ?? null
      if (g === null) {
        left('left')
        continue
      }
      to = g
      how = 'owner'
    } else if (p.path === null) {
      left('unknown')
      continue
    } else if (p.state === 'gone') {
      left('gone')
      continue
    } else if (p.worktree) {
      left('worktree')
      continue
    } else {
      const found = clones.get(remoteKey(p.remote) ?? '')?.[0]
      if (found !== undefined && p.top) {
        const rest = under(p.path, p.top, source.platform)
        to = joinPath(found, rest ?? '', target.platform)
      } else if (
        source.platform !== 'win32' &&
        target.platform !== 'win32' &&
        targetPaths.has(pathKey(p.path, target.platform))
      ) {
        to = p.path
        how = 'same'
      } else {
        left(p.state === 'git' && remoteKey(p.remote) ? 'noClone' : 'noRemote')
        continue
      }
    }
    const toFolder = folderFor(to, target.folders[p.profile] ?? [])
    const slot = `${p.profile}/${toFolder}`
    if (taken.has(slot)) {
      left('taken')
      continue
    }
    taken.add(slot)
    pairs.push({ profile: p.profile, folder: p.folder, from: p.path ?? '', to, toFolder, how })
  }
  return { pairs, unpaired }
}

/** A path the owner typed for the target: absolute as the target writes one; null when it is not. */
export function givenPath(text: string, platform: Platform): string | null {
  const s = text.trim().replace(/[\\/]+$/, '')
  if (s === '' || /[\0\r\n]/.test(s)) return null
  if (platform === 'win32') return /^[a-zA-Z]:\\/.test(winPath(s)) || /^[a-zA-Z]:$/.test(s) ? winPath(s) : null
  return s.startsWith('/') && !s.includes('\\') ? s : null
}
