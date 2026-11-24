// Master side of the relay pipe (#512, docs/design/nodes 20.1):
// Local SSH forward (`ssh -N -L 127.0.0.1:<local>:<socketsDir>/<stem>.sock`) to a node's socket
// on the relay server, paired with SHA-256 certificate pinning (adapters/door-cert.ts) for
// `createLink`.
import { existsSync } from 'node:fs'
import { pinnedTls } from '../../adapters/door-cert.ts'
import { freeLocalPort, localForwardUp, localPortFor, localPortTaken } from '../../adapters/node-ssh.ts'
import { createDeviceStore, type DeviceStore, relayKeyPath } from '../../adapters/node-store.ts'
import { relaySocketsDir } from '../../adapters/paths.ts'
import { run as runProcess } from '../../adapters/process.ts'
import {
  endStraySsh,
  knownHostsReady,
  readPidRecord,
  type SshChild,
  spawnSsh,
  sshBin,
  writePidRecord,
} from '../../adapters/ssh.ts'
import type { LinkConfig, NodesConfig } from '../../core/nodes.ts'
import { RELAY_KEY_NAME, relayKeyBody, relaySocketPath, relaySocketStem } from '../../core/relay-texts.ts'
import { isLasting, SSH_OPTIONS, sshHint, sshPathArg, type TunnelHint } from '../../core/tunnel.ts'
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

export interface OpenedRelayForward {
  localPort: number
  alive(): boolean
  close(): Promise<void>
  killNow(): void
}

/**
 * Opens a temporary `ssh -L` forward to a relay socket (used by T18 during onboarding before a
 * persistent `Link` exists).
 */
export async function openRelayForward(o: {
  relay: MasterRelayConfig
  socket: string
  key?: string
  knownHosts?: () => string
  socketsDir?: string
  bin?: () => string | null
  spawn?: (bin: string, args: string[]) => SshChild
  freePort?: () => Promise<number>
  timeoutMs?: number
}): Promise<{ ok: true; forward: OpenedRelayForward } | { ok: false; error: string; hint: TunnelHint | null }> {
  const socketPath = relaySocketPath(o.socket, o.socketsDir ?? relaySocketsDir())
  if (!socketPath) return { ok: false, error: `invalid relay socket name: ${o.socket}`, hint: null }
  const key = o.key ?? relayKeyPath('master')
  if (!existsSync(key))
    return { ok: false, error: 'no relay master key yet: set up the relay first', hint: 'publickey' }
  const bin = (o.bin ?? sshBin)()
  if (!bin) return { ok: false, error: 'ssh not found', hint: 'noSsh' }
  const spawn = o.spawn ?? spawnSsh
  const port = await (o.freePort ?? freeLocalPort)()
  const knownHosts = (o.knownHosts ?? knownHostsReady)()
  const args = relayForwardArgs({ relay: o.relay, socketPath, key, knownHosts, localPort: port })
  const child = spawn(bin, args)
  const lines: string[] = []
  const timeoutMs = o.timeoutMs ?? 30_000
  return new Promise(resolve => {
    let settled = false
    let asked = false
    let exited = false
    let closing: Promise<void> | null = null
    const closeForward = (): Promise<void> => {
      if (closing) return closing
      asked = true
      closing = (async () => {
        child.kill()
        await child.exited.catch(() => {})
      })()
      return closing
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void closeForward().then(() => resolve({ ok: false, error: 'ssh forward timed out', hint: 'network' }))
    }, timeoutMs)
    const finish = (
      res: { ok: true; forward: OpenedRelayForward } | { ok: false; error: string; hint: TunnelHint | null },
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
    }
    child.onLine(line => {
      if (settled) return
      if (localForwardUp(line, port)) {
        finish({
          ok: true,
          forward: {
            localPort: port,
            alive: () => !asked && !exited,
            close: closeForward,
            killNow: () => {
              asked = true
              child.killNow()
            },
          },
        })
        return
      }
      if (!line.startsWith('debug')) {
        lines.push(line)
        if (lines.length > 20) lines.shift()
      }
    })
    void child.exited.then(r => {
      exited = true
      if (settled || asked) return
      if (r.error) return finish({ ok: false, error: `${bin}: ${r.error}`, hint: 'noSsh' })
      const hint = sshHint(lines)
      const last = lines.at(-1) ?? `ssh exited with code ${String(r.code)}`
      finish({ ok: false, error: last, hint: isLasting(hint) ? hint : (hint ?? null) })
    })
  })
}

