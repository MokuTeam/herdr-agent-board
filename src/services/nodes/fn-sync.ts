// The functions registry synced through the master (#864, core/fn-sync.ts): the master keeps a bare
// hub of MokuTab's functions repository (`<state>/fn-sync/hub.git`) and runs one round per machine,
// its own folder among them: the machine says its branch and commit, its new commits come up as a
// bundle (every file they bring through the board's secret check and size limits first), the
// registry's branch fast-forwards to them, and a machine behind fast-forwards to the registry.
// A round over every machine runs twice, so a commit one machine brings reaches those asked before
// it in the same sync. Only the owner's devices take part: never one whose relayed requests are not
// the owner's (`owner: false`), nor a revoked one, and Team peers have no link here at all. The log
// and the record name machines, commits and paths, never a file's contents.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bundleOf,
  fetchBundle,
  hasCommit,
  hubInit,
  isAncestor,
  isBranch,
  isSha,
  newBlobs,
  blob as readBlob,
  setRef,
  treeSize,
} from '../../adapters/fn-git.ts'
import { isRecord, replaceFile } from '../../adapters/json-store.ts'
import {
  decide,
  FN_MAX_FILE_BYTES,
  FN_MAX_FILES,
  FN_MAX_TOTAL_BYTES,
  type FnAction,
  type FnLook,
  type FnRefused,
  refusalOf,
} from '../../core/fn-sync.ts'
import { LOCAL, type NodesConfig } from '../../core/nodes.ts'
import type { FnTaken, NodeFunctions } from '../node/fn-sync.ts'
import { type Clock, realClock } from '../tunnel.ts'
import type { Link } from './link.ts'
import type { NodeLinks } from './links.ts'

/** Why a machine is left for the next time, not stopped: it moved while the round ran, or MokuTab is saving there. */
export const AGAIN = new Set(['changed', 'busy'])

/** One machine as a round sees it: the master's own folder or a node's through its door. */
export interface FnReplica {
  id: string
  /** `older`: its board has no such routes. */
  look(): Promise<FnLook | 'older'>
  bundle(have: readonly string[]): Promise<Uint8Array | null>
  take(bytes: Uint8Array, branch: string, expect: string | null): Promise<FnTaken>
}

/** What a round with one machine came to. */
export interface FnRound {
  device: string
  /** What it did: `current`, `seed`, `take` (its commits went into the registry), `give`, `clone`, `skip`, `stop`. */
  did: string
  /** Why it stopped, or why it was skipped: `no-folder`, `older`, `offline`, `not-repo`, `branch`, `dirty`, `diverged`, `refused`, `changed`, `busy` (MokuTab saving there), `git`. */
  why?: string
  /** Its commit before and after. */
  from?: string
  to?: string
  refused: FnRefused[]
}

export interface FnSyncReport {
  ok: boolean
  dryRun: boolean
  branch: string | null
  head: string | null
  rounds: FnRound[]
  at: number
}

interface MachineRecord {
  at: number
  head?: string
  stop?: string
  refused?: FnRefused[]
}

interface FnState {
  branch: string | null
  head: string | null
  machines: Record<string, MachineRecord>
  stamps: Record<string, string>
}

function stateOf(raw: unknown): FnState {
  const s: FnState = { branch: null, head: null, machines: {}, stamps: {} }
  if (!isRecord(raw)) return s
  if (isBranch(raw.branch)) s.branch = raw.branch
  if (isSha(raw.head)) s.head = raw.head
  if (isRecord(raw.machines))
    for (const [id, m] of Object.entries(raw.machines))
      if (isRecord(m) && typeof m.at === 'number')
        s.machines[id] = {
          at: m.at,
          ...(isSha(m.head) && { head: m.head }),
          ...(typeof m.stop === 'string' && { stop: m.stop }),
          ...(Array.isArray(m.refused) && {
            refused: m.refused.filter(isRecord).map(x => ({ path: String(x.path), why: String(x.why) })),
          }),
        }
  if (isRecord(raw.stamps))
    for (const [id, v] of Object.entries(raw.stamps)) if (typeof v === 'string') s.stamps[id] = v
  return s
}

/** A machine id as a ref names it. */
const refId = (id: string): string => id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'machine'

export interface FnSyncOptions {
  /** `<state>/fn-sync`: the hub and the record. */
  dir: string
  /** The machines to sync now: the master's own folder first, then each owner device online. */
  replicas: () => FnReplica[]
  log(text: string): void
  now?: () => number
}

