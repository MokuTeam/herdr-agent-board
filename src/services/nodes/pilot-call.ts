// Master-side bridge for MokuPilot calls with sessions running on a remote node (#618).
//
// When the owner clicks Call on a node card (@<device>:<key>), the master checks that the node is
// online and supports pilot-call, mints a scoped per-call capability grant bound strictly to that
// device and session, and launches local MokuPilot with MOKUPILOT_NODE_CALL_URL and
// MOKUPILOT_NODE_CALL_TOKEN in its environment. MokuPilot talks to the master's loopback bridge
// (/api/mokupilot/node-call/<grantId>/...), which forwards requests to the node's door over the
// existing node link. Only created once config.json has `nodes`.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isRecord } from '../../adapters/json-store.ts'
import { knobMs } from '../../adapters/pacing.ts'
import { t } from '../../core/lang.ts'
import { callable } from '../../core/mokupilot.ts'
import { mokupilotMode, resolveMode, type Viewer } from '../../core/mokupilot-mode.ts'
import { nodesConfig, parseNodeKey } from '../../core/nodes.ts'
import { isPilotCallId, UUID } from '../../core/pilot-call.ts'
import type { Config, Item } from '../../core/types.ts'
import { type CallResult, startCall } from '../mokupilot.ts'
import { ownAddresses } from '../tunnel.ts'
import type { Link } from './link.ts'
import type { NodeLinks } from './links.ts'

export interface NodePilotCallGrant {
  id: string
  token: string
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
  /** Validate grant id + Bearer token (timing-safe). */
  authorize(grantId: string, authHeader: string | null): NodePilotCallGrant | null
  /** Forward `POST /start` to the node's door, scoped to the grant's session/cwd/profile. */
  startRun(grant: NodePilotCallGrant, rawBody: unknown): Promise<Response>
  /** Forward `GET /runs/:runId/events` SSE stream from the node, recording fork session IDs. */
  events(grant: NodePilotCallGrant, runId: string, req: Request): Promise<Response>
  /** Forward `POST /runs/:runId/(stdin|mcp-reply|close)` to the node. */
  runPost(
    grant: NodePilotCallGrant,
    runId: string,
    action: 'stdin' | 'mcp-reply' | 'close',
    rawBody: string,
  ): Promise<Response>
  /** Forward `POST /files` to upload post-call files to the node. */
  uploadFiles(grant: NodePilotCallGrant, rawBody: string): Promise<Response>
  /** Forward `POST /report` to queue a post-call report for the grant's origin session on the node. */
  deliverReport(grant: NodePilotCallGrant, rawBody: unknown): Promise<Response>
  /** End and revoke a grant, closing any active runs on the node. */
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
  /** Grant TTL in ms (default 6 hours). */
  grantTtlMs?: number
  /** Probe timeout in ms (default 5 s). */
  checkTimeoutMs?: number
}

const CHECK_TIMEOUT_MS = 5000
const DEFAULT_GRANT_TTL_MS = 6 * 3600 * 1000
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

