// spawn-agent on a node (#760): the start goes up the uplink (core/node-uplink.ts) as the call
// `spawn`, and the master places it as it places a start of its own (services/nodes/spawn-from.ts),
// with what only the node can read of the folder: its checkout and whether the brief names a file
// of the node. The logic without the network: the call's words, read back field by field on the
// master (neither side trusts what the other sends), and the line the node prints.
import { type GitIdentity, identityOf } from '../git-access.ts'
import { DEVICE_ID, LOCAL } from '../node-key.ts'
import { hasUnprintable } from '../team.ts'

/** Placement turned the start away before anything ran: the node may start it itself (no --device). */
export const SPAWN_NOT_STARTED = 3

/** The longest the master follows a start for a node (s): the node's call waits a little longer. */
export const SPAWN_FOLLOW_MAX_SEC = 150

/** What the node read of the folder, for the rule of core/portable.ts the master applies. */
export interface NodeFolderFacts {
  /** The checkout the folder is in; null when it is in none. */
  checkout: {
    /** The remote's URL without a password, null when a node could not clone it (none, or a local path). */
    url: string | null
    clean: boolean
    /** HEAD is a branch that equals its remote branch. */
    headPushed: boolean
    /** HEAD's branch; '' when detached. */
    branch: string
    /** The folder below the checkout's root ('/' between, '' for the root), null when it is not below it. */
    subdir: string | null
  } | null
  /** The author a commit there carries (#611), null when git there gives none. */
  identity: GitIdentity | null
  /** The first path the brief names that exists on the node, outside the folders every machine has. */
  localPath: string | null
}

/** A start a node's session asks its master for. */
export interface SpawnCall {
  name: string
  /** The folder as the node names it, absolute. */
  cwd: string
  label?: string
  message: string
  model?: string
  agent?: 'pi' | 'agy' | 'codex'
  /** The node's own profile id the start is in (spawn-agent's rule on the node). */
  profile?: string
  /** --device: a device id of the master's, or `local` for the master itself. */
  device?: string
  /** --trust (#798): the board that runs it answers Claude's folder-trust dialog for its folder. */
  trust?: true
  timeoutSec: number
  /** The herdr workspace label it opens in: the caller's, as the node shows it. */
  workspace: string
  /** null: the folder is not on the node (one of the device --device names). */
  facts: NodeFolderFacts | null
}

/** The call's arguments: one JSON word, read back by spawnCallOf. */
export const spawnCallArgv = (c: SpawnCall): string[] => [JSON.stringify(c)]

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !hasUnprintable(v)
const AGENTS = ['pi', 'agy', 'codex'] as const

function factsOf(v: unknown): NodeFolderFacts | null | undefined {
  if (v === null) return null
  if (!isObject(v)) return undefined
  let checkout: NodeFolderFacts['checkout'] = null
  if (v.checkout !== null) {
    const c = v.checkout
    if (!isObject(c)) return undefined
    if (c.url !== null && !text(c.url, 2048)) return undefined
    if (typeof c.clean !== 'boolean' || typeof c.headPushed !== 'boolean') return undefined
    if (!text(c.branch, 255)) return undefined
    if (c.subdir !== null && !text(c.subdir, 4096)) return undefined
    checkout = {
      url: (c.url as string | null) || null,
      clean: c.clean,
      headPushed: c.headPushed,
      branch: c.branch,
      subdir: c.subdir as string | null,
    }
  }
  let identity: GitIdentity | null = null
  if (v.identity !== null && v.identity !== undefined) {
    if (!isObject(v.identity)) return undefined
    identity = identityOf(v.identity.name, v.identity.email)
    if (!identity) return undefined
  }
  if (v.localPath !== null && !text(v.localPath, 4096)) return undefined
  return { checkout, identity, localPath: (v.localPath as string | null) || null }
}

/** The call as the master reads it, or null when it is not one. */
export function spawnCallOf(argv: readonly string[]): SpawnCall | null {
  if (argv.length !== 1) return null
  let raw: unknown
  try {
    raw = JSON.parse(argv[0] ?? '')
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  const { name, cwd, label, message, model, agent, profile, device, timeoutSec, workspace, trust } = raw
  if (!text(name, 60) || !name.trim() || !text(cwd, 4096) || !cwd.trim()) return null
  if (typeof message !== 'string' || message.length > 64 * 1024) return null
  if (label !== undefined && !text(label, 200)) return null
  if (model !== undefined && !text(model, 200)) return null
  if (agent !== undefined && !AGENTS.includes(agent as (typeof AGENTS)[number])) return null
  if (profile !== undefined && !text(profile, 64)) return null
  if (device !== undefined && (typeof device !== 'string' || (device !== LOCAL && !DEVICE_ID.test(device)))) return null
  if (typeof timeoutSec !== 'number' || !Number.isFinite(timeoutSec) || timeoutSec <= 0) return null
  if (trust !== undefined && trust !== true) return null
  if (!text(workspace, 200)) return null
  const facts = factsOf(raw.facts)
  if (facts === undefined) return null
  return {
    name,
    cwd,
    message,
    timeoutSec,
    workspace,
    facts,
    ...(label !== undefined && { label }),
    ...(model !== undefined && { model }),
    ...(agent !== undefined && { agent: agent as SpawnCall['agent'] & string }),
    ...(profile !== undefined && { profile }),
    ...(device !== undefined && { device }),
    ...(trust === true && { trust: true as const }),
  }
}

/**
 * The master's line as the node prints it. A session the master placed on this very node is one of
 * its own herdr's: its pane and herdr's name for it, as spawn-agent prints a start here, with the
 * device and the session after them. Any other line stays as the master wrote it.
 */
export function nodeSideLine(line: string, self: string, herdrName: (pane: string) => string): string {
  const m = /^pane=@([a-z0-9][a-z0-9-]*):(\S+) name=(.*) agent=\S+ device=(\S+) session=(\S+)$/.exec(line)
  if (!m || m[1] !== self || m[4] !== self) return line
  const [, , pane = '', name = '', device = '', session = ''] = m
  return `pane=${pane} name=${name} agent=${herdrName(pane)} device=${device} session=${session}`
}
