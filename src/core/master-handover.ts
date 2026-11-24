// Guided master handover (#697): pure types, binary bundle codec, preflight validation,
// reverse-link resolution, config flipping, CLI argument parsing, and report formatting.
// Zero I/O and no `node:` imports.
import { isDevice, LOCAL } from './node-key.ts'
import { type LinkConfig, NODE_PORT, type NodeConfig } from './nodes.ts'
import { RELAY_NODE_USER, relaySocketStem } from './relay-texts.ts'

export const HANDOVER_MAGIC = 'MHB1'
export const HANDOVER_VERSION = 1
export const MIN_HANDOVER_FREE_MB = 64
export const HANDOVER_DISK_MULTIPLIER = 3
export const MAX_HANDOVER_BUNDLE_BYTES = 256 * 1024 * 1024

export const HANDOVER_CATEGORIES = [
  'db',
  'threadFiles',
  'journal',
  'access',
  'team',
  'calendar',
  'tunnel',
  'schedule',
  'nodes',
  'backup',
] as const

export type HandoverCategory = (typeof HANDOVER_CATEGORIES)[number]

export interface HandoverCheckItem {
  id: 'master' | 'target' | 'online' | 'commit' | 'targetRole' | 'backup' | 'disk' | 'reverseLink' | 'otherNodes'
  ok: boolean
  detail: string
  blocking: boolean
}

export interface HandoverFileEntry {
  /** Forward-slash relative path inside `<state>/` (e.g. `board.db`, `team-key.json`). */
  path: string
  category: HandoverCategory
  size: number
  sha256: string
  /** Unix file mode (e.g. 0o600 for private keys/secrets). */
  mode?: number
}

export interface HandoverCredential {
  id: string
  token: string
  cert?: string
}

export interface HandoverManifest {
  v: 1
  id: string
  from: string
  to: string
  createdAt: number
  files: HandoverFileEntry[]
  credentials: HandoverCredential[]
}

export interface HandoverSummaryItem {
  category: HandoverCategory
  files: number
  bytes: number
}

export interface HandoverPlan {
  ok: boolean
  from: string
  to: string
  targetTitle: string
  commit: string
  reverseLink: LinkConfig | null
  checks: HandoverCheckItem[]
  items: HandoverSummaryItem[]
  totalFiles: number
  totalBytes: number
  requiredFreeMb: number
  targetFreeMb: number | null
  rekey: {
    dbChanges: number
    scheduleEntries: number
    watchEntries: number
    ownerWatchSessions: number
  }
  otherNodes: { id: string; online: boolean }[]
  carryBackupServer: boolean
  normalizeTunnelKey: boolean
  errors: string[]
  warnings: string[]
}

export interface HandoverVerifyCheck {
  name: 'nodes' | 'tunnel' | 'team' | 'threads' | 'time' | 'access' | 'schedule'
  ok: boolean
  skipped?: boolean
  detail: string
}

export interface HandoverVerifyResult {
  ok: boolean
  checks: HandoverVerifyCheck[]
}

export type HandoverPhase = 'idle' | 'checking' | 'checked' | 'running' | 'done' | 'failed' | 'rolled-back'

export type HandoverStep = 'check' | 'freeze' | 'backup' | 'pair' | 'ship' | 'apply' | 'verify' | 'commit' | 'rollback'

export interface HandoverStateRecord {
  v: 1
  id: string
  role: 'old-master' | 'new-master' | 'peer'
  phase: 'prepared' | 'applied' | 'committed' | 'rolled-back'
  from: string
  to: string
  peerId: string
  otherNodes: string[]
  enrolledSocket?: string
  at: number
}

