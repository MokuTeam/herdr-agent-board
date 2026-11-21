// The master ships its commit to a node (#590, docs/design/nodes 6.2, 6.5, 11.3): a device that is
// online and whose status names another commit than this board's gets the plugin at this board's
// commit as one archive (`git archive`, adapters/git.ts archiveCommit), then `{ commit, sha256 }`;
// the node unpacks, installs, swaps and restarts its board (services/node/update.ts). Made by
// server/app.ts only once `nodes` is on.
//
// By itself when none of that node's sessions is in a turn: looked at when the node's link brings a
// payload, a state or a status (links.ts onChange), which also comes once the link is up after this
// board starts; there is no timer of its own. At once when asked (`board nodes update <id>`, the
// Devices row's Update), a session in a turn or not. Once a try for a pair of commits (this board's,
// the node's) failed, it is not made again by itself until either commit changes; asked, it is. While
// it runs, and until the node's status names the new commit, the device's view says so; a node that
// does not come back on it within BACK_MS is a failure.
import { createHash } from 'node:crypto'
import type { DeviceUpdate } from '../../core/nodes.ts'
import { MAX_ARCHIVE_BYTES } from '../node/update.ts'
import { type Clock, realClock } from '../tunnel.ts'
import type { NodeLinks } from './links.ts'

/** The node answers on the new commit within this long after it said it restarts (paced in tests by the clock). */
export const BACK_MS = 3 * 60_000
/** The archive's upload may take this long: 20 MB through an ssh forward. */
const SEND_MS = 5 * 60_000
/** The node's unpack and `bun install --production` may take this long (its own limit is 10 minutes). */
const UPDATE_MS = 12 * 60_000

/** What `board nodes update` and the row's Update are answered. */
export interface ShipAnswer {
  ok: boolean
  /** The node already runs this board's commit. */
  current?: boolean
  commit?: string
  error?: string
  detail?: string
}

export interface NodeUpdater {
  /** The device's update as its view shows it; null when none runs and none failed. */
  view(id: string): DeviceUpdate | null
  /** An update to the device is on its way (sent, or the node restarting on it). */
  updating(id: string): boolean
  /** Ships this board's commit to the device now (asked): a session in a turn or not. */
  ship(id: string): Promise<ShipAnswer>
  close(): void
}

export interface NodeUpdaterOptions {
  links: Pick<NodeLinks, 'on' | 'link' | 'onChange'>
  /** This board's commit (server/app.ts runningCommit); '' when it has none. */
  commit(): Promise<string>
  /** Whether this board is a git checkout it can make an archive of; one installed from an archive is not. */
  canShip(): Promise<boolean>
  /** The checkout at `commit` as one tar (adapters/git.ts archiveCommit); null when git cannot. */
  archive(commit: string): Promise<Uint8Array | null>
  /** A device's update state changed: the board publishes again. */
  onChange(): void
  /** Whether config.json marks the device revoked (#510): it gets no update, by itself or asked. */
  revoked?: (id: string) => boolean
  log(text: string): void
  clock?: Clock
  backMs?: number
}

const short = (sha: string): string => sha.slice(0, 12)

