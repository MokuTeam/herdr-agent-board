// Extracted I/O, forward reuse pool, and strict hello/pin verification for computer onboarding (#513).
import { existsSync } from 'node:fs'
import { pinnedTls, probeDoorCert } from '../../adapters/door-cert.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { run as runProcess } from '../../adapters/process.ts'
import { knownHostsFile, sshKeygenBin } from '../../adapters/ssh.ts'
import type { ComputerFound } from '../../core/node-computer-setup.ts'
import { NODE_API } from '../../core/node-door.ts'
import { parseHelloJoin, verifyJoinProof } from '../../core/node-join.ts'
import type {
  ComputerClaimRequest,
  ComputerClaimResult,
  ComputerProbeResult,
  RelayKeyActivateRequest,
  RelayKeyActivateResult,
  RelayTarget,
} from './computer-setup.ts'
import { type OpenedRelayForward, openRelayForward } from './relay.ts'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export type VerifyHelloOutcome =
  | { ok: true; found: ComputerFound & { certPem: string } }
  | {
      ok: false
      reason: 'bad-api' | 'claimed' | 'burned-code' | 'old-plugin' | 'bad-fingerprint' | 'bad-proof'
    }

/**
 * Pure pin decision for `GET /api/hello` (#513): refuses forged or mismatched cert fingerprints,
 * wrong join codes, wrong node ids, already-claimed nodes, and unsupported door versions without
 * ever calling `pinCert`.
 */
export function verifyComputerHello(probe: ComputerProbeResult, expectedCode: string): VerifyHelloOutcome {
  const { hello, certPem, certFingerprint } = probe
  if (hello.node.api !== NODE_API) return { ok: false, reason: 'bad-api' }
  if (hello.node.claimed) return { ok: false, reason: 'claimed' }
  const fp = certFingerprint.trim().toLowerCase()
  const declaredCert = typeof hello.node.cert === 'string' ? hello.node.cert.trim().toLowerCase() : null
  const parsedJoin = parseHelloJoin(hello.node.join)
  if (!parsedJoin) {
    return { ok: false, reason: declaredCert ? 'burned-code' : 'old-plugin' }
  }
  if (declaredCert && declaredCert !== fp) return { ok: false, reason: 'bad-fingerprint' }
  if (parsedJoin.fingerprint !== fp) return { ok: false, reason: 'bad-fingerprint' }
  if (!verifyJoinProof(expectedCode, fp, hello.node.id, parsedJoin.proof)) {
    return { ok: false, reason: 'bad-proof' }
  }
  return {
    ok: true,
    found: {
      id: hello.node.id,
      host: hello.host,
      platform: hello.platform,
      version: hello.version,
      fingerprint: fp,
      certPem,
    },
  }
}

/** Reads and normalizes the relay server's SSH host key lines from `<state>/tunnel/known_hosts`. */
export async function readRelayHostKey(
  host: string,
  sshPort: number,
  opts?: {
    bin?: () => string | null
    knownHosts?: () => string
    run?: typeof runProcess
  },
): Promise<string | null> {
  const bin = (opts?.bin ?? sshKeygenBin)()
  const kh = (opts?.knownHosts ?? knownHostsFile)()
  if (!bin || !existsSync(kh)) return null
  const name = (sshPort === 22 ? host : `[${host}]:${sshPort}`).toLowerCase()
  const run = opts?.run ?? runProcess
  const r = await run(bin, ['-F', name, '-f', kh], { timeout: 5000 })
  if (r.code !== 0) return null
  const lines = r.stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const parts = l.split(/\s+/)
      return parts.length >= 3 && !parts[0]?.startsWith('@') ? `${name} ${parts[1]} ${parts[2]}` : l
    })
  return lines.length ? lines.join('\n') : null
}

export interface RelayForwardPool {
  acquire(relay: RelayTarget, socket: string): Promise<OpenedRelayForward | null>
  drop(socket: string): Promise<void>
  closeAll(): Promise<void>
}

/**
 * Reuses one live `ssh -L` forward per enrolment socket so polling `/api/hello` does not spawn a
 * fresh SSH connection on every interval.
 */
export function createRelayForwardPool(
  openFn: typeof openRelayForward = openRelayForward,
  timeoutMs = 10_000,
): RelayForwardPool {
  const active = new Map<string, { targetKey: string; fwd: OpenedRelayForward }>()
  const pending = new Map<string, Promise<OpenedRelayForward | null>>()

  const keyOf = (r: RelayTarget): string => `${r.user}@${r.host}:${r.sshPort}`

  async function drop(socket: string): Promise<void> {
    const held = active.get(socket)
    if (held) {
      active.delete(socket)
      await held.fwd.close().catch(() => {})
    }
  }

  async function acquire(relay: RelayTarget, socket: string): Promise<OpenedRelayForward | null> {
    const inflight = pending.get(socket)
    if (inflight) return await inflight
    const targetKey = keyOf(relay)
    const held = active.get(socket)
    if (held) {
      if (held.targetKey === targetKey && held.fwd.alive()) return held.fwd
      active.delete(socket)
      await held.fwd.close().catch(() => {})
    }
    const p = (async () => {
      const opened = await openFn({ relay, socket, timeoutMs })
      if (!opened.ok) return null
      active.set(socket, { targetKey, fwd: opened.forward })
      return opened.forward
    })()
    pending.set(socket, p)
    try {
      return await p
    } finally {
      if (pending.get(socket) === p) pending.delete(socket)
    }
  }

  async function closeAll(): Promise<void> {
    const sockets = [...active.keys()]
    await Promise.all(sockets.map(s => drop(s)))
  }

  return { acquire, drop, closeAll }
}