export interface HandoverView {
  phase: HandoverPhase
  step: HandoverStep | null
  id: string | null
  target: string | null
  plan: HandoverPlan | null
  verify: HandoverVerifyResult | null
  error: string | null
  rolledBack: boolean
  canRollback: boolean
  rollbackNeedsConfirm: boolean
  rollbackReason?: string
  state: HandoverStateRecord | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Validates that a relative path inside `<state>/` is safe to extract:
 * forward slashes only, no empty segments, no `.` or `..`, no drive letters, no control chars.
 */
export function isSafeHandoverRelPath(rel: string): boolean {
  if (!rel || typeof rel !== 'string') return false
  if (rel.startsWith('/') || rel.startsWith('\\') || rel.includes('\\')) return false
  if (/^[a-zA-Z]:/.test(rel)) return false
  for (let i = 0; i < rel.length; i++) {
    const code = rel.charCodeAt(i)
    if (code < 32 || code === 127) return false
  }
  const parts = rel.split('/')
  for (const p of parts) {
    if (!p || p === '.' || p === '..') return false
  }
  return true
}

/**
 * Encodes a manifest and matching raw file byte arrays into a single binary payload (`MHB1`).
 */
export function packHandoverBundle(manifest: HandoverManifest, bodies: readonly Uint8Array[]): Uint8Array {
  if (manifest.files.length !== bodies.length) {
    throw new Error(`handover bundle count mismatch: ${manifest.files.length} files vs ${bodies.length} bodies`)
  }
  let bodyTotal = 0
  for (const [i, f] of manifest.files.entries()) {
    const b = bodies[i]
    if (!b) throw new Error(`handover bundle missing body for ${f.path}`)
    if (!isSafeHandoverRelPath(f.path)) throw new Error(`unsafe handover path: ${f.path}`)
    if (f.size !== b.byteLength) throw new Error(`handover size mismatch for ${f.path}`)
    bodyTotal += b.byteLength
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const total = 4 + 4 + manifestBytes.byteLength + bodyTotal
  if (total > MAX_HANDOVER_BUNDLE_BYTES) {
    throw new Error(`handover bundle exceeds max size (${total} > ${MAX_HANDOVER_BUNDLE_BYTES})`)
  }
  const out = new Uint8Array(total)
  out.set(new TextEncoder().encode(HANDOVER_MAGIC), 0)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(4, manifestBytes.byteLength, false)
  out.set(manifestBytes, 8)
  let offset = 8 + manifestBytes.byteLength
  for (const b of bodies) {
    out.set(b, offset)
    offset += b.byteLength
  }
  return out
}

function isHandoverEntry(v: unknown): v is HandoverFileEntry {
  return (
    isObj(v) &&
    typeof v.path === 'string' &&
    isSafeHandoverRelPath(v.path) &&
    typeof v.category === 'string' &&
    (HANDOVER_CATEGORIES as readonly string[]).includes(v.category) &&
    typeof v.size === 'number' &&
    Number.isInteger(v.size) &&
    v.size >= 0 &&
    typeof v.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.sha256) &&
    (v.mode === undefined || (typeof v.mode === 'number' && Number.isInteger(v.mode) && v.mode > 0))
  )
}

function isCredential(v: unknown): v is HandoverCredential {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    isDevice(v.id) &&
    typeof v.token === 'string' &&
    v.token.length >= 32 &&
    (v.cert === undefined || typeof v.cert === 'string')
  )
}

/**
 * Decodes and validates a `MHB1` binary bundle back into its manifest and file slices.
 */
