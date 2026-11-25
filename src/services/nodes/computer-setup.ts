// "Add a computer" (#513, docs/design/nodes 11.2, 20.2): master-side setup for claiming a
// computer behind NAT through the owner's relay server with one pasted command.
//
// Flow:
// 1. start(): generates a 10-minute join code, a unique socket name, and a throwaway dial keypair
//    for agent-board-relay-n; enrols the public key on the relay server via forced command;
//    persists { socket, expiresAt } in pending-enrols.json so unclaimed keys are always removed
//    after 10 minutes; builds the POSIX sh one-liner (never holding any master token/key); and
//    polls the relay socket.
// 2. Poll: probes GET /api/hello through the relay socket, verifies that hello.node.join.fingerprint
//    matches the TLS peer certificate and hello.node.join.proof is a valid HMAC-SHA256 over the
//    join code, cert fingerprint, and node id, then transitions to `found` for Approve.
// 3. approve(): claims POST /api/node/claim over the pinned TLS connection, pins the certificate,
//    stores the token, adds `{ link: { kind: 'relay', socket } }` to config.json, starts the
//    link, reads status, writes default thresholds, sends the first bundle, and reports Claude
//    login state.
// 4. Expiry / cancel / sweepExpired(): removes unclaimed keys from the relay server cleanly.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { EditResult } from '../../adapters/config-file.ts'
import { isRecord, replaceFile } from '../../adapters/json-store.ts'
import type { DeviceStore } from '../../adapters/node-store.ts'
import { t } from '../../core/lang.ts'
import {
  COMPUTER_IDLE_VIEW,
  type ComputerFound,
  type ComputerMasterStepId,
  type ComputerSetupView,
  computerIdProblem,
  computerPortOf,
  computerSteps,
  relayLink,
} from '../../core/node-computer-setup.ts'
import { generateJoinCode, generateSocketName } from '../../core/node-join.ts'
import { nodeOneLine, nodeOneshotScript } from '../../core/node-oneshot.ts'
import { type MasterState, putDevice } from '../../core/node-setup.ts'
import {
  defaultThresholds,
  deviceIdFromHost,
  fillThresholds,
  type LinkReason,
  type NodeStatus,
  nodesConfig,
} from '../../core/nodes.ts'
import { RELAY_KEY_NAME } from '../../core/relay-texts.ts'
import type { Text } from '../../core/server-plan.ts'
import type { Config } from '../../core/types.ts'
import type { BundleSync, SyncReport } from './bundle-sync.ts'
import { verifyComputerHello } from './computer-setup-io.ts'
import type { NodeLinks } from './links.ts'

export interface RelayTarget {
  host: string
  sshPort: number
  user: string
}

export interface ComputerProbeResult {
  ok: true
  certPem: string
  certFingerprint: string
  hello: {
    host: string
    platform: string
    version: string
    node: { api: number; id: string; claimed: boolean; cert?: string; join?: unknown }
  }
}

export interface ComputerClaimRequest {
  certPem: string
  code: string
  masterName: string
  nonce?: string
}

export type ComputerClaimResult =
  | { ok: true; token: string; id: string; relayPublicKey?: string }
  | { ok: false; status?: number; error: string }

export interface RelayKeyActivateRequest {
  certPem: string
  token: string
  publicKey: string
}

export type RelayKeyActivateResult = { ok: true } | { ok: false; status?: number; error: string }

export interface PendingEnrol {
  socket: string
  /** Permanent socket path to unlink only while the attempt is still unclaimed. */
  unclaimedSocket?: string
  expiresAt: number
}

