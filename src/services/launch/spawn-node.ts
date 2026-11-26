// spawn-agent on a node (#760): a new session a node's session starts is its master's to place, as
// one on the master is (spawn-board.ts askBoard). The start goes up the node's uplink as the call
// `spawn` (core/launch/spawn-node.ts), with what only this computer can read of the folder: its git
// checkout (remote, clean, pushed, branch, the folder below the root, the author) and the first path
// the brief names that exists here. The master answers with spawn-agent's line.
//
// Without --device a master that cannot be asked (no board here, the master not reachable, one
// too old to take the call) or that turns the start away before anything ran leaves it to this
// computer, as before #760, with the reason on stderr. With --device that is an error instead,
// unless the device is this node itself. A start the master took and that did not finish is never
// started here as well.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { checkoutFacts, checkoutIdentity, gitInfo } from '../../adapters/git.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { type Env, inheritedProfileDir } from '../../adapters/profiles.ts'
import type { SpawnOptions } from '../../core/launch/spawn-args.ts'
import { callerOf } from '../../core/launch/spawn-board.ts'
import {
  type NodeFolderFacts,
  nodeSideLine,
  SPAWN_NOT_STARTED,
  type SpawnCall,
  spawnCallArgv,
} from '../../core/launch/spawn-node.ts'
import { UPLINK_REFUSED } from '../../core/node-uplink.ts'
import type { NodeConfig } from '../../core/nodes.ts'
import { everyMachineHas, pathsIn } from '../../core/portable.ts'
import { type Profile, spawnEnv } from '../../core/profiles.ts'
import type { Config, Item } from '../../core/types.ts'
import type { NodeCall, NodeCallAnswer } from '../../entrypoints/node-call.ts'
import { absoluteDir, profileRefusal } from './spawn-agent.ts'

/** The longest a brief may be in the call (core/node-uplink.ts takes 64 KiB a word). */
const CALL_CHARS = 60 * 1024

export interface AskMasterDeps {
  profiles: Profile[]
  env: Env
  home: string
  /** `POST /api/node/call` on this computer's board (entrypoints/node-call.ts callBoard). */
  call: (body: NodeCall) => Promise<NodeCallAnswer>
  /** The board's payload here, for the caller's card; null when it does not answer. */
  board: () => Promise<Record<string, unknown> | null>
  /** herdr's name for the agent in a pane here. */
  herdrName: (pane: string) => Promise<string>
  /** Why it starts here after all (stderr). */
  log: (line: string) => void
  /**
   * The board here starts sessions with a launcher of the owner's own (`launch.command`,
   * `launch.agent`), which may run spawn-agent itself, unmarked: such a node's starts stay its own.
   */
  ownLauncher?: boolean
  /** Tests: the folder's facts; read with git by default. */
  facts?: (cwd: string, brief: string) => Promise<NodeFolderFacts>
}

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The folder's facts as the master's rule reads them, read here with git. */
export async function folderFacts(cwd: string, brief: string): Promise<NodeFolderFacts> {
  const [facts, info, identity] = await Promise.all([checkoutFacts(cwd), gitInfo(cwd), checkoutIdentity(cwd)])
  let checkout: NodeFolderFacts['checkout'] = null
  if (facts) {
    const below = relative(facts.root, cwd)
    const subdir = !below ? '' : below === '..' || below.startsWith(`..${sep}`) ? null : below.split(sep).join('/')
    checkout = {
      // A remote no other machine can clone (a folder of this computer) is none.
      url: facts.remote?.address ? facts.remote.url : null,
      clean: facts.clean,
      headPushed: facts.headPushed,
      branch: info && info.branch !== 'HEAD' ? info.branch : '',
      subdir,
    }
  }
  const localPath = pathsIn(brief).find(p => !everyMachineHas(p) && existsSync(p)) ?? null
  return { checkout, identity, localPath }
}

/**
 * The start as the master made it: the line spawn-agent prints, or null when this computer starts
 * it itself (said on stderr why). Throws with the reason when it must not start here.
 */