export interface FnSync {
  /** Every machine, twice; `dryRun` says what it would do, and fetches, writes and keeps nothing. */
  syncAll(opts?: { dryRun?: boolean }): Promise<FnSyncReport>
  /** The stamp a device's status had when it was last synced, so a moved one asks for a sync. */
  stamp(device: string): string | undefined
  setStamp(device: string, stamp: string): void
}

export function createFnSync(o: FnSyncOptions): FnSync {
  const now = o.now ?? Date.now
  const hub = join(o.dir, 'hub.git')
  const file = join(o.dir, 'state.json')
  const state: FnState = (() => {
    try {
      return stateOf(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return stateOf(null)
    }
  })()
  const save = (): void => {
    mkdirSync(o.dir, { recursive: true })
    replaceFile(file, `${JSON.stringify(state, null, 1)}\n`, undefined, 0o600)
  }

  /** The files commits `to` brings over `from` the board will not carry, and the tree's own limits. */
  async function refusals(to: string, from: string | null): Promise<FnRefused[]> {
    const out: FnRefused[] = []
    for (const b of await newBlobs(hub, to, from)) {
      if (b.size > FN_MAX_FILE_BYTES) {
        out.push({ path: b.path, why: 'too-large' })
        continue
      }
      const why = refusalOf(await readBlob(hub, b.sha))
      if (why) out.push({ path: b.path, why })
    }
    const size = await treeSize(hub, to)
    if (size.files > FN_MAX_FILES || size.bytes > FN_MAX_TOTAL_BYTES)
      out.push({ path: '.', why: `total: ${size.files} files, ${size.bytes} bytes` })
    return out
  }

  async function round(r: FnReplica, s: FnState, dryRun: boolean): Promise<FnRound> {
    const out: FnRound = { device: r.id, did: 'skip', refused: [] }
    let look: FnLook | 'older'
    try {
      look = await r.look()
    } catch {
      return { ...out, why: 'offline' }
    }
    if (look === 'older') return { ...out, why: 'older' }
    if (look.state === 'repo') out.from = look.head
    const hubHead = s.branch && s.head ? { branch: s.branch, head: s.head } : null
    const relate = async () =>
      look.state === 'repo' && hubHead && (await hasCommit(hub, look.head))
        ? {
            known: true,
            behind: await isAncestor(hub, look.head, hubHead.head),
            ahead: await isAncestor(hub, hubHead.head, look.head),
          }
        : { known: false, behind: false, ahead: false }
    let action: FnAction = decide({ look, hub: hubHead, relation: await relate() })
    const stop = (why: string, extra: Partial<FnRound> = {}): FnRound => {
      if (!dryRun)
        s.machines[r.id] = {
          at: now(),
          ...(out.from && { head: out.from }),
          stop: why,
          ...(extra.refused?.length && { refused: extra.refused }),
        }
      return { ...out, ...extra, did: 'stop', why }
    }
    const fine = (did: string, to?: string): FnRound => {
      if (!dryRun) s.machines[r.id] = { at: now(), ...((to ?? out.from) && { head: to ?? out.from }) }
      return { ...out, did, ...(to && { to }) }
    }
    if (action.do === 'skip') return { ...out, why: look.state === 'none' ? 'no-folder' : 'empty' }
    if (action.do === 'stop') {
      if (action.why === 'diverged' && !dryRun && out.from) await setRef(hub, `refs/conflicts/${refId(r.id)}`, out.from)
      return stop(action.why)
    }
    if (action.do === 'current') return fine('current')
    if (dryRun) return { ...out, did: action.do === 'fetch' ? 'new-commits' : action.do }
    if (look.state !== 'repo' && action.do !== 'clone') return stop('git')
    try {
      if (action.do === 'fetch' || action.do === 'seed') {
        await hubInit(hub)
        const bytes = await r.bundle(hubHead ? [hubHead.head] : [])
        if (!bytes || look.state !== 'repo') return { ...out, why: 'changed' }
        const got = await fetchBundle(hub, bytes, look.branch, `refs/machines/${refId(r.id)}`)
        if (got !== look.head) return { ...out, why: 'changed' }
        if (action.do === 'seed') {
          const refused = await refusals(got, null)
          if (refused.length) return stop('refused', { refused })
          await setRef(hub, `refs/heads/${look.branch}`, got)
          s.branch = look.branch
          s.head = got
          o.log(`functions sync: the registry starts from ${r.id} at ${got.slice(0, 8)}`)
          return fine('seed', got)
        }
        action = decide({ look, hub: hubHead, relation: await relate() })
        if (action.do === 'stop') {
          if (action.why === 'diverged') await setRef(hub, `refs/conflicts/${refId(r.id)}`, got)
          return stop(action.why)
        }
      }
      if (action.do === 'take' && hubHead && look.state === 'repo') {
        const refused = await refusals(look.head, hubHead.head)
        if (refused.length) return stop('refused', { refused })
        await setRef(hub, `refs/heads/${hubHead.branch}`, look.head)
        s.head = look.head
        o.log(`functions sync: ${r.id} brought ${hubHead.head.slice(0, 8)}..${look.head.slice(0, 8)}`)
        return fine('take', look.head)
      }
      if ((action.do === 'give' || action.do === 'clone') && hubHead) {
        const expect = action.do === 'give' && look.state === 'repo' ? look.head : null
        const bytes = await bundleOf(hub, hubHead.branch, expect ? [expect] : [])
        if (!bytes) return stop('git')
        const got = await r.take(bytes, hubHead.branch, expect)
        // MokuTab saving there now (its lock), or the folder moved meanwhile: next time, no stop.
        if (!got.ok) return AGAIN.has(got.why) ? { ...out, why: got.why } : stop(got.why)
        o.log(`functions sync: ${r.id} now at ${got.head.slice(0, 8)}`)
        return fine(action.do, got.head)
      }
      return fine('current')
    } catch (err) {
      o.log(`functions sync ${r.id}: ${err instanceof Error ? err.message : String(err)}`)
      return stop('git')
    }
  }

  async function run(dryRun: boolean): Promise<FnSyncReport> {
    const s: FnState = dryRun ? structuredClone(state) : state
    const rounds: FnRound[] = []
    const replicas = o.replicas()
    // A dry run moves nothing, so a second pass would say nothing new.
    for (let pass = 0; pass < (dryRun ? 1 : 2); pass++)
      for (const r of replicas) {
        const got = await round(r, s, dryRun)
        const at = rounds.findIndex(x => x.device === got.device)
        // A machine is reported once: what moved it, else its last word.
        if (at < 0) rounds.push(got)
        else if (got.did !== 'current' || (rounds[at] as FnRound).did === 'stop') {
          const from = (rounds[at] as FnRound).from ?? got.from
          rounds[at] = { ...got, ...(from && { from }) }
        }
      }
    if (!dryRun) save()
    return {
      ok: rounds.every(r => r.did !== 'stop' && !AGAIN.has(r.why ?? '') && r.why !== 'offline'),
      dryRun,
      branch: s.branch,
      head: s.head,
      rounds,
      at: now(),
    }
  }

  let running: Promise<FnSyncReport> | null = null
  let queued: Promise<FnSyncReport> | null = null
  return {
    syncAll(opts) {
      if (opts?.dryRun === true) return run(true)
      // One at a time; those asked while one runs share one more after it.
      const start = (): Promise<FnSyncReport> => {
        const p = run(false).finally(() => {
          if (running === p) running = null
        })
        running = p
        return p
      }
      if (!running) return start()
      queued ??= running
        .catch(() => null)
        .then(() => {
          queued = null
          return start()
        })
      return queued
    },
    stamp: device => state.stamps[device],
    setStamp(device, stamp) {
      state.stamps[device] = stamp
    },
  }
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const unb64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'))

/** A machine's look as its door said it, checked field by field. */
export function lookOf(v: unknown): FnLook | null {
  if (!isRecord(v)) return null
  if (v.state === 'none' || v.state === 'empty' || v.state === 'not-repo') return { state: v.state }
  if (v.state === 'repo' && isBranch(v.branch) && isSha(v.head) && Array.isArray(v.dirty))
    return { state: 'repo', branch: v.branch, head: v.head, dirty: v.dirty.slice(0, 500).map(String) }
  return null
}

/** A node's folder through its door (server/routes/node.ts functionsDoorRoutes). A 404: its board is older. */
export function linkReplica(id: string, link: Pick<Link, 'fetch'>, requestMs = 60_000): FnReplica {
  const ask = async (path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await link.fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(requestMs),
    })
    const got: unknown = await res.json().catch(() => ({}))
    return { status: res.status, body: isRecord(got) ? got : {} }
  }
  return {
    id,
    async look() {
      const r = await ask('/api/node/functions')
      if (r.status === 404) return 'older'
      const look = r.status === 200 ? lookOf(r.body.look) : null
      if (!look) throw new Error(`status ${r.status}`)
      return look
    },
    async bundle(have) {
      const r = await ask('/api/node/functions/bundle', { have })
      return r.status === 200 && typeof r.body.b64 === 'string' ? unb64(r.body.b64) : null
    },
    async take(bytes, branch, expect) {
      const r = await ask('/api/node/functions/take', { b64: b64(bytes), branch, expect })
      if (r.status === 200 && r.body.ok === true && isSha(r.body.head)) return { ok: true, head: r.body.head }
      return { ok: false, why: typeof r.body.why === 'string' ? r.body.why.slice(0, 40) : `node ${r.status}` }
    },
  }
}