export function unpackHandoverBundle(bytes: Uint8Array): { manifest: HandoverManifest; bodies: Uint8Array[] } {
  if (bytes.byteLength < 8) throw new Error('handover bundle truncated')
  const magic = new TextDecoder().decode(bytes.subarray(0, 4))
  if (magic !== HANDOVER_MAGIC) throw new Error(`not a handover bundle: bad magic ${JSON.stringify(magic)}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const manifestLen = view.getUint32(4, false)
  if (manifestLen <= 0 || 8 + manifestLen > bytes.byteLength) {
    throw new Error('handover bundle has invalid manifest length')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + manifestLen)))
  } catch {
    throw new Error('handover bundle manifest is not valid JSON')
  }
  if (
    !isObj(parsed) ||
    parsed.v !== HANDOVER_VERSION ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    !isDevice(parsed.from) ||
    !isDevice(parsed.to) ||
    typeof parsed.createdAt !== 'number' ||
    !Array.isArray(parsed.files) ||
    !parsed.files.every(isHandoverEntry) ||
    !Array.isArray(parsed.credentials) ||
    !parsed.credentials.every(isCredential)
  ) {
    throw new Error('handover bundle manifest failed validation')
  }
  const manifest = parsed as unknown as HandoverManifest
  const bodies: Uint8Array[] = []
  let offset = 8 + manifestLen
  const seen = new Set<string>()
  for (const entry of manifest.files) {
    if (seen.has(entry.path)) throw new Error(`duplicate handover entry: ${entry.path}`)
    seen.add(entry.path)
    if (offset + entry.size > bytes.byteLength) {
      throw new Error(`handover bundle truncated at ${entry.path}`)
    }
    bodies.push(bytes.subarray(offset, offset + entry.size))
    offset += entry.size
  }
  if (offset !== bytes.byteLength) {
    throw new Error('handover bundle has trailing bytes')
  }
  return { manifest, bodies }
}

const normalizeHost = (host: string): string => {
  const s = host.trim().toLowerCase()
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/**
 * Checks whether a backup server hostname or IP points to the target device itself.
 */
export function isBackupTargetSelf(serverHost: string, selfNames: readonly string[]): boolean {
  const target = normalizeHost(serverHost)
  if (!target) return false
  if (LOOPBACK_HOSTS.has(target)) return true
  for (const raw of selfNames) {
    const candidate = normalizeHost(raw)
    if (!candidate) continue
    if (candidate === target) return true
    const dot = candidate.indexOf('.')
    if (dot > 0 && candidate.slice(0, dot) === target) return true
  }
  return false
}

const PORT_OK = (n: number): boolean => Number.isInteger(n) && n > 0 && n < 65536

/**
 * Resolves the reverse link the new master will use to dial the old master after handover.
 * Supports explicit `--reverse-link`:
 * - `direct:http://127.0.0.1:<port>` (or `direct:https://...`)
 * - `ssh:<user>@<host>[:<sshPort>]` (plus optional `?port=<doorPort>`)
 * - `relay[:<socket>]`
 *
 * When omitted:
 * - if `targetLink` is `direct`, defaults to `direct:http://127.0.0.1:<oldMasterNodePort>`
 * - else if `hasRelay` is true, defaults to `relay` with socket `oldMasterId` (NAT transport #511-#513)
 */
const hasControlOrSpace = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

const isLoopbackDirect = (link: LinkConfig | null): boolean => {
  if (link?.kind !== 'direct') return false
  try {
    return LOOPBACK_HOSTS.has(normalizeHost(new URL(link.url).hostname))
  } catch {
    return false
  }
}

export function parseReverseLinkSpec(o: {
  spec?: string | null
  oldMasterId: string
  oldMasterNodePort?: number
  existingSocket?: string | null
  targetLink: LinkConfig | null
  hasRelay: boolean
}): { ok: true; link: LinkConfig } | { ok: false; error: string } {
  const doorPort = o.oldMasterNodePort && PORT_OK(o.oldMasterNodePort) ? o.oldMasterNodePort : NODE_PORT
  const raw = typeof o.spec === 'string' ? o.spec.trim() : ''
  if (!raw) {
    if (isLoopbackDirect(o.targetLink)) {
      return { ok: true, link: { kind: 'direct', url: `http://127.0.0.1:${doorPort}` } }
    }
    if (o.hasRelay) {
      const stem = relaySocketStem(o.existingSocket || o.oldMasterId)
      if (!stem) return { ok: false, error: `cannot derive relay socket name from ${o.oldMasterId}` }
      return { ok: true, link: { kind: 'relay', socket: stem } }
    }
    return {
      ok: false,
      error:
        'no reverse transport: configure nodes.relay for NAT or pass --reverse-link <ssh:user@host|relay:socket|direct:url>',
    }
  }

  if (raw.startsWith('direct:')) {
    const url = raw.slice('direct:'.length).trim()
    try {
      const u = new URL(url)
      if (u.username || u.password) return { ok: false, error: 'direct reverse link must not contain credentials' }
      const isLoopbackUrl = LOOPBACK_HOSTS.has(normalizeHost(u.hostname))
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackUrl)) {
        return { ok: false, error: 'direct reverse link must use https or loopback http' }
      }
      if (isLoopbackUrl && !isLoopbackDirect(o.targetLink)) {
        return {
          ok: false,
          error:
            'loopback direct reverse link is only allowed when target is also local; pass a reachable https:// URL, ssh:..., or relay',
        }
      }
      return { ok: true, link: { kind: 'direct', url } }
    } catch {
      return { ok: false, error: `invalid direct reverse link URL: ${url}` }
    }
  }

  if (raw === 'relay' || raw.startsWith('relay:')) {
    if (!o.hasRelay) return { ok: false, error: 'relay reverse link requires nodes.relay in config.json' }
    const given = raw === 'relay' ? o.existingSocket || o.oldMasterId : raw.slice('relay:'.length).trim()
    const stem = relaySocketStem(given)
    if (!stem) return { ok: false, error: `invalid relay socket name: ${given}` }
    return { ok: true, link: { kind: 'relay', socket: stem } }
  }

  if (raw.startsWith('ssh:')) {
    const rest = raw.slice('ssh:'.length).trim()
    const [addr = '', query = ''] = rest.split('?', 2)
    const at = addr.indexOf('@')
    if (at <= 0) return { ok: false, error: 'ssh reverse link must be ssh:<user>@<host>[:<sshPort>]' }
    const user = addr.slice(0, at).trim()
    const hostPart = addr.slice(at + 1).trim()
    let host = hostPart
    let sshPort = 22
    const colon = hostPart.lastIndexOf(':')
    if (colon > 0 && !hostPart.endsWith(']')) {
      host = hostPart.slice(0, colon).trim()
      sshPort = Number(hostPart.slice(colon + 1).trim())
      if (!PORT_OK(sshPort)) return { ok: false, error: `invalid ssh port in reverse link: ${hostPart}` }
    }
    if (
      !user ||
      !host ||
      hasControlOrSpace(user) ||
      hasControlOrSpace(host) ||
      user.startsWith('-') ||
      host.startsWith('-')
    ) {
      return { ok: false, error: 'invalid user or host in ssh reverse link' }
    }
    let port = doorPort
    if (query) {
      for (const pair of query.split('&')) {
        const [k, v] = pair.split('=', 2)
        if (k === 'port' && v) {
          port = Number(v)
          if (!PORT_OK(port)) return { ok: false, error: `invalid node port in reverse link: ${v}` }
        }
      }
    }
    return { ok: true, link: { kind: 'ssh', host, sshPort, user, port } }
  }

  return { ok: false, error: `unknown --reverse-link format: ${raw} (expected direct:..., ssh:..., or relay[:...])` }
}

const pickDeviceLimits = (raw: Record<string, unknown> | undefined): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  if (!raw) return out
  for (const key of ['title', 'maxSessions', 'minFreeMemMb', 'maxLoad', 'tags', 'drain'] as const) {
    if (raw[key] !== undefined) out[key] = structuredClone(raw[key])
  }
  return out
}

