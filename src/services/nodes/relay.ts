// Master side of the relay pipe (#512, docs/design/nodes 20.1):
// Local SSH forward (`ssh -N -L 127.0.0.1:<local>:<socketsDir>/<stem>.sock`) to a node's socket
// on the relay server, paired with SHA-256 certificate pinning (adapters/door-cert.ts) for
// `createLink`.
import { existsSync } from 'node:fs'
import { pinnedTls } from '../../adapters/door-cert.ts'
import { localForwardUp, localPortFor, localPortTaken } from '../../adapters/node-ssh.ts'
import type { DeviceStore } from '../../adapters/node-store.ts'
import { relaySocketsDir } from '../../adapters/paths.ts'
import { endStraySsh, knownHostsReady, readPidRecord, spawnSsh, sshBin, writePidRecord } from '../../adapters/ssh.ts'
import type { LinkConfig, NodesConfig } from '../../core/nodes.ts'
import { relaySocketPath, relaySocketStem } from '../../core/relay-texts.ts'
import { SSH_OPTIONS, sshPathArg } from '../../core/tunnel.ts'
import type { RelayPipeDeps } from './link.ts'

export { relaySocketPath, relaySocketStem }

export type MasterRelayConfig = NonNullable<NodesConfig['relay']>
type RelayLink = Extract<LinkConfig, { kind: 'relay' }>

export interface RelayForwardLine {
  relay: MasterRelayConfig
  socketPath: string
  key: string
  knownHosts: string
  localPort: number
  platform?: string
}

/** `-L`'s value for a relay forward: `127.0.0.1:<local>:<socketPath>`. */
export const relayLocalForward = (localPort: number, socketPath: string): string =>
  `127.0.0.1:${localPort}:${socketPath}`

/**
 * Builds the `ssh -L` argument list for forwarding a local TCP port to a node's unix socket on
 * the relay server. Spawned without a shell.
 */
export function relayForwardArgs(l: RelayForwardLine): string[] {
  const knownHosts = `UserKnownHostsFile="${sshPathArg(l.knownHosts, l.platform)}"`
  return [
    '-F',
    'none',
    '-N',
    '-T',
    '-v',
    '-i',
    sshPathArg(l.key, l.platform),
    ...[...SSH_OPTIONS, knownHosts].flatMap(o => ['-o', o]),
    '-p',
    String(l.relay.sshPort),
    '-L',
    relayLocalForward(l.localPort, l.socketPath),
    `${l.relay.user}@${l.relay.host}`,
  ]
}

/**
 * Builds `RelayPipeDeps` for `createLink` on a `kind: 'relay'` device: uses the master's relay
 * forward key, the device's pinned door certificate (`store.cert(id)`), and per-device pid/port.
 */
export function relayPipeDeps(
  id: string,
  link: RelayLink,
  relay: MasterRelayConfig,
  store: DeviceStore,
  o?: { keyPath?: string; socketsDir?: string; knownHosts?: () => string },
): RelayPipeDeps {
  const key = o?.keyPath ?? store.relayKeyPath('master')
  const socketsDir = o?.socketsDir ?? relaySocketsDir()
  const socketPath = relaySocketPath(link.socket, socketsDir)
  const knownHosts = o?.knownHosts ?? knownHostsReady
  return {
    bin: () => sshBin(),
    args: port =>
      relayForwardArgs({
        relay,
        socketPath: socketPath ?? '',
        key,
        knownHosts: knownHosts(),
        localPort: port,
      }),
    forward: port => relayLocalForward(port, socketPath ?? ''),
    localPort: fresh => localPortFor(id, fresh),
    keyExists: () => existsSync(key),
    spawn: spawnSsh,
    stray: {
      read: () => readPidRecord(store.pidFile(id)),
      write: r => writePidRecord(r, store.pidFile(id)),
      end: r => endStraySsh(r),
    },
    up: localForwardUp,
    portTaken: localPortTaken,
    pinnedCert: () => store.cert(id),
    tlsFor: pinnedTls,
    socketValid: socketPath !== null,
  }
}