/** The local folder as a round sees it (services/node/fn-sync.ts), under the master's own id. */
export function localReplica(id: string, fns: NodeFunctions): FnReplica {
  return { id, look: () => fns.look(), bundle: have => fns.bundle(have), take: (b, br, e) => fns.take(b, br, e) }
}

/**
 * The devices whose folders take part (#864): the owner's own, each with a link online. Never one
 * whose relayed requests are not the owner's (`owner: false`), nor a revoked one. Team peers have
 * no link and are never here.
 */
export function fnSyncDevices(nodes: NodesConfig | null, online: (id: string) => boolean): string[] {
  if (!nodes) return []
  return nodes.order.filter(id => {
    const d = nodes.devices[id]
    return !!d?.link && id !== LOCAL && d.owner !== false && d.revoked !== true && online(id)
  })
}

export interface FnSyncRunnerOptions {
  sync: FnSync
  /** The master's own folder (services/node/fn-sync.ts). */
  local: NodeFunctions
  nodes: () => NodesConfig | null
  links: Pick<NodeLinks, 'link' | 'onChange'>
  log(text: string): void
  clock?: Clock
  /** How often the master's folder and the devices' stamps are looked at (no request to a node: its last status). */
  tickMs?: number
  /** A change waits this long for the ones after it, so a save of several files is one sync. */
  settleMs?: number
  /** A machine left for next time (`busy`, `changed`) is asked again after this. */
  retryMs?: number
}

