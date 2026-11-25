// The node's side of the feature flags from its master (#775, core/master-flags.ts). Made by
// server/app.ts only once config.json has `node`. The master posts its flags to this node's door
// (`POST /api/node/master-flags`); they are kept in memory and in <state>/node/master-flags.json with
// the time they came (adapters/master-flags-store.ts), never in config.json, and stay as they are
// while the master is away.
//
// The card-level features the master has on (core/master-flags.ts NODE_GATED_KEYS) go into the live
// config, in memory only, where the node's own config.json has them off: the scheduler, the routes
// and the cards of this board read them as on via the master. `apply` puts them back after each
// reload of config.json and takes out what it put there before.
import { readMasterFlags, writeMasterFlags } from '../../adapters/master-flags-store.ts'
import {
  type MasterFlags,
  masterFlagsWireOf,
  NODE_GATED_KEYS,
  sameFlags,
  withMasterFlags,
} from '../../core/master-flags.ts'
import { nodeConfig } from '../../core/nodes.ts'
import type { Config } from '../../core/types.ts'
import type { Answer } from './bundle.ts'

export interface NodeMasterFlags {
  /** The flags as they last came, or null: none yet. */
  current(): MasterFlags | null
  /** The master's post: kept; the live config and the board follow when it says something new. */
  take(raw: unknown): Answer
  /** The live config with the master's card-level features (after each reload of config.json). */
  apply(): void
}

export interface NodeMasterFlagsDeps {
  /** The live config, changed in place. */
  cfg: Config
  /** The flags said something new: the board shows it again. */
  changed(): void
  log(text: string): void
  now?: () => number
}

export function createNodeMasterFlags(deps: NodeMasterFlagsDeps): NodeMasterFlags {
  const now = deps.now ?? Date.now
  const live = deps.cfg as unknown as Record<string, unknown>
  let current: MasterFlags | null = readMasterFlags()
  /** What apply put in the live config, by key: taken out again only while it is still there. */
  const put = new Map<string, unknown>()

  function apply(): void {
    for (const [key, value] of put) if (live[key] === value) delete live[key]
    put.clear()
    if (nodeConfig(deps.cfg.node) === null) return
    const next = withMasterFlags(live, current)
    for (const key of NODE_GATED_KEYS) {
      if (next[key] === live[key]) continue
      live[key] = next[key]
      put.set(key, next[key])
    }
  }

  return {
    current: () => current,
    take(raw) {
      const wire = masterFlagsWireOf(raw)
      if (!wire) return { status: 400, body: { ok: false, error: 'flags' } }
      const was = current
      current = { ...wire, at: now() }
      try {
        writeMasterFlags(current)
      } catch (err) {
        deps.log(`master flags: not kept on disk: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!sameFlags(was, current)) {
        apply()
        deps.changed()
      }
      return { status: 200, body: { ok: true } }
    },
    apply,
  }
}
