// Node-side handover service (#697): serves `/api/node/handover/*` on the node's master door.
// Handles preflight inspection, pre-handover local backup, receiving/unsealing/applying the
// master bundle + rekeying, live verification, commit (closing node role), rollback, and
// multi-node re-pairing/unpairing.
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { accessFile, readLogins, readPasskeys, readSecrets } from '../../adapters/access-store.ts'
import { readConfigFile, withConfigFile } from '../../adapters/config-file.ts'
import { dbFile, integrityOf } from '../../adapters/db.ts'
import {
  applyHandoverFiles,
  checkBackupReadiness,
  handoverStageDir,
  isBackupKey,
  latestHandoverBackupId,
  readHandoverState,
  restoreLocalBackup,
  type TargetBackupCheck,
  takeLocalBackup,
  unsealHandoverBundle,
  writeHandoverState,
} from '../../adapters/handover-store.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { masterName, type NodeStore } from '../../adapters/node-store.ts'
import { stateDir } from '../../adapters/paths.ts'
import { keepStream } from '../../adapters/plugin-update.ts'
import { listEntries } from '../../adapters/schedule-store.ts'
import {
  buildTargetMasterConfig,
  type HandoverVerifyCheck,
  type HandoverVerifyResult,
  MAX_HANDOVER_BUNDLE_BYTES,
} from '../../core/master-handover.ts'
import { nodeConfig, nodesConfig } from '../../core/nodes.ts'
import { teamConfig } from '../../core/team.ts'
import { timeConfig } from '../../core/time.ts'
import { type TunnelStatus, tunnelConfig } from '../../core/tunnel.ts'
import type { Config } from '../../core/types.ts'
import { threadsConfig } from '../../core/work-threads.ts'
import type { NodeLinks } from '../nodes/links.ts'
import type { TeamState } from '../team-hub.ts'
import type { Answer } from './bundle.ts'
import { freeMbUnder } from './status.ts'

const HANDOVER_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/
const SHA256_RE = /^[0-9a-f]{64}$/

export interface NodeHandoverCheckPayload {
  ok: true
  id: string
  commit: string
  platform: string
  arch: string
  hostname: string
  selfNames: string[]
  hasNodes: boolean
  freeMb: number | null
  backup: TargetBackupCheck
}

export interface NodeHandoverOptions {
  cfg: Config
  nodeStore: NodeStore
  commit: () => Promise<string>
  nodeLinks: () => NodeLinks | null
  tunnelStatus: () => TunnelStatus
  teamState: () => TeamState
  beforeDbReplace: () => Promise<void> | void
  afterDbReplace: () => Promise<void> | void
  reloadConfig: () => Promise<void>
  log: (text: string) => void
  platform?: string
  arch?: string
  hostName?: () => string
  freeMb?: (dir: string) => number | null
  now?: () => number
}

export interface NodeHandover {
  check(masterHost?: string | null): Promise<Answer>
  prepare(body: unknown): Promise<Answer>
  putBundle(id: string, sha256: string, body: ReadableStream<Uint8Array> | null): Promise<Answer>
  apply(body: unknown): Promise<Answer>
  verify(body: unknown): Promise<Answer>
  commit(body: unknown, callingMasterId?: string): Promise<Answer>
  rollback(body: unknown): Promise<Answer>
  pair(body: unknown): Promise<Answer>
  unpair(body: unknown, callingMasterId?: string): Promise<Answer>
}

