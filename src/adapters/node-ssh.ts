// The master's ssh to a node (#499, docs/design/nodes 4.2, 6.5): for a device whose link is
// `{ kind: 'ssh' }`, a local forward from 127.0.0.1:<local port> on this computer to the node's door
// on 127.0.0.1:<link.port> there, as the device's fenced user:
//   ssh -F none -N -T -v -i <link-key> -o ... -p <sshPort> -L 127.0.0.1:<local>:127.0.0.1:<port> <user>@<host>
// Built on the tunnel's ssh (adapters/ssh.ts, core/tunnel.ts): the binary from BOARD_SSH_BIN_PATH,
// the board's own known_hosts with the node's host key pinned on first use, the same options, and a
// pid record per device (adapters/node-store.ts pidFile) that lets the next board end an ssh this
// one left. The local port is picked free once and kept while the board runs. Nothing here runs
// through a shell.
import { createServer } from 'node:net'
import type { LinkConfig } from '../core/nodes.ts'
import { SSH_OPTIONS, sshPathArg } from '../core/tunnel.ts'

type SshLink = Extract<LinkConfig, { kind: 'ssh' }>

export interface NodeSshLine {
  link: SshLink
  /** The device's link key (node-store.ts keyPath). */
  key: string
  /** The board's own known_hosts, the tunnel's (adapters/ssh.ts knownHostsFile). */
  knownHosts: string
  /** The port on 127.0.0.1 here that the forward listens on. */
  localPort: number
  platform?: string
}

/** `-L`'s value: 127.0.0.1:<local> here to 127.0.0.1:<port> on the node; also what its pid record names. */
export const localForward = (localPort: number, port: number): string => `127.0.0.1:${localPort}:127.0.0.1:${port}`

/**
 * The whole ssh line, spawned without a shell. `-F none`: the user's ~/.ssh/config cannot change
 * it; `-v`: ssh says when the forward listens (localForwardUp). ExitOnForwardFailure ends an ssh
 * whose local port another program took.
 */
export function nodeSshArgs(l: NodeSshLine): string[] {
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
    String(l.link.sshPort),
    '-L',
    localForward(l.localPort, l.link.port),
    `${l.link.user}@${l.link.host}`,
  ]
}

/**
 * ssh -v saying the forward listens, which it says once it is logged in:
 * `debug1: Local forwarding listening on 127.0.0.1 port 50123.`
 */
export function localForwardUp(line: string, localPort: number): boolean {
  const m = /^debug1: Local forwarding listening on 127\.0\.0\.1 port (\d+)\.?$/.exec(line.trim())
  return m !== null && Number(m[1]) === localPort
}

/** ssh could not listen on the local port: another program took it since it was picked. */
export const localPortTaken = (line: string): boolean => /Address already in use|cannot listen to port/.test(line)

/** A port on 127.0.0.1 that nothing listens on now: the system's pick for port 0. */
export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const at = server.address()
      const port = typeof at === 'object' && at ? at.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/** Each device's local port, picked once and kept while the board runs. */
const ports = new Map<string, number>()

/**
 * The device's local port: the one it had, or a new free one when it has none or `fresh` (the old
 * one taken). Never one another device holds, should the system hand the same port out twice.
 */
export async function localPortFor(id: string, fresh = false): Promise<number> {
  const kept = ports.get(id)
  if (kept !== undefined && !fresh) return kept
  const others = new Set([...ports].filter(([dev]) => dev !== id).map(([, port]) => port))
  let port = await freeLocalPort()
  for (let tries = 1; others.has(port) && tries < 20; tries++) port = await freeLocalPort()
  ports.set(id, port)
  return port
}
