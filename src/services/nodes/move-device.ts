// A session moved to another device (#616, `board move --device`, POST /api/move with `device`): the
// master carries it between the two boards, each doing its own half (core/move-device.ts). The
// source (this board, or a node through its door) checks the folder, puts the session to sleep and
// packs it; the target makes the folder from git and says which files it lacks; the files go one by
// one, by hash, straight from the source to the target; the target writes them and resumes the
// session; once its start is on its way (or done) the target puts the schedule entries in and the
// source finishes: its card marked moved and hidden, its entries removed, its pane closed. The
// threads on this board follow the session's new key (`<id>` here, `@<device>:<id>` on a node).
// Anything that fails before the target's start calls the move off at the source, which wakes the
// session again when it was awake: nothing is lost and the session stays where it was.
//
// Between two nodes the master is the way between: the files pass through this process as streams.
// A node on a board without these routes answers 404 for them: it is said so, update it first.
import { isRecord } from '../../adapters/json-store.ts'
import { pause } from '../../adapters/pacing.ts'
import { changesKey, LOCAL, type MovePack, profileOn } from '../../core/move-device.ts'
import { isDevice } from '../../core/node-key.ts'
import { type NodesConfig, nodeKey, parseNodeKey } from '../../core/nodes.ts'
import type { Item } from '../../core/types.ts'
import type { MoveIn, MoveInCheck, MoveInCommit } from '../move-in.ts'
import type { MoveOut, PackResult } from '../move-out.ts'
import { sessionsFor } from '../sleep.ts'
import type { Link } from './link.ts'

/** How it went for one target, as `board move` and the card's menu read it. */
/** What a move would take, shown before it (`--dry-run`, the card's Device): nothing put to sleep or copied. */
export interface MovePlan {
  /** The folder it would run in there. */
  cwd: string
  address: string
  branch: string
  /** The uncommitted files that would go with it, by their path in the checkout. */
  changes: { path: string; size: number }[]
  deleted: string[]
  /** The session's own files (transcript, side folder, history) and their bytes. */
  files: number
  bytes: number
  /** The changes as one key (core/move-device.ts changesKey): a move given it goes only with these same changes. */
  changesKey: string
}

export interface DeviceMoveOutcome {
  target: string
  result: 'moved' | 'refused' | 'plan'
  plan?: MovePlan
  why?: string
  /** The session's key before and after, as this board names it. */
  key?: string
  newKey?: string
  name?: string
  pane?: string | null
  from?: string
  to?: string
  notes?: string[]
}

/** One board's half of a move, the same whether it is this one or a node. */
export interface MoveSide {
  readonly id: string
  pack(key: string, from: string, dryRun?: boolean): Promise<PackResult>
  file(session: string, n: number): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | { ok: false; why: string }>
  abort(session: string): Promise<void>
  finish(session: string, to: string): Promise<{ ok: true; notes: string[] } | { ok: false; why: string }>
  check(pack: MovePack): Promise<MoveInCheck>
  put(sha: string, body: ReadableStream<Uint8Array>): Promise<{ ok: true } | { ok: false; why: string }>
  commit(pack: MovePack): Promise<MoveInCommit>
  settle(pack: MovePack): Promise<{ ok: true; entries: number } | { ok: false; why: string }>
  launchState(id: string): Promise<string | null>
}

export interface DeviceMoveOptions {
  nodes: () => NodesConfig | null
  link: (id: string) => Pick<Link, 'fetch' | 'state'> | null
  /** This board's own halves. */
  out: MoveOut
  in: MoveIn
  /** This board's sessions and every node's (prefixed keys), as the page has them. */
  items: () => Item[]
  /** The threads of this board follow a session's new key (adapters/work-thread-store.ts rekeySession). */
  rekeyThreads: (from: string, to: string) => void
  log: (text: string) => void
  /** How long the target's start is waited for before the source finishes anyway (2 minutes). */
  startWaitMs?: number
}

/** A launch's state that could not be asked: the wait goes on. */
const UNKNOWN = 'unknown'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** This board's own halves as a side. */
export function localSide(o: Pick<DeviceMoveOptions, 'out' | 'in'>): MoveSide {
  return {
    id: LOCAL,
    pack: (key, from, dryRun) => o.out.pack(key, from, dryRun),
    async file(session, n) {
      const abs = o.out.file(session, n)
      if (!abs) return { ok: false, why: 'the file is no longer offered' }
      return { ok: true, body: Bun.file(abs).stream() }
    },
    async abort(session) {
      await o.out.abort(session)
    },
    finish: (session, to) => o.out.finish(session, to),
    check: pack => o.in.check(pack),
    put: (sha, body) => o.in.put(sha, body),
    commit: pack => o.in.commit(pack),
    settle: async pack => {
      const r = o.in.settle(pack)
      return r.ok ? r : { ok: false, why: r.why }
    },
    launchState: async id => o.in.launchState(id),
  }
}