/**
 * When a sync runs by itself: a device comes online (its link reconnected), a device's status
 * brings another stamp of its folder, the master's folder changed; and every 30 minutes all the same.
 */
export function createFnSyncRunner(o: FnSyncRunnerOptions): { kick(): void; close(): void } {
  const clock = o.clock ?? realClock
  const tickMs = o.tickMs ?? 15_000
  const settleMs = o.settleMs ?? 3000
  const retryMs = o.retryMs ?? 20_000
  let timer: unknown = null
  let localStamp: string | undefined
  const wasOnline = new Map<string, boolean>()
  let lastFull = clock.now()
  let again: unknown = null
  const kick = (): void => {
    if (timer) return
    timer = clock.setTimeout(() => {
      timer = null
      lastFull = clock.now()
      void o.sync
        .syncAll()
        .then(r => {
          localStamp = o.local.stamp()
          // Each device's stamp as its folder is now, so the status after our own writes asks nothing.
          for (const round of r.rounds) {
            const st = o.links.link(round.device)?.view().status as { functions?: string } | null | undefined
            if (round.did !== 'stop' && st?.functions) o.sync.setStamp(round.device, st.functions)
          }
          // A machine left for next time (MokuTab saving there) is asked again soon, not in 30 minutes.
          if (!again && r.rounds.some(x => AGAIN.has(x.why ?? '')))
            again = clock.setTimeout(() => {
              again = null
              kick()
            }, retryMs)
        })
        .catch(err => o.log(`functions sync: ${err instanceof Error ? err.message : String(err)}`))
    }, settleMs)
  }
  const look = (id: string): void => {
    const nodes = o.nodes()
    const link = o.links.link(id)
    const on = link?.state().state === 'online'
    const was = wasOnline.get(id) ?? false
    wasOnline.set(id, on)
    if (!on || !fnSyncDevices(nodes, () => true).includes(id)) return
    if (!was) {
      kick()
      return
    }
    const stamp = (link?.view().status as { functions?: string } | null | undefined)?.functions
    if (stamp && stamp !== o.sync.stamp(id)) kick()
  }
  const off = o.links.onChange(look)
  const interval = clock.setInterval(() => {
    const stamp = o.local.stamp()
    if (stamp !== undefined && stamp !== localStamp) {
      localStamp = stamp
      kick()
    }
    for (const id of o.nodes()?.order ?? []) look(id)
    if (clock.now() - lastFull > 30 * 60_000) kick()
  }, tickMs)
  kick()
  return {
    kick,
    close() {
      off()
      clock.clearInterval(interval)
      if (timer) clock.clearTimeout(timer)
      if (again) clock.clearTimeout(again)
    },
  }
}
