// Both sides' records of the node link. On a master (#499, docs/design/nodes 7.1), per device in
// `<state>/nodes/<id>/`: `token` (0600; the master is the client, so it holds the token the node
// gave it), the ssh link's `link-key`, the link's ssh pid record, the offline copy, what was sent of
// each profile's bundle, and `uplink-seen.json` (0600, #508), the results of the last calls the
// device's sessions made. Never logged, never printed.
//
// On a node, the masters it answers to (#498, docs/design/nodes 7.2): `<state>/node/masters.json`, mode
// 0600, a list of { id, name, tokenHash, pairedAt, seenAt, via }. A list from its first version,
// with one entry in stage 1, so a second master is no migration (21.3).
//
// A master's token is 32 random bytes, base64url, handed out once by add(); only its SHA-256 is
// kept, as a phone's is (services/remote.ts), and hashes are compared in constant time. The file is
// changed under its lock (json-store.ts), so `board node token` and `board node forget` from a
// shell and the door in the board's process never lose each other's changes. A master forgotten
// from a shell ends its open streams too: while a stream watches, the file is read again every
// second (paced in tests), and only then.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { UPLINK_SEEN_MAX, type UplinkResult, uplinkResultOf } from '../core/node-uplink.ts'
import { DEVICE_ID } from '../core/nodes.ts'
import { hasUnprintable } from '../core/team.ts'
import { isRecord, readJson, replaceFile, updateJson } from './json-store.ts'
import { pace } from './pacing.ts'
import { stateDir } from './paths.ts'

/** How a master came to this node: by `board node token` (stage 1); claim and install come later. */
export type MasterVia = 'hand' | 'claim' | 'install'

export interface MasterRecord {
  id: string
  /** What the owner called it, for `board node`. */
  name: string
  tokenHash: string
  pairedAt: number
  /** When its token was last used, written at most once a minute; null before. */
  seenAt: number | null
  via: MasterVia
}

/** A master's name: trimmed, not empty, at most this long, nothing unprintable. */
export const MASTER_NAME_MAX = 64

/** The node's own folder in the board's state folder. */
export const nodeDir = (): string => join(stateDir(), 'node')

const VIAS: ReadonlySet<unknown> = new Set(['hand', 'claim', 'install'])
const isMaster = (m: unknown): m is MasterRecord =>
  isRecord(m) &&
  typeof m.id === 'string' &&
  typeof m.name === 'string' &&
  typeof m.tokenHash === 'string' &&
  /^[0-9a-f]{64}$/.test(m.tokenHash) &&
  typeof m.pairedAt === 'number' &&
  (m.seenAt === null || typeof m.seenAt === 'number') &&
  VIAS.has(m.via)
const isMasters = (v: unknown): v is MasterRecord[] => Array.isArray(v) && v.every(isMaster)

/** A name as given, or null when it will not do. */
export function masterName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return name && name.length <= MASTER_NAME_MAX && !hasUnprintable(name) ? name : null
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Whether two SHA-256 hashes in hex are the same, in time that does not depend on where they differ. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y)
}

export interface NodeStore {
  /** The masters, as the file has them now; throws when it is there but cannot be read or does not parse. */
  list(): MasterRecord[]
  /** Adds a master; its token is in the answer and nowhere else. */
  add(name: string, via: MasterVia): { master: MasterRecord; token: string }
  /** The master a token is, or null; throws, as list() does, when the file cannot be read. */
  verify(token: string): MasterRecord | null
  /** Forgets a master: its token stops working at once, its open streams end. False: no such master. */
  forget(id: string): boolean
  /** Calls `gone` once the master is forgotten, by this process or another; returns the unwatch. */
  watch(id: string, gone: () => void): () => void
}

export interface NodeStoreOptions {
  /** The folder masters.json is in (nodeDir()). */
  dir?: string
  now?: () => number
  /** How often a watched file is read again (1 s, paced in tests). */
  pollMs?: number
}