/**
 * Flips `nodes` from old master `oldMasterId` to `targetId`:
 * - `nodes.id` becomes `targetId`
 * - `nodes.order` maps `targetId` -> `'local'` and `'local'` -> `oldMasterId`
 * - `nodes.devices.local` takes `targetId`'s thresholds/tags/title/drain (without `link`)
 * - `nodes.devices[oldMasterId]` takes old `local` thresholds/tags/title/drain + `link: reverseLink`
 * - non-revoked third-party devices are preserved as-is; `targetId` is removed from `devices`
 */
export function flipNodesConfig(
  oldNodesRaw: Record<string, unknown>,
  opts: {
    oldMasterId: string
    targetId: string
    oldMasterTitle?: string
    reverseLink: LinkConfig
  },
): Record<string, unknown> {
  const { oldMasterId, targetId, oldMasterTitle, reverseLink } = opts
  const oldDevices = isObj(oldNodesRaw.devices) ? oldNodesRaw.devices : {}
  const oldLocalRaw = isObj(oldDevices[LOCAL]) ? oldDevices[LOCAL] : {}
  const targetRaw = isObj(oldDevices[targetId]) ? oldDevices[targetId] : {}

  const nextDevices: Record<string, unknown> = {}
  nextDevices[LOCAL] = pickDeviceLimits(targetRaw)

  const oldMasterEntry = pickDeviceLimits(oldLocalRaw)
  if (!oldMasterEntry.title && oldMasterTitle) oldMasterEntry.title = oldMasterTitle
  oldMasterEntry.link = reverseLink
  for (const key of ['profiles', 'sinks', 'mcp', 'accept', 'paused', 'giveSecrets'] as const) {
    if (oldLocalRaw[key] !== undefined) oldMasterEntry[key] = structuredClone(oldLocalRaw[key])
  }
  nextDevices[oldMasterId] = oldMasterEntry

  for (const [id, entry] of Object.entries(oldDevices)) {
    if (id === LOCAL || id === targetId || id === oldMasterId) continue
    if (!isObj(entry) || entry.revoked === true) continue
    nextDevices[id] = structuredClone(entry)
  }

  const rawOrder = Array.isArray(oldNodesRaw.order) ? oldNodesRaw.order : []
  const nextOrder: string[] = []
  const pushUnique = (id: string): void => {
    if (!nextOrder.includes(id) && Object.hasOwn(nextDevices, id)) nextOrder.push(id)
  }
  for (const entry of rawOrder) {
    if (typeof entry !== 'string') continue
    if (entry === targetId) pushUnique(LOCAL)
    else if (entry === LOCAL) pushUnique(oldMasterId)
    else pushUnique(entry)
  }
  for (const id of Object.keys(nextDevices)) pushUnique(id)

  const next: Record<string, unknown> = {
    ...structuredClone(oldNodesRaw),
    id: targetId,
    order: nextOrder,
    devices: nextDevices,
  }
  return next
}