export interface ComputerSetupDeps {
  cfg: Config
  relayHostKey(host: string, sshPort: number): Promise<string | null>
  generateDialKey(
    socket: string,
  ): Promise<{ ok: true; publicKey: string; privateKey: string } | { ok: false; error: string }>
  enrol: {
    add(relay: RelayTarget, socket: string, publicKey: string): Promise<{ ok: true } | { ok: false; error: string }>
    remove(relay: RelayTarget, socket: string): Promise<{ ok: true } | { ok: false; error: string }>
  }
  probe(relay: RelayTarget, socket: string): Promise<ComputerProbeResult | null>
  claim(relay: RelayTarget, socket: string, req: ComputerClaimRequest): Promise<ComputerClaimResult>
  activateRelayKey?(relay: RelayTarget, socket: string, req: RelayKeyActivateRequest): Promise<RelayKeyActivateResult>
  releaseProbe?(socket: string): void
  pinCert(deviceId: string, certPem: string): void
  store: Pick<DeviceStore, 'token' | 'setToken' | 'dropCredentials'>
  editNodes(change: (nodes: Record<string, unknown>, had: boolean) => boolean): EditResult
  follow(): void
  links(): Pick<NodeLinks, 'link' | 'retry'> | null
  bundles(): Pick<BundleSync, 'syncIfBehind'> | null
  commit(): Promise<string>
  hostName(): string
  pendingFile(): string
  onChange(): void
  log(text: string): void
  now(): number
  newId(): string
  joinTtlMs: number
  pollMs: number
  linkWaitMs: number
  retryBaseMs?: number
  retryMaxMs?: number
  pause(ms: number): Promise<void>
  repoUrl?: string
}

export type Answer = { status: number; body: unknown }

export interface ComputerSetup {
  view(): ComputerSetupView
  start(o?: Record<string, unknown>): Promise<Answer>
  approve(o?: Record<string, unknown>): Promise<Answer>
  cancel(): Promise<Answer>
  sweepExpired(): Promise<void>
  close(): void
}

const LINK_LOOK_MS = 250
const FATAL: readonly LinkReason[] = ['host-key', 'key', 'api', 'device', 'not-built']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const pack = (script: string): string => nodeOneLine(script, b => gzipSync(b, { level: 9 }))

const isPendingEnrol = (v: unknown): v is PendingEnrol =>
  isRecord(v) &&
  typeof v.socket === 'string' &&
  RELAY_KEY_NAME.test(v.socket) &&
  (v.unclaimedSocket === undefined ||
    (typeof v.unclaimedSocket === 'string' && RELAY_KEY_NAME.test(v.unclaimedSocket))) &&
  typeof v.expiresAt === 'number' &&
  Number.isFinite(v.expiresAt)

function readPending(file: string): PendingEnrol[] {
  if (!existsSync(file)) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(raw) ? raw.filter(isPendingEnrol) : []
  } catch {
    return []
  }
}

function writePending(file: string, items: PendingEnrol[]): void {
  if (items.length === 0) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  replaceFile(file, `${JSON.stringify(items, null, 2)}\n`, undefined, 0o600)
}

interface ActiveAttempt {
  gen: number
  relay: RelayTarget
  socket: string
  pasteKeyName: string
  code: string
  claimNonce: string
  expiresAt: number
  explicitId: string
  found: (ComputerFound & { certPem: string }) | null
}

const DEFAULT_RETRY_BASE_MS = 5000
const DEFAULT_RETRY_MAX_MS = 60_000

const hintForReason = (reason: 'claimed' | 'burned-code' | 'old-plugin' | string): Text | null => {
  if (reason === 'claimed') return { key: 'node.computer.hint.claimed' }
  if (reason === 'burned-code') return { key: 'node.computer.hint.burned' }
  if (reason === 'old-plugin') return { key: 'node.computer.hint.oldPlugin' }
  return null
}

