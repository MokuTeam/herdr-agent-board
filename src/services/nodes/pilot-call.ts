// Master-side bridge for MokuPilot calls (#618, #700).
//
// 1. Clicking Call on a node card (`@<device>:<key>`) when MokuPilot runs on the master:
//    mints a scoped per-call grant and launches local MokuPilot with MOKUPILOT_NODE_CALL_URL and
//    MOKUPILOT_NODE_CALL_TOKEN, forwarding requests over the node link to that node's door.
// 2. Link mode (`mokupilot://call?...`) on a master with `nodes`: returns a mokupilot:// link for
//    the viewer's MokuPilot (including node cards, after checking the target node is reachable).
// 3. Reverse bridge (#700): when MokuPilot runs on a node (viewer's machine) and asks for a
//    session on the master or a third device, openForNode() resolves the target and mints a grant
//    scoped to `ownerDevice` so services/nodes/pilot-bridge.ts can proxy the call over the link.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { isRecord } from '../../adapters/json-store.ts'
import { knobMs } from '../../adapters/pacing.ts'
import { t } from '../../core/lang.ts'
import { callable, callLink } from '../../core/mokupilot.ts'
import { isRegisteredNodeViewer, mokupilotMode, resolveMode, type Viewer } from '../../core/mokupilot-mode.ts'
import { dropMovedCards } from '../../core/node-items.ts'
import { configuredNodeAddresses, LOCAL, nodesConfig, parseNodeKey } from '../../core/nodes.ts'
import { isPilotCallId, type PilotSessionSummary, parseOpenRequest, UUID } from '../../core/pilot-call.ts'
import { type ProfileSet, profileLabel } from '../../core/profiles.ts'
import type { Config, Item } from '../../core/types.ts'
import { type CallResult, callProfileEnv, startCall } from '../mokupilot.ts'
import type { Answer } from '../node/bundle.ts'
import type { NodePilotCall } from '../node/pilot-call.ts'
import { ownAddresses } from '../tunnel.ts'
import type { Link } from './link.ts'
import type { NodeLinks } from './links.ts'

export interface NodePilotCallGrant {
  id: string
  token: string
  target: { kind: 'local' } | { kind: 'node'; device: string }
  /** Undefined for master-launched grants; calling node device id for grants opened via pilot-bridge (#700). */
  ownerDevice?: string
  device: string
  key: string
  prefixedKey: string
  session: string
  cwd: string
  profile: string
  profileFolder: string
  /** Sessions this grant may resume: the origin session plus any fork UUID it created. */
  allowedSessions: Set<string>
  /** Run IDs started under this grant. */
  runs: Set<string>
  expiresAt: number
}

export interface NodePilotCalls {
  /** Start a MokuPilot call for a node card (`@<device>:<key>`). */
  startForItem(item: Item, viewer?: Viewer): Promise<CallResult>
  /** Validate grant id + Bearer token (timing-safe) for master's own loopback MokuPilot. */
  authorize(grantId: string, authHeader: string | null): NodePilotCallGrant | null
  /** Validate grant id owned by a specific calling node over the pilot bridge (#700). */
  authorizeForNode(callingDevice: string, grantId: string): NodePilotCallGrant | null
  /** Open a call from a node's MokuPilot to a local, master, or third-device session (#700). */
  openForNode(callingDevice: string, rawBody: unknown): Promise<{ status: number; body: unknown }>
  /** Open a call from MokuPilot running on the master itself (#700). */
  openLocal(rawBody: unknown): Promise<Response>
  /** List callable sessions for MokuPilot running on the master itself (#700, #730). */
  sessionsLocal(): Response
  /** Whether MokuPilot node bridge is enabled for `device` (`local` or a non-revoked node id, #730, #738). */
  bridgeEnabled(device: string): boolean
  /** Whether a node item may set `call.parent` to `parentKey` under an active/recent bridge grant (#730). */
  allowsCallParent(callingDevice: string, parentKey: string): boolean
  /** List callable sessions across the master and all online/known nodes (#700). */
  listSessions(): PilotSessionSummary[]
  /** Revoke all grants and close active runs owned by a calling node (#700). */
  revokeForNode(callingDevice: string): void
  /** Start a forked/resumed run on the grant's target (master local or remote node). */
  startRun(grant: NodePilotCallGrant, rawBody: unknown): Promise<Response>
  /** Stream `GET /runs/:runId/events` SSE from the target, recording fork session IDs. */
  events(grant: NodePilotCallGrant, runId: string, req: Request): Promise<Response>
  /** Forward `POST /runs/:runId/(stdin|mcp-reply|close)` to the target. */
  runPost(
    grant: NodePilotCallGrant,
    runId: string,
    action: 'stdin' | 'mcp-reply' | 'close',
    rawBody: string,
  ): Promise<Response>
  /** Upload post-call files to the target. */
  uploadFiles(grant: NodePilotCallGrant, rawBody: string): Promise<Response>
  /** Queue a post-call report for the grant's origin session on the target. */
  deliverReport(grant: NodePilotCallGrant, rawBody: unknown): Promise<Response>
  /** End and revoke a grant, closing any active runs on the target. */
  end(grant: NodePilotCallGrant): Promise<Response>
  /** Close all grants (board shutdown). */
  close(): void
}