export function createNodeStore({ dir = nodeDir(), now = Date.now, pollMs = 1000 }: NodeStoreOptions = {}): NodeStore {
  const file = join(dir, 'masters.json')
  const seen = new Map<string, number>()
  const watchers = new Map<string, Set<() => void>>()
  let timer: ReturnType<typeof setInterval> | undefined

  /**
   * The masters; none while there is no file. A file that cannot be read for a moment (EMFILE,
   * EACCES) or does not parse is no revocation: it throws, so the door answers 500 and not 401, no
   * stream ends, and nothing writes over it.
   */
  function read(): MasterRecord[] {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return []
      throw err
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      value = null
    }
    if (!isMasters(value)) throw new Error('masters.json is not a list of masters: fix or remove it')
    return value
  }
  /** Changes the list under its lock; `change` returning undefined writes nothing. */
  function save(change: (masters: MasterRecord[]) => MasterRecord[] | undefined): void {
    mkdirSync(dir, { recursive: true })
    updateJson(
      file,
      masters => {
        // updateJson reads a file that does not parse as none: never written over.
        if (masters === null && existsSync(file)) read()
        return change(masters ?? [])
      },
      isMasters,
      { mode: 0o600 },
    )
  }
  /** The watchers are told only from a list that was read: a failed read ends no stream. */
  const readable = (): MasterRecord[] | null => {
    try {
      return read()
    } catch {
      return null
    }
  }

  /** Tells the watchers of every master no longer in `masters`; the poll stops with the last one. */
  function ended(masters: readonly MasterRecord[]): void {
    const ids = new Set(masters.map(m => m.id))
    for (const [id, set] of watchers) {
      if (ids.has(id)) continue
      watchers.delete(id)
      for (const gone of set) gone()
    }
    if (!watchers.size && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return {
    list: read,
    add(name, via) {
      const token = randomBytes(32).toString('base64url')
      const master: MasterRecord = {
        id: randomBytes(6).toString('hex'),
        name,
        tokenHash: hashToken(token),
        pairedAt: now(),
        seenAt: null,
        via,
      }
      save(masters => [...masters, master])
      return { master, token }
    },
    verify(token) {
      const hash = hashToken(token)
      // Every entry compared, the first match kept: no early way out to time.
      let found: MasterRecord | null = null
      for (const m of read()) if (sameHash(m.tokenHash, hash) && !found) found = m
      if (!found) return null
      const id = found.id
      // When it was last seen goes to the file at most once a minute.
      const last = seen.get(id) ?? found.seenAt ?? 0
      if (now() - last > 60_000) {
        seen.set(id, now())
        // Bookkeeping: a disk that is full or read-only does not turn the master away.
        try {
          save(masters => masters.map(m => (m.id === id ? { ...m, seenAt: now() } : m)))
        } catch {}
      }
      return found
    },
    forget(id) {
      let found = false
      save(masters => {
        found = masters.some(m => m.id === id)
        return found ? masters.filter(m => m.id !== id) : undefined
      })
      if (found) ended(read())
      return found
    },
    watch(id, gone) {
      const set = watchers.get(id) ?? new Set()
      watchers.set(id, set)
      set.add(gone)
      timer ??= setInterval(() => {
        const masters = readable()
        if (masters) ended(masters)
      }, pollMs * pace())
      return () => {
        set.delete(gone)
        if (!set.size && watchers.get(id) === set) watchers.delete(id)
        if (!watchers.size && timer) {
          clearInterval(timer)
          timer = undefined
        }
      }
    },
  }
}

/** The master's folder for its devices in the board's state folder. */
export const nodesDir = (): string => join(stateDir(), 'nodes')

/**
 * The master's relay keys (#511): `master` (local unix socket forwarding) and `enrol`
 * (forced-command script to add/remove NAT node keys), under `<nodes>/relay/`, private to the
 * user; their `.pub` files live beside them.
 */
export const relayKeyPath = (kind: 'master' | 'enrol', dir = nodesDir()): string => join(dir, 'relay', `${kind}-key`)

/** Deletes the master's relay keys (`master-key`, `enrol-key` and their `.pub` halves). */
export function dropRelayCredentials(dir = nodesDir()): void {
  const folder = join(dir, 'relay')
  for (const name of ['master-key', 'master-key.pub', 'enrol-key', 'enrol-key.pub'])
    rmSync(join(folder, name), { force: true })
}

/** A token as a node hands it out (32 random bytes, base64url; add() above), with room for a longer one. */
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/
export const isNodeToken = (v: string): boolean => TOKEN.test(v)

export interface DeviceStore {
  /** The device's own folder, `<nodes>/<id>`. Throws on an id that is not one, so no path leaves the folder. */
  dir(id: string): string
  /** The token the node gave this master, or null: none stored, unreadable, or not a token. */
  token(id: string): string | null
  /** Stores the device's token, mode 0600, whole or not at all. Throws on one that is not a token, without it in the message. */
  setToken(id: string, token: string): void
  /** The ssh link's private key, made by `board nodes key`; its public half beside it with `.pub`. */
  keyPath(id: string): string
  /** The pid record of the device's link ssh (adapters/ssh.ts PidRecord). */
  pidFile(id: string): string
  /**
   * The device's offline copy (`snapshot.json`, #500): when its last payload came and its part of
   * the master's payload as checked then (core/node-items.ts). null: none, unreadable, or not one.
   */
  snapshot(id: string): DeviceSnapshot | null
  /** Writes the offline copy, mode 0600, whole or not at all. */
  setSnapshot(id: string, snapshot: DeviceSnapshot): void
  /**
   * What was sent of each profile's bundle (`bundle.json`, #506): read again through
   * services/nodes/bundle-sync.ts, never trusted. null: none, unreadable, or no JSON object.
   */
  bundle(id: string): Record<string, unknown> | null
  /** Writes the bundle record, mode 0600, whole or not at all. */
  setBundle(id: string, value: Record<string, unknown>): void
  /**
   * The result the master gave a call of the device's sessions before (#508, `uplink-seen.json`),
   * or null: a call seen again is answered with it and not run again.
   */
  seenCall(id: string, call: string): UplinkResult | null
  /** Remembers a call's result, the last UPLINK_SEEN_MAX calls of the device; mode 0600. */
  rememberCall(id: string, call: string, result: UplinkResult): void
  /**
   * The device's revocation (#510, `revoke.json`): when, whether the node's sessions are to sleep,
   * and `told`: null while the node is still to be told, true once it answered `leave`, false when
   * the owner dropped the credentials without telling it. null: never revoked, or unreadable.
   */
  revocation(id: string): Revocation | null
  setRevocation(id: string, value: Revocation): void
  /** Deletes the device's token and its link key with the public half: nothing of it opens the node any more. */
  dropCredentials(id: string): void
}

/** A device's revocation as `revoke.json` keeps it. */
export interface Revocation {
  at: number
  sleep: boolean
  told: boolean | null
}

const isRevocation = (v: unknown): v is Revocation =>
  isRecord(v) &&
  typeof v.at === 'number' &&
  typeof v.sleep === 'boolean' &&
  (v.told === null || typeof v.told === 'boolean')

/** The offline copy of a device: `part` is read again through core/node-items.ts nodePart, never trusted. */
export interface DeviceSnapshot {
  at: number
  part: unknown
}

export function createDeviceStore({ dir = nodesDir() }: { dir?: string } = {}): DeviceStore {
  const folder = (id: string): string => {
    if (!DEVICE_ID.test(id)) throw new Error(`not a device id: ${JSON.stringify(id)}`)
    return join(dir, id)
  }
  return {
    dir: folder,
    token(id) {
      try {
        const token = readFileSync(join(folder(id), 'token'), 'utf8').trim()
        return isNodeToken(token) ? token : null
      } catch {
        return null
      }
    },
    setToken(id, token) {
      if (!isNodeToken(token))
        throw new Error('not a token: a node prints one line of 32 or more letters, digits, - and _')
      const at = folder(id)
      mkdirSync(at, { recursive: true })
      replaceFile(join(at, 'token'), `${token}\n`, undefined, 0o600)
    },
    keyPath: id => join(folder(id), 'link-key'),
    pidFile: id => join(folder(id), 'ssh-pid.json'),
    snapshot(id) {
      try {
        const value: unknown = JSON.parse(readFileSync(join(folder(id), 'snapshot.json'), 'utf8'))
        return isRecord(value) && typeof value.at === 'number' && Number.isFinite(value.at)
          ? { at: value.at, part: value.part }
          : null
      } catch {
        return null
      }
    },
    setSnapshot(id, snapshot) {
      const at = folder(id)
      mkdirSync(at, { recursive: true })
      replaceFile(join(at, 'snapshot.json'), JSON.stringify(snapshot), undefined, 0o600)
    },
    bundle(id) {
      try {
        const value: unknown = JSON.parse(readFileSync(join(folder(id), 'bundle.json'), 'utf8'))
        return isRecord(value) ? value : null
      } catch {
        return null
      }
    },
    setBundle(id, value) {
      const at = folder(id)
      mkdirSync(at, { recursive: true })
      replaceFile(join(at, 'bundle.json'), JSON.stringify(value, null, 2), undefined, 0o600)
    },
    seenCall(id, call) {
      return seenCalls(join(folder(id), 'uplink-seen.json')).find(s => s.id === call)?.result ?? null
    },
    rememberCall(id, call, result) {
      const at = folder(id)
      const file = join(at, 'uplink-seen.json')
      const kept = [...seenCalls(file).filter(s => s.id !== call), { id: call, result }].slice(-UPLINK_SEEN_MAX)
      mkdirSync(at, { recursive: true })
      replaceFile(file, JSON.stringify({ calls: kept }), undefined, 0o600)
    },
    revocation: id => readJson(join(folder(id), 'revoke.json'), isRevocation),
    setRevocation(id, value) {
      const at = folder(id)
      mkdirSync(at, { recursive: true })
      replaceFile(join(at, 'revoke.json'), JSON.stringify(value), undefined, 0o600)
    },
    dropCredentials(id) {
      const at = folder(id)
      for (const name of ['token', 'link-key', 'link-key.pub']) rmSync(join(at, name), { force: true })
    },
  }
}

/** The calls a device's ledger holds, oldest first; none when it is missing or not one. */
function seenCalls(file: string): { id: string; result: UplinkResult }[] {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(value) || !Array.isArray(value.calls)) return []
    return value.calls.flatMap(c => {
      const result = isRecord(c) && typeof c.id === 'string' ? uplinkResultOf(c.result) : null
      return result ? [{ id: c.id as string, result }] : []
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- the lanes the panel last saw (#510)

const isWords = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

/**
 * The board's lanes when Settings, Devices last saved which of them may leave this computer
 * (`<nodes>/lanes-seen.json`, design 12): a lane not among them came since, and the panel shows
 * it unticked and new. null: never saved, or unreadable.
 */
export function readLanesSeen(dir = nodesDir()): string[] | null {
  return readJson(join(dir, 'lanes-seen.json'), isWords)
}

/** Keeps the board's lanes as they were when the panel saved its list. */
export function writeLanesSeen(ids: readonly string[], dir = nodesDir()): void {
  mkdirSync(dir, { recursive: true })
  replaceFile(join(dir, 'lanes-seen.json'), `${JSON.stringify(ids)}\n`)
}