export type ComputerFetch = (input: string, init?: BunFetchRequestInit) => Promise<Response>

/** Probes `/api/hello` over the relay forward and TLS peer certificate pinning. */
export async function probeComputerDoor(
  relay: RelayTarget,
  socket: string,
  opts?: {
    pool?: RelayForwardPool
    open?: typeof openRelayForward
    probeCert?: typeof probeDoorCert
    fetchFn?: ComputerFetch
  },
): Promise<ComputerProbeResult | null> {
  const ownOpen = !opts?.pool
  const fwd = opts?.pool
    ? await opts.pool.acquire(relay, socket)
    : await (opts?.open ?? openRelayForward)({ relay, socket, timeoutMs: 10_000 }).then(r => (r.ok ? r.forward : null))
  if (!fwd) return null
  try {
    const probeCert = opts?.probeCert ?? probeDoorCert
    const fetchFn = opts?.fetchFn ?? fetch
    const { cert, fingerprint } = await probeCert(fwd.localPort, { timeoutMs: 5000 })
    const res = await fetchFn(`https://127.0.0.1:${fwd.localPort}/api/hello`, {
      headers: { host: `127.0.0.1:${fwd.localPort}` },
      tls: pinnedTls(cert),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      host?: unknown
      platform?: unknown
      version?: unknown
      node?: { api?: unknown; id?: unknown; claimed?: unknown; cert?: unknown; join?: unknown }
    }
    if (
      typeof body.host !== 'string' ||
      typeof body.platform !== 'string' ||
      typeof body.version !== 'string' ||
      !isRecord(body.node) ||
      typeof body.node.api !== 'number' ||
      typeof body.node.id !== 'string' ||
      typeof body.node.claimed !== 'boolean'
    )
      return null
    return {
      ok: true,
      certPem: cert,
      certFingerprint: fingerprint,
      hello: {
        host: body.host,
        platform: body.platform,
        version: body.version,
        node: {
          api: body.node.api,
          id: body.node.id,
          claimed: body.node.claimed,
          ...(typeof body.node.cert === 'string' && { cert: body.node.cert }),
          ...(body.node.join !== undefined && { join: body.node.join }),
        },
      },
    }
  } catch {
    return null
  } finally {
    if (ownOpen) await fwd.close().catch(() => {})
  }
}

/** Claims the node via `POST /api/node/claim` over the pinned TLS connection. */
export async function claimComputerDoor(
  relay: RelayTarget,
  socket: string,
  req: ComputerClaimRequest,
  opts?: {
    pool?: RelayForwardPool
    open?: typeof openRelayForward
    fetchFn?: ComputerFetch
  },
): Promise<ComputerClaimResult> {
  const ownOpen = !opts?.pool
  const fwd = opts?.pool
    ? await opts.pool.acquire(relay, socket)
    : await (opts?.open ?? openRelayForward)({ relay, socket, timeoutMs: 10_000 }).then(r => (r.ok ? r.forward : null))
  if (!fwd) return { ok: false, error: 'relay forward failed' }
  try {
    const fetchFn = opts?.fetchFn ?? fetch
    const res = await fetchFn(`https://127.0.0.1:${fwd.localPort}/api/node/claim`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${fwd.localPort}`,
        'content-type': 'application/json',
        'x-board': '1',
      },
      body: JSON.stringify({
        code: req.code,
        master: { name: req.masterName },
        ...(req.nonce && { nonce: req.nonce }),
      }),
      tls: pinnedTls(req.certPem),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => null)) as {
      token?: unknown
      id?: unknown
      relayPublicKey?: unknown
      error?: unknown
    } | null
    if (!res.ok || !body || typeof body.token !== 'string' || typeof body.id !== 'string') {
      return {
        ok: false,
        status: res.status,
        error: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
      }
    }
    return {
      ok: true,
      token: body.token,
      id: body.id,
      ...(typeof body.relayPublicKey === 'string' && { relayPublicKey: body.relayPublicKey }),
    }
  } catch (err) {
    if (opts?.pool) await opts.pool.drop(socket)
    return { ok: false, error: messageOf(err) }
  } finally {
    if (ownOpen) await fwd.close().catch(() => {})
  }
}

/** Tells the newly claimed node to activate its staged fresh relay key (`POST /api/node/relay-key`). */
export async function activateComputerRelayKey(
  relay: RelayTarget,
  socket: string,
  req: RelayKeyActivateRequest,
  opts?: {
    pool?: RelayForwardPool
    open?: typeof openRelayForward
    fetchFn?: ComputerFetch
  },
): Promise<RelayKeyActivateResult> {
  const ownOpen = !opts?.pool
  const fwd = opts?.pool
    ? await opts.pool.acquire(relay, socket)
    : await (opts?.open ?? openRelayForward)({ relay, socket, timeoutMs: 10_000 }).then(r => (r.ok ? r.forward : null))
  if (!fwd) return { ok: false, error: 'relay forward failed' }
  try {
    const fetchFn = opts?.fetchFn ?? fetch
    const res = await fetchFn(`https://127.0.0.1:${fwd.localPort}/api/node/relay-key`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${fwd.localPort}`,
        authorization: `Bearer ${req.token}`,
        'content-type': 'application/json',
        'x-board': '1',
      },
      body: JSON.stringify({ publicKey: req.publicKey }),
      tls: pinnedTls(req.certPem),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null
      return {
        ok: false,
        status: res.status,
        error: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
      }
    }
    return { ok: true }
  } catch (err) {
    if (opts?.pool) await opts.pool.drop(socket)
    return { ok: false, error: messageOf(err) }
  } finally {
    if (ownOpen) await fwd.close().catch(() => {})
  }
}
