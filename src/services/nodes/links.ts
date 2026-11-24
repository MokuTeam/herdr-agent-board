// The master's links (#499, docs/design/nodes 5, 7.1): one per device of config.json's `nodes`
// (core/nodes.ts nodesConfig) that has a link, following config.json live: a device added gets its
// link, one removed loses it, one whose link changed starts over. Started from server/app.ts only
// once `nodes` is on; with it off again every link ends: no ssh, no timer, no file.
//
// One watch for all of them, as the tunnel's supervisor has (services/tunnel.ts): a tick every 5 s
// that sees the computer slept (a gap over 30 s), and a poll of this computer's addresses every
// 10 s; either sends every link to try again at once.
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { headCommit } from '../../adapters/git.ts'
import { localForward, localForwardUp, localPortFor, localPortTaken, nodeSshArgs } from '../../adapters/node-ssh.ts'
import { createDeviceStore, type DeviceStore } from '../../adapters/node-store.ts'
import { knobMs, pace } from '../../adapters/pacing.ts'
import { ROOT } from '../../adapters/paths.ts'
import { endStraySsh, knownHostsReady, readPidRecord, spawnSsh, sshBin, writePidRecord } from '../../adapters/ssh.ts'
import {
  type DeviceConfig,
  type DeviceView,
  type LinkConfig,
  LOCAL,
  type NodesProblem,
  nodesConfig,
} from '../../core/nodes.ts'
import type { Config } from '../../core/types.ts'
import { type Clock, networkSignature, realClock } from '../tunnel.ts'
import { createLink, DEAD_MS, type Link, type LinkDeps, type LinkTimes, type SshPipeDeps, STATUS_MS } from './link.ts'

export interface NodeLinks {
  /** config.json changed: the links follow `nodes`. */
  configChanged(): void
  /** Whether `nodes` is on now. */
  on(): boolean
  /** The devices in order, this computer among them, each with its link; and what does not check out. */
  view(): { devices: DeviceView[]; problems: NodesProblem[] }
  /** A device's link, or null. */
  link(id: string): Link | null
  /**
   * Calls `fn` with the device's id when its link brings a payload, changes its state or brings a
   * status whose shown figures moved, and when the link goes (the device left config.json);
   * returns the unsubscribe.
   */
  onChange(fn: (id: string) => void): () => void
  /** The device's link tries again at once (a token was stored). False: no such link. */
  retry(id: string): boolean
  /**
   * The links follow config.json and the store again now: a revoked device whose token is gone
   * (services/nodes/revoke.ts) loses its link.
   */
  follow(): Promise<void>
  /** For an exit handler: every link's ssh ended synchronously. */
  killNow(): void
  close(): Promise<void>
}

export interface NodeLinksOptions {
  /** The live config. */
  cfg: Config
  log(text: string): void
  /** Tests: the link a device gets (createLink by default). */
  makeLink?: (device: DeviceConfig, times: LinkTimes) => Link
  store?: DeviceStore
  clock?: Clock
  network?: () => string
  hostName?: string
  /** This board's commit (server/app.ts runningCommit); git's HEAD in the plugin's folder when not given. */
  commit?: () => Promise<string>
}

/** The sleep watch: a tick this often; a gap longer than SLEPT_MS means the computer slept. */
const TICK_MS = 5000
const SLEPT_MS = 30_000
const NETWORK_POLL_MS = 10_000

/** The waits, as written or as a test sets them (adapters/pacing.ts). */
export const linkTimes = (): LinkTimes => ({
  deadMs: knobMs('BOARD_NODE_DEAD_MS', DEAD_MS),
  statusMs: knobMs('BOARD_NODE_STATUS_MS', STATUS_MS),
  pace: pace(),
})

/** The ssh a device's link runs, as the tunnel runs its own: its key, pid record and local port per device. */
export function sshPipeDeps(id: string, link: Extract<LinkConfig, { kind: 'ssh' }>, store: DeviceStore): SshPipeDeps {
  return {
    bin: () => sshBin(),
    args: port => nodeSshArgs({ link, key: store.keyPath(id), knownHosts: knownHostsReady(), localPort: port }),
    forward: port => localForward(port, link.port),
    localPort: fresh => localPortFor(id, fresh),
    keyExists: () => existsSync(store.keyPath(id)),
    spawn: spawnSsh,
    stray: {
      read: () => readPidRecord(store.pidFile(id)),
      write: r => writePidRecord(r, store.pidFile(id)),
      end: r => endStraySsh(r),
    },
    up: localForwardUp,
    portTaken: localPortTaken,
  }
}

/** The production link: the device's token and key from the store, ssh as the tunnel runs it. */
function realLink(
  device: DeviceConfig,
  times: LinkTimes,
  store: DeviceStore,
  log: (t: string) => void,
  commit: () => string,
): Link {
  const link = device.link
  const deps: LinkDeps = { token: () => store.token(device.id), clock: realClock, log, commit }
  if (link?.kind === 'ssh') deps.ssh = sshPipeDeps(device.id, link, store)
  return createLink({ device, cfg: times, deps })
}