export interface NodePilotCallsDeps {
  cfg: Config
  links: Pick<NodeLinks, 'link' | 'onChange'>
  port(): number
  log(text: string): void
  own?: () => readonly string[]
  /** Override startCall in tests. */
  launch?: typeof startCall
  /** Master's own local NodePilotCall runner for sessions living on the master (#700). */
  localPilotCall?: NodePilotCall
  /** Master's own local items (#700). */
  ownItems?: () => Item[]
  /** Remote nodes' aggregated items (#700). */
  remoteItems?: () => Item[]
  /** Master's own device id (#700). */
  masterId?: () => string
  /** Master's Claude profiles (#700). */
  profiles?: () => ProfileSet
  /** Registered node addresses allowed to request node-card mokupilot:// links (#700). */
  nodeAddresses?: () => readonly string[]
  home?: string
  platform?: string
  env?: Record<string, string | undefined>
  /** Grant TTL in ms (default 6 hours). */
  grantTtlMs?: number
  /** Probe timeout in ms (default 5 s). */
  checkTimeoutMs?: number
  /** Maximum active bridge grants per calling node (#730, default 16). */
  maxGrantsPerNode?: number
}

const CHECK_TIMEOUT_MS = 5000
const DEFAULT_GRANT_TTL_MS = 6 * 3600 * 1000
const DEFAULT_MAX_GRANTS_PER_NODE = 16
const CALL_PARENT_TTL_MS = 24 * 3600 * 1000
const MAX_PARENTS_PER_NODE = 64
const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Extract a Claude session UUID from a buffered SSE `line` event (`system.init`), if present. */
export function extractInitSessionId(chunk: string): string | null {
  for (const rawLine of chunk.split('\n')) {
    if (!rawLine.startsWith('data: ')) continue
    try {
      const outer = JSON.parse(rawLine.slice(6)) as { line?: unknown }
      if (typeof outer?.line !== 'string' || !outer.line.includes('session_id')) continue
      const inner = JSON.parse(outer.line) as { type?: unknown; subtype?: unknown; session_id?: unknown }
      if (
        inner?.type === 'system' &&
        inner.subtype === 'init' &&
        typeof inner.session_id === 'string' &&
        UUID.test(inner.session_id)
      ) {
        return inner.session_id
      }
    } catch {}
  }
  return null
}

function answerToResponse(ans: Answer): Response {
  return jsonRes(ans.status, ans.body)
}

function parseJsonBody(rawBody: string): { ok: true; value: unknown } | { ok: false; res: Response } {
  try {
    return { ok: true, value: JSON.parse(rawBody || '{}') }
  } catch {
    return { ok: false, res: jsonRes(400, { ok: false, error: 'invalid json' }) }
  }
}

