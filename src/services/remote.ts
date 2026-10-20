// Pairing for the remote mode (core/remote.ts). A phone on the tailnet asks to pair; the request
// waits, in memory, until the user approves or denies it on the board (or `board remote`), or 10
// minutes pass. An approved phone gets its token once, on its next poll; the board keeps only
// the token's hash, with the Tailscale device it was given to, in remote-devices.json in the state
// folder. A token works from that device only.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, readJson, updateJson } from '../adapters/json-store.ts'
import { stateDir } from '../adapters/paths.ts'
import type { Caller } from '../adapters/tailscale.ts'
import { deviceFor, PAIR_MAX, PAIR_TTL_MS, type PairRequest, type RemoteDevice } from '../core/remote.ts'

export const devicesFile = (): string => join(stateDir(), 'remote-devices.json')

const isDevices = (v: unknown): v is RemoteDevice[] =>
  Array.isArray(v) && v.every(d => isRecord(d) && typeof d.id === 'string' && typeof d.tokenHash === 'string')

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')
const newId = (): string => randomBytes(6).toString('hex')

export type PairAnswer = { ok: true; id: string } | { ok: false; status: 429 | 400; error: 'busy' | 'name' }
export type PollAnswer =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'approved'; token: string; device: string }
  | { status: 'gone' }

export interface Remote {
  /** A request from `who`; one of its own that still waits is answered again instead. */
  request(name: unknown, who: Caller): PairAnswer
  /** How the request stands, for the device that made it only; the token goes out once. */
  poll(id: string, who: Caller): PollAnswer
  approve(id: string): boolean
  deny(id: string): boolean
  /** Unpairs a device: its token stops working at once. */
  revoke(id: string): boolean
  /** The paired device a token is, used from the device it was given to; null for any other. */
  verify(token: string, who: Caller): RemoteDevice | null
  pending(): PairRequest[]
  devices(): RemoteDevice[]
}

export function createRemote({ onChange, now = Date.now }: { onChange: () => void; now?: () => number }): Remote {
  const requests = new Map<string, PairRequest>()
  /** Tokens of approved requests, until their phone polls once. */
  const handed = new Map<string, string>()
  const seen = new Map<string, number>()

  const devices = (): RemoteDevice[] => readJson(devicesFile(), isDevices) ?? []
  function save(change: (list: RemoteDevice[]) => RemoteDevice[]): void {
    mkdirSync(stateDir(), { recursive: true })
    updateJson(devicesFile(), list => change(list ?? []), isDevices, { mode: 0o600 })
  }

  function expire(): void {
    for (const [id, r] of requests) {
      if (now() - r.at > PAIR_TTL_MS) {
        requests.delete(id)
        handed.delete(id)
      }
    }
  }

  return {
    request(name, who) {
      expire()
      const label = typeof name === 'string' ? name.trim().slice(0, 60) : ''
      if (!label) return { ok: false, status: 400, error: 'name' }
      const mine = [...requests.values()].find(r => r.node === who.node && r.status === 'pending')
      if (mine) return { ok: true, id: mine.id }
      if ([...requests.values()].filter(r => r.status === 'pending').length >= PAIR_MAX)
        return { ok: false, status: 429, error: 'busy' }
      const id = newId()
      requests.set(id, { id, name: label, ...who, at: now(), status: 'pending' })
      onChange()
      return { ok: true, id }
    },
    poll(id, who) {
      expire()
      const r = requests.get(id)
      if (!r || r.node !== who.node) return { status: 'gone' }
      if (r.status === 'pending') return { status: 'pending' }
      requests.delete(id)
      const token = handed.get(id)
      handed.delete(id)
      return r.status === 'approved' && token ? { status: 'approved', token, device: r.device } : { status: 'denied' }
    },
    approve(id) {
      expire()
      const r = requests.get(id)
      if (r?.status !== 'pending') return false
      const token = randomBytes(32).toString('base64url')
      const { status: _, at: __, ...who } = r
      // One device, one pairing: pairing it again replaces its old token.
      save(list => [
        ...list.filter(d => d.node !== r.node),
        { ...who, id: newId(), tokenHash: hashToken(token), pairedAt: now(), seenAt: null },
      ])
      r.status = 'approved'
      handed.set(id, token)
      onChange()
      return true
    },
    deny(id) {
      const r = requests.get(id)
      if (r?.status !== 'pending') return false
      r.status = 'denied'
      onChange()
      return true
    },
    revoke(id) {
      let found = false
      save(list => {
        found = list.some(d => d.id === id)
        return list.filter(d => d.id !== id)
      })
      if (found) onChange()
      return found
    },
    verify(token, who) {
      const device = deviceFor(devices(), hashToken(token), who.node)
      if (!device) return null
      // When it was last seen goes to the file at most once a minute.
      const last = seen.get(device.id) ?? device.seenAt ?? 0
      if (now() - last > 60_000) {
        seen.set(device.id, now())
        save(list => list.map(d => (d.id === device.id ? { ...d, seenAt: now() } : d)))
      }
      return device
    },
    pending() {
      expire()
      return [...requests.values()].filter(r => r.status === 'pending')
    },
    devices,
  }
}
