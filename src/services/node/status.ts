// A node's status (#498, docs/design/nodes 6.3): `GET /api/node/status` on the master door, asked
// every 30 s and right before a placement. Facts only: the machine's load, the board's sessions and
// launches, the room under `node.workRoot`, the profiles and the agents. The node holds no
// threshold and takes no decision; the master does.
import { existsSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { headCommit } from '../../adapters/git.ts'
import { ROOT } from '../../adapters/paths.ts'
import { type SysLoad, sysLoad } from '../../adapters/sysload.ts'
import { CLAUDE_AGENT, launchAgents } from '../../core/launch/agents.ts'
import { NODE_API } from '../../core/node-door.ts'
import type { NodeConfig } from '../../core/nodes.ts'
import type { Profile } from '../../core/profiles.ts'
import type { Item, LaunchSpec, LaunchView } from '../../core/types.ts'
import { piOnPath } from '../launch/launches.ts'

export interface NodeStatus {
  api: number
  id: string
  version: string
  commit: string
  platform: string
  arch: string
  cpus: number
  memTotalMb: number
  memAvailableMb: number | null
  load: [number, number, number] | null
  sessions: { awake: number; working: number; asleep: number }
  /** Launches still on their way (starting, waiting, a trust dialog). */
  launches: number
  /** null when the folder, or every folder above it, cannot be read. */
  workRootFreeMb: number | null
  /** loggedIn: null where a folder cannot tell (macOS keeps Claude's login in the Keychain). bundle: null until profile sync (T10). */
  profiles: { id: string; loggedIn: boolean | null; bundle: null }[]
  /** The agents a start may name here, by the board's own rule (core/launch/agents.ts). */
  agents: string[]
  at: number
}

export interface StatusSources {
  node: () => NodeConfig | null
  items: () => Item[]
  launches: () => LaunchView[]
  /** The profiles shown on this board. */
  profiles: () => Profile[]
  /** config.json's `launch`, for the agents. */
  launch: () => LaunchSpec | undefined
  version: string
  /** The plugin's commit, asked once (git in the plugin's folder); '' outside a checkout. */
  commit?: () => Promise<string>
  load?: () => Promise<SysLoad>
  freeMb?: (dir: string) => number | null
  exists?: (file: string) => boolean
  /** Whether `pi` is on this board's PATH (services/launch/launches.ts). */
  piFound?: () => boolean
  platform?: string
  arch?: string
  home?: string
  now?: () => number
}

const LIVE: ReadonlySet<string> = new Set(['starting', 'waiting', 'trust'])
const MB = 1024 * 1024

/** `~` and `~/...` at the home folder; anything else resolved as it is. */
export function expandHome(dir: string, home: string): string {
  if (dir === '~') return home
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return join(home, dir.slice(2))
  return resolve(dir)
}

/** Free space for this user on the volume of `dir`, or of the nearest folder above it that exists. */
export function freeMbUnder(dir: string): number | null {
  let at = dir
  for (;;) {
    try {
      const s = statfsSync(at)
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / MB)
    } catch {
      const up = dirname(at)
      if (up === at) return null
      at = up
    }
  }
}

/** Whether a profile is logged in: `.credentials.json` in its folder; without it, null on macOS (the Keychain), false elsewhere. */
export function loggedIn(dir: string, platform: string, exists: (file: string) => boolean): boolean | null {
  if (exists(join(dir, '.credentials.json'))) return true
  return platform === 'darwin' ? null : false
}

/**
 * What a start may name on this node: what its new-session window offers (Claude Code, and pi when
 * config.json says how to start it or it is on PATH). With the config's own launcher
 * (`launch.command`, `launch.agent`) the window offers none and every start is that launcher's,
 * which starts Claude Code: `claude`.
 */
export function agentsOf(launch: LaunchSpec | undefined, piFound: () => boolean): string[] {
  const offered = launchAgents(launch, piFound).map(a => a.id)
  return offered.length ? offered : [CLAUDE_AGENT]
}

export function createNodeStatus(src: StatusSources): { answer(): Promise<NodeStatus | null> } {
  const platform = src.platform ?? process.platform
  const exists = src.exists ?? existsSync
  let commit: Promise<string> | null = null
  const commitOnce = (): Promise<string> => {
    commit ??= (src.commit ?? (async () => (await headCommit(ROOT).catch(() => null)) ?? ''))()
    return commit
  }
  return {
    async answer() {
      const node = src.node()
      if (!node) return null
      const items = src.items()
      const awake = items.filter(i => !i.sleeping)
      const [load, sha] = await Promise.all([(src.load ?? sysLoad)(), commitOnce()])
      return {
        api: NODE_API,
        id: node.id,
        version: src.version,
        commit: sha,
        platform,
        arch: src.arch ?? process.arch,
        cpus: load.cpus,
        memTotalMb: load.memTotalMb,
        memAvailableMb: load.memAvailableMb,
        load: load.load,
        sessions: {
          awake: awake.length,
          working: awake.filter(i => i.status === 'working').length,
          asleep: items.length - awake.length,
        },
        launches: src.launches().filter(l => LIVE.has(l.state)).length,
        workRootFreeMb: (src.freeMb ?? freeMbUnder)(expandHome(node.workRoot, src.home ?? homedir())),
        profiles: src.profiles().map(p => ({ id: p.id, loggedIn: loggedIn(p.dir, platform, exists), bundle: null })),
        agents: agentsOf(src.launch(), src.piFound ?? piOnPath),
        at: (src.now ?? Date.now)(),
      }
    },
  }
}