/** A node's halves through its door (server/routes/node.ts `/api/node/move/...`). */
export function nodeSide(id: string, link: Pick<Link, 'fetch'>): MoveSide {
  const older = `${id} runs a board without device moves: update it first`
  async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await link.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      return { ok: false, why: `${id} did not answer (${messageOf(err)})`, error: 'offline' }
    }
    if (res.status === 404) {
      await res.body?.cancel()
      return { ok: false, why: older, error: 'older' }
    }
    if (res.status === 503) {
      await res.body?.cancel()
      return { ok: false, why: `${id} is not reachable now`, error: 'offline' }
    }
    const got: unknown = await res.json().catch(() => null)
    return isRecord(got) ? got : { ok: false, why: `${id} answered ${res.status}` }
  }
  const why = (r: Record<string, unknown>): string => (typeof r.why === 'string' && r.why) || 'it failed there'
  const enc = encodeURIComponent
  return {
    id,
    async pack(key, from, dryRun) {
      const r = await call('/api/node/move/out', { key, from, ...(dryRun && { dryRun: true }) })
      return r.ok === true && isRecord(r.pack) && typeof r.key === 'string'
        ? { ok: true, pack: r.pack as unknown as MovePack, key: r.key, wasAwake: r.wasAwake === true }
        : { ok: false, why: why(r), ...(typeof r.kind === 'string' && { kind: r.kind as never }) }
    },
    async file(session, n) {
      let res: Response
      try {
        res = await link.fetch(`/api/node/move/out/${enc(session)}/file/${n}`, { method: 'GET' })
      } catch (err) {
        return { ok: false, why: `${id} did not answer (${messageOf(err)})` }
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel()
        return { ok: false, why: res.status === 404 ? 'the file is no longer offered' : `${id} answered ${res.status}` }
      }
      return { ok: true, body: res.body }
    },
    async abort(session) {
      await call(`/api/node/move/out/${enc(session)}/abort`, {}).catch(() => {})
    },
    async finish(session, to) {
      const r = await call(`/api/node/move/out/${enc(session)}/finish`, { to })
      return r.ok === true
        ? { ok: true, notes: Array.isArray(r.notes) ? r.notes.map(String) : [] }
        : { ok: false, why: why(r) }
    },
    async check(pack) {
      const r = await call('/api/node/move/in/check', { pack })
      return r.ok === true && typeof r.cwd === 'string' && Array.isArray(r.missing)
        ? { ok: true, cwd: r.cwd, missing: r.missing.map(String) }
        : { ok: false, error: 'repo', why: why(r) }
    },
    async put(sha, body) {
      let res: Response
      try {
        res = await link.fetch(`/api/node/move/in/blob/${sha}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body,
          // A stream as the body: Bun sends it as it comes.
          duplex: 'half',
        } as RequestInit)
      } catch (err) {
        return { ok: false, why: `${id} did not answer (${messageOf(err)})` }
      }
      const r: unknown = await res.json().catch(() => null)
      return isRecord(r) && r.ok === true
        ? { ok: true }
        : { ok: false, why: isRecord(r) ? why(r) : `${id} answered ${res.status}` }
    },
    async commit(pack) {
      const r = await call('/api/node/move/in/commit', { pack })
      return r.ok === true && typeof r.launch === 'string'
        ? {
            ok: true,
            cwd: String(r.cwd ?? ''),
            launch: r.launch,
            notes: Array.isArray(r.notes) ? r.notes.map(String) : [],
          }
        : { ok: false, error: 'launch', why: why(r) }
    },
    async settle(pack) {
      const r = await call('/api/node/move/in/settle', { pack })
      return r.ok === true ? { ok: true, entries: Number(r.entries) || 0 } : { ok: false, why: why(r) }
    },
    async launchState(launch) {
      // Only the node's own answer says its launch is gone (null); no answer is not knowing.
      try {
        const res = await link.fetch(`/api/node/move/in/launch/${enc(launch)}`, { method: 'GET' })
        const r: unknown = res.ok ? await res.json().catch(() => undefined) : await res.body?.cancel()
        if (isRecord(r) && (typeof r.state === 'string' || r.state === null)) return r.state as string | null
      } catch {}
      return UNKNOWN
    },
  }
}

/**
 * Move the sessions `targets` name to `device` (`local`: this computer), one after the other.
 * One outcome per target, in their order.
 */
export async function moveToDevice(
  o: DeviceMoveOptions,
  targets: readonly string[],
  device: string,
  { dryRun = false, expect }: { dryRun?: boolean; expect?: string } = {},
): Promise<DeviceMoveOutcome[]> {
  const cfg = o.nodes()
  const asked = [...new Set(targets.map(s => s.trim()).filter(Boolean))]
  const refuseAll = (why: string): DeviceMoveOutcome[] => asked.map(target => ({ target, result: 'refused', why }))
  if (!cfg) return refuseAll('a move to another device is made from the master: this board has no devices')
  const sideOf = (id: string): MoveSide | string => {
    if (id === LOCAL) return localSide(o)
    const dev = cfg.devices[id]
    if (!isDevice(id) || !dev?.link) return `no device ${id} (\`board nodes\` lists them)`
    if (dev.revoked) return `${id} is revoked`
    const link = o.link(id)
    if (link?.state().state !== 'online') return `${id} is not reachable now`
    return nodeSide(id, link)
  }
  const target = sideOf(device)
  if (typeof target === 'string') return refuseAll(target)
  const items = o.items()
  const out: DeviceMoveOutcome[] = []
  const seen = new Set<string>()
  for (const t of asked) {
    const fits = sessionsFor(items, t)
    const item = fits[0]
    if (!item) {
      out.push({ target: t, result: 'refused', why: 'no such session on the board' })
      continue
    }
    if (fits.length > 1) {
      out.push({
        target: t,
        result: 'refused',
        why: `fits several sessions (${fits.map(i => i.name).join(', ')}): give its key`,
      })
      continue
    }
    if (seen.has(item.key)) continue
    seen.add(item.key)
    const at = parseNodeKey(item.key)
    const from = at?.device ?? LOCAL
    const who = { key: item.key, name: item.name, pane: item.pane, from, to: device }
    if (from === device) {
      out.push({
        target: t,
        result: 'refused',
        why: `it is on ${device === LOCAL ? 'this computer' : device} already`,
        ...who,
      })
      continue
    }
    const source = sideOf(from)
    if (typeof source === 'string') {
      out.push({ target: t, result: 'refused', why: source, ...who })
      continue
    }
    const r = await (dryRun ? planOne : moveOne)(o, cfg, source, target, at?.key ?? item.key, expect).catch(
      (err: unknown): DeviceMoveOutcome => ({ target: t, result: 'refused', why: messageOf(err) }),
    )
    out.push({ ...r, target: t, ...who, ...(r.newKey && { newKey: r.newKey }) })
  }
  return out
}

/** What moving it would take, asked of both sides without sleeping or copying anything. */
async function planOne(
  _o: DeviceMoveOptions,
  cfg: NodesConfig,
  source: MoveSide,
  target: MoveSide,
  key: string,
  _expect?: string,
): Promise<DeviceMoveOutcome> {
  const packed = await source.pack(key, source.id === LOCAL ? cfg.id : source.id, true)
  if (!packed.ok) return { target: key, result: 'refused', why: packed.why }
  const pack = { ...packed.pack, profile: profileOn(cfg.devices, source.id, target.id, packed.pack.profile) }
  const checked = await target.check(pack)
  if (!checked.ok) return { target: key, result: 'refused', why: checked.why }
  const own = pack.files.filter(f => f.kind !== 'change')
  return {
    target: key,
    result: 'plan',
    plan: {
      cwd: checked.cwd,
      address: pack.folder.address,
      branch: pack.folder.branch,
      changes: pack.files.filter(f => f.kind === 'change').map(f => ({ path: f.path, size: f.size })),
      deleted: pack.folder.deleted,
      files: own.length,
      bytes: own.reduce((s, f) => s + f.size, 0),
      changesKey: changesKey(pack),
    },
  }
}

async function moveOne(
  o: DeviceMoveOptions,
  cfg: NodesConfig,
  source: MoveSide,
  target: MoveSide,
  key: string,
  expect?: string,
): Promise<DeviceMoveOutcome> {
  const fail = (why: string): DeviceMoveOutcome => ({ target: key, result: 'refused', why })
  const packed = await source.pack(key, source.id === LOCAL ? cfg.id : source.id)
  if (!packed.ok) return fail(packed.why)
  const session = packed.pack.session
  // Moved with the changes the owner saw listed, or not at all.
  if (expect !== undefined && changesKey(packed.pack) !== expect) {
    await source.abort(session).catch(() => {})
    return fail('its uncommitted changes are not the ones listed any more: look again')
  }
  // Whatever throws before the target's start was asked for calls the move off at the source.
  let committed = false
  try {
    return await carry(o, cfg, source, target, key, packed.pack, () => {
      committed = true
    })
  } catch (err) {
    if (committed) throw err
    await source.abort(session).catch(() => {})
    return fail(messageOf(err))
  }
}

async function carry(
  o: DeviceMoveOptions,
  cfg: NodesConfig,
  source: MoveSide,
  target: MoveSide,
  key: string,
  given: MovePack,
  started: () => void,
): Promise<DeviceMoveOutcome> {
  const fail = (why: string): DeviceMoveOutcome => ({ target: key, result: 'refused', why })
  const session = given.session
  const packed = { pack: given }
  const pack: MovePack = {
    ...packed.pack,
    profile: profileOn(cfg.devices, source.id, target.id, packed.pack.profile),
  }
  const callOff = async (why: string): Promise<DeviceMoveOutcome> => {
    await source.abort(session).catch(() => {})
    o.log(`move: ${pack.name || session} stays on ${source.id}: ${why}`)
    return fail(why)
  }
  const checked = await target.check(pack)
  if (!checked.ok) return callOff(checked.why)
  for (const sha of checked.missing) {
    const n = pack.files.findIndex(f => f.sha256 === sha)
    if (n < 0) continue
    const got = await source.file(session, n)
    if (!got.ok) return callOff(`a file did not come from ${source.id}: ${got.why}`)
    const put = await target.put(sha, got.body)
    if (!put.ok) return callOff(`a file did not go to ${target.id}: ${put.why}`)
  }
  started()
  const committed = await target
    .commit(pack)
    .catch(
      (err: unknown): Awaited<ReturnType<MoveSide['commit']>> => ({ ok: false, error: 'launch', why: messageOf(err) }),
    )
  if (!committed.ok) return callOff(committed.why)
  const notes = [...committed.notes]
  // The old card goes once the new start is on its way: done, or still starting when the wait ends.
  const state = await waitStart(target, committed.launch, o.startWaitMs ?? 120_000)
  if (state === 'failed') return callOff(`its resume on ${target.id} failed: its card there says why`)
  if (state !== 'done')
    notes.push(state === null ? 'its start there is no longer shown' : `its start there is ${state}`)
  // From here on the session runs there: what fails is a note, and the source is finished all the same.
  const settled = await target.settle(pack).catch((err: unknown) => ({ ok: false as const, why: messageOf(err) }))
  if (!settled.ok) notes.push(`its schedule entries stayed behind (${settled.why})`)
  else if (settled.entries) notes.push(`${settled.entries} schedule entr${settled.entries === 1 ? 'y' : 'ies'} moved`)
  const finished = await source
    .finish(session, target.id === LOCAL ? cfg.id : target.id)
    .catch((err: unknown) => ({ ok: false as const, why: messageOf(err) }))
  if (!finished.ok) notes.push(`the old card stays on ${source.id} (${finished.why})`)
  else notes.push(...finished.notes)
  const oldKey = source.id === LOCAL ? session : nodeKey(source.id, session)
  const newKey = target.id === LOCAL ? session : nodeKey(target.id, session)
  try {
    o.rekeyThreads(oldKey, newKey)
  } catch (err) {
    notes.push(`its threads did not follow (${messageOf(err)})`)
  }
  notes.push(`runs in ${committed.cwd}`)
  o.log(`move: ${pack.name || session} moved from ${source.id} to ${target.id}`)
  return { target: key, result: 'moved', newKey, notes }
}

/** The target's start, asked every half second until it is done or failed, or the wait is over: its last state. */
async function waitStart(target: MoveSide, launch: string, ms: number): Promise<string | null> {
  const until = Date.now() + ms
  let state: string | null = 'starting'
  for (;;) {
    state = await target.launchState(launch).catch(() => UNKNOWN)
    if (state === 'done' || state === 'failed' || state === null) return state
    if (Date.now() > until) return state
    await pause(500)
  }
}