export function createNodePilotCalls(deps: NodePilotCallsDeps): NodePilotCalls {
  const grants = new Map<string, NodePilotCallGrant>()
  const own = deps.own ?? ownAddresses
  const launch = deps.launch ?? startCall
  const grantTtlMs = deps.grantTtlMs ?? knobMs('BOARD_PILOT_GRANT_TTL_MS', DEFAULT_GRANT_TTL_MS)
  const checkTimeoutMs = deps.checkTimeoutMs ?? knobMs('BOARD_PILOT_CHECK_MS', CHECK_TIMEOUT_MS)

  function sweep(): void {
    const now = Date.now()
    for (const [id, g] of grants) if (g.expiresAt <= now) grants.delete(id)
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
      if (decided.resolved === 'link') {
        return { ok: false, error: t('mokupilot.err.nodeLink'), ...where }
      }

      const r = reach(device)
      if ('error' in r) return { ok: false, error: r.error, ...where }

      const session = String(item.session)
      let checkData: { cwd: string; profile: string }
      try {
        const res = await r.link.fetch('/api/node/pilot-call/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session,
            cwd: item.cwd || '',
            profile: item.profile || '',
            profileFolder: item.profileFolder || '',
          }),
          signal: AbortSignal.timeout(checkTimeoutMs),
        })
        if (res.status === 404) {
          await res.body?.cancel()
          return { ok: false, error: t('mokupilot.err.nodeOld', { device }), ...where }
        }
        const ans = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (!res.ok || !ans || ans.ok !== true || typeof ans.cwd !== 'string' || !ans.cwd) {
          const why = typeof ans?.error === 'string' && ans.error ? ans.error : `HTTP ${res.status}`
          return { ok: false, error: t('mokupilot.err.nodeCheck', { device, why }), ...where }
        }
        checkData = { cwd: ans.cwd, profile: typeof ans.profile === 'string' ? ans.profile : item.profile || '' }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        return { ok: false, error: t('mokupilot.err.nodeCheck', { device, why }), ...where }
      }

      sweep()
      const grantId = randomBytes(16).toString('base64url')
      const token = randomBytes(32).toString('base64url')
      const grant: NodePilotCallGrant = {
        id: grantId,
        token,
        device,
        key: at.key,
        prefixedKey: item.key,
        session,
        cwd: checkData.cwd,
        profile: checkData.profile,
        profileFolder: item.profileFolder || '',
        // Only fork UUIDs observed in system.init may be resumed in-place (never the live origin session).
        allowedSessions: new Set(),
        runs: new Set(),
        expiresAt: Date.now() + grantTtlMs,
      }
      grants.set(grantId, grant)

      const url = `http://127.0.0.1:${deps.port()}/api/mokupilot/node-call/${grantId}`
      const started = await launch(deps.cfg, item, {
        viewer,
        own,
        nodeCall: {
          url,
          token,
          device,
          parent: item.key,
          cwd: checkData.cwd,
        },
      })
      if (!started.ok) {
        grants.delete(grantId)
        return started
      }
      deps.log(`pilot-call: launched MokuPilot for ${item.key} via grant ${grantId.slice(0, 8)}`)
      return started
    },

    authorize(grantId, authHeader) {
      if (!isPilotCallId(grantId)) return null
      sweep()
      const grant = grants.get(grantId)
      if (!grant) return null
      const m = /^Bearer\s+(\S+)$/i.exec((authHeader ?? '').trim())
      if (!m || !safeEqual(m[1] ?? '', grant.token)) return null
      return grant
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
      const res = await forwardJson(grant.device, '/api/node/pilot-call/start', JSON.stringify(forwarded))
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
      const r = reach(grant.device)
      if ('error' in r) return jsonRes(r.status, { ok: false, error: r.error })
      const ac = new AbortController()
      const end = (): void => ac.abort()
      req.signal.addEventListener('abort', end, { once: true })
      const offState = r.link.onState(s => {
        if (s.state !== 'online') end()
      })
      const offLinks = deps.links.onChange(id => {
        if (id === grant.device && deps.links.link(id) !== r.link) end()
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
            end()
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
      } catch (err) {
        done()
        return jsonRes(503, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },

    async runPost(grant, runId, action, rawBody) {
      if (!grant.runs.has(runId)) return jsonRes(404, { ok: false, error: 'run not found' })
      return forwardJson(grant.device, `/api/node/pilot-call/${runId}/${action}`, rawBody)
    },

    async uploadFiles(grant, rawBody) {
      return forwardJson(grant.device, '/api/node/pilot-call/files', rawBody)
    },

    async deliverReport(grant, rawBody) {
      if (!isRecord(rawBody)) return jsonRes(400, { ok: false, error: 'invalid report request' })
      const forwarded = {
        session: grant.session,
        report: rawBody.report,
        ...(typeof rawBody.reportId === 'string' && { reportId: rawBody.reportId }),
      }
      return forwardJson(grant.device, '/api/node/pilot-call/report', JSON.stringify(forwarded))
    },

    async end(grant) {
      grants.delete(grant.id)
      const closes = [...grant.runs].map(runId =>
        forwardJson(grant.device, `/api/node/pilot-call/${runId}/close`, JSON.stringify({ kill: false })).catch(
          () => null,
        ),
      )
      await Promise.all(closes)
      return jsonRes(200, { ok: true })
    },

    close() {
      for (const grant of [...grants.values()]) {
        for (const runId of grant.runs) {
          void forwardJson(grant.device, `/api/node/pilot-call/${runId}/close`, JSON.stringify({ kill: true })).catch(
            () => null,
          )
        }
      }
      grants.clear()
    },
  }
}