export function createNodePilotCalls(deps: NodePilotCallsDeps): NodePilotCalls {
  const grants = new Map<string, NodePilotCallGrant>()
  const grantedParents = new Map<string, Map<string, number>>()
  const stdinChains = new Map<string, Promise<void>>()
  const own = deps.own ?? ownAddresses
  const nodeAddresses = deps.nodeAddresses ?? (() => configuredNodeAddresses(nodesConfig(deps.cfg.nodes)))
  const launch = deps.launch ?? startCall
  const grantTtlMs = deps.grantTtlMs ?? knobMs('BOARD_PILOT_GRANT_TTL_MS', DEFAULT_GRANT_TTL_MS)
  const checkTimeoutMs = deps.checkTimeoutMs ?? knobMs('BOARD_PILOT_CHECK_MS', CHECK_TIMEOUT_MS)
  const maxGrantsPerNode = Math.max(1, deps.maxGrantsPerNode ?? DEFAULT_MAX_GRANTS_PER_NODE)

  function sweep(): void {
    const now = Date.now()
    for (const [id, g] of grants) if (g.expiresAt <= now) grants.delete(id)
  }

  function bridgeEnabled(device: string): boolean {
    const dev = nodesConfig(deps.cfg.nodes)?.devices[device]
    return !!dev && !dev.revoked && dev.pilotBridge !== false
  }

  function grantsForNode(callingDevice: string): number {
    let count = 0
    for (const g of grants.values()) {
      if (g.ownerDevice === callingDevice) count++
    }
    return count
  }

  function recordCallParent(callingDevice: string, parentKey: string): void {
    const now = Date.now()
    const expiresAt = now + Math.max(grantTtlMs, CALL_PARENT_TTL_MS)
    let map = grantedParents.get(callingDevice)
    if (!map) {
      map = new Map()
      grantedParents.set(callingDevice, map)
    } else {
      for (const [k, exp] of map) {
        if (exp <= now) map.delete(k)
      }
    }
    map.delete(parentKey)
    while (map.size >= MAX_PARENTS_PER_NODE) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    map.set(parentKey, expiresAt)
  }

  function currentMasterId(): string {
    return deps.masterId?.() ?? nodesConfig(deps.cfg.nodes)?.id ?? ''
  }

  function reach(device: string): { link: Link } | { error: string; status: number } {
    const conf = nodesConfig(deps.cfg.nodes)
    const link = conf?.devices[device]?.link ? deps.links.link(device) : null
    if (!link) return { error: t('err.gone'), status: 404 }
    const s = link.state()
    if (s.state === 'refused' && s.reason === 'api')
      return { error: t('mokupilot.err.nodeApi', { device }), status: 503 }
    if (s.state !== 'online') return { error: t('mokupilot.err.nodeOffline', { device }), status: 503 }
    return { link }
  }

  async function probeNode(
    device: string,
    body: { session: string; cwd: string; profile: string; profileFolder: string },
  ): Promise<{ ok: true; cwd: string; profile: string } | { ok: false; status: number; error: string }> {
    const r = reach(device)
    if ('error' in r) return { ok: false, status: r.status, error: r.error }
    try {
      const res = await r.link.fetch('/api/node/pilot-call/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(checkTimeoutMs),
      })
      if (res.status === 404) {
        await res.body?.cancel()
        return { ok: false, status: 409, error: t('mokupilot.err.nodeOld', { device }) }
      }
      const ans = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok || !ans || ans.ok !== true || typeof ans.cwd !== 'string' || !ans.cwd) {
        const why = typeof ans?.error === 'string' && ans.error ? ans.error : `HTTP ${res.status}`
        return {
          ok: false,
          status: res.status >= 400 ? res.status : 409,
          error: t('mokupilot.err.nodeCheck', { device, why }),
        }
      }
      return {
        ok: true,
        cwd: ans.cwd,
        profile: typeof ans.profile === 'string' ? ans.profile : body.profile,
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      return { ok: false, status: 503, error: t('mokupilot.err.nodeCheck', { device, why }) }
    }
  }

  async function forwardJson(device: string, path: string, body: string): Promise<Response> {
    const r = reach(device)
    if ('error' in r) return jsonRes(r.status, { ok: false, error: r.error })
    try {
      const res = await r.link.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      const text = await res.text()
      return new Response(text, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
      })
    } catch (err) {
      return jsonRes(503, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  function mintGrant(o: {
    target: NodePilotCallGrant['target']
    ownerDevice?: string
    device: string
    key: string
    prefixedKey: string
    session: string
    cwd: string
    profile: string
    profileFolder: string
  }): NodePilotCallGrant {
    sweep()
    const grantId = randomBytes(16).toString('base64url')
    const token = randomBytes(32).toString('base64url')
    const grant: NodePilotCallGrant = {
      id: grantId,
      token,
      target: o.target,
      ...(o.ownerDevice !== undefined && { ownerDevice: o.ownerDevice }),
      device: o.device,
      key: o.key,
      prefixedKey: o.prefixedKey,
      session: o.session,
      cwd: o.cwd,
      profile: o.profile,
      profileFolder: o.profileFolder,
      // Only fork UUIDs observed in system.init may be resumed in-place (never the live origin session).
      allowedSessions: new Set(),
      runs: new Set(),
      expiresAt: Date.now() + grantTtlMs,
    }
    grants.set(grantId, grant)
    return grant
  }

  function mergedItems(): Item[] {
    const ownList = deps.ownItems?.() ?? []
    const remList = deps.remoteItems?.() ?? []
    return dropMovedCards([...ownList, ...remList], currentMasterId())
  }

  async function resolveOpenTarget(
    callingDevice: string | null,
    rawBody: unknown,
  ): Promise<
    | {
        kind: 'caller-local'
        session: string
        cwd: string
      }
    | {
        kind: 'resolved'
        target: NodePilotCallGrant['target']
        device: string
        key: string
        prefixedKey: string
        session: string
        cwd: string
        profile: string
        profileFolder: string
        foundItem?: Item | undefined
      }
    | { kind: 'error'; status: number; error: string }
  > {
    if (deps.cfg.mokupilot === false) return { kind: 'error', status: 409, error: t('mokupilot.err.off') }
    const parsed = parseOpenRequest(rawBody)
    if ('error' in parsed) return { kind: 'error', status: 400, error: parsed.error }
    const masterId = currentMasterId()
    const lower = parsed.session.toLowerCase()
    const isCallableSession = (i: Item): boolean =>
      !i.call && !i.day && callable(i) && String(i.session).toLowerCase() === lower

    const items = mergedItems()
    let target: NodePilotCallGrant['target'] | null = null
    let foundItem: Item | undefined

    if (parsed.device) {
      if (callingDevice && parsed.device === callingDevice) {
        const hit = items.find(i => i.device === callingDevice && isCallableSession(i))
        if (!hit) return { kind: 'error', status: 404, error: t('mokupilot.err.sessionNotFound') }
        return { kind: 'caller-local', session: parsed.session, cwd: hit.cwd || '' }
      }
      if (parsed.device === LOCAL || (masterId && parsed.device === masterId)) {
        target = { kind: 'local' }
        foundItem = items.find(i => !i.device && isCallableSession(i))
      } else {
        target = { kind: 'node', device: parsed.device }
        foundItem = items.find(i => i.device === parsed.device && isCallableSession(i))
      }
    } else {
      const hit = items.find(isCallableSession)
      if (hit) {
        if (callingDevice && hit.device === callingDevice) {
          return { kind: 'caller-local', session: parsed.session, cwd: hit.cwd || '' }
        }
        foundItem = hit
        target = hit.device ? { kind: 'node', device: hit.device } : { kind: 'local' }
      } else if (!callingDevice && deps.localPilotCall) {
        const localCheck = await deps.localPilotCall.check({
          session: parsed.session,
          cwd: parsed.cwd,
          profile: '',
          profileFolder: '',
        })
        if (localCheck.status === 200) {
          target = { kind: 'local' }
        }
      }
    }

    if (!target || (callingDevice && !foundItem)) {
      return { kind: 'error', status: 404, error: t('mokupilot.err.sessionNotFound') }
    }

    if (callingDevice) {
      sweep()
      if (grantsForNode(callingDevice) >= maxGrantsPerNode) {
        return { kind: 'error', status: 429, error: 'too many active call grants for this device' }
      }
    }

    const probeReq = {
      session: parsed.session,
      cwd: callingDevice ? foundItem?.cwd || '' : parsed.cwd || foundItem?.cwd || '',
      profile: foundItem?.profile || '',
      profileFolder: foundItem?.profileFolder || '',
    }

    if (target.kind === 'local') {
      if (!deps.localPilotCall) return { kind: 'error', status: 500, error: 'local pilot-call runner unavailable' }
      const check = await deps.localPilotCall.check(probeReq)
      const body = check.body as Record<string, unknown>
      if (check.status !== 200 || body.ok !== true || typeof body.cwd !== 'string' || !body.cwd) {
        return {
          kind: 'error',
          status: check.status,
          error: typeof body.error === 'string' ? body.error : t('mokupilot.err.sessionNotFound'),
        }
      }
      const profile = typeof body.profile === 'string' ? body.profile : probeReq.profile
      return {
        kind: 'resolved',
        target,
        device: masterId || LOCAL,
        key: foundItem?.key ?? parsed.session,
        prefixedKey: foundItem?.key ?? parsed.session,
        session: parsed.session,
        cwd: body.cwd,
        profile,
        profileFolder: probeReq.profileFolder,
        foundItem,
      }
    }

    const check = await probeNode(target.device, probeReq)
    if (!check.ok) return { kind: 'error', status: check.status, error: check.error }
    const at = foundItem ? parseNodeKey(foundItem.key) : null
    const rawKey = at?.key ?? parsed.session
    const prefixedKey = foundItem?.key ?? `@${target.device}:${rawKey}`
    return {
      kind: 'resolved',
      target,
      device: target.device,
      key: rawKey,
      prefixedKey,
      session: parsed.session,
      cwd: check.cwd,
      profile: check.profile,
      profileFolder: probeReq.profileFolder,
      foundItem,
    }
  }

  function teeInitEvents(grant: NodePilotCallGrant, res: Response, done: () => void): Response {
    if (!res.ok || !res.body) {
      done()
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
      })
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const MAX_PEEK_LINE = 2 * 1024 * 1024
    let lineBuf = ''
    let droppingLine = false
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) {
          done()
          try {
            controller.close()
          } catch {}
          return
        }
        if (next.value) {
          const text = decoder.decode(next.value, { stream: true })
          const parts = text.split('\n')
          for (let i = 0; i < parts.length; i++) {
            const seg = parts[i] ?? ''
            if (!droppingLine) {
              if (lineBuf.length + seg.length > MAX_PEEK_LINE) {
                lineBuf = ''
                droppingLine = true
              } else {
                lineBuf += seg
              }
            }
            if (i < parts.length - 1) {
              if (!droppingLine && lineBuf) {
                const initSid = extractInitSessionId(lineBuf)
                if (initSid && initSid.toLowerCase() !== grant.session.toLowerCase()) {
                  grant.allowedSessions.add(initSid.toLowerCase())
                }
              }
              lineBuf = ''
              droppingLine = false
            }
          }
          controller.enqueue(next.value)
        }
      },
      cancel() {
        done()
        return reader.cancel().catch(() => {})
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  function closeGrantRuns(grant: NodePilotCallGrant, kill: boolean): Promise<unknown> {
    const closes = [...grant.runs].map(runId => {
      if (grant.target.kind === 'local') {
        try {
          deps.localPilotCall?.close(runId, { kill })
        } catch {}
        return Promise.resolve(null)
      }
      return forwardJson(grant.target.device, `/api/node/pilot-call/${runId}/close`, JSON.stringify({ kill })).catch(
        () => null,
      )
    })
    return Promise.all(closes)
  }

  return {
    async startForItem(item, viewer) {
      const at = parseNodeKey(item.key)
      const device = item.device || at?.device || ''
      if (!device || !at) return { ok: false, error: t('err.gone') }
      if (item.call || item.day) return { ok: false, error: t('err.noPane') }
      if (!callable(item)) return { ok: false, error: t('mokupilot.err.notClaude') }
      if (deps.cfg.mokupilot === false) return { ok: false, error: t('mokupilot.err.off') }

      const mode = mokupilotMode(deps.cfg.mokupilot)
      const decided = resolveMode(mode, viewer, mode === 'auto' && viewer ? own() : [])
      const where = {
        resolved: decided.resolved,
        why: decided.why,
        ...(decided.viewer && { viewer: decided.viewer }),
      }

      const session = String(item.session)
      const probe = await probeNode(device, {
        session,
        cwd: item.cwd || '',
        profile: item.profile || '',
        profileFolder: item.profileFolder || '',
      })
      if (!probe.ok) return { ok: false, error: probe.error, ...where }

      if (decided.resolved === 'link') {
        if (!isRegisteredNodeViewer(viewer, nodeAddresses())) {
          return { ok: false, error: t('mokupilot.err.nodeLink'), ...where }
        }
        const url = callLink(item, probe.cwd)
        if (!url) return { ok: false, error: t('mokupilot.err.notClaude'), ...where }
        return { ok: true, state: 'link', url, ...where }
      }

      const grant = mintGrant({
        target: { kind: 'node', device },
        device,
        key: at.key,
        prefixedKey: item.key,
        session,
        cwd: probe.cwd,
        profile: probe.profile,
        profileFolder: item.profileFolder || '',
      })

      const url = `http://127.0.0.1:${deps.port()}/api/mokupilot/node-call/${grant.id}`
      const started = await launch(deps.cfg, item, {
        viewer,
        own,
        nodeCall: {
          url,
          token: grant.token,
          device,
          parent: item.key,
          cwd: probe.cwd,
        },
      })
      if (!started.ok) {
        grants.delete(grant.id)
        return started
      }
      deps.log(`pilot-call: launched MokuPilot for ${item.key} via grant ${grant.id.slice(0, 8)}`)
      return started
    },

    authorize(grantId, authHeader) {
      if (!isPilotCallId(grantId)) return null
      sweep()
      const grant = grants.get(grantId)
      if (!grant || grant.ownerDevice !== undefined) return null
      const m = /^Bearer\s+(\S+)$/i.exec((authHeader ?? '').trim())
      if (!m || !safeEqual(m[1] ?? '', grant.token)) return null
      return grant
    },

    authorizeForNode(callingDevice, grantId) {
      if (!bridgeEnabled(callingDevice)) return null
      if (!isPilotCallId(grantId)) return null
      sweep()
      const grant = grants.get(grantId)
      if (!grant || grant.ownerDevice !== callingDevice) return null
      return grant
    },

    bridgeEnabled,

    allowsCallParent(callingDevice, parentKey) {
      if (!bridgeEnabled(callingDevice)) return false
      const map = grantedParents.get(callingDevice)
      if (!map) return false
      const now = Date.now()
      const checkKey = (k: string): boolean => {
        const exp = map.get(k)
        if (exp === undefined) return false
        if (exp <= now) {
          map.delete(k)
          return false
        }
        return true
      }
      if (checkKey(parentKey)) return true
      const at = parseNodeKey(parentKey)
      const masterId = currentMasterId()
      if (at && masterId && at.device === masterId) {
        return checkKey(at.key)
      }
      return false
    },

    async openForNode(callingDevice, rawBody) {
      if (!bridgeEnabled(callingDevice)) {
        return { status: 403, body: { ok: false, error: t('mokupilot.err.bridgeOff') } }
      }
      const resolved = await resolveOpenTarget(callingDevice, rawBody)
      if (resolved.kind === 'error') {
        return { status: resolved.status, body: { ok: false, error: resolved.error } }
      }
      if (resolved.kind === 'caller-local') {
        return {
          status: 200,
          body: {
            ok: true,
            locality: 'local',
            session: resolved.session,
            ...(resolved.cwd && { cwd: resolved.cwd }),
          },
        }
      }
      sweep()
      if (grantsForNode(callingDevice) >= maxGrantsPerNode) {
        return { status: 429, body: { ok: false, error: 'too many active call grants for this device' } }
      }
      const grant = mintGrant({
        target: resolved.target,
        ownerDevice: callingDevice,
        device: resolved.device,
        key: resolved.key,
        prefixedKey: resolved.prefixedKey,
        session: resolved.session,
        cwd: resolved.cwd,
        profile: resolved.profile,
        profileFolder: resolved.profileFolder,
      })
      recordCallParent(callingDevice, grant.prefixedKey)
      deps.log(
        `pilot-call: opened bridge grant ${grant.id.slice(0, 8)} for node ${callingDevice} -> ${resolved.prefixedKey}`,
      )
      return {
        status: 200,
        body: {
          ok: true,
          locality: 'remote',
          grantId: grant.id,
          device: grant.device,
          parent: grant.prefixedKey,
          session: grant.session,
          cwd: grant.cwd,
          profile: grant.profile,
        },
      }
    },

    async openLocal(rawBody) {
      if (!bridgeEnabled(LOCAL)) {
        return jsonRes(403, { ok: false, error: t('mokupilot.err.bridgeOff') })
      }
      const resolved = await resolveOpenTarget(null, rawBody)
      if (resolved.kind === 'error') {
        return jsonRes(resolved.status, { ok: false, error: resolved.error })
      }
      if (resolved.kind === 'caller-local') {
        return jsonRes(200, { ok: true, locality: 'local', session: resolved.session })
      }
      if (resolved.target.kind === 'local') {
        const set = deps.profiles?.()
        const env = deps.env ?? process.env
        const home = deps.home ?? homedir()
        const platform = deps.platform ?? process.platform
        const profItem = {
          profile: resolved.profile || resolved.foundItem?.profile || null,
          profileFolder: resolved.profileFolder,
        }
        const prof = set ? callProfileEnv(profItem, set, { env, home, platform }) : undefined
        if (set && prof === null) {
          return jsonRes(409, {
            ok: false,
            error: t('mokupilot.err.profileUnknown', { profile: profileLabel(profItem, set) }),
          })
        }
        return jsonRes(200, {
          ok: true,
          locality: 'local',
          session: resolved.session,
          cwd: resolved.cwd,
          profile: resolved.profile,
          ...(prof && { claudeConfigDir: prof.dir }),
        })
      }
      const grant = mintGrant({
        target: resolved.target,
        device: resolved.device,
        key: resolved.key,
        prefixedKey: resolved.prefixedKey,
        session: resolved.session,
        cwd: resolved.cwd,
        profile: resolved.profile,
        profileFolder: resolved.profileFolder,
      })
      const url = `http://127.0.0.1:${deps.port()}/api/mokupilot/node-call/${grant.id}`
      return jsonRes(200, {
        ok: true,
        locality: 'remote',
        url,
        token: grant.token,
        device: grant.device,
        parent: grant.prefixedKey,
        session: grant.session,
        cwd: grant.cwd,
      })
    },

    sessionsLocal() {
      if (!bridgeEnabled(LOCAL)) {
        return jsonRes(403, { ok: false, error: t('mokupilot.err.bridgeOff') })
      }
      return jsonRes(200, { ok: true, sessions: this.listSessions(), masterOnline: true })
    },

    listSessions() {
      const items = mergedItems()
      const out: PilotSessionSummary[] = []
      for (const it of items) {
        if (it.call || it.day || !callable(it)) continue
        out.push({
          key: it.key,
          session: String(it.session),
          name: it.name,
          device: it.device ?? null,
          cwd: it.cwd,
          category: it.category,
          profile: it.profile ?? null,
          status: it.status,
        })
      }
      return out
    },

    revokeForNode(callingDevice) {
      grantedParents.delete(callingDevice)
      for (const [id, grant] of [...grants.entries()]) {
        if (grant.ownerDevice !== callingDevice) continue
        grants.delete(id)
        void closeGrantRuns(grant, true)
      }
    },

    async startRun(grant, rawBody) {
      if (!isRecord(rawBody)) return jsonRes(400, { ok: false, error: 'invalid request body' })
      const fork = rawBody.fork !== false
      let session = grant.session
      if (!fork) {
        const requested = typeof rawBody.session === 'string' ? rawBody.session.trim() : ''
        if (!UUID.test(requested) || !grant.allowedSessions.has(requested.toLowerCase())) {
          return jsonRes(403, { ok: false, error: 'session not allowed for this call grant' })
        }
        session = requested
      }
      const forwarded = {
        session,
        cwd: grant.cwd,
        profile: grant.profile,
        profileFolder: grant.profileFolder,
        ...(typeof rawBody.model === 'string' && { model: rawBody.model }),
        ...(typeof rawBody.effort === 'string' && { effort: rawBody.effort }),
        fullAccess: rawBody.fullAccess === true,
        fork,
        ...(rawBody.mcp !== undefined && { mcp: rawBody.mcp }),
      }
      if (grant.target.kind === 'local') {
        if (!deps.localPilotCall) return jsonRes(500, { ok: false, error: 'local pilot-call runner unavailable' })
        const ans = await deps.localPilotCall.start(forwarded)
        const body = ans.body as { ok?: unknown; id?: unknown }
        if (ans.status === 200 && body?.ok === true && isPilotCallId(body.id)) {
          grant.runs.add(body.id)
        }
        return answerToResponse(ans)
      }
      const res = await forwardJson(grant.target.device, '/api/node/pilot-call/start', JSON.stringify(forwarded))
      const text = await res.text()
      try {
        const parsed = JSON.parse(text) as { ok?: unknown; id?: unknown }
        if (res.ok && parsed.ok === true && isPilotCallId(parsed.id)) {
          grant.runs.add(parsed.id)
        }
      } catch {}
      return new Response(text, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
      })
    },

    async events(grant, runId, req) {
      if (!grant.runs.has(runId)) return jsonRes(404, { ok: false, error: 'run not found' })
      if (grant.target.kind === 'local') {
        if (!deps.localPilotCall) return jsonRes(500, { ok: false, error: 'local pilot-call runner unavailable' })
        const res = deps.localPilotCall.events(runId, req)
        return teeInitEvents(grant, res, () => {})
      }
      const device = grant.target.device
      const r = reach(device)
      if ('error' in r) return jsonRes(r.status, { ok: false, error: r.error })
      const ac = new AbortController()
      const end = (): void => ac.abort()
      req.signal.addEventListener('abort', end, { once: true })
      const offState = r.link.onState(s => {
        if (s.state !== 'online') end()
      })
      const offLinks = deps.links.onChange(id => {
        if (id === device && deps.links.link(id) !== r.link) end()
      })
      let finished = false
      const done = (): void => {
        if (finished) return
        finished = true
        offState()
        offLinks()
        req.signal.removeEventListener('abort', end)
      }
      try {
        const res = await r.link.fetch(`/api/node/pilot-call/${runId}/events`, { method: 'GET', signal: ac.signal })
        return teeInitEvents(grant, res, () => {
          end()
          done()
        })
      } catch (err) {
        done()
        return jsonRes(503, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },

    async runPost(grant, runId, action, rawBody) {
      if (!grant.runs.has(runId)) return jsonRes(404, { ok: false, error: 'run not found' })
      const execute = async (): Promise<Response> => {
        if (grant.target.kind === 'local') {
          if (!deps.localPilotCall) return jsonRes(500, { ok: false, error: 'local pilot-call runner unavailable' })
          const parsed = parseJsonBody(rawBody)
          if (!parsed.ok) return parsed.res
          if (action === 'stdin') return answerToResponse(deps.localPilotCall.stdin(runId, parsed.value))
          if (action === 'mcp-reply') return answerToResponse(deps.localPilotCall.mcpReply(runId, parsed.value))
          return answerToResponse(deps.localPilotCall.close(runId, parsed.value))
        }
        return forwardJson(grant.target.device, `/api/node/pilot-call/${runId}/${action}`, rawBody)
      }
      if (action === 'stdin') {
        const chainKey = `${grant.id}\u0000${runId}`
        const prev = stdinChains.get(chainKey) ?? Promise.resolve()
        const run = prev.then(execute, execute)
        const tail = run.then(
          () => {},
          () => {},
        )
        stdinChains.set(chainKey, tail)
        void tail.then(() => {
          if (stdinChains.get(chainKey) === tail) stdinChains.delete(chainKey)
        })
        return run
      }
      return execute()
    },

    async uploadFiles(grant, rawBody) {
      if (grant.target.kind === 'local') {
        if (!deps.localPilotCall) return jsonRes(500, { ok: false, error: 'local pilot-call runner unavailable' })
        const parsed = parseJsonBody(rawBody)
        if (!parsed.ok) return parsed.res
        return answerToResponse(deps.localPilotCall.uploadFiles(parsed.value))
      }
      return forwardJson(grant.target.device, '/api/node/pilot-call/files', rawBody)
    },

    async deliverReport(grant, rawBody) {
      if (!isRecord(rawBody)) return jsonRes(400, { ok: false, error: 'invalid report request' })
      const forwarded = {
        session: grant.session,
        report: rawBody.report,
        ...(typeof rawBody.reportId === 'string' && { reportId: rawBody.reportId }),
      }
      if (grant.target.kind === 'local') {
        if (!deps.localPilotCall) return jsonRes(500, { ok: false, error: 'local pilot-call runner unavailable' })
        return answerToResponse(await deps.localPilotCall.deliverReport(forwarded))
      }
      return forwardJson(grant.target.device, '/api/node/pilot-call/report', JSON.stringify(forwarded))
    },

    async end(grant) {
      grants.delete(grant.id)
      await closeGrantRuns(grant, false)
      return jsonRes(200, { ok: true })
    },

    close() {
      for (const grant of [...grants.values()]) {
        void closeGrantRuns(grant, true)
      }
      grants.clear()
      grantedParents.clear()
    },
  }
}