export function createNodeUpdater(o: NodeUpdaterOptions): NodeUpdater {
  const clock = o.clock ?? realClock
  const backMs = o.backMs ?? BACK_MS
  const states = new Map<string, DeviceUpdate>()
  /** The pair of commits last tried by itself per device: `<ours>><theirs>`. */
  const tried = new Map<string, string>()
  const backTimers = new Map<string, unknown>()
  /** The last archive made, kept for the next node: one commit at a time. */
  let made: { commit: string; bytes: Uint8Array; sha256: string } | null = null
  let closed = false
  /** Devices a look or a ship is busy with, before its first await: a second waits or is told busy. */
  const pending = new Set<string>()
  /** Looks asked for while one ran: made once it ends. */
  const again = new Set<string>()
  const revoked = (id: string): boolean => o.revoked?.(id) === true

  function set(id: string, next: DeviceUpdate | null): void {
    const timer = backTimers.get(id)
    if (timer !== undefined && next?.state !== 'restarting') {
      clock.clearTimeout(timer)
      backTimers.delete(id)
    }
    if (next) states.set(id, next)
    else if (!states.delete(id)) return
    o.onChange()
  }

  const fail = (id: string, commit: string, error: string, detail?: string): ShipAnswer => {
    o.log(
      `nodes: the update of ${id} to ${short(commit)} failed: ${error}${detail ? ` (${detail.slice(0, 200)})` : ''}`,
    )
    set(id, { state: 'failed', commit, error, ...(detail && { detail }), at: clock.now() })
    return { ok: false, commit, error, ...(detail && { detail }) }
  }

  async function archiveOf(commit: string): Promise<typeof made> {
    if (made?.commit === commit) return made
    const bytes = await o.archive(commit)
    if (!bytes) return null
    made = { commit, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    return made
  }

  /** The node's answer as JSON, or an empty record. */
  async function answerOf(res: Response): Promise<Record<string, unknown>> {
    const body: unknown = await res.json().catch(() => null)
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  }

  const words = (a: Record<string, unknown>, status: number): string =>
    typeof a.error === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(a.error)
      ? a.error
      : status === 404
        ? 'not-built'
        : 'node'

  async function send(id: string, commit: string): Promise<ShipAnswer> {
    const link = o.links.link(id)
    if (link?.state().state !== 'online') return fail(id, commit, 'offline')
    set(id, { state: 'updating', commit, at: clock.now() })
    o.log(`nodes: updating ${id} to ${short(commit)}`)
    const archive = await archiveOf(commit)
    if (!archive) return fail(id, commit, 'git-archive')
    if (archive.bytes.length > MAX_ARCHIVE_BYTES) return fail(id, commit, 'too-big')
    try {
      const put = await link.fetch('/api/node/update/blob', {
        method: 'PUT',
        headers: { 'content-type': 'application/x-tar' },
        body: archive.bytes as Uint8Array<ArrayBuffer>,
        signal: AbortSignal.timeout(SEND_MS),
      })
      const sent = await answerOf(put)
      if (!put.ok)
        return fail(id, commit, words(sent, put.status), typeof sent.detail === 'string' ? sent.detail : undefined)
      if (sent.sha256 !== archive.sha256) return fail(id, commit, 'sha256')
      const res = await link.fetch('/api/node/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commit, sha256: archive.sha256 }),
        signal: AbortSignal.timeout(UPDATE_MS),
      })
      const a = await answerOf(res)
      if (!res.ok || a.ok !== true)
        return fail(id, commit, words(a, res.status), typeof a.detail === 'string' ? a.detail : undefined)
      if (a.current === true) {
        set(id, null)
        return { ok: true, current: true, commit }
      }
    } catch (err) {
      const offline = link.state().state !== 'online'
      return fail(id, commit, offline ? 'offline' : 'timeout', err instanceof Error ? err.message : undefined)
    }
    // Restarting: done once its status names the commit, failed when it does not within backMs.
    set(id, { state: 'restarting', commit, at: clock.now() })
    backTimers.set(
      id,
      clock.setTimeout(() => {
        backTimers.delete(id)
        if (states.get(id)?.state === 'restarting' && states.get(id)?.commit === commit) fail(id, commit, 'not-back')
      }, backMs),
    )
    // The node's board restarts: its link brings the new status, and look() sees the commit.
    return { ok: true, commit }
  }

  /**
   * What the device's link says now: the commit its status names (null before a status; '' for a
   * node that knows none, which an update gives one), and whether any of its sessions is in a turn
   * or a start is on its way there (a clone or a bundle the board's restart would cut).
   */
  function facts(id: string): { online: boolean; theirs: string | null; turn: boolean } {
    const link = o.links.link(id)
    const online = link?.state().state === 'online'
    const status = link?.view().status ?? null
    const items = link?.payload()?.items ?? []
    const turn = items.some(i => i.status === 'working') || (status?.launches ?? 0) > 0
    return { online, theirs: status ? status.commit : null, turn }
  }

  /** By itself: ships when the node is online on another commit, no session there in a turn, and this pair was not tried. */
  async function look(id: string): Promise<void> {
    if (closed || !o.links.on()) return
    if (pending.has(id)) {
      again.add(id)
      return
    }
    pending.add(id)
    try {
      await lookNow(id)
    } finally {
      pending.delete(id)
    }
    if (again.delete(id)) await look(id)
  }

  async function lookNow(id: string): Promise<void> {
    if (revoked(id)) return
    const ours = await o.commit()
    if (!ours) return
    const { online, theirs, turn } = facts(id)
    const now = states.get(id)
    if (theirs === ours) {
      if (now?.state === 'restarting') o.log(`nodes: ${id} runs ${short(ours)} now`)
      if (now && now.state !== 'updating') set(id, null)
      return
    }
    if (!online || theirs === null || now?.state === 'updating' || now?.state === 'restarting') return
    const pair = `${ours}>${theirs}`
    if (tried.get(id) === pair) return
    if (turn) return
    tried.set(id, pair)
    if (!(await o.canShip())) {
      fail(id, ours, 'no-checkout')
      return
    }
    await send(id, ours)
  }

  const off = o.links.onChange(id => {
    void look(id).catch(err => o.log(`nodes: update of ${id}: ${err instanceof Error ? err.message : String(err)}`))
  })

  return {
    view: id => states.get(id) ?? null,
    updating(id) {
      const s = states.get(id)?.state
      return s === 'updating' || s === 'restarting'
    },
    async ship(id) {
      const now = states.get(id)
      if (pending.has(id) || now?.state === 'updating' || now?.state === 'restarting')
        return { ok: false, commit: now?.commit ?? '', error: 'busy' }
      if (revoked(id)) return { ok: false, error: 'revoked' }
      pending.add(id)
      try {
        const ours = await o.commit()
        if (!ours || !(await o.canShip())) return fail(id, ours, 'no-checkout')
        const { theirs } = facts(id)
        if (theirs === ours) {
          if (states.has(id)) set(id, null)
          return { ok: true, current: true, commit: ours }
        }
        if (theirs !== null) tried.set(id, `${ours}>${theirs}`)
        return await send(id, ours)
      } finally {
        pending.delete(id)
      }
    },
    close() {
      closed = true
      off()
      for (const timer of backTimers.values()) clock.clearTimeout(timer)
      backTimers.clear()
    },
  }
}
