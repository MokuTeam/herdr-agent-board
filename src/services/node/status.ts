// A node's status (#498, docs/design/nodes 6.3): `GET /api/node/status` on the master door, asked
// every 30 s and right before a placement. Facts only: the machine's load, the board's sessions and
// launches, the room under `node.workRoot`, the profiles and the agents. The node holds no
// threshold and takes no decision; the master does.
import { existsSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { archiveStamp, headCommit } from '../../adapters/git.ts'
import { ROOT } from '../../adapters/paths.ts'
import { type SysLoad, sysLoad } from '../../adapters/sysload.ts'
import type { BoardAgyLimits } from '../../core/agy-limits.ts'
import type { GitFacts } from '../../core/git-access.ts'
import { CLAUDE_AGENT, launchAgents } from '../../core/launch/agents.ts'
import { NODE_API } from '../../core/node-door.ts'
import type { NodeConfig, NodeStatus } from '../../core/nodes.ts'
import type { Profile } from '../../core/profiles.ts'
import type { Item, LaunchSpec, LaunchView } from '../../core/types.ts'
import { agyOnPath, piOnPath } from '../launch/launches.ts'

export type { NodeStatus }

export interface StatusSources {
  node: () => NodeConfig | null
  items: () => Item[]
  launches: () => LaunchView[]
  /** The profiles shown on this board. */
  profiles: () => Profile[]
  /** A profile's applied bundle (services/node/bundle.ts); null before its first. */
  bundle?: (profile: string) => { seq: number; hash: string } | null
  /** config.json's `launch`, for the agents. */
  launch: () => LaunchSpec | undefined
  version: string
  /** The plugin's commit, asked once (git in the plugin's folder, else the archive's stamp); '' for neither. */
  commit?: () => Promise<string>
  load?: () => Promise<SysLoad>
  freeMb?: (dir: string) => number | null
  exists?: (file: string) => boolean
  /** Whether `pi` is on this board's PATH (services/launch/launches.ts). */
  piFound?: () => boolean
  /** Whether `agy` is on this board's PATH (services/launch/launches.ts). */
  agyFound?: () => boolean
  /**
   * The programs of core/bundle.ts NODE_PROGRAMS on this node's PATH (#603), asked once: the
   * master's bundle runs a hook's program only where it is. No `programs` in the status without it.
   */
  programs?: () => readonly string[]
  /**
   * What the node has for git (#609, services/node/git-access.ts facts): an identity, the hosts with a
   * login. Looked once per run and again after a secrets request. No `git` in the status without it.
   */
  git?: () => Promise<GitFacts>
  /**
   * Antigravity (Gemini) usage reading (#647), only when agy is installed on this node: undefined
   * omits the field (no agy), null reports installed-but-unknown, else the reading.
   */
  agyLimits?: () => BoardAgyLimits | null | undefined
  /** Non-internal interface addresses of this node (#700). */
  addresses?: () => readonly string[]
  /** How this board takes an update (#793): by git in a checkout, else from an archive. No `updates` without it. */
  updates?: () => 'git' | 'archive'
  /** The MokuTab functions folder's stamp (#864, services/node/fn-sync.ts); undefined without the folder. */
  functions?: () => string | undefined
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
 * What a start may name on this node: what its new-session window offers (Claude Code, and pi or
 * agy when config.json says how to start it or it is on PATH). With the config's own launcher
 * (`launch.command`, `launch.agent`) the window offers none and every start is that launcher's,
 * which starts Claude Code: `claude`.
 */
export function agentsOf(
  launch: LaunchSpec | undefined,
  piFound: () => boolean,
  agyFound: () => boolean = () => false,
): string[] {
  const offered = launchAgents(launch, piFound, agyFound).map(a => a.id)
  return offered.length ? offered : [CLAUDE_AGENT]
}

export function createNodeStatus(src: StatusSources): { answer(): Promise<NodeStatus | null> } {
  const platform = src.platform ?? process.platform
  const exists = src.exists ?? existsSync
  let commit: Promise<string> | null = null
  let programs: string[] | null = null
  const programsOnce = (ask: () => readonly string[]): string[] => {
    programs ??= [...ask()]
    return programs
  }
  const commitOnce = (): Promise<string> => {
    // a plugin "Add a server" unpacked from an archive has no .git: its stamp says the commit (#509)
    commit ??= (src.commit ?? (async () => (await headCommit(ROOT).catch(() => null)) ?? archiveStamp(ROOT) ?? ''))()
    return commit
  }
  return {
    async answer() {
      const node = src.node()
      if (!node) return null
      const items = src.items()
      const awake = items.filter(i => !i.sleeping)
      const [load, sha, git] = await Promise.all([(src.load ?? sysLoad)(), commitOnce(), src.git?.()])
      const agyLimits = src.agyLimits?.()
      const functions = src.functions?.()
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
        profiles: src
          .profiles()
          .map(p => ({ id: p.id, loggedIn: loggedIn(p.dir, platform, exists), bundle: src.bundle?.(p.id) ?? null })),
        agents: agentsOf(src.launch(), src.piFound ?? piOnPath, src.agyFound ?? agyOnPath),
        ...(src.programs && { programs: programsOnce(src.programs) }),
        ...(git && { git }),
        ...(agyLimits !== undefined && { agyLimits }),
        ...(src.addresses && { addresses: [...src.addresses()].slice(0, 32) }),
        ...(src.updates && { updates: src.updates() }),
        // Its own profiles (#802): the master starts here without a bundle. Absent: as before.
        ...(node.ownProfiles && { ownProfiles: true as const }),
        ...(functions && { functions }),
        at: (src.now ?? Date.now)(),
      }
    },
  }
}