export function createNodeLinks(o: NodeLinksOptions): NodeLinks {
  const clock = o.clock ?? realClock
  const network = o.network ?? networkSignature
  const host = o.hostName ?? hostname()
  const store = o.store ?? createDeviceStore()
  // This board's commit, asked once, as the node's status has its own (services/node/status.ts).
  let commit = ''
  let commitAsked = false
  const ownCommit = (): string => {
    if (!commitAsked) {
      commitAsked = true
      void (o.commit ?? (async () => (await headCommit(ROOT)) ?? ''))()
        .then(sha => {
          commit = sha
        })
        .catch(() => {})
    }
    return commit
  }
  const make =
    o.makeLink ?? ((device: DeviceConfig, times: LinkTimes) => realLink(device, times, store, o.log, ownCommit))
  const links = new Map<string, { link: Link; key: string; device: DeviceConfig; off: (() => void)[] }>()
  const changeFns = new Set<(id: string) => void>()
  const changed = (id: string): void => {
    for (const fn of changeFns) fn(id)
  }
  let watch: { tick: unknown; poll: unknown } | null = null
  let lastTick = 0
  let lastNetwork = ''
  let closed = false
  let queue: Promise<void> = Promise.resolve()
  const nodes = () => (closed ? null : nodesConfig(o.cfg.nodes, host))
  const configKey = (): string => JSON.stringify(o.cfg.nodes ?? null)
  let lastConfig = ''

  function again(why: string): void {
    for (const { link } of links.values()) link.reconnect(why)
  }

  function watchOn(): void {
    if (watch) return
    lastTick = clock.now()
    lastNetwork = network()
    watch = {
      tick: clock.setInterval(() => {
        const now = clock.now()
        const gap = now - lastTick
        lastTick = now
        if (gap > SLEPT_MS) again(`${Math.round(gap / 1000)} s between two ticks (the computer slept)`)
      }, TICK_MS),
      poll: clock.setInterval(() => {
        const now = network()
        if (now === lastNetwork) return
        lastNetwork = now
        again("this computer's addresses changed")
      }, NETWORK_POLL_MS),
    }
  }

  function watchOff(): void {
    if (!watch) return
    clock.clearInterval(watch.tick)
    clock.clearInterval(watch.poll)
    watch = null
  }

  async function syncNow(): Promise<void> {
    const cfg = nodes()
    const wanted = new Map<string, DeviceConfig>()
    for (const id of cfg?.order ?? []) {
      const device = cfg?.devices[id]
      // A revoked device keeps its link only while its token is kept for the call that tells it (#510).
      if (id !== LOCAL && device?.link && !(device.revoked && store.token(id) === null)) wanted.set(id, device)
    }
    for (const [id, held] of [...links]) {
      const device = wanted.get(id)
      if (device && JSON.stringify(device.link) === held.key) {
        const renamed = held.device.title !== device.title
        held.device = device
        if (renamed) changed(id)
        continue
      }
      links.delete(id)
      for (const off of held.off) off()
      await held.link.close()
      changed(id)
    }
    for (const [id, device] of wanted) {
      if (links.has(id)) continue
      const link = make(device, linkTimes())
      const off = [link.onPayload(() => changed(id)), link.onState(() => changed(id)), link.onStatus(() => changed(id))]
      links.set(id, { link, key: JSON.stringify(device.link), device, off })
    }
    if (links.size) watchOn()
    else watchOff()
  }

  /** One at a time: a change that comes while one is followed waits for it. */
  function sync(): Promise<void> {
    queue = queue.then(syncNow).catch(err => o.log(`node links: ${err instanceof Error ? err.message : String(err)}`))
    return queue
  }

  lastConfig = configKey()
  void sync()

  return {
    configChanged() {
      const now = configKey()
      if (now === lastConfig) return
      lastConfig = now
      void sync()
    },
    on: () => nodes() !== null,
    view() {
      const cfg = nodes()
      if (!cfg) return { devices: [], problems: [] }
      // A revoked device (#510): whether the node was told, and whether its credentials are kept.
      const revoked = (id: string, device: DeviceConfig | undefined): Pick<DeviceView, 'revoked'> =>
        device?.revoked
          ? { revoked: { told: store.revocation(id)?.told === true, kept: store.token(id) !== null } }
          : {}
      const devices = cfg.order.flatMap((id): DeviceView[] => {
        const held = links.get(id)
        if (held)
          return [
            {
              ...held.link.view(),
              title: cfg.devices[id]?.title ?? held.device.title,
              ...revoked(id, cfg.devices[id]),
            },
          ]
        const device = cfg.devices[id]
        if (!device) return []
        return [
          {
            id,
            title: device.title,
            kind: null,
            link: null,
            status: null,
            sameCommit: null,
            payloadAt: null,
            ...revoked(id, device),
          },
        ]
      })
      return { devices, problems: cfg.problems }
    },
    link: id => links.get(id)?.link ?? null,
    onChange(fn) {
      changeFns.add(fn)
      return () => changeFns.delete(fn)
    },
    retry(id) {
      const held = links.get(id)
      if (!held) return false
      held.link.reconnect('a token stored', true)
      return true
    },
    follow: () => sync(),
    killNow() {
      for (const { link } of links.values()) link.killNow()
    },
    async close() {
      closed = true
      await sync()
    },
  }
}
