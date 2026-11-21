// Revoking a device from the master (#510, docs/design/nodes 11.4). In order: config.json's
// `nodes.devices.<id>.revoked` is written and the live config sees it at once, so the placer
// refuses the device from that instant and its queued starts go on to others (core/placement.ts
// unfitWhy); then, while the link is online, the node is called on `POST /api/node/leave` (its
// sessions to sleep unless the owner keeps them running) and, once it answered, the device's token
// and link key are deleted and its link closed. A node that is not reachable is told the next time
// its link comes online: until then its token and key are kept for that one call, and `forget`
// drops them at once without telling it. `<nodes>/<id>/revoke.json` (adapters/node-store.ts)
// keeps where it stands across restarts. Made by server/app.ts only while `nodes` is on.
import type { EditResult } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import type { DeviceStore, Revocation } from '../../adapters/node-store.ts'
import { LOCAL, type NodesConfig } from '../../core/nodes.ts'
import type { NodeLinks } from './links.ts'

export interface RevokerOptions {
  links: NodeLinks
  store: DeviceStore
  /** config.json's `nodes` as the live config has it now. */
  config(): NodesConfig | null
  /** Writes `nodes.devices.<id>.revoked: true` (core/nodes.ts markRevoked), seen by the live config at once. */
  mark(id: string): EditResult
  now?: () => number
  log(text: string): void
}

export interface RevokeAsk {
  /** The node's sessions put to sleep before it forgets this master (not `--keep-running`). */
  sleep: boolean
  /** The token and link key dropped now, without telling the node (`--forget`, "Forget now"). */
  forget: boolean
}

export interface RevokeAnswer {
  status: number
  body: Record<string, unknown>
}

export interface Revoker {
  revoke(id: string, ask: RevokeAsk): Promise<RevokeAnswer>
  /** Stops following the links. */
  close(): void
}

/** Whether the node was told, and when it was, what it says of its sessions. */
interface Told {
  told: boolean
  slept?: number | undefined
  kept?: number | undefined
}

/** How long the node has to answer `leave`: its sessions go to sleep first. */
const LEAVE_MS = 60_000

export function createRevoker(o: RevokerOptions): Revoker {
  const now = o.now ?? Date.now
  const telling = new Map<string, Promise<Told>>()
  // The devices still to be told, from revoke.json as a restart finds it, and whether each one's
  // link was online when last seen: it is told when it comes online, not on every payload.
  const pending = new Set<string>()
  const wasOnline = new Map<string, boolean>()
  for (const [id, device] of Object.entries(o.config()?.devices ?? {}))
    if (device.revoked && o.store.revocation(id)?.told === null) pending.add(id)

  /** The device's token and key deleted, where it stands written, its link closed. */
  async function drop(id: string, rev: Revocation, told: boolean): Promise<void> {
    o.store.dropCredentials(id)
    o.store.setRevocation(id, { ...rev, told })
    pending.delete(id)
    wasOnline.delete(id)
    o.log(
      `nodes: ${id} revoked; ${told ? 'the node was told and forgot this board' : 'its token and key dropped without telling the node'}`,
    )
    await o.links.follow()
  }

  /** Calls `leave` on the device while its link is online; true once the node answered and its credentials are gone. */
  function tell(id: string): Promise<Told> {
    const running = telling.get(id)
    if (running) return running
    const p = (async (): Promise<Told> => {
      const rev = o.store.revocation(id)
      if (!rev || rev.told !== null) return { told: rev?.told === true }
      const link = o.links.link(id)
      const state = link?.state()
      // The node refuses the token: it forgot this board already (`board node leave` there, or a
      // leave it finished after this board stopped waiting). Nothing is left to tell it.
      if (state?.state === 'refused' && state.reason === 'token') {
        await drop(id, rev, true)
        return { told: true }
      }
      if (!link || state?.state !== 'online') return { told: false }
      let res: Response
      let answer: unknown = null
      try {
        res = await link.fetch('/api/node/leave', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sleep: rev.sleep }),
          signal: AbortSignal.timeout(LEAVE_MS),
        })
        answer = await res.json().catch(() => null)
      } catch {
        return { told: false }
      }
      // 401: the node forgot this board already (`board node leave` there); the token opens nothing.
      if (!res.ok && res.status !== 401) {
        o.log(`nodes: ${id} did not take leave (${res.status}); told again when its link comes back`)
        return { told: false }
      }
      await drop(id, rev, true)
      // What the node says of its sessions: put to sleep, and kept awake (at work, a dialog, wake down).
      const a = isRecord(answer) ? answer : {}
      const count = (v: unknown): number | undefined =>
        Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined
      return { told: true, slept: count(a.slept), kept: count(a.kept) }
    })().finally(() => telling.delete(id))
    telling.set(id, p)
    return p
  }

  // A device revoked while it was away is told as soon as its link is online again.
  const off = o.links.onChange(id => {
    if (!pending.has(id)) return
    const state = o.links.link(id)?.state()
    const online = state?.state === 'online'
    const was = wasOnline.get(id) === true
    wasOnline.set(id, online)
    if ((online && !was) || (state?.state === 'refused' && state.reason === 'token')) void tell(id)
  })

  return {
    async revoke(id, ask) {
      const device = id === LOCAL ? undefined : o.config()?.devices[id]
      if (!device?.link) return { status: 404, body: { error: 'device' } }
      const marked = o.mark(id)
      if (!marked.ok) return { status: 409, body: { ...marked } }
      let rev = o.store.revocation(id)
      if (!rev || rev.told !== null) {
        // Revoked again after it was told or forgotten: nothing more to tell it.
        if (rev && o.store.token(id) === null)
          return { status: 200, body: { ok: true, told: rev.told === true, kept: false } }
        rev = { at: now(), sleep: ask.sleep, told: null }
      } else rev = { ...rev, sleep: ask.sleep }
      o.store.setRevocation(id, rev)
      pending.add(id)
      wasOnline.set(id, o.links.link(id)?.state().state === 'online')
      if (ask.forget) {
        await drop(id, rev, false)
        return { status: 200, body: { ok: true, told: false, kept: false } }
      }
      const r = await tell(id)
      const sessions =
        r.slept !== undefined || r.kept !== undefined ? { sessions: { slept: r.slept ?? 0, kept: r.kept ?? 0 } } : {}
      return { status: 200, body: { ok: true, told: r.told, kept: !r.told, ...sessions } }
    },
    close: off,
  }
}