const MASTER_ROLE_KEYS = [
  'categories',
  'threads',
  'time',
  'calendar',
  'team',
  'tunnel',
  'remote',
  'presence',
  'journal',
  'todos',
  'decisions',
  'watches',
  'workdesk',
  'workdeskDialog',
  'boardEvents',
] as const

/**
 * Builds the new master's config.json by merging master-role sections onto the target's existing
 * machine-local config (preserving target's port, profiles, launch, wake, housekeeping, etc.).
 */
export function buildTargetMasterConfig(
  oldConfigRaw: Record<string, unknown>,
  targetConfigRaw: Record<string, unknown>,
  opts: {
    flippedNodes: Record<string, unknown>
    keepTargetNode: boolean
    normalizeTunnelKey?: boolean
    carryBackupServer?: boolean
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = structuredClone(targetConfigRaw)
  for (const key of MASTER_ROLE_KEYS) {
    if (oldConfigRaw[key] !== undefined) {
      next[key] = structuredClone(oldConfigRaw[key])
    } else {
      delete next[key]
    }
  }
  if (opts.normalizeTunnelKey && isObj(next.tunnel)) {
    const tunnel = { ...next.tunnel }
    delete tunnel.key
    next.tunnel = tunnel
  }
  if (opts.carryBackupServer && isObj(oldConfigRaw.backup) && isObj(oldConfigRaw.backup.server)) {
    next.backup = { server: structuredClone(oldConfigRaw.backup.server) }
  }
  next.nodes = structuredClone(opts.flippedNodes)
  if (!opts.keepTargetNode) {
    delete next.node
  }
  return next
}

const OLD_MASTER_STRIP_KEYS = [
  'nodes',
  'team',
  'threads',
  'time',
  'calendar',
  'watches',
  'todos',
  'decisions',
  'journal',
  'workdesk',
  'workdeskDialog',
  'boardEvents',
  'remote',
  'presence',
] as const

/**
 * Builds the old master's config.json as a node of the new master.
 * While `keepNodesFrozen` is true (before commit), `nodes` stays present so the old master keeps
 * its outbound link to verify/commit/rollback the new master. On commit (`keepNodesFrozen: false`),
 * master-only sections (`nodes`, `team`, `threads`, `time`, `calendar`, `watches`, etc.) are
 * stripped and `tunnel.on` is turned off so only the new master runs them.
 */
export function buildOldMasterNodeConfig(
  oldConfigRaw: Record<string, unknown>,
  opts: {
    nodeConfig: {
      id: string
      port: number
      workRoot?: string
      listen?: 'loopback' | 'tailnet'
      tls?: boolean
      relay?: NodeConfig['relay']
    }
    keepNodesFrozen: boolean
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = structuredClone(oldConfigRaw)
  const node: Record<string, unknown> = {
    id: opts.nodeConfig.id,
    port: opts.nodeConfig.port,
    ...(opts.nodeConfig.workRoot !== undefined && { workRoot: opts.nodeConfig.workRoot }),
    ...(opts.nodeConfig.listen !== undefined && { listen: opts.nodeConfig.listen }),
    ...(opts.nodeConfig.tls && { tls: true }),
    ...(opts.nodeConfig.relay && { relay: structuredClone(opts.nodeConfig.relay) }),
  }
  next.node = node
  if (!opts.keepNodesFrozen) {
    for (const key of OLD_MASTER_STRIP_KEYS) delete next[key]
    if (isObj(next.tunnel)) {
      next.tunnel = { ...next.tunnel, on: false }
    }
  }
  return next
}

/**
 * Builds the `node.relay` object for the old master when the reverse link uses the relay (#511-#513).
 */
export function buildOldMasterRelayNodeConfig(
  masterRelay: { host: string; sshPort: number; user: string },
  socket: string,
): NonNullable<NodeConfig['relay']> {
  return {
    host: masterRelay.host,
    sshPort: masterRelay.sshPort,
    user: RELAY_NODE_USER,
    socket,
  }
}

export const MASTER_USAGE = [
  'usage: board master handover --to <device> [--dry-run] [--reverse-link <spec>] [--node-port <port>] [--allow-offline-nodes] [--json]',
  '       board master rollback [--id <id>] [--local-only] [--discard-since-commit] [--json]',
  '       board master status [--json]',
].join('\n')

export type ParsedMasterCli =
  | {
      op: 'handover'
      to: string
      dryRun: boolean
      reverseLink?: string
      nodePort?: number
      allowOfflineNodes: boolean
      json: boolean
    }
  | {
      op: 'rollback'
      id?: string
      localOnly: boolean
      discardSinceCommit: boolean
      json: boolean
    }
  | {
      op: 'status'
      json: boolean
    }

/** Parses `board master ...` arguments without touching argv globals. */
export function parseMasterCliArgs(
  args: readonly string[],
): { ok: true; cmd: ParsedMasterCli } | { ok: false; error: string } {
  const [sub, ...rest] = args
  if (!sub || sub === 'status') {
    let json = false
    for (const w of rest) {
      if (w === '--json') json = true
      else return { ok: false, error: MASTER_USAGE }
    }
    return { ok: true, cmd: { op: 'status', json } }
  }

  if (sub === 'rollback') {
    let id: string | undefined
    let localOnly = false
    let discardSinceCommit = false
    let json = false
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i] ?? ''
      if (w === '--local-only') localOnly = true
      else if (w === '--discard-since-commit') discardSinceCommit = true
      else if (w === '--json') json = true
      else if (w === '--id' || w.startsWith('--id=')) {
        const val = w === '--id' ? rest[++i] : w.slice('--id='.length)
        if (!val || val.startsWith('--')) return { ok: false, error: MASTER_USAGE }
        id = val
      } else {
        return { ok: false, error: MASTER_USAGE }
      }
    }
    return { ok: true, cmd: { op: 'rollback', ...(id && { id }), localOnly, discardSinceCommit, json } }
  }

  if (sub === 'handover') {
    let to: string | undefined
    let dryRun = false
    let reverseLink: string | undefined
    let nodePort: number | undefined
    let allowOfflineNodes = false
    let json = false
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i] ?? ''
      if (w === '--dry-run') dryRun = true
      else if (w === '--allow-offline-nodes') allowOfflineNodes = true
      else if (w === '--json') json = true
      else if (w === '--to' || w.startsWith('--to=')) {
        const val = w === '--to' ? rest[++i] : w.slice('--to='.length)
        if (!val || val.startsWith('--')) return { ok: false, error: MASTER_USAGE }
        to = val
      } else if (w === '--reverse-link' || w.startsWith('--reverse-link=')) {
        const val = w === '--reverse-link' ? rest[++i] : w.slice('--reverse-link='.length)
        if (!val || val.startsWith('--')) return { ok: false, error: MASTER_USAGE }
        reverseLink = val
      } else if (w === '--node-port' || w.startsWith('--node-port=')) {
        const val = w === '--node-port' ? rest[++i] : w.slice('--node-port='.length)
        const port = Number(val)
        if (!val || !PORT_OK(port)) return { ok: false, error: `invalid --node-port: ${val ?? ''}` }
        nodePort = port
      } else {
        return { ok: false, error: MASTER_USAGE }
      }
    }
    if (!to || !isDevice(to)) {
      return { ok: false, error: `missing or invalid --to <device>\n${MASTER_USAGE}` }
    }
    return {
      ok: true,
      cmd: {
        op: 'handover',
        to,
        dryRun,
        ...(reverseLink !== undefined && { reverseLink }),
        ...(nodePort !== undefined && { nodePort }),
        allowOfflineNodes,
        json,
      },
    }
  }

  return { ok: false, error: MASTER_USAGE }
}

