// What may leave this computer (design: docs/design/nodes, 8.4). The board can choose where a
// process runs; it cannot make a folder exist on another machine. So a task goes anywhere but
// the device that has its folder only when its inputs travel: the code in git, pushed, and a
// first message that names no file of this computer. The rule over facts handed in; git reads
// them (adapters/git.ts), the placer asks (services/nodes/placer.ts).

/** Why a task stays on the device that has its folder; the page turns it into the card's one line. */
export type PortableWhy =
  | { kind: 'lane' } // the lane is not one `nodes.lanes` lets leave
  | { kind: 'no-remote' } // not in a git checkout, or the checkout has no remote
  | { kind: 'changes' } // the tree has changes (untracked files included)
  | { kind: 'unpushed' } // HEAD is not its upstream: commits not pushed, or no upstream at all
  | { kind: 'base-unpushed'; branch: string } // the new worktree's branch is not its remote branch
  | { kind: 'local-path'; path: string } // the brief names a path that exists on this computer

export type Portable = { ok: true } | { ok: false; why: PortableWhy }

/** `nodes.lanes` as the config gives it: lane ids, `"all"`, or absent (none leave). */
export type Lanes = 'all' | readonly string[] | null | undefined

export interface PortableFacts {
  lane: string
  lanes: Lanes
  /** The checkout the folder is in, or null when it is in none. */
  checkout: {
    /** The remote's address (any form, a local path too), or null when the checkout has none. */
    remote: string | null
    clean: boolean
    /** HEAD equals its upstream. */
    headPushed: boolean
  } | null
  /** The task asks for a new worktree from this branch: whether the branch equals its remote branch. */
  worktree: { branch: string; pushed: boolean } | null
  /** The first message, as the session will get it. */
  brief: string
  /** Whether a path exists on this computer: asked only for what pathsIn finds, at most 20 times. */
  exists: (path: string) => boolean
}

/**
 * Whether a lane's sessions may run on another device. Absent or empty lanes: none. Lane ids are
 * compared trimmed and in lower case, as config.json may write them either way.
 */
export function laneLeaves(lane: string, lanes: Lanes): boolean {
  if (lanes === 'all') return true
  if (!Array.isArray(lanes)) return false
  const id = lane.trim().toLowerCase()
  return lanes.some(l => typeof l === 'string' && l.trim().toLowerCase() === id)
}

/**
 * The rule of 8.4, cheapest first: the lane, then git, then the brief's paths (the only step that
 * touches the disk, through `exists`). A new worktree starts from its branch, so the tree's own
 * changes and HEAD do not matter then.
 */
export function portable(facts: PortableFacts): Portable {
  if (!laneLeaves(facts.lane, facts.lanes)) return no({ kind: 'lane' })
  const c = facts.checkout
  if (!c?.remote) return no({ kind: 'no-remote' })
  if (facts.worktree) {
    if (!facts.worktree.pushed) return no({ kind: 'base-unpushed', branch: facts.worktree.branch })
  } else {
    if (!c.clean) return no({ kind: 'changes' })
    if (!c.headPushed) return no({ kind: 'unpushed' })
  }
  for (const path of pathsIn(facts.brief)) if (facts.exists(path)) return no({ kind: 'local-path', path })
  return { ok: true }
}

const no = (why: PortableWhy): Portable => ({ ok: false, why })

/** At most this many paths are taken from a brief. */
export const MAX_PATHS = 20

// A path ends at whitespace, a quote, a backtick or a bracket; the sentence's punctuation after it
// is not part of it. A quoted path may hold spaces and ends at its closing quote.
const CHARS = String.raw`[^\s"'\`<>()\[\]{}|]`
const DRIVE = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]`
const UNC = String.raw`\\\\[^\s\\/"'\`<>|]+[\\/][^\s\\/"'\`<>|]+`
// POSIX: a slash at the start of a word, not two (a URL's `//`, after its scheme) and not after a
// letter, digit or dot (`a/b`, `./x`, a URL's own path).
const POSIX = String.raw`(?<![A-Za-z0-9._~\-/\\:])/(?=[^\s/])`
const QUOTED = new RegExp(String.raw`(["'\`])((?:${DRIVE}|${UNC}|${POSIX})[^"'\`\r\n]*)\1`, 'g')
const BARE = new RegExp(`(?:${DRIVE}|${UNC}|${POSIX})${CHARS}*`, 'g')
const TRAILING = /[.,;:!?]+$/
// `x.ts:42` or `x.ts:42:7`: a place in the file, not part of its name.
const LINE = /(?::\d+){1,2}$/

/**
 * Absolute paths in a text, by shape alone, in the order they appear, each once and at most
 * MAX_PATHS: Windows (`C:\x`, `C:/x`, UNC `\\host\share`) and POSIX (`/x`). Nothing is looked
 * up: whether one exists is the caller's question.
 */
export function pathsIn(text: string): string[] {
  const found: { at: number; path: string }[] = []
  const taken: [number, number][] = []
  for (const m of text.matchAll(QUOTED)) {
    found.push({ at: m.index, path: (m[2] ?? '').replace(LINE, '') })
    taken.push([m.index, m.index + m[0].length])
  }
  for (const m of text.matchAll(BARE)) {
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue
    const path = m[0].replace(TRAILING, '').replace(LINE, '').replace(TRAILING, '')
    if (path.length > 1 && !/^[A-Za-z]:[\\/]?$/.test(path)) found.push({ at: m.index, path })
  }
  const out: string[] = []
  for (const { path } of found.sort((a, b) => a.at - b.at)) {
    if (!out.includes(path)) out.push(path)
    if (out.length === MAX_PATHS) break
  }
  return out
}

// What a node may make a folder of: a host of letters, digits, dots and dashes; path segments of
// letters, digits, dots, dashes and underscores that do not start with a dot or a dash.
const HOST = /^[A-Za-z0-9.-]+$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/**
 * A remote's address as host/path, the name a node gives its checkout
 * (`<workRoot>/<host>/<path>`): `https://github.com/a/b.git`, `git@github.com:a/b` and
 * `ssh://git@github.com:22/a/b` are all `github.com/a/b`. Strict, since it becomes a folder on
 * another machine: anything outside HOST and SEGMENT is null, and so is a path on this computer
 * (a local bare repository, `file://`), which has no host.
 */
export function repoAddress(url: string): string | null {
  const u = url.trim()
  let host = ''
  let path = ''
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d*)?(\/.*)?$/i.exec(u)
  const scp = /^(?:[^@/\\]+@)?([^/:\\]{2,}):(?!\/\/)(.+)$/.exec(u)
  if (withScheme) {
    const [, scheme = '', h = '', p = ''] = withScheme
    if (scheme.toLowerCase() === 'file') return null
    host = h
    path = p
  } else if (scp) {
    const [, h = '', p = ''] = scp
    host = h
    path = p
  } else return null
  if (!HOST.test(host)) return null
  const segments = path
    .replace(/^\/|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/')
  if (!segments.every(s => SEGMENT.test(s))) return null
  return `${host.toLowerCase()}/${segments.join('/')}`
}
