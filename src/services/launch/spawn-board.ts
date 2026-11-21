// spawn-agent asks the board (#505, docs/design/nodes 8.5): with `nodes` in config.json a new
// session an agent starts goes through the board's placer, as one started on the board does, so it
// may run on another device or wait for room. Asked only when the board answers on its port (the
// `board` command's probe, GET /api/board within 1.5 s); a board that does not, and every start the
// placer does not take (core/launch/spawn-board.ts placeable), run as without `nodes`. So do the
// starts of a board with a launcher of the owner's own (`launch.command`, `launch.agent`), a start in
// a hidden profile that is not its caller's, and one the board refuses on stale herdr data.
//
// The request is the New session window's, with `byHand: false`: the name, the folder, the brief as
// the first message, the label, the workspace, the profile spawn-agent would start in here, the
// model, the agent, and the caller's card and lane. Then the board's payload is read once a second
// until it says what became of the start, for as long as --timeout-sec gives: the line for this
// computer is spawn-agent's own (herdr names the pane's agent), one for a node names the device, a
// start that waits prints `queued=`, and a refusal or a failure throws with the reason.
import { readFileSync } from 'node:fs'
import { herdr } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { pause } from '../../adapters/pacing.ts'
import { type Env, inheritedProfileDir } from '../../adapters/profiles.ts'
import { parentProfile } from '../../core/item-profile.ts'
import { t } from '../../core/lang.ts'
import { type SpawnOptions, spawnLine } from '../../core/launch/spawn-args.ts'
import { callerOf, type Followed, launchBody, outcomeOf, placeable } from '../../core/launch/spawn-board.ts'
import { nodesConfig } from '../../core/nodes.ts'
import { type Profile, spawnEnv } from '../../core/profiles.ts'
import type { Config, Item } from '../../core/types.ts'
import { absoluteDir, profileRefusal } from './spawn-agent.ts'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** herdr's name for the agent in a pane; the pane itself when herdr does not say, as spawn-agent's own naming. */
async function herdrName(pane: string): Promise<string> {
  try {
    const answer = await herdr(['agent', 'list'])
    const agents = isRecord(answer) && Array.isArray(answer.agents) ? answer.agents : []
    const found = agents.find(a => isRecord(a) && a.pane_id === pane)
    return isRecord(found) && typeof found.name === 'string' && found.name ? found.name : pane
  } catch {
    return pane
  }
}

export interface AskBoardDeps {
  profiles: Profile[]
  env: Env
  home: string
  fetch?: typeof fetch
}

/**
 * The start as the board made it: the line spawn-agent prints (exit 0), or null when the board is
 * not asked (no `nodes`, a start the placer does not take, no workspace, no board answering), and
 * spawn-agent starts the session itself as without `nodes`. Throws with the reason when the board
 * refuses the start or it fails.
 */
export async function askBoard(o: SpawnOptions, cfg: Config, d: AskBoardDeps): Promise<string | null> {
  if (nodesConfig(cfg.nodes) === null || !placeable(o)) return null
  // The board would start it with the owner's own launcher, which takes another path than this one
  // (and may run spawn-agent itself, unmarked): such a board's agent starts stay as they were.
  if (cfg.launch?.command || cfg.launch?.agent) return null
  const workspace = o.workspace || d.env.HERDR_WORKSPACE_ID
  if (!workspace) return null
  const get = d.fetch ?? fetch
  const base = `http://127.0.0.1:${Number(cfg.port) || 12422}`
  const board = async (ms: number): Promise<Record<string, unknown> | null> => {
    try {
      const res = await get(`${base}/api/board`, { signal: AbortSignal.timeout(ms) })
      const body: unknown = await res.json()
      return res.ok && isRecord(body) ? body : null
    } catch {
      return null
    }
  }
  const first = await board(1500)
  if (!first) return null

  // What spawn-agent would do here: the brief, the profile (refused as it would be), the caller.
  const message =
    o.briefFile !== undefined
      ? readFileSync(o.briefFile, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
      : (o.brief ?? '').trim()
  const target = spawnEnv(o, inheritedProfileDir(d.env, d.home), d.profiles, d.home)
  if (!target.ok) throw new Error(profileRefusal(target))
  const profile = target.profile?.id
  const items = Array.isArray(first.items) ? (first.items as Item[]) : []
  const caller = callerOf(items, d.env)
  const same = !!caller && (!profile || parentProfile(caller, d.profiles)?.id === profile)
  // A hidden profile is the board's to start in only as the parent's: asked by name it is refused.
  if (target.profile?.hidden && !same) return null
  const body = launchBody(o, {
    cwd: absoluteDir(o.cwd),
    message,
    workspace: { id: workspace, ...(!o.workspace && caller?.workspace && { label: caller.workspace }) },
    ...(caller?.category && { category: caller.category }),
    ...(profile && { profile }),
    ...(same && caller && { parent: caller.key }),
  })

  let res: Response
  let answer: unknown
  try {
    res = await get(`${base}/api/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    answer = await res.json().catch(() => null)
  } catch (err) {
    // It may have started: never a second start here. The board's card says.
    throw new Error(`the board did not answer the start (${messageOf(err)}): see the board before starting it again`)
  }
  const a = isRecord(answer) ? answer : {}
  // Refused on herdr data it does not trust yet (409, fresh-data): nothing was started, so it starts here.
  if (res.status === 409) return null
  if (res.ok && (a.ok !== true || typeof a.id !== 'string'))
    throw new Error(`the board answered the start unreadably: see the board before starting it again`)
  if (!res.ok || a.ok !== true || typeof a.id !== 'string') {
    const why = typeof a.error === 'string' && a.error ? a.error : `the board answered ${res.status}`
    throw new Error(typeof a.field === 'string' && a.field ? `${why} (${a.field})` : why)
  }

  let f: Followed = {
    id: a.id,
    session: typeof a.session === 'string' ? a.session : null,
    name: o.name,
    device: null,
    seen: false,
  }
  const deadline = Date.now() + o.timeoutSec * 1000
  while (Date.now() < deadline) {
    const payload = await board(5000)
    if (payload) {
      const r = outcomeOf(payload, f, t)
      if (r.kind === 'printed') return r.line
      if (r.kind === 'failed') throw new Error(r.error)
      if (r.kind === 'here')
        return spawnLine({ pane: r.pane, name: o.name, agent: await herdrName(r.pane), kind: r.agent })
      f = { ...f, device: r.device, seen: r.seen }
    }
    await pause(1000)
  }
  throw new Error(
    f.device
      ? `the start went to ${f.device} and did not show there within ${o.timeoutSec} s: see its card on the board`
      : `the board did not finish the start within ${o.timeoutSec} s: see its card on the board`,
  )
}