export interface RelayEnrolLine {
  relay: MasterRelayConfig
  key: string
  knownHosts: string
  command: string
  platform?: string
}

/** Builds `ssh` arguments for invoking the relay server's forced-command enrolment script. */
export function relayEnrolArgs(l: RelayEnrolLine): string[] {
  const knownHosts = `UserKnownHostsFile="${sshPathArg(l.knownHosts, l.platform)}"`
  return [
    '-F',
    'none',
    '-T',
    '-i',
    sshPathArg(l.key, l.platform),
    ...[...SSH_OPTIONS, knownHosts].flatMap(o => ['-o', o]),
    '-p',
    String(l.relay.sshPort),
    `${l.relay.user}@${l.relay.host}`,
    l.command,
  ]
}

export interface RelayEnrolDeps {
  relay: MasterRelayConfig
  key: string
  keyExists?: () => boolean
  knownHosts?: () => string
  bin?: () => string | null
  timeoutMs?: number
}

export interface RelayEnrol {
  add(name: string, publicKey: string): Promise<{ ok: true } | { ok: false; error: string }>
  remove(name: string): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }>
}

/** Client for adding/removing one-time node dial keys on the relay server via forced command. */
export function createRelayEnrol(d: RelayEnrolDeps): RelayEnrol {
  const keyExists = d.keyExists ?? (() => existsSync(d.key))
  const knownHosts = d.knownHosts ?? knownHostsReady
  const binFn = d.bin ?? (() => sshBin())
  const timeoutMs = d.timeoutMs ?? 30_000

  async function exec(command: string): Promise<{ ok: true; lines: string[] } | { ok: false; error: string }> {
    if (!keyExists()) return { ok: false, error: 'no relay enrol key yet: set up the relay first' }
    const bin = binFn()
    if (!bin) return { ok: false, error: 'ssh not found' }
    const args = relayEnrolArgs({ relay: d.relay, key: d.key, knownHosts: knownHosts(), command })
    const r = await runProcess(bin, args, { timeout: timeoutMs })
    if (r.code !== 0) {
      const msg = r.stderr.trim() || r.stdout.trim() || `ssh exited with code ${String(r.code)}`
      return { ok: false, error: msg }
    }
    const lines = r.stdout
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    return { ok: true, lines }
  }

  return {
    async add(name, publicKey) {
      if (!RELAY_KEY_NAME.test(name)) return { ok: false, error: `invalid relay key name: ${name}` }
      const body = relayKeyBody(publicKey)
      if (!body) return { ok: false, error: 'invalid relay public key' }
      const r = await exec(`add ${name} ${body}`)
      if (!r.ok) return r
      if (!r.lines.includes(`@@added ${name}`)) {
        return { ok: false, error: `unexpected enrol add response: ${r.lines.join(' ') || 'empty'}` }
      }
      return { ok: true }
    },
    async remove(name) {
      if (!RELAY_KEY_NAME.test(name)) return { ok: false, error: `invalid relay key name: ${name}` }
      const r = await exec(`remove ${name}`)
      if (!r.ok) return r
      if (r.lines.includes(`@@removed ${name}`)) return { ok: true, removed: true }
      if (r.lines.includes(`@@missing ${name}`)) return { ok: true, removed: false }
      return { ok: false, error: `unexpected enrol remove response: ${r.lines.join(' ') || 'empty'}` }
    },
  }
}

/** Convenience constructor using the master board's `DeviceStore` / default enrol key path. */
export function relayEnrolFor(
  relay: MasterRelayConfig,
  o?: { store?: DeviceStore; key?: string; timeoutMs?: number },
): RelayEnrol {
  const key = o?.key ?? (o?.store ?? createDeviceStore()).relayKeyPath('enrol')
  return createRelayEnrol({ relay, key, ...(o?.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }) })
}