export async function askMaster(o: SpawnOptions, node: NodeConfig, d: AskMasterDeps): Promise<string | null> {
  // --device names a machine: this node itself may still start it here when the master cannot place it.
  const strict = o.device !== undefined && o.device !== node.id
  const here = (why: string): null => {
    if (strict) throw new Error(`--device ${o.device}: ${why}`)
    d.log(`${why}: starting it on this computer`)
    return null
  }
  if (d.ownLauncher) {
    if (strict)
      throw new Error(
        `--device ${o.device}: the board starts sessions with a launcher of its own (launch.command), which places nothing`,
      )
    return null
  }
  // What only this computer has (a herdr workspace id, Codex's options, which a placed start does
  // not carry): such a start stays here, as before.
  const own = [
    ...(o.workspace !== undefined ? ['--workspace'] : []),
    ...(o.effort !== undefined ? ['--effort'] : []),
    ...(o.approval !== undefined ? ['--approval'] : []),
    ...(o.sandbox !== undefined ? ['--sandbox'] : []),
  ]
  if (own.length) {
    if (strict)
      throw new Error(`--device ${o.device}: ${own.join(', ')} are this computer's: give them without --device`)
    return null
  }
  const cwd = absoluteDir(o.cwd)
  const folder = isFolder(cwd)
  // No folder here and no machine named: this computer's start says what is wrong, as before.
  if (!folder && o.device === undefined) return null
  if (!folder && o.device === node.id) throw new Error(`--device ${o.device}: no folder ${cwd} on this computer`)

  const first = await d.board()
  if (!first) return here('the board does not answer on this computer')
  const items = Array.isArray(first.items) ? (first.items as Item[]) : []
  const caller = callerOf(items, d.env)
  if (!caller) return here("this session is not on the board, so the board's computer cannot place its start")

  const message =
    o.briefFile !== undefined
      ? readFileSync(o.briefFile, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
      : (o.brief ?? '').trim()
  const target = spawnEnv(o, inheritedProfileDir(d.env, d.home), d.profiles, d.home)
  if (!target.ok) throw new Error(profileRefusal(target))
  const facts = folder ? await (d.facts ?? folderFacts)(cwd, message) : null
  const req: SpawnCall = {
    name: o.name,
    // A folder this computer lacks is the named device's, as that device writes it.
    cwd: folder
      ? cwd
      : String(o.cwd)
          .trim()
          .replace(/^["']|["']$/g, ''),
    message,
    timeoutSec: o.timeoutSec,
    workspace: caller.workspace || '',
    facts,
    ...(o.label !== undefined && { label: o.label }),
    ...(o.model !== undefined && { model: o.model }),
    ...(o.agent !== undefined && { agent: o.agent }),
    ...(target.profile && { profile: target.profile.id }),
    ...(o.device !== undefined && { device: o.device }),
    ...(o.lane !== undefined && { lane: o.lane }),
    ...(o.trust && { trust: true as const }),
  }
  const argv = spawnCallArgv(req)
  if ((argv[0] ?? '').length > CALL_CHARS) return here("the brief is too long to send to the board's computer")

  const answer = await d.call({
    cmd: 'spawn',
    argv,
    session: caller.key,
    lane: caller.category || null,
    files: [],
  })
  if (!answer) return here('the board does not run on this computer')
  if (answer.state === 'unreachable') return here("the board's computer is not reachable")
  if (answer.state === 'kept')
    throw new Error('the board kept the start for later, which it never does: see the board before starting it again')
  const said = answer.err.join('; ') || `exit ${answer.code}`
  if (answer.code === UPLINK_REFUSED) {
    if (answer.err.some(l => /is not taken from a node/i.test(l)))
      return here("the board's computer does not place starts from a node yet (update its board)")
    return here(`the board's computer refused the start (${said})`)
  }
  if (answer.code === SPAWN_NOT_STARTED) {
    if (strict) throw new Error(said)
    return here(`the board's computer did not place it (${said})`)
  }
  if (answer.code !== 0) throw new Error(said)
  for (const line of answer.err) d.log(line)
  const line = answer.out.at(-1)
  if (!line) throw new Error("the board's computer started it but said nothing: see the board before starting it again")
  const names = new Map<string, string>()
  // herdr here is asked only for a session that runs here.
  const m = /^pane=@([^:]+):(\S+) /.exec(line)
  if (m?.[1] === node.id && m[2]) names.set(m[2], await d.herdrName(m[2]))
  return nodeSideLine(line, node.id, pane => names.get(pane) ?? pane)
}

/** The board's payload on this computer (`GET /api/board`), as askBoard reads it; null when it does not answer. */
export const boardHere = (port: unknown) => async (): Promise<Record<string, unknown> | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${Number(port) || 12422}/api/board`, {
      signal: AbortSignal.timeout(1500),
    })
    const body: unknown = await res.json()
    return res.ok && isRecord(body) ? body : null
  } catch {
    return null
  }
}

/** Whether this board is a node and only that: `node` set and readable, no `nodes`. */
export async function pureNode(cfg: Config): Promise<NodeConfig | null> {
  if (cfg.node === undefined || cfg.node === null || cfg.node === false) return null
  const { nodeConfig, nodesConfig } = await import('../../core/nodes.ts')
  if (nodesConfig(cfg.nodes) !== null) return null
  return nodeConfig(cfg.node)
}
