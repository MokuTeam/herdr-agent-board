// The node's reverse SSH tunnel to the relay server (#512, docs/design/nodes 20.1): while
// `node.relay` is configured and the door is listening, the node dials the relay server with
// `ssh -R <socketsDir>/<socket>.sock:127.0.0.1:<doorPort>`, kept up by the tunnel's supervisor
// (services/tunnel.ts). Without `node.relay` (or without `<state>/node/relay-key`), nothing runs.
import { existsSync } from 'node:fs'
import { nodeRelayKeyPath, nodeRelayKnownHostsReady, nodeRelayPidFile } from '../../adapters/node-store.ts'
import { pace } from '../../adapters/pacing.ts'
import { relaySocketsDir } from '../../adapters/paths.ts'
import { endStraySsh, publicKeyOf, readPidRecord, spawnSsh, sshBin, writePidRecord } from '../../adapters/ssh.ts'
import type { NodeConfig } from '../../core/nodes.ts'
import { relaySocketPath } from '../../core/relay-texts.ts'
import { forwardSpec, sshArgs, type TunnelConfig, type TunnelStatus } from '../../core/tunnel.ts'
import {
  type Clock,
  createSupervisor,
  networkSignature,
  realClock,
  type Supervisor,
  type SupervisorDeps,
  type TunnelPlan,
} from '../tunnel.ts'

export type RelayConfig = NonNullable<NodeConfig['relay']>

export interface RelayDialLine {
  relay: RelayConfig
  socketPath: string
  key: string
  knownHosts: string
  doorPort: number
  platform?: string
}

function relayTunnelConfig(relay: RelayConfig, socketPath: string, key: string): TunnelConfig {
  return {
    on: true,
    host: relay.host,
    sshPort: relay.sshPort,
    user: relay.user,
    key,
    socket: socketPath,
    domain: '',
    port: null,
    publicPort: null,
  }
}

/** Builds the `ssh -R` argument list for the node's relay dialer, using the tunnel's ssh options. */
export function relayDialArgs(l: RelayDialLine): string[] {
  return sshArgs({
    conf: relayTunnelConfig(l.relay, l.socketPath, l.key),
    key: l.key,
    knownHosts: l.knownHosts,
    target: l.doorPort,
    ...(l.platform !== undefined && { platform: l.platform }),
  })
}

/**
 * Builds the TunnelPlan for the node's relay dialer, or null if `node.relay` is absent,
 * `node.tls` is not true, the door port is invalid, or `relay.socket` does not pass validation.
 */
export function relayDialPlan(o: {
  node: NodeConfig
  doorPort: number
  key: string
  knownHosts: string
  socketsDir?: string
  bin?: string
  platform?: string
}): TunnelPlan | null {
  const { relay } = o.node
  if (!relay || !o.node.tls || o.doorPort <= 0) return null
  const socketPath = relaySocketPath(relay.socket, o.socketsDir ?? relaySocketsDir())
  if (!socketPath) return null
  const conf = relayTunnelConfig(relay, socketPath, o.key)
  return {
    conf,
    bin: o.bin ?? 'ssh',
    args: sshArgs({
      conf,
      key: o.key,
      knownHosts: o.knownHosts,
      target: o.doorPort,
      ...(o.platform !== undefined && { platform: o.platform }),
    }),
    forward: forwardSpec(socketPath, o.doorPort),
  }
}

export interface RelayDialOptions {
  node(): NodeConfig | null
  doorPort(): number | null
  keyPath?: () => string
  keyExists?: (path: string) => boolean
  knownHosts?: () => string
  socketsDir?: () => string
  bin?: () => string | null
  spawn?: SupervisorDeps['spawn']
  stray?: SupervisorDeps['stray']
  clock?: Clock
  network?: () => string
  random?: () => number
  pace?: number
  onChange?: () => void
  log(text: string): void
}

export interface RelayDial {
  sync(): Promise<void>
  restart(): Promise<void>
  status(): TunnelStatus
  /** Reason `plan()` last returned null while `node` is configured, or null. */
  idleReason(): string | null
  running(): boolean
  killNow(): void
  close(): Promise<void>
}

/**
 * Keeps the node's `ssh -R` relay forward connected while `node.relay` is configured, the door is
 * listening, and the node's relay key exists.
 */
export function createRelayDial(o: RelayDialOptions): RelayDial {
  const keyPath = o.keyPath ?? (() => nodeRelayKeyPath())
  const keyExists = o.keyExists ?? existsSync
  const knownHosts = o.knownHosts ?? (() => nodeRelayKnownHostsReady())
  const socketsDir = o.socketsDir ?? relaySocketsDir
  const bin = o.bin ?? (() => sshBin())
  const pidFile = nodeRelayPidFile()
  let lastReasonKey: string | null = null
  let lastIdleReason: string | null = null

  const idle = (key: string, reason: string | null, logLine?: string): null => {
    lastIdleReason = reason
    if (key !== lastReasonKey) {
      lastReasonKey = key
      if (logLine) o.log(logLine)
    }
    return null
  }

  const supervisor: Supervisor = createSupervisor({
    label: 'relay dial',
    pace: o.pace ?? pace(),
    plan: () => {
      const n = o.node()
      if (!n) return idle('no-node', null)
      if (!n.relay) {
        return idle(
          'no-relay',
          'node.relay is not configured',
          'relay dial: not started (node.relay is not configured)',
        )
      }
      if (!n.tls) {
        return idle(
          'no-tls',
          'refusing to forward plaintext door (node.tls must be true)',
          'relay dial: refusing to forward plaintext door (node.tls must be true)',
        )
      }
      const port = o.doorPort()
      if (port === null || port <= 0) {
        return idle(
          `no-door:${n.port}`,
          `node door is not listening on port ${n.port}`,
          `relay dial: not started (node door is not listening on port ${n.port})`,
        )
      }
      const key = keyPath()
      if (!keyExists(key)) {
        return idle(`no-key:${key}`, `no relay key at ${key}`, `relay dial: no relay key at ${key}`)
      }
      const built = relayDialPlan({
        node: n,
        doorPort: port,
        key,
        knownHosts: knownHosts(),
        socketsDir: socketsDir(),
        bin: bin() ?? 'ssh',
      })
      if (!built) {
        return idle(
          `bad-socket:${n.relay.socket}`,
          `invalid relay socket name ${JSON.stringify(n.relay.socket)}`,
          `relay dial: invalid relay socket name ${JSON.stringify(n.relay.socket)}`,
        )
      }
      lastReasonKey = null
      lastIdleReason = null
      return built
    },
    spawn: o.spawn ?? spawnSsh,
    stray: o.stray ?? {
      read: () => readPidRecord(pidFile),
      write: r => writePidRecord(r, pidFile),
      end: r => endStraySsh(r),
    },
    clock: o.clock ?? realClock,
    network: o.network ?? networkSignature,
    ...(o.random !== undefined && { random: o.random }),
    checkKey: () => publicKeyOf(keyPath()),
    sshFound: bin,
    onChange: o.onChange ?? (() => {}),
    log: o.log,
  })

  return {
    sync: () => supervisor.sync(),
    restart: () => supervisor.restart(),
    status: () => supervisor.status(),
    idleReason: () => lastIdleReason,
    running: () => supervisor.running(),
    killNow: () => supervisor.killNow(),
    close: () => supervisor.close(),
  }
}