export function createComputerSetup(d: ComputerSetupDeps): ComputerSetup {
  let view: ComputerSetupView = { ...COMPUTER_IDLE_VIEW }
  let active: ActiveAttempt | null = null
  let generation = 0
  let busy = false
  let closed = false
  let polling = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const sweepTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retryBaseMs = d.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  const retryMaxMs = d.retryMaxMs ?? DEFAULT_RETRY_MAX_MS

  const set = (patch: Partial<ComputerSetupView>): void => {
    view = { ...view, ...patch }
    d.onChange()
  }
  const step = (id: ComputerMasterStepId, state: MasterState, said: Text | null = null): void =>
    set({ master: view.master.map(s => (s.id === id ? { ...s, state, said: said ?? s.said } : s)) })
  const selfId = (): string => nodesConfig(d.cfg.nodes, d.hostName())?.id ?? deviceIdFromHost(d.hostName())
  const ok = (more: Record<string, unknown> = {}): Answer => ({ status: 200, body: { ok: true, ...more } })
  const failAnswer = (status: number, error: string): Answer => ({ status, body: { ok: false, error } })

  function stopTimers(): void {
    clearTimeout(pollTimer)
    clearTimeout(expiryTimer)
    pollTimer = undefined
    expiryTimer = undefined
  }

  function addPending(entry: PendingEnrol): void {
    const file = d.pendingFile()
    const next = [...readPending(file).filter(x => x.socket !== entry.socket), entry]
    writePending(file, next)
  }

  function dropPending(socket: string): void {
    const file = d.pendingFile()
    if (!existsSync(file)) return
    const next = readPending(file).filter(x => x.socket !== socket)
    writePending(file, next)
  }

  function clearRetry(socket: string): void {
    const tmr = retryTimers.get(socket)
    if (tmr) {
      clearTimeout(tmr)
      retryTimers.delete(socket)
    }
  }

  function scheduleRemoveRetry(
    relay: RelayTarget,
    socket: string,
    unclaimedSocket: string | undefined,
    attempt: number,
  ): void {
    if (closed) return
    clearRetry(socket)
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt)
    const timer = setTimeout(
      () => {
        retryTimers.delete(socket)
        void removePendingKey(relay, socket, unclaimedSocket, attempt + 1)
      },
      Math.max(0, delay),
    )
    retryTimers.set(socket, timer)
  }

  async function removePendingKey(
    relay: RelayTarget,
    socket: string,
    unclaimedSocket?: string,
    attempt = 0,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let errText = ''
    try {
      const r = await d.enrol.remove(relay, socket)
      if (!r.ok) {
        errText = r.error
      } else {
        let sockErr = ''
        if (unclaimedSocket && unclaimedSocket !== socket) {
          const rs = await d.enrol.remove(relay, unclaimedSocket).catch(err => ({
            ok: false as const,
            error: messageOf(err),
          }))
          if (!rs.ok) sockErr = rs.error
        }
        if (!sockErr) {
          clearRetry(socket)
          dropPending(socket)
          if (view.phase === 'expired' && view.socket && (view.socket === socket || view.socket === unclaimedSocket)) {
            if (view.error) set({ error: null })
          }
          return { ok: true }
        }
        // Keep only the unclaimedSocket removal pending on retry; paste key is already gone.
        addPending({ socket: unclaimedSocket as string, expiresAt: d.now() })
        dropPending(socket)
        errText = sockErr
        d.log(`computer setup: failed to unlink expired socket ${unclaimedSocket}: ${sockErr}`)
        scheduleRemoveRetry(relay, unclaimedSocket as string, undefined, attempt)
        return { ok: false, error: errText }
      }
    } catch (err) {
      errText = messageOf(err)
    }
    d.log(`computer setup: failed to remove enrolled key ${socket}: ${errText}`)
    scheduleRemoveRetry(relay, socket, unclaimedSocket, attempt)
    return { ok: false, error: errText }
  }

  async function expireAttempt(gen: number): Promise<void> {
    if (closed || !active || active.gen !== gen) return
    if (busy) {
      armExpiry(gen, Math.min(250, d.pollMs))
      return
    }
    const cur = active
    active = null
    stopTimers()
    d.releaseProbe?.(cur.socket)
    const rm = await removePendingKey(cur.relay, cur.pasteKeyName, cur.socket)
    if (closed || generation !== gen) return
    if (rm.ok) {
      d.log(`computer setup: join code for ${cur.socket} expired and key removed`)
      set({
        phase: 'expired',
        command: null,
        script: null,
        found: null,
        next: null,
        error: null,
      })
      return
    }
    set({
      phase: 'expired',
      command: null,
      script: null,
      found: null,
      next: null,
      error: t('node.computer.err.expiredRemoveFailed', { error: rm.error }),
    })
  }

  function armExpiry(gen: number, ms: number): void {
    clearTimeout(expiryTimer)
    expiryTimer = setTimeout(() => void expireAttempt(gen), Math.max(0, ms))
  }

  function schedulePoll(gen: number): void {
    clearTimeout(pollTimer)
    if (closed || !active || active.gen !== gen || active.found !== null) return
    pollTimer = setTimeout(() => void pollOnce(gen), d.pollMs)
  }

  async function pollOnce(gen: number): Promise<void> {
    if (closed || polling || !active || active.gen !== gen || active.found !== null) return
    if (d.now() >= active.expiresAt) {
      await expireAttempt(gen)
      return
    }
    polling = true
    const cur = active
    try {
      const res = await d.probe(cur.relay, cur.socket)
      if (closed || !active || active.gen !== gen) return
      if (d.now() >= cur.expiresAt) {
        await expireAttempt(gen)
        return
      }
      if (res) {
        const checked = verifyComputerHello(res, cur.code)
        if (checked.ok) {
          cur.found = checked.found
          set({
            phase: 'found',
            next: null,
            found: {
              id: checked.found.id,
              host: checked.found.host,
              platform: checked.found.platform,
              version: checked.found.version,
              fingerprint: checked.found.fingerprint,
            },
          })
          return
        }
        const hint = hintForReason(checked.reason)
        if (hint && view.next?.key !== hint.key) set({ next: hint })
        d.log(`computer setup: ignored unverified hello (${checked.reason}) on ${cur.socket}`)
      }
    } catch {
      // Transient probe failure while node is still installing/dialling: keep polling until expiry.
    } finally {
      polling = false
    }
    if (!closed && active && active.gen === gen && active.found === null) schedulePoll(gen)
  }

  async function finishClaim(deviceId: string, socket: string, gen: number): Promise<void> {
    const gone = (): boolean => closed || gen !== generation
    const fail = (id: ComputerMasterStepId, said: Text, next: Text): void => {
      if (gone()) return
      step(id, 'fail', said)
      set({ phase: 'failed', next, error: t(said.key, said.params) })
    }

    set({ phase: 'finishing', next: null, error: null })
    step('config', 'run')
    const link = relayLink(socket)
    const me = selfId()
    let wrote = false
    const r = d.editNodes((nodes, had) => {
      wrote = putDevice(nodes, had, { id: deviceId, link, selfId: me })
      return wrote
    })
    if (!r.ok)
      return fail(
        'config',
        { key: 'node.setup.said.config', params: { error: r.error } },
        { key: 'node.setup.next.config' },
      )
    const liveHad = isObject(d.cfg.nodes)
    const live = liveHad ? structuredClone(d.cfg.nodes as Record<string, unknown>) : {}
    putDevice(live, liveHad, { id: deviceId, link, selfId: me })
    d.cfg.nodes = live
    step('config', wrote ? 'ok' : 'skip', { key: 'node.setup.said.device', params: { id: deviceId } })
    d.follow()
    if (!d.links()) return fail('link', { key: 'node.setup.said.noLinks' }, { key: 'node.setup.next.config' })

    step('link', 'run')
    const deadline = d.now() + d.linkWaitMs
    let retried = false
    let status: NodeStatus | null = null
    for (;;) {
      if (gone()) return
      const lk = d.links()?.link(deviceId) ?? null
      const st = lk?.state()
      if (st?.state === 'refused' && st.reason && FATAL.includes(st.reason))
        return fail(
          'link',
          { key: `node.setup.why.${st.reason}`, params: { detail: st.detail ?? '' } },
          { key: 'node.setup.next.link' },
        )
      if (st?.state === 'refused' && st.reason === 'token' && !retried) {
        retried = true
        d.links()?.retry(deviceId)
      }
      if (lk && st?.state === 'online') {
        if (view.master.find(s => s.id === 'link')?.state !== 'ok') step('link', 'ok')
        step('status', 'run')
        status = await lk.status()
        if (gone()) return
        if (status) break
      }
      if (d.now() > deadline) {
        const which = st?.state === 'online' ? 'status' : 'link'
        const why: Text =
          st?.state === 'refused' && st.reason
            ? { key: `node.setup.why.${st.reason}`, params: { detail: st.detail ?? '' } }
            : { key: 'node.setup.said.noAnswer', params: { s: String(Math.round(d.linkWaitMs / 1000)) } }
        return fail(which, why, { key: 'node.setup.next.link' })
      }
      await d.pause(LINK_LOOK_MS)
    }

    step('status', 'ok', {
      key: 'node.setup.said.status',
      params: { mem: String(status.memTotalMb), cpus: String(status.cpus) },
    })

    step('thresholds', 'run')
    const given = defaultThresholds(status)
    let filled = false
    const t2 = d.editNodes(nodes => {
      filled = fillThresholds(nodes, deviceId, given)
      return filled
    })
    if (!t2.ok)
      return fail(
        'thresholds',
        { key: 'node.setup.said.config', params: { error: t2.error } },
        { key: 'node.setup.next.config' },
      )
    if (isObject(d.cfg.nodes)) fillThresholds(d.cfg.nodes as Record<string, unknown>, deviceId, given)
    step('thresholds', filled ? 'ok' : 'skip', {
      key: 'node.setup.said.thresholds',
      params: { sessions: String(given.maxSessions), mem: String(given.minFreeMemMb) },
    })

    step('bundle', 'run', { key: 'node.place.syncing', params: { name: deviceId } })
    const bundles = d.bundles()
    if (!bundles) return fail('bundle', { key: 'node.setup.said.noLinks' }, { key: 'node.setup.next.bundle' })
    let report: SyncReport
    try {
      report = await bundles.syncIfBehind(deviceId)
    } catch (err) {
      return fail(
        'bundle',
        { key: 'node.setup.said.bundleError', params: { error: messageOf(err) } },
        { key: 'node.setup.next.bundle' },
      )
    }
    if (gone()) return
    set({
      bundle: {
        ok: report.ok,
        applied: report.applied.length,
        kept: report.kept.length,
        sent: report.sent,
        why: report.why ?? null,
      },
    })
    if (!report.ok)
      return fail(
        'bundle',
        { key: 'node.setup.said.bundleFailed', params: { why: report.why ?? '', detail: report.detail ?? '' } },
        { key: 'node.setup.next.bundle' },
      )

    const secretsGiven =
      report.secrets && !report.secrets.error ? [...report.secrets.given, ...report.secrets.files] : []
    const toGive = report.lines
      .filter(l => l.verdict === 'needs-secret' && l.why !== 'reference' && !secretsGiven.includes(l.name))
      .map(l => l.name)
    const files = { applied: String(report.applied.length), kept: String(report.kept.length) }
    step('bundle', 'ok', {
      key: secretsGiven.length
        ? toGive.length
          ? 'node.setup.said.bundleBoth'
          : 'node.setup.said.bundleGiven'
        : toGive.length
          ? 'node.setup.said.bundleToGive'
          : 'node.setup.said.bundle',
      params: { ...files, given: secretsGiven.join(', '), toGive: toGive.join(', ') },
    })

    const login = { device: deviceId, profiles: status.profiles.map(p => ({ id: p.id, loggedIn: p.loggedIn })) }
    const out = login.profiles.some(x => x.loggedIn !== true)
    set({ login })
    step('login', out ? 'wait' : 'ok', {
      key: out ? 'node.setup.said.login' : 'node.setup.said.loggedIn',
      params: { device: deviceId },
    })
    d.log(`computer setup: ${deviceId} added`)
    set({ phase: 'done' })
  }

  return {
    view: () => view,

    async start(o = {}) {
      if (busy) return failAnswer(409, t('node.computer.err.busy'))
      const cfg = nodesConfig(d.cfg.nodes, d.hostName())
      if (!cfg?.relay) return { status: 409, body: { ok: false, need: 'relay', error: t('node.computer.err.noRelay') } }
      const explicitId = typeof o.id === 'string' ? o.id.trim() : ''
      if (explicitId) {
        const problem = computerIdProblem(explicitId, { selfId: cfg.id, devices: cfg.devices })
        if (problem) return failAnswer(409, t(problem.key, problem.params))
      }
      const port = computerPortOf(o.port)
      if (port === null) return failAnswer(400, t('node.setup.err.port'))

      busy = true
      try {
        const hostKey = await d.relayHostKey(cfg.relay.host, cfg.relay.sshPort)
        if (!hostKey) return failAnswer(409, t('node.computer.err.noHostKey'))

        // Clean up any prior unclaimed attempt before starting a fresh one.
        stopTimers()
        const prev = active
        active = null
        generation += 1
        const gen = generation
        if (prev) {
          d.releaseProbe?.(prev.socket)
          await removePendingKey(prev.relay, prev.pasteKeyName, prev.socket)
        }
        if (closed || gen !== generation) return failAnswer(409, t('node.computer.err.cancelled'))

        const socket = generateSocketName(explicitId || d.hostName())
        const pasteKeyName = `${socket}-init`
        const code = generateJoinCode()
        const claimNonce = generateJoinCode()
        const expiresAt = d.now() + d.joinTtlMs
        const dialKey = await d.generateDialKey(socket)
        if (!dialKey.ok) return failAnswer(500, dialKey.error)

        const commit = await d.commit().catch(() => '')
        const script = nodeOneshotScript({
          relay: {
            host: cfg.relay.host,
            sshPort: cfg.relay.sshPort,
            socket,
            hostKey,
          },
          dialKey: dialKey.privateKey,
          code,
          expiresAt,
          ...(commit && { commit }),
          ...(d.repoUrl && { repoUrl: d.repoUrl }),
          ...(explicitId && { id: explicitId }),
          port,
        })
        const command = pack(script)

        const added = await d.enrol.add(cfg.relay, pasteKeyName, dialKey.publicKey)
        if (!added.ok) return failAnswer(502, added.error)

        addPending({ socket: pasteKeyName, unclaimedSocket: socket, expiresAt })

        active = { gen, relay: cfg.relay, socket, pasteKeyName, code, claimNonce, expiresAt, explicitId, found: null }
        set({
          ...COMPUTER_IDLE_VIEW,
          phase: 'waiting',
          command,
          script,
          socket,
          expiresAt,
        })
        armExpiry(gen, d.joinTtlMs)
        schedulePoll(gen)
        return ok()
      } finally {
        busy = false
      }
    },

    async approve(o = {}) {
      if (busy) return failAnswer(409, t('node.computer.err.busy'))
      const cur = active
      if (!cur?.found || (view.phase !== 'found' && view.phase !== 'failed'))
        return failAnswer(409, t('node.computer.err.notFound'))
      if (d.now() >= cur.expiresAt) {
        await expireAttempt(cur.gen)
        return failAnswer(410, t('node.computer.err.expired'))
      }
      const cfg = nodesConfig(d.cfg.nodes, d.hostName())
      const givenId = typeof o.id === 'string' ? o.id.trim() : ''
      if (givenId && givenId !== cur.found.id)
        return failAnswer(409, t('node.computer.err.idMismatch', { id: cur.found.id }))
      const deviceId = cur.found.id
      const problem = computerIdProblem(deviceId, {
        selfId: cfg?.id ?? selfId(),
        devices: cfg?.devices ?? {},
      })
      if (problem) return failAnswer(409, t(problem.key, problem.params))

      busy = true
      const gen = cur.gen
      clearTimeout(pollTimer)
      pollTimer = undefined
      set({
        phase: 'claiming',
        device: { id: deviceId },
        master: computerSteps(),
        error: null,
        next: null,
      })
      step('claim', 'run')
      try {
        const claimed = await d.claim(cur.relay, cur.socket, {
          certPem: cur.found.certPem,
          code: cur.code,
          masterName: selfId(),
          nonce: cur.claimNonce,
        })
        if (closed || gen !== generation) return failAnswer(409, t('node.computer.err.cancelled'))
        if (!claimed.ok) {
          if (claimed.status === 409) {
            // Another master holds this computer: remove only this attempt's "-init" paste key
            // (same backoff path as TTL removal, leaving any permanent key/socket intact) and
            // instruct how to forget it.
            stopTimers()
            active = null
            d.releaseProbe?.(cur.socket)
            addPending({ socket: cur.pasteKeyName, expiresAt: d.now() })
            await removePendingKey(cur.relay, cur.pasteKeyName)
            if (closed || gen !== generation) return failAnswer(409, t('node.computer.err.cancelled'))
            const msg = t('node.computer.err.alreadyClaimed')
            step('claim', 'fail', { key: 'node.computer.said.claimFailed', params: { error: msg } })
            set({
              phase: 'failed',
              command: null,
              script: null,
              error: msg,
              next: { key: 'node.computer.next.claimed' },
            })
            return failAnswer(409, msg)
          }
          if (claimed.status === 410 || d.now() >= cur.expiresAt) {
            step('claim', 'fail', { key: 'node.computer.said.claimFailed', params: { error: claimed.error } })
            stopTimers()
            active = null
            d.releaseProbe?.(cur.socket)
            const rm = await removePendingKey(cur.relay, cur.pasteKeyName, cur.socket)
            set({
              phase: 'expired',
              command: null,
              script: null,
              found: null,
              error: rm.ok ? null : t('node.computer.err.expiredRemoveFailed', { error: rm.error }),
            })
            return failAnswer(410, claimed.error)
          }
          // Transient failure (e.g. aborted claim after server processed it): keep `active` so Approve retries idempotently.
          step('claim', 'fail', { key: 'node.computer.said.claimFailed', params: { error: claimed.error } })
          set({ phase: 'failed', error: claimed.error })
          return failAnswer(claimed.status ?? 502, claimed.error)
        }

        if (claimed.relayPublicKey) {
          const addedPerm = await d.enrol.add(cur.relay, cur.socket, claimed.relayPublicKey)
          if (!addedPerm.ok) {
            step('claim', 'fail', { key: 'node.computer.said.claimFailed', params: { error: addedPerm.error } })
            set({ phase: 'failed', error: addedPerm.error })
            return failAnswer(502, addedPerm.error)
          }
          if (d.activateRelayKey) {
            const activated = await d.activateRelayKey(cur.relay, cur.socket, {
              certPem: cur.found.certPem,
              token: claimed.token,
              publicKey: claimed.relayPublicKey,
            })
            if (!activated.ok) {
              step('claim', 'fail', { key: 'node.computer.said.claimFailed', params: { error: activated.error } })
              set({ phase: 'failed', error: activated.error })
              return failAnswer(activated.status ?? 502, activated.error)
            }
          }
        }

        if (closed || gen !== generation) return failAnswer(409, t('node.computer.err.cancelled'))

        // Claim succeeded: disarm expiry; remove the "-init" paste key only when the node rotated
        // to a permanent key, otherwise keep it enrolled and stop tracking it as pending.
        stopTimers()
        active = null
        d.releaseProbe?.(cur.socket)
        if (claimed.relayPublicKey) {
          addPending({ socket: cur.pasteKeyName, expiresAt: d.now() })
          await removePendingKey(cur.relay, cur.pasteKeyName)
          if (closed || gen !== generation) return failAnswer(409, t('node.computer.err.cancelled'))
        } else {
          clearRetry(cur.pasteKeyName)
          dropPending(cur.pasteKeyName)
        }
        step('claim', 'ok', { key: 'node.setup.said.device', params: { id: deviceId } })
        set({ command: null, script: null })

        d.pinCert(deviceId, cur.found.certPem)
        d.store.setToken(deviceId, claimed.token)

        await finishClaim(deviceId, cur.socket, gen)
        return ok({ id: deviceId })
      } finally {
        busy = false
      }
    },

    async cancel() {
      if (busy) return failAnswer(409, t('node.computer.err.busy'))
      stopTimers()
      const prev = active
      active = null
      generation += 1
      if (prev) {
        d.releaseProbe?.(prev.socket)
        await removePendingKey(prev.relay, prev.pasteKeyName, prev.socket)
      }
      set({ ...COMPUTER_IDLE_VIEW })
      return ok()
    },

    async sweepExpired() {
      const file = d.pendingFile()
      const entries = readPending(file)
      if (!entries.length) return
      const relay = nodesConfig(d.cfg.nodes, d.hostName())?.relay
      if (!relay) return
      const now = d.now()
      for (const entry of entries) {
        if (closed) return
        if (now >= entry.expiresAt) {
          await removePendingKey(relay, entry.socket, entry.unclaimedSocket)
        } else if (!closed && !sweepTimers.has(entry.socket)) {
          const delay = Math.max(0, entry.expiresAt - now)
          const timer = setTimeout(() => {
            sweepTimers.delete(entry.socket)
            void removePendingKey(relay, entry.socket, entry.unclaimedSocket)
          }, delay)
          sweepTimers.set(entry.socket, timer)
        }
      }
    },

    close() {
      closed = true
      stopTimers()
      for (const timer of sweepTimers.values()) clearTimeout(timer)
      sweepTimers.clear()
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
    },
  }
}