const CATEGORY_LABEL: Record<HandoverCategory, string> = {
  db: 'database (board.db)',
  threadFiles: 'thread attachments',
  journal: 'away journal (journal.db)',
  access: 'access store (passwords, passkeys, logins)',
  team: 'team keys and files',
  calendar: 'calendar cache and secrets',
  tunnel: 'tunnel config and key',
  schedule: 'schedule and watches',
  nodes: 'node keys, relay keys, and records',
  backup: 'backup key / server drop key',
}

/** Formats a handover dry-run plan into human-readable lines for CLI output. */
export function formatHandoverPlan(plan: HandoverPlan): string[] {
  const lines: string[] = [
    `dry-run · handover ${plan.from} -> ${plan.to} (${plan.targetTitle}) · ${plan.ok ? 'ready' : 'blocked'}`,
  ]
  for (const c of plan.checks) {
    const tag = c.ok ? 'ok' : c.blocking ? 'fail' : 'warn'
    lines.push(`  [${tag}] ${c.id}: ${c.detail}`)
  }
  lines.push(
    `state to move · ${plan.totalFiles} file(s), ${Math.ceil(plan.totalBytes / 1024)} KB (requires ${plan.requiredFreeMb} MB free on ${plan.to})`,
  )
  for (const item of plan.items) {
    lines.push(`  - ${CATEGORY_LABEL[item.category]}: ${item.files} file(s), ${Math.ceil(item.bytes / 1024)} KB`)
  }
  if (plan.rekey.dbChanges + plan.rekey.scheduleEntries + plan.rekey.watchEntries + plan.rekey.ownerWatchSessions > 0) {
    lines.push(
      `rekey · db=${plan.rekey.dbChanges}, schedule=${plan.rekey.scheduleEntries}, watches=${plan.rekey.watchEntries}, owner-watch=${plan.rekey.ownerWatchSessions}`,
    )
  }
  for (const w of plan.warnings) lines.push(`warning · ${w}`)
  for (const e of plan.errors) lines.push(`error · ${e}`)
  return lines
}

/** Formats a handover execution or rollback outcome into human-readable lines. */
export function formatHandoverResult(r: {
  ok: boolean
  id?: string | null
  from?: string
  to?: string
  rolledBack?: boolean
  error?: string | null
  verify?: HandoverVerifyResult | null
}): string[] {
  const lines: string[] = []
  if (r.ok) {
    lines.push(`ok · handover ${r.id ?? ''} complete (${r.from ?? ''} -> ${r.to ?? ''})`.trim())
  } else {
    lines.push(
      `failed · handover ${r.id ?? ''} ${r.rolledBack ? '(rolled back)' : ''}: ${r.error ?? 'unknown error'}`.trim(),
    )
  }
  if (r.verify) {
    for (const c of r.verify.checks) {
      const tag = c.skipped ? 'skip' : c.ok ? 'ok' : 'fail'
      lines.push(`  [${tag}] verify ${c.name}: ${c.detail}`)
    }
  }
  return lines
}