function collectSelfNames(host: string, masterHost?: string | null): string[] {
  const names = new Set<string>()
  if (host) names.add(host)
  if (masterHost) names.add(masterHost)
  try {
    const ifaces = networkInterfaces()
    for (const list of Object.values(ifaces)) {
      if (!list) continue
      for (const addr of list) {
        if (addr.address) names.add(addr.address)
      }
    }
  } catch {}
  return [...names]
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createNodeHandover(o: NodeHandoverOptions): NodeHandover {
  const now = o.now ?? Date.now
  const hostFn = o.hostName ?? hostname
  const freeFn = o.freeMb ?? freeMbUnder
  let busy = false

  const withBusy = async (fn: () => Promise<Answer>): Promise<Answer> => {
    if (busy) return { status: 409, body: { ok: false, error: 'handover is busy' } }
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }

  return {
    async check(masterHost) {
      const node = nodeConfig(o.cfg.node)
      if (!node) return { status: 503, body: { ok: false, error: 'node is not configured' } }
      const host = hostFn()
      const selfNames = collectSelfNames(host, masterHost)
      const rawCfg = readConfigFile() ?? (structuredClone(o.cfg) as unknown as Record<string, unknown>)
      const backup = checkBackupReadiness(rawCfg, selfNames)
      const payload: NodeHandoverCheckPayload = {
        ok: true,
        id: node.id,
        commit: await o.commit(),
        platform: o.platform ?? process.platform,
        arch: o.arch ?? process.arch,
        hostname: host,
        selfNames,
        hasNodes: nodesConfig(o.cfg.nodes, host) !== null,
        freeMb: freeFn(stateDir()),
        backup,
      }
      return { status: 200, body: payload as unknown as Record<string, unknown> }
    },

    async prepare(body) {
      return withBusy(async () => {
        if (!isRecord(body) || typeof body.id !== 'string' || !HANDOVER_ID_RE.test(body.id)) {
          return { status: 400, body: { ok: false, error: 'invalid handover id' } }
        }
        if (typeof body.from !== 'string' || typeof body.to !== 'string') {
          return { status: 400, body: { ok: false, error: 'missing from/to device ids' } }
        }
        const node = nodeConfig(o.cfg.node)
        if (!node) return { status: 503, body: { ok: false, error: 'node is not configured' } }
        if (node.id !== body.to) {
          return { status: 409, body: { ok: false, error: `target id mismatch: expected ${node.id}, got ${body.to}` } }
        }
        if (nodesConfig(o.cfg.nodes, hostFn()) !== null) {
          return { status: 409, body: { ok: false, error: 'target already has nodes configured' } }
        }
        takeLocalBackup(body.id, now())
        writeHandoverState({
          v: 1,
          id: body.id,
          role: 'new-master',
          phase: 'prepared',
          from: body.from,
          to: body.to,
          peerId: body.from,
          otherNodes: [],
          at: now(),
        })
        o.log(`handover ${body.id}: prepared local backup on ${node.id}`)
        return { status: 200, body: { ok: true, id: body.id } }
      })
    },

    async putBundle(id, sha256, body) {
      return withBusy(async () => {
        if (!HANDOVER_ID_RE.test(id)) return { status: 400, body: { ok: false, error: 'invalid handover id' } }
        if (!SHA256_RE.test(sha256)) return { status: 400, body: { ok: false, error: 'invalid bundle sha256' } }
        const stage = handoverStageDir(id)
        mkdirSync(stage, { recursive: true, mode: 0o700 })
        const bundleFile = join(stage, 'bundle.abk')
        const kept = await keepStream(body, bundleFile, MAX_HANDOVER_BUNDLE_BYTES)
        if (!kept) return { status: 413, body: { ok: false, error: 'handover bundle exceeds size limit' } }
        if (kept.sha256 !== sha256) {
          rmSync(bundleFile, { force: true })
          return { status: 400, body: { ok: false, error: 'handover bundle sha256 mismatch' } }
        }
        return { status: 200, body: { ok: true, id, size: kept.size, sha256: kept.sha256 } }
      })
    },

    async apply(body) {
      return withBusy(async () => {
        if (
          !isRecord(body) ||
          typeof body.id !== 'string' ||
          !HANDOVER_ID_RE.test(body.id) ||
          !isBackupKey(body.key) ||
          (!isRecord(body.targetConfig) && (!isRecord(body.oldConfig) || !isRecord(body.flippedNodes)))
        ) {
          return { status: 400, body: { ok: false, error: 'invalid handover apply payload' } }
        }
        const node = nodeConfig(o.cfg.node)
        if (!node) return { status: 503, body: { ok: false, error: 'node is not configured' } }
        const bundleFile = join(handoverStageDir(body.id), 'bundle.abk')
        if (!existsSync(bundleFile)) {
          return { status: 404, body: { ok: false, error: 'staged handover bundle not found' } }
        }

        let unpacked: ReturnType<typeof unsealHandoverBundle>
        try {
          unpacked = unsealHandoverBundle(readFileSync(bundleFile), body.key)
        } catch (err) {
          return { status: 400, body: { ok: false, error: `cannot unseal handover bundle: ${msg(err)}` } }
        }

        if (unpacked.manifest.id !== body.id || unpacked.manifest.to !== node.id) {
          return { status: 409, body: { ok: false, error: 'handover bundle id or target mismatch' } }
        }

        const existingTargetCfg = readConfigFile() ?? (structuredClone(o.cfg) as unknown as Record<string, unknown>)
        const targetConfig = isRecord(body.targetConfig)
          ? structuredClone(body.targetConfig)
          : buildTargetMasterConfig(body.oldConfig as Record<string, unknown>, existingTargetCfg, {
              flippedNodes: body.flippedNodes as Record<string, unknown>,
              keepTargetNode: true,
              normalizeTunnelKey: body.normalizeTunnelKey === true,
              carryBackupServer: body.carryBackupServer === true,
            })
        await o.beforeDbReplace()
        let applied: Awaited<ReturnType<typeof applyHandoverFiles>>
        try {
          applied = await applyHandoverFiles(body.id, unpacked.manifest, unpacked.bodies, {
            keepTargetBackupKey: body.keepTargetBackupKey === true,
          })
          withConfigFile((_, save) => save(targetConfig))
          const otherNodes = unpacked.manifest.credentials.map(c => c.id).filter(id => id !== unpacked.manifest.from)
          writeHandoverState({
            v: 1,
            id: body.id,
            role: 'new-master',
            phase: 'applied',
            from: unpacked.manifest.from,
            to: unpacked.manifest.to,
            peerId: unpacked.manifest.from,
            otherNodes,
            at: now(),
          })
        } finally {
          await o.afterDbReplace()
        }

        await o.reloadConfig()
        o.log(`handover ${body.id}: applied master state and config on ${node.id}`)
        return {
          status: 200,
          body: {
            ok: true,
            id: body.id,
            rekeyTotal: applied.rekeyTotal,
            journalRekeyed: applied.journalRekeyed,
          },
        }
      })
    },

    async verify(body) {
      const b = isRecord(body) ? body : {}
      const expectedNodes = Array.isArray(b.expectedNodes)
        ? b.expectedNodes.filter((x): x is string => typeof x === 'string')
        : []
      const checks: HandoverVerifyCheck[] = []

      // 1. Nodes linked
      const links = o.nodeLinks()
      if (!links?.on()) {
        checks.push({ name: 'nodes', ok: false, detail: 'master node links are not active' })
      } else {
        const missing: string[] = []
        const notOnline: string[] = []
        for (const id of expectedNodes) {
          const link = links.link(id)
          if (!link) missing.push(id)
          else if (link.state().state !== 'online') notOnline.push(`${id} (${link.state().state})`)
        }
        if (missing.length || notOnline.length) {
          const parts: string[] = []
          if (missing.length) parts.push(`missing: ${missing.join(', ')}`)
          if (notOnline.length) parts.push(`not online: ${notOnline.join(', ')}`)
          checks.push({ name: 'nodes', ok: false, detail: parts.join('; ') })
        } else {
          checks.push({
            name: 'nodes',
            ok: true,
            detail: expectedNodes.length ? `${expectedNodes.length} node(s) online` : 'master links active',
          })
        }
      }

      // 2. Tunnel
      const tCfg = tunnelConfig(o.cfg.tunnel)
      if (!tCfg.on) {
        checks.push({ name: 'tunnel', ok: true, skipped: true, detail: 'tunnel is off' })
      } else {
        const ts = o.tunnelStatus()
        checks.push({
          name: 'tunnel',
          ok: ts.state === 'connected',
          detail:
            ts.state === 'connected'
              ? 'tunnel connected'
              : `tunnel state is ${ts.state}${ts.error ? `: ${ts.error}` : ''}`,
        })
      }

      // 3. Team
      if (teamConfig(o.cfg.team) === null) {
        checks.push({ name: 'team', ok: true, skipped: true, detail: 'team is off' })
      } else {
        const state = o.teamState()
        checks.push({
          name: 'team',
          ok: state === 'online',
          detail: state === 'online' ? 'team connected' : `team state is ${state}`,
        })
      }

      // 4. Threads & Time in board.db
      const dbExists = existsSync(dbFile())
      const threadsOn = threadsConfig(o.cfg.threads) !== null
      const timeOn = timeConfig(o.cfg.time) !== null
      if (!dbExists) {
        checks.push({
          name: 'threads',
          ok: !threadsOn,
          skipped: !threadsOn,
          detail: threadsOn ? 'board.db missing' : 'no board.db',
        })
        checks.push({
          name: 'time',
          ok: !timeOn,
          skipped: !timeOn,
          detail: timeOn ? 'board.db missing' : 'no board.db',
        })
      } else {
        const whole = integrityOf(dbFile())
        if (!whole.ok) {
          checks.push({ name: 'threads', ok: false, detail: `board.db damaged: ${whole.detail}` })
          checks.push({ name: 'time', ok: false, detail: `board.db damaged: ${whole.detail}` })
        } else {
          let sql: Database | null = null
          try {
            sql = new Database(dbFile(), { readonly: true, strict: true })
            try {
              const row = sql.query('SELECT count(*) AS n FROM threads').get() as { n: number }
              checks.push({ name: 'threads', ok: true, detail: `${row.n} thread(s) readable` })
            } catch (err) {
              checks.push({ name: 'threads', ok: false, detail: `threads unreadable: ${msg(err)}` })
            }
            try {
              const row = sql.query('SELECT count(*) AS n FROM time_entries').get() as { n: number }
              checks.push({ name: 'time', ok: true, detail: `${row.n} time entry(s) readable` })
            } catch (err) {
              checks.push({ name: 'time', ok: false, detail: `time unreadable: ${msg(err)}` })
            }
          } catch (err) {
            checks.push({ name: 'threads', ok: false, detail: msg(err) })
            checks.push({ name: 'time', ok: false, detail: msg(err) })
          } finally {
            sql?.close(false)
          }
        }
      }

      // 5. Access store
      if (!existsSync(accessFile())) {
        checks.push({ name: 'access', ok: true, skipped: true, detail: 'access not configured' })
      } else {
        try {
          const secrets = readSecrets()
          const logins = readLogins()
          const passkeys = readPasskeys()
          const ready = secrets.passwordHash !== null || passkeys.length > 0
          checks.push({
            name: 'access',
            ok: ready,
            detail: ready
              ? `access readable (${logins.length} login(s), ${passkeys.length} passkey(s))`
              : 'access.json has no password or passkey',
          })
        } catch (err) {
          checks.push({ name: 'access', ok: false, detail: `access unreadable: ${msg(err)}` })
        }
      }

      // 6. Schedule
      try {
        const entries = listEntries()
        checks.push({ name: 'schedule', ok: true, detail: `${entries.length} schedule entry(s) readable` })
      } catch (err) {
        checks.push({ name: 'schedule', ok: false, detail: `schedule unreadable: ${msg(err)}` })
      }

      const result: HandoverVerifyResult = {
        ok: checks.every(c => c.ok),
        checks,
      }
      return { status: 200, body: result as unknown as Record<string, unknown> }
    },

    async commit(body, callingMasterId) {
      return withBusy(async () => {
        if (!isRecord(body) || typeof body.id !== 'string' || !HANDOVER_ID_RE.test(body.id)) {
          return { status: 400, body: { ok: false, error: 'invalid handover id' } }
        }
        const raw = readConfigFile()
        if (!raw) return { status: 500, body: { ok: false, error: 'config.json unreadable' } }
        const next = { ...raw }
        delete next.node
        withConfigFile((_, save) => save(next))

        const prev = readHandoverState()
        if (prev && prev.id === body.id) {
          writeHandoverState({ ...prev, phase: 'committed', at: now() })
        }
        rmSync(handoverStageDir(body.id), { recursive: true, force: true })
        if (callingMasterId) {
          try {
            o.nodeStore.forget(callingMasterId)
          } catch {}
        }
        o.log(`handover ${body.id}: committed master role`)
        // Defer reload so the HTTP 200 response completes before the node door stops listening.
        setTimeout(() => void o.reloadConfig().catch(() => {}), 100)
        return { status: 200, body: { ok: true, id: body.id } }
      })
    },

    async rollback(body) {
      return withBusy(async () => {
        const b = isRecord(body) ? body : {}
        const id = typeof b.id === 'string' && HANDOVER_ID_RE.test(b.id) ? b.id : latestHandoverBackupId()
        if (!id) return { status: 404, body: { ok: false, error: 'no handover backup found' } }
        await o.beforeDbReplace()
        let result: { restored: number; removed: number }
        try {
          result = await restoreLocalBackup(id)
          rmSync(handoverStageDir(id), { recursive: true, force: true })
          const prev = readHandoverState()
          if (prev && prev.id === id) {
            writeHandoverState({ ...prev, phase: 'rolled-back', at: now() })
          }
        } finally {
          await o.afterDbReplace()
        }
        o.log(`handover ${id}: rolled back local state (${result.restored} restored, ${result.removed} removed)`)
        if (b.deferRefresh === true) {
          setTimeout(() => void o.reloadConfig().catch(() => {}), 100)
        } else {
          await o.reloadConfig()
        }
        return { status: 200, body: { ok: true, id, ...result } }
      })
    },

    async pair(body) {
      return withBusy(async () => {
        if (!isRecord(body) || typeof body.id !== 'string' || !HANDOVER_ID_RE.test(body.id)) {
          return { status: 400, body: { ok: false, error: 'invalid handover id' } }
        }
        const name = masterName(body.masterName)
        if (!name) return { status: 400, body: { ok: false, error: 'invalid masterName' } }
        if (!nodeConfig(o.cfg.node)) return { status: 503, body: { ok: false, error: 'node is not configured' } }
        takeLocalBackup(body.id, now())
        const added = o.nodeStore.add(name, 'hand')
        o.log(`handover ${body.id}: paired new master ${name} (${added.master.id})`)
        return { status: 200, body: { ok: true, masterId: added.master.id, token: added.token } }
      })
    },

    async unpair(body, callingMasterId) {
      return withBusy(async () => {
        const b = isRecord(body) ? body : {}
        const targetId = b.self === true ? callingMasterId : typeof b.masterId === 'string' ? b.masterId : ''
        if (!targetId) return { status: 400, body: { ok: false, error: 'missing masterId' } }
        const forgotten = o.nodeStore.forget(targetId)
        return { status: 200, body: { ok: true, forgotten } }
      })
    },
  }
}
