// Who answers on the board's port (#356). An old board server left running from another checkout
// (a worktree's `bun src/entrypoints/server.ts`) holds the port, and this install's board cannot
// listen there: the board command then talks to that old one. The facts come from the system and
// from the server itself (adapters/port-owner.ts); this decides whether they are this install's
// board and words them.
import type { SetupCheck } from './setup.ts'
import type { Translator } from './types.ts'

export interface PortOwner {
  pid: number
  /** The process's command line, as the system tells it. */
  command: string | null
  /** Its working folder, where the system tells it (not on Windows). */
  cwd: string | null
  /** When it started (ms), where the system tells it. */
  startedAt: number | null
}

/** What the server on the port says of itself. */
export interface ServerSays {
  /** /api/hello's version; null: no agent board answered. */
  version: string | null
  /** /api/process's install folder; null: the server does not know the route (older code). */
  root: string | null
}

/** Why the process on the port is not this install's board. */
export type Stranger = 'no-board' | 'elsewhere' | 'older'

const norm = (p: string, platform: string): string => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? s.toLowerCase() : s
}
const unquote = (s: string): string => s.replace(/^["']|["']$/g, '')
const absolute = (p: string): boolean => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p)

/** The script the process runs (the first word of its command line that ends in .ts or .js), or null. */
export function scriptOf(command: string | null): string | null {
  if (!command) return null
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return words.map(unquote).find(w => /\.[cm]?[tj]s$/i.test(w)) ?? null
}

/**
 * The checkout the process runs from, by the system's facts: the part of its script's path before
 * `src/entrypoints/` when the path is absolute, else its working folder, else null (a relative
 * path on Windows, which does not tell another process's working folder).
 */
export function checkoutOf(owner: PortOwner): string | null {
  const script = scriptOf(owner.command)
  if (script && absolute(script)) {
    const path = script.replace(/\\/g, '/')
    const cut = path.search(/\/src\/entrypoints\//)
    return cut > 0 ? script.slice(0, cut) : script.slice(0, path.lastIndexOf('/'))
  }
  return owner.cwd
}

/**
 * Null when the process is this install's board: the one board.json names, or a server that says
 * this install's folder. Else why not: no agent board answered, a board from another folder, or a
 * board server that does not know /api/process and so runs code older than this install's.
 */
export function strangerOf(
  owner: PortOwner,
  says: ServerSays,
  root: string,
  savedPid: number | null,
  platform: string,
): Stranger | null {
  if (savedPid !== null && owner.pid === savedPid) return null
  if (says.version === null) return 'no-board'
  if (says.root === null) return 'older'
  return norm(says.root, platform) === norm(root, platform) ? null : 'elsewhere'
}

function age(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

const WHY: Record<Stranger, string> = {
  'no-board': 'not an agent board',
  elsewhere: 'a board installed in another folder',
  older: 'a board server older than this install (it does not answer /api/process)',
}

/** The process in one line: pid, folder, what it runs, when it started, and why it is not this install's board. */
export function describeOwner(owner: PortOwner, says: ServerSays, why: Stranger | null, now: number): string {
  const parts = [`pid ${owner.pid}`]
  const from = says.root ?? checkoutOf(owner)
  if (from) parts.push(`folder ${from}`)
  const script = scriptOf(owner.command)
  if (script && from) parts.push(`runs ${script}`)
  else if (owner.command) parts.push(`command ${owner.command}`)
  if (owner.startedAt !== null) parts.push(`started ${age(now - owner.startedAt)}`)
  if (says.version !== null) parts.push(`agent-board ${says.version || '(no version)'}`)
  if (why) parts.push(WHY[why])
  return parts.join(' · ')
}

/**
 * `board doctor`'s line on the port: nothing when the system does not name a process, ok when it
 * is this install's board, a warning naming the process when it is not.
 */
export function portCheck(
  port: number,
  owner: PortOwner | null,
  says: ServerSays,
  why: Stranger | null,
  root: string,
  now: number,
  t: Translator,
): SetupCheck | null {
  if (!owner) return null
  const base = { id: 'board-port', title: t('setup.port.title', { port }), code: '' }
  if (!why) return { ...base, level: 'ok', detail: t('setup.port.own', { pid: owner.pid }), fix: '' }
  return {
    ...base,
    level: 'warn',
    detail: t('setup.port.other', { owner: describeOwner(owner, says, why, now), root }),
    fix: t('setup.port.fix', { pid: owner.pid }),
  }
}
