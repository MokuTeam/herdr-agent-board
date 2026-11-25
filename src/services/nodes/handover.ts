// Master-side guided handover service (#697): preflight checks, dry-run planning,
// freezing and backing up the old master, shipping encrypted state over the existing link,
// pairing reverse/peer links, verifying the new master, committing, and two-device rollback.

import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dropKey } from '../../adapters/backup-store.ts'
import { readConfigFile, withConfigFile } from '../../adapters/config-file.ts'
import { dbFile } from '../../adapters/db.ts'
import { ensureDoorCert } from '../../adapters/door-cert.ts'
import {
  collectMasterState,
  latestHandoverBackupId,
  makeEphemeralKey,
  readHandoverState,
  readMasterBackupKey,
  restoreLocalBackup,
  retireShippedOldMasterState,
  sealHandoverBundle,
  sha256Hex,
  type TargetBackupCheck,
  takeLocalBackup,
  writeHandoverState,
} from '../../adapters/handover-store.ts'
import { isRecord } from '../../adapters/json-store.ts'
import {
  createDeviceStore,
  createNodeStore,
  type DeviceStore,
  nodeRelayKeyPath,
  nodeRelayKnownHostsReady,
  relayKeyPath,
} from '../../adapters/node-store.ts'
import { knobMs, pace, pause } from '../../adapters/pacing.ts'
import { nodeDir } from '../../adapters/paths.ts'
import { generateKey, knownHostsFile } from '../../adapters/ssh.ts'
import { activeTargets, backupConfig } from '../../core/backup.ts'
import {
  buildOldMasterNodeConfig,
  buildOldMasterRelayNodeConfig,
  collectDirectProbeAddresses,
  flipNodesConfig,
  formatDirectHttpsUrl,
  HANDOVER_DISK_MULTIPLIER,
  HANDOVER_VERSION,
  type HandoverCheckItem,
  type HandoverCredential,
  type HandoverManifest,
  type HandoverPhase,
  type HandoverPlan,
  type HandoverStateRecord,
  type HandoverStep,
  type HandoverVerifyResult,
  type HandoverView,
  isBackupTargetSelf,
  MAX_HANDOVER_BUNDLE_BYTES,
  MIN_HANDOVER_FREE_MB,
  parseReverseLinkSpec,
  relayTargetEndpoint,
} from '../../core/master-handover.ts'

import { LOCAL } from '../../core/node-key.ts'
import { type LinkConfig, NODE_PORT, nodeConfig, nodesConfig } from '../../core/nodes.ts'
import { RELAY_MASTER_USER, relaySocketStem } from '../../core/relay-texts.ts'
import type { Config } from '../../core/types.ts'
import { backupNow } from '../backup.ts'
import { rekeyBoard } from '../db-rekey.ts'
import { type LocalRelayAnswer, pinKnownHostKeys } from '../node/handover.ts'
import { ownAddresses as systemOwnAddresses } from '../tunnel.ts'
import type { Link } from './link.ts'
import type { NodeLinks } from './links.ts'
import { relayEnrolFor } from './relay.ts'

export interface MasterHandoverCheckOpts {
  to: string
  reverseLink?: string
  nodePort?: number
  allowOfflineNodes?: boolean
  sudoPassword?: string
}

export interface MasterHandoverRunResult {
  ok: boolean
  id?: string
  from?: string
  to?: string
  rolledBack?: boolean
  error?: string
  need?: 'sudoPassword'
  plan?: HandoverPlan
  verify?: HandoverVerifyResult | null
}

export interface MasterHandoverRollbackOpts {
  id?: string
  localOnly?: boolean
  discardSinceCommit?: boolean
  sudoPassword?: string
}

export interface MasterHandoverRollbackResult {
  ok: boolean
  id?: string
  error?: string
  need?: 'sudoPassword'
  restored?: number
  removed?: number
}

export interface MasterHandoverOptions {
  cfg: Config
  links: () => Pick<NodeLinks, 'on' | 'link' | 'view'> | null
  commit: () => Promise<string>
  setFreeze: (frozen: boolean) => void
  beforeDbReplace: () => Promise<void> | void
  afterDbReplace: () => Promise<void> | void
  reloadConfig: () => Promise<void>
  log: (text: string) => void
  store?: DeviceStore
  hostName?: () => string
  now?: () => number
  ownAddresses?: () => string[]
  /** Override direct-reachability check from target to old master (tests). */
  probeDirect?: (opts: {
    targetLink: Pick<Link, 'fetch'>
    addresses: string[]
    doorCert: { cert: string; key: string }
    nodePort: number
  }) => Promise<{ ok: true; host: string; url: string } | { ok: false }>
  /** Pre-check local relay sudo readiness on committed new-master rollback. */
  checkLocalRelay?: (opts: { host: string; sshPort: number; sudoPassword?: string }) => Promise<LocalRelayAnswer>
  /** Override local relay undo on committed/localOnly rollback (tests). */
  undoLocalRelay?: (opts: { host: string; sshPort: number; sudoPassword?: string }) => Promise<LocalRelayAnswer>
  generateKey?: (
    comment: string,
    path: string,
  ) => Promise<{ ok: true; publicKey: string } | { ok: false; error: string }>
  enrolAdd?: (
    relay: { host: string; sshPort: number; user: string },
    socket: string,
    publicKey: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  enrolRemove?: (
    relay: { host: string; sshPort: number; user: string },
    socket: string,
  ) => Promise<{ ok: true; removed: boolean } | { ok: false; error: string }>
  verifyTimeoutMs?: number
  verifyPollMs?: number
}

export interface MasterHandover {
  view(): HandoverView
  check(opts: MasterHandoverCheckOpts): Promise<HandoverPlan>
  run(opts: MasterHandoverCheckOpts): Promise<MasterHandoverRunResult>
  rollback(opts?: MasterHandoverRollbackOpts): Promise<MasterHandoverRollbackResult>
  cancel(): HandoverView
}

interface TargetCheckResponse {
  ok: boolean
  id: string
  commit: string
  platform: string
  arch: string
  hostname: string
  selfNames: string[]
  hasNodes: boolean
  freeMb: number | null
  backup: TargetBackupCheck
  handoverState?: HandoverStateRecord | null
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const stampId = (at: number): string => {
  const iso = new Date(at).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `ho-${iso}-${randomBytes(2).toString('hex')}`
}

async function fetchJson<T>(
  link: Pick<Link, 'fetch'>,
  path: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string; need?: string }> {
  let res: Response
  try {
    res = await link.fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    return { ok: false, status: 503, error: msg(err) }
  }
  const data = (await res.json().catch(() => null)) as T | null
  if (!res.ok) {
    const errText = isRecord(data) && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
    const need = isRecord(data) && typeof data.need === 'string' ? data.need : undefined
    return { ok: false, status: res.status, error: errText, ...(need && { need }) }
  }
  if (!data) return { ok: false, status: res.status, error: 'empty response' }
  return { ok: true, status: res.status, data }
}

async function defaultProbeDirect(opts: {
  targetLink: Pick<Link, 'fetch'>
  addresses: string[]
  doorCert: { cert: string; key: string }
  nodePort: number
}): Promise<{ ok: true; host: string; url: string } | { ok: false }> {
  if (opts.addresses.length === 0) return { ok: false }
  const nonce = randomBytes(16).toString('hex')
  let srv: ReturnType<typeof Bun.serve> | null = null
  try {
    srv = Bun.serve({
      hostname: '0.0.0.0',
      port: 0,
      idleTimeout: 0,
      development: false,
      tls: { cert: opts.doorCert.cert, key: opts.doorCert.key },
      fetch(req) {
        try {
          const u = new URL(req.url)
          if (req.method === 'GET' && u.pathname === '/probe' && req.headers.get('x-probe-nonce') === nonce) {
            return Response.json({ ok: true, nonce })
          }
        } catch {}
        return Response.json({ ok: false }, { status: 404 })
      },
    })
    const probePort = srv.port
    if (!probePort) return { ok: false }
    const urls = opts.addresses.map(ip => formatDirectHttpsUrl(ip, probePort))
    const r = await fetchJson<{ ok: boolean; host?: string }>(
      opts.targetLink,
      '/api/node/handover/probe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls, nonce, cert: opts.doorCert.cert }),
      },
      15_000,
    )
    if (r.ok && r.data.ok && r.data.host) {
      return { ok: true, host: r.data.host, url: formatDirectHttpsUrl(r.data.host, opts.nodePort) }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  } finally {
    await srv?.stop(true).catch(() => {})
  }
}

const isLoopbackDirectLink = (link: LinkConfig | null | undefined): boolean => {
  if (link?.kind !== 'direct') return false
  try {
    const h = new URL(link.url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return h === '127.0.0.1' || h === 'localhost' || h === '::1'
  } catch {
    return false
  }
}

function canRollbackState(state: HandoverStateRecord | null): { can: boolean; reason?: string } {
  if (!state) {
    const latest = latestHandoverBackupId()
    return latest ? { can: true } : { can: false, reason: 'no handover backup recorded' }
  }
  if (state.phase === 'rolled-back') return { can: false, reason: 'already rolled back' }
  if (state.role === 'old-master' && state.phase === 'committed') {
    return {
      can: false,
      reason: `this device is now a node of ${state.peerId}; run rollback on ${state.peerId} or pass --local-only`,
    }
  }
  return { can: true }
}

export function createMasterHandover(o: MasterHandoverOptions): MasterHandover {
  const store = o.store ?? createDeviceStore()
  const hostFn = o.hostName ?? hostname
  const now = o.now ?? Date.now
  const genKey = o.generateKey ?? generateKey
  const enrolAdd = o.enrolAdd ?? ((relay, socket, pub) => relayEnrolFor(relay, { store }).add(socket, pub))
  const enrolRemove = o.enrolRemove ?? ((relay, socket) => relayEnrolFor(relay, { store }).remove(socket))

  let phase: HandoverPhase = 'idle'
  let step: HandoverStep | null = null
  let currentId: string | null = null
  let currentTarget: string | null = null
  let lastPlan: HandoverPlan | null = null
  let lastVerify: HandoverVerifyResult | null = null
  let lastError: string | null = null
  let lastNeed: 'sudoPassword' | undefined
  let rolledBack = false
  let busy = false

  function currentView(): HandoverView {
    const state = readHandoverState()
    const rb = canRollbackState(state)
    return {
      phase,
      step,
      id: currentId,
      target: currentTarget,
      plan: lastPlan,
      verify: lastVerify,
      error: lastError,
      rolledBack,
      canRollback: rb.can,
      rollbackNeedsConfirm: state?.role === 'new-master' && state.phase === 'committed',
      ...(rb.reason && { rollbackReason: rb.reason }),
      ...(lastNeed && { need: lastNeed }),
      state,
    }
  }

  function linkFor(id: string): Pick<Link, 'fetch' | 'state'> | null {
    return o.links()?.link(id) ?? null
  }

  async function inspect(opts: MasterHandoverCheckOpts): Promise<{
    plan: HandoverPlan
    carryBackupKey: boolean
  }> {
    lastNeed = undefined
    const host = hostFn()
    const nCfg = nodesConfig(o.cfg.nodes, host)
    const rawCfg = readConfigFile() ?? (structuredClone(o.cfg) as unknown as Record<string, unknown>)
    const checks: HandoverCheckItem[] = []
    const errors: string[] = []
    const warnings: string[] = []
    const failCheck = (id: HandoverCheckItem['id'], detail: string, blocking = true): void => {
      checks.push({ id, ok: false, detail, blocking })
      if (blocking) errors.push(detail)
      else warnings.push(detail)
    }
    const passCheck = (id: HandoverCheckItem['id'], detail: string): void => {
      checks.push({ id, ok: true, detail, blocking: true })
    }

    if (!nCfg) {
      failCheck('master', 'this board is not a master (nodes is not configured)')
      return {
        carryBackupKey: false,
        plan: {
          ok: false,
          from: host,
          to: opts.to,
          targetTitle: opts.to,
          commit: '',
          reverseLink: null,
          checks,
          items: [],
          totalFiles: 0,
          totalBytes: 0,
          requiredFreeMb: MIN_HANDOVER_FREE_MB,
          targetFreeMb: null,
          rekey: { dbChanges: 0, scheduleEntries: 0, watchEntries: 0, ownerWatchSessions: 0 },
          otherNodes: [],
          carryBackupServer: false,
          normalizeTunnelKey: false,
          errors,
          warnings,
        },
      }
    }
    passCheck('master', `master id ${nCfg.id}`)

    const targetId = opts.to
    const targetDev = nCfg.devices[targetId]
    const targetTitle = targetDev?.title || targetId
    const ownCommit = await o.commit()

    if (!targetDev || targetId === LOCAL || !targetDev.link) {
      failCheck('target', `${targetId} is not a remote node of this master`)
    } else if (targetDev.revoked) {
      failCheck('target', `${targetId} is revoked`)
    } else {
      passCheck('target', `node ${targetId} (${targetDev.link.kind})`)
    }

    const link = targetDev?.link && !targetDev.revoked ? linkFor(targetId) : null
    const linkOnline = link?.state().state === 'online'
    if (targetDev?.link && !targetDev.revoked) {
      if (!linkOnline) failCheck('online', `${targetId} is ${link?.state().state ?? 'disconnected'} (must be online)`)
      else passCheck('online', `${targetId} is online`)
    }

    let targetCheck: TargetCheckResponse | null = null
    const targetLinkCfg = targetDev?.link
    if (link && linkOnline && targetLinkCfg) {
      const masterHost =
        targetLinkCfg.kind === 'ssh'
          ? targetLinkCfg.host
          : targetLinkCfg.kind === 'direct'
            ? (() => {
                try {
                  return new URL(targetLinkCfg.url).hostname
                } catch {
                  return ''
                }
              })()
            : ''
      const q = masterHost ? `?masterHost=${encodeURIComponent(masterHost)}` : ''
      const r = await fetchJson<TargetCheckResponse>(link, `/api/node/handover/check${q}`, { method: 'GET' }, 15_000)
      if (!r.ok) {
        failCheck(
          'commit',
          r.status === 404
            ? `${targetId} runs an older board without handover support: update it first`
            : `cannot inspect ${targetId}: ${r.error}`,
        )
      } else {
        targetCheck = r.data
      }
    }

    // Commit match check
    if (targetCheck) {
      if (!ownCommit || !targetCheck.commit) {
        failCheck(
          'commit',
          `cannot verify commit parity (master=${ownCommit || 'unknown'}, target=${targetCheck.commit || 'unknown'})`,
        )
      } else if (ownCommit !== targetCheck.commit) {
        failCheck(
          'commit',
          `commit mismatch: master=${ownCommit.slice(0, 8)}, ${targetId}=${targetCheck.commit.slice(0, 8)} (update ${targetId} first)`,
        )
      } else {
        passCheck('commit', `same commit ${ownCommit.slice(0, 8)}`)
      }

      // Target role check
      if (targetCheck.hasNodes) {
        failCheck('targetRole', `${targetId} already has nodes configured`)
      } else {
        passCheck('targetRole', `${targetId} is a node ready to take over`)
      }
    }

    // Backup check
    let carryBackupServer = false
    let carryBackupKey = false
    if (targetCheck) {
      const tb = targetCheck.backup
      if (tb.selfConflict) {
        failCheck('backup', `target backup server (${tb.selfConflict}) points to ${targetId} itself`)
      } else if (tb.ok) {
        passCheck('backup', `target backup ready (${tb.detail})`)
      } else if (tb.target === null) {
        const masterBackup = backupConfig(rawCfg.backup)
        const masterHasDropKey = existsSync(dropKey()) || readMasterBackupKey() !== null
        if (
          masterBackup.server?.set &&
          masterHasDropKey &&
          !isBackupTargetSelf(masterBackup.server.host, targetCheck.selfNames)
        ) {
          carryBackupServer = true
          carryBackupKey = !tb.hasKey && readMasterBackupKey() !== null
          passCheck(
            'backup',
            `will carry server backup target ${masterBackup.server.host}:${masterBackup.server.port} from master`,
          )
        } else {
          failCheck('backup', `${targetId} has no working backup target (${tb.detail})`)
        }
      } else {
        failCheck('backup', `${targetId} backup not ready: ${tb.detail}`)
      }
    }

    // Collect dry inventory & rekey estimate
    const collected = collectMasterState(rawCfg, targetId, {
      pack: false,
      carryBackupKey: carryBackupKey || !targetCheck?.backup.hasKey,
      carryBackupServer,
    })

    let rekeyInfo = { dbChanges: 0, scheduleEntries: 0, watchEntries: 0, ownerWatchSessions: 0 }
    try {
      const report = rekeyBoard({ from: nCfg.id, to: targetId, dryRun: true })
      rekeyInfo = {
        dbChanges: report.db.total,
        scheduleEntries: report.schedule.entries.length,
        watchEntries: report.schedule.watches.length,
        ownerWatchSessions: report.ownerWatch.sessions,
      }
    } catch (err) {
      failCheck('master', `cannot plan database rekey: ${msg(err)}`)
    }

    if (collected.totalBytes > MAX_HANDOVER_BUNDLE_BYTES) {
      failCheck(
        'disk',
        `bundle payload ${Math.ceil(collected.totalBytes / (1024 * 1024))} MB exceeds ${MAX_HANDOVER_BUNDLE_BYTES / (1024 * 1024)} MB transfer limit`,
      )
    } else if (collected.totalBytes > 50 * 1024 * 1024) {
      warnings.push(
        `large handover payload (${Math.ceil(collected.totalBytes / (1024 * 1024))} MB); shipping over SSH/relay may take several minutes`,
      )
    }

    const requiredFreeMb = Math.max(
      MIN_HANDOVER_FREE_MB,
      Math.ceil((collected.totalBytes * HANDOVER_DISK_MULTIPLIER) / (1024 * 1024)),
    )
    if (targetCheck) {
      if (targetCheck.freeMb === null) {
        failCheck('disk', `cannot determine free disk space on ${targetId}`)
      } else if (targetCheck.freeMb < requiredFreeMb) {
        failCheck(
          'disk',
          `not enough disk on ${targetId}: ${targetCheck.freeMb} MB free, ${requiredFreeMb} MB required`,
        )
      } else {
        passCheck('disk', `${targetCheck.freeMb} MB free on ${targetId} (${requiredFreeMb} MB needed)`)
      }
    }

    // Reverse link check
    const existingNode = nodeConfig(rawCfg.node)
    let reverseLink: LinkConfig | null = null
    let relaySetup: HandoverPlan['relaySetup']

    if (opts.reverseLink || isLoopbackDirectLink(targetDev?.link) || nCfg.relay !== null) {
      const rev = parseReverseLinkSpec({
        spec: opts.reverseLink ?? null,
        oldMasterId: nCfg.id,
        oldMasterNodePort: opts.nodePort ?? existingNode?.port ?? NODE_PORT,
        existingSocket: existingNode?.relay?.socket ?? null,
        targetLink: targetDev?.link ?? null,
        hasRelay: nCfg.relay !== null,
      })
      if (!rev.ok) {
        failCheck('reverseLink', rev.error)
      } else {
        reverseLink = rev.link
        if (reverseLink.kind === 'relay') {
          const hasMasterRelay = existsSync(relayKeyPath('master')) && existsSync(relayKeyPath('enrol'))
          if (!hasMasterRelay) {
            failCheck('reverseLink', 'relay reverse link selected, but master relay keys are missing')
            reverseLink = null
          } else {
            passCheck('reverseLink', `relay socket ${reverseLink.socket} (NAT transport)`)
          }
        } else if (reverseLink.kind === 'ssh') {
          if (!existsSync(store.keyPath(nCfg.id))) {
            failCheck(
              'reverseLink',
              `ssh reverse link requires ${store.keyPath(nCfg.id)} so ${targetId} can connect back to ${nCfg.id} (use relay/direct or pre-install the SSH link key)`,
            )
          } else {
            passCheck(
              'reverseLink',
              `ssh ${reverseLink.user}@${reverseLink.host}:${reverseLink.sshPort} (door ${reverseLink.port})`,
            )
          }
        } else {
          passCheck(
            'reverseLink',
            reverseLink.kind === 'direct' ? `direct ${reverseLink.url}` : `${reverseLink.kind} reverse link`,
          )
        }
      }
    } else if (!targetDev?.link || !link || !linkOnline || !targetCheck) {
      failCheck('reverseLink', `${targetId} must be online to detect reverse connectivity`)
    } else {
      const doorPort = opts.nodePort ?? existingNode?.port ?? NODE_PORT
      const doorCert = ensureDoorCert(nCfg.id, nodeDir())
      const addrs = collectDirectProbeAddresses((o.ownAddresses ?? systemOwnAddresses)())
      const direct = await (o.probeDirect ?? defaultProbeDirect)({
        targetLink: link,
        addresses: addrs,
        doorCert,
        nodePort: doorPort,
      })
      if (direct.ok) {
        reverseLink = { kind: 'direct', url: direct.url }
        passCheck('reverseLink', `direct TLS ${direct.url}`)
      } else if (targetCheck.platform !== 'linux') {
        failCheck(
          'reverseLink',
          `${targetId} runs ${targetCheck.platform} and cannot host a relay (requires a Linux server or direct reachability)`,
        )
      } else {
        const ep = relayTargetEndpoint(targetDev.link)
        const stem = relaySocketStem(existingNode?.relay?.socket || nCfg.id)
        if (!ep) {
          failCheck(
            'reverseLink',
            `${targetId} has no SSH host for hosting a relay (use direct reachability or --reverse-link)`,
          )
        } else if (!stem) {
          failCheck('reverseLink', `cannot derive relay socket name from ${nCfg.id}`)
        } else {
          const rc = await fetchJson<{ ok: boolean; user?: string; need?: string }>(
            link,
            '/api/node/handover/relay',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                op: 'check',
                host: ep.host,
                sshPort: ep.sshPort,
                ...(opts.sudoPassword !== undefined && { sudoPassword: opts.sudoPassword }),
              }),
            },
            60_000,
          )
          if (!rc.ok) {
            if (rc.need === 'sudoPassword') {
              lastNeed = 'sudoPassword'
              relaySetup = {
                host: ep.host,
                sshPort: ep.sshPort,
                user: RELAY_MASTER_USER,
                needsSudoPassword: true,
              }
              reverseLink = { kind: 'relay', socket: stem }
            }
            failCheck('reverseLink', rc.error)
          } else {
            const user = rc.data.user || RELAY_MASTER_USER
            relaySetup = {
              host: ep.host,
              sshPort: ep.sshPort,
              user,
              needsSudoPassword: false,
            }
            reverseLink = { kind: 'relay', socket: stem }
            passCheck('reverseLink', `relay will be set up on ${targetId} (${ep.host}:${ep.sshPort})`)
          }
        }
      }
    }

    // Other nodes check
    const otherNodes: { id: string; online: boolean }[] = []
    for (const [id, dev] of Object.entries(nCfg.devices)) {
      if (id === LOCAL || id === targetId || dev.revoked || !dev.link) continue
      const st = linkFor(id)?.state().state === 'online'
      otherNodes.push({ id, online: st })
    }
    const offlineOthers = otherNodes.filter(n => !n.online).map(n => n.id)
    if (offlineOthers.length > 0) {
      if (opts.allowOfflineNodes) {
        failCheck('otherNodes', `offline node(s) skipped by --allow-offline-nodes: ${offlineOthers.join(', ')}`, false)
      } else {
        failCheck(
          'otherNodes',
          `other node(s) offline (${offlineOthers.join(', ')}): bring them online or pass --allow-offline-nodes`,
        )
      }
    } else {
      passCheck(
        'otherNodes',
        otherNodes.length ? `${otherNodes.length} peer node(s) online` : 'no other nodes to re-pair',
      )
    }

    return {
      carryBackupKey: carryBackupKey || !targetCheck?.backup.hasKey,
      plan: {
        ok: errors.length === 0,
        from: nCfg.id,
        to: targetId,
        targetTitle,
        commit: ownCommit,
        reverseLink,
        checks,
        items: collected.summary,
        totalFiles: collected.totalFiles,
        totalBytes: collected.totalBytes,
        requiredFreeMb,
        targetFreeMb: targetCheck?.freeMb ?? null,
        rekey: rekeyInfo,
        otherNodes,
        carryBackupServer,
        normalizeTunnelKey: collected.normalizedTunnelKey,
        ...(relaySetup && { relaySetup }),
        errors,
        warnings,
      },
    }
  }

  async function autoRollback(ctx: {
    id: string
    targetLink: Pick<Link, 'fetch'> | null
    targetPrepared: boolean
    relayApplied: boolean
    relayEndpoint: { host: string; sshPort: number } | null
    sudoPassword?: string
    localBackupTaken: boolean
    pairedOthers: { id: string; masterId: string }[]
    enrolledSocket: string | null
    relayCfg: { host: string; sshPort: number; user: string } | null
  }): Promise<{ relayUndoError?: string }> {
    step = 'rollback'
    let relayUndoError: string | undefined
    if (ctx.targetPrepared && ctx.targetLink) {
      await fetchJson(ctx.targetLink, '/api/node/handover/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: ctx.id }),
      }).catch(() => {})
    }
    if (ctx.relayApplied && ctx.targetLink && ctx.relayEndpoint) {
      const ur = await fetchJson<{ ok: boolean }>(
        ctx.targetLink,
        '/api/node/handover/relay',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            op: 'undo',
            host: ctx.relayEndpoint.host,
            sshPort: ctx.relayEndpoint.sshPort,
            ...(ctx.sudoPassword !== undefined && { sudoPassword: ctx.sudoPassword }),
          }),
        },
        180_000,
      )
      if (!ur.ok) {
        relayUndoError = `target relay undo failed: ${ur.error}`
        o.log(`handover ${ctx.id}: ${relayUndoError}`)
        if (ur.need === 'sudoPassword') lastNeed = 'sudoPassword'
      }
    }
    for (const p of ctx.pairedOthers) {
      const peer = linkFor(p.id)
      if (!peer) continue
      await fetchJson(peer, '/api/node/handover/unpair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ masterId: p.masterId }),
      }).catch(() => {})
    }
    if (ctx.enrolledSocket && ctx.relayCfg) {
      await enrolRemove(ctx.relayCfg, ctx.enrolledSocket).catch(() => {})
    }
    try {
      if (ctx.localBackupTaken) {
        await restoreLocalBackup(ctx.id, { scope: 'old-master-precommit' })
        const prev = readHandoverState()
        if (prev && prev.id === ctx.id) {
          writeHandoverState({ ...prev, phase: 'rolled-back', at: now() })
        }
      }
    } finally {
      await o.reloadConfig().catch(() => {})
      o.setFreeze(false)
    }
    return { ...(relayUndoError && { relayUndoError }) }
  }

  return {
    view: currentView,

    cancel() {
      if (busy) return currentView()
      phase = 'idle'
      step = null
      lastPlan = null
      lastVerify = null
      lastError = null
      lastNeed = undefined
      rolledBack = false
      return currentView()
    },

    async check(opts) {
      if (busy) throw new Error('handover already in progress')
      busy = true
      phase = 'checking'
      step = 'check'
      currentTarget = opts.to
      lastError = null
      lastVerify = null
      rolledBack = false
      try {
        const { plan } = await inspect(opts)
        lastPlan = plan
        phase = 'checked'
        step = null
        return plan
      } catch (err) {
        phase = 'failed'
        lastError = msg(err)
        throw err
      } finally {
        busy = false
      }
    },

    async run(opts) {
      if (busy) return { ok: false, error: 'handover already in progress' }
      busy = true
      phase = 'running'
      step = 'check'
      currentTarget = opts.to
      lastVerify = null
      lastError = null
      rolledBack = false

      try {
        const { plan, carryBackupKey } = await inspect(opts)
        lastPlan = plan
        if (!plan.ok || !plan.reverseLink) {
          phase = 'failed'
          step = null
          lastError = plan.errors[0] ?? 'handover preflight checks failed'
          return { ok: false, error: lastError, ...(lastNeed && { need: lastNeed }), plan }
        }

        const id = stampId(now())
        currentId = id
        const rawCfg = readConfigFile() ?? (structuredClone(o.cfg) as unknown as Record<string, unknown>)
        const nCfg = nodesConfig(rawCfg.nodes, hostFn())
        if (!nCfg) {
          phase = 'failed'
          step = null
          lastError = 'nodes configuration disappeared'
          return { ok: false, error: lastError, plan }
        }
        const targetLink = linkFor(plan.to)
        if (!targetLink) {
          phase = 'failed'
          step = null
          lastError = `${plan.to} link disappeared`
          return { ok: false, error: lastError, plan }
        }

        let targetPrepared = false
        let localBackupTaken = false
        let relayApplied = false
        let relayTargetHostKeys: string[] = []
        const relayEndpoint = plan.relaySetup
          ? { host: plan.relaySetup.host, sshPort: plan.relaySetup.sshPort, user: plan.relaySetup.user }
          : null
        const pairedOthers: { id: string; masterId: string; token: string }[] = []
        let enrolledSocket: string | null = null
        let oldNodeCfg: Parameters<typeof buildOldMasterNodeConfig>[1]['nodeConfig'] | null = null
        let verify: HandoverVerifyResult | null = null

        try {
          if (plan.relaySetup && relayEndpoint) {
            step = 'relay'
            const rr = await fetchJson<{ ok: boolean; user?: string; hostKeys?: string[] }>(
              targetLink,
              '/api/node/handover/relay',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  op: 'apply',
                  host: relayEndpoint.host,
                  sshPort: relayEndpoint.sshPort,
                  ...(opts.sudoPassword !== undefined && { sudoPassword: opts.sudoPassword }),
                }),
              },
              180_000,
            )
            if (!rr.ok) {
              if (rr.need === 'sudoPassword') lastNeed = 'sudoPassword'
              throw new Error(`relay setup on ${plan.to} failed: ${rr.error}`)
            }
            relayApplied = true
            if (Array.isArray(rr.data.hostKeys)) relayTargetHostKeys = rr.data.hostKeys
          }

          // Step 2: Freeze old master, run DB backup to configured targets, take local backup, prepare target.
          step = 'freeze'
          o.setFreeze(true)

          step = 'backup'
          const mBackup = backupConfig(rawCfg.backup)
          if (existsSync(dbFile()) && readMasterBackupKey() && activeTargets(mBackup).length > 0) {
            const bRes = await backupNow({ cfg: rawCfg as Config, force: true })
            if (bRes.failed.length > 0) {
              throw new Error(`pre-handover database backup failed: ${bRes.failed[0]?.error}`)
            }
          }
          takeLocalBackup(id, now())
          localBackupTaken = true
          writeHandoverState({
            v: 1,
            id,
            role: 'old-master',
            phase: 'prepared',
            from: plan.from,
            to: plan.to,
            peerId: plan.to,
            otherNodes: plan.otherNodes.filter(n => n.online).map(n => n.id),
            at: now(),
          })

          const prep = await fetchJson<{ ok: boolean; error?: string }>(
            targetLink,
            '/api/node/handover/prepare',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, from: plan.from, to: plan.to }),
            },
            30_000,
          )
          if (!prep.ok) throw new Error(`target prepare failed: ${prep.error}`)
          targetPrepared = true

          // Step 3 & 4 prep: Set up old master's node door + reverse creds, re-pair other nodes, pack & seal bundle.
          step = 'pair'
          const oldNodeStore = createNodeStore({ dir: nodeDir() })
          const { token: reverseToken } = oldNodeStore.add(plan.to, 'hand')
          const existingNode = nodeConfig(rawCfg.node)
          const nodePort = opts.nodePort ?? existingNode?.port ?? NODE_PORT
          let reverseCert: string | undefined

          if (plan.reverseLink.kind === 'relay') {
            const effectiveRelay = relayEndpoint ?? nCfg.relay
            if (!effectiveRelay) throw new Error('nodes.relay missing for relay reverse link')
            const doorCert = ensureDoorCert(plan.from, nodeDir())
            reverseCert = doorCert.cert
            const dialKey = nodeRelayKeyPath(nodeDir())
            let dialPub: string
            if (!existsSync(dialKey)) {
              const made = await genKey(`agent-board relay node ${plan.reverseLink.socket}`, dialKey)
              if (!made.ok) throw new Error(`cannot generate relay dial key: ${made.error}`)
              dialPub = made.publicKey
            } else {
              dialPub = readFileSync(`${dialKey}.pub`, 'utf8').trim()
            }
            const khSrc = knownHostsFile()
            const khDst = nodeRelayKnownHostsReady(nodeDir())
            if (existsSync(khSrc) && !existsSync(khDst)) copyFileSync(khSrc, khDst)
            if (relayTargetHostKeys.length > 0) {
              pinKnownHostKeys(
                khDst,
                [{ host: effectiveRelay.host, sshPort: effectiveRelay.sshPort }],
                relayTargetHostKeys,
              )
            }

            if (relayEndpoint) {
              const enr = await fetchJson<{ ok: boolean }>(
                targetLink,
                '/api/node/handover/relay',
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    op: 'enrol-add',
                    host: relayEndpoint.host,
                    sshPort: relayEndpoint.sshPort,
                    socket: plan.reverseLink.socket,
                    publicKey: dialPub,
                  }),
                },
                30_000,
              )
              if (!enr.ok) throw new Error(`cannot enrol relay socket for old master: ${enr.error}`)
            } else {
              const enr = await enrolAdd(effectiveRelay, plan.reverseLink.socket, dialPub)
              if (!enr.ok) throw new Error(`cannot enrol relay socket for old master: ${enr.error}`)
            }
            enrolledSocket = plan.reverseLink.socket
            writeHandoverState({
              v: 1,
              id,
              role: 'old-master',
              phase: 'prepared',
              from: plan.from,
              to: plan.to,
              peerId: plan.to,
              otherNodes: plan.otherNodes.filter(n => n.online).map(n => n.id),
              enrolledSocket,
              ...(relayApplied && { relayApplied: true }),
              at: now(),
            })
            oldNodeCfg = {
              id: plan.from,
              port: nodePort,
              workRoot: existingNode?.workRoot ?? '~',
              listen: 'loopback',
              tls: true,
              relay: buildOldMasterRelayNodeConfig(effectiveRelay, plan.reverseLink.socket),
            }
          } else if (plan.reverseLink.kind === 'direct' && plan.reverseLink.url.startsWith('https://')) {
            const doorCert = ensureDoorCert(plan.from, nodeDir())
            reverseCert = doorCert.cert
            oldNodeCfg = {
              id: plan.from,
              port: nodePort,
              workRoot: existingNode?.workRoot ?? '~',
              listen: 'tailnet',
              tls: true,
            }
          } else {
            oldNodeCfg = {
              id: plan.from,
              port: nodePort,
              workRoot: existingNode?.workRoot ?? '~',
              listen: existingNode?.listen ?? 'loopback',
              tls: existingNode?.tls ?? false,
            }
          }

          // Start old master's node door while keeping nodes frozen so outbound verify link works.
          if (!oldNodeCfg) throw new Error('missing old master node config')
          const frozenOldConfig = buildOldMasterNodeConfig(rawCfg, {
            nodeConfig: oldNodeCfg,
            keepNodesFrozen: true,
          })
          withConfigFile((_, save) => save(frozenOldConfig))
          await o.reloadConfig()

          // Pair new master on all online peer nodes.
          for (const other of plan.otherNodes) {
            if (!other.online) continue
            const peerLink = linkFor(other.id)
            if (!peerLink) throw new Error(`link to ${other.id} missing during re-pairing`)
            const paired = await fetchJson<{ ok: boolean; masterId: string; token: string }>(
              peerLink,
              '/api/node/handover/pair',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id, masterName: plan.to }),
              },
              15_000,
            )
            if (!paired.ok) throw new Error(`failed to pair new master on ${other.id}: ${paired.error}`)
            pairedOthers.push({ id: other.id, masterId: paired.data.masterId, token: paired.data.token })
          }

          const credentials: HandoverCredential[] = [
            { id: plan.from, token: reverseToken, ...(reverseCert && { cert: reverseCert }) },
            ...pairedOthers.map(p => {
              const cert = store.cert(p.id)
              return { id: p.id, token: p.token, ...(cert && { cert }) }
            }),
          ]

          const flippedNodes = flipNodesConfig(rawCfg.nodes as Record<string, unknown>, {
            oldMasterId: plan.from,
            targetId: plan.to,
            oldMasterTitle: isRecord(nCfg.devices[LOCAL]) ? (nCfg.devices[LOCAL].title as string) : hostFn(),
            reverseLink: plan.reverseLink,
            ...(relayEndpoint && {
              relay: {
                host: relayEndpoint.host,
                ...(relayEndpoint.sshPort !== 22 ? { sshPort: relayEndpoint.sshPort } : {}),
                user: relayEndpoint.user,
              },
            }),
          })

          // node/handover.ts apply merges oldConfig + flippedNodes onto target's local config.json
          // via buildTargetMasterConfig so machine-local settings (port, profiles, launch, wake) stay intact.
          const collected = collectMasterState(rawCfg, plan.to, {
            pack: true,
            carryBackupKey,
            carryBackupServer: plan.carryBackupServer,
          })
          // Always use a one-time ephemeral key for bundle transport instead of exposing any
          // long-term backup key in the apply HTTP request.
          const sealingKey = makeEphemeralKey(now())
          const manifest: HandoverManifest = {
            v: HANDOVER_VERSION,
            id,
            from: plan.from,
            to: plan.to,
            createdAt: now(),
            files: collected.entries,
            credentials,
          }
          const sealed = sealHandoverBundle(manifest, collected.bodies, sealingKey)
          const bundleSha = sha256Hex(sealed)
          const shipTimeoutMs = Math.min(600_000, Math.max(120_000, Math.ceil(sealed.byteLength / (256 * 1024)) * 1000))

          // Step 3: Ship encrypted bundle
          step = 'ship'
          const shipRes = await fetchJson<{ ok: boolean }>(
            targetLink,
            '/api/node/handover/bundle',
            {
              method: 'PUT',
              headers: {
                'content-type': 'application/octet-stream',
                'x-handover-id': id,
                'x-handover-sha256': bundleSha,
              },
              body: new Uint8Array(sealed),
            },
            shipTimeoutMs,
          )
          if (!shipRes.ok) throw new Error(`shipping bundle failed: ${shipRes.error}`)

          // Step 4: Apply & rekey on target
          step = 'apply'
          const applyRes = await fetchJson<{ ok: boolean }>(
            targetLink,
            '/api/node/handover/apply',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                id,
                key: sealingKey,
                oldConfig: rawCfg,
                flippedNodes,
                normalizeTunnelKey: collected.normalizedTunnelKey,
                carryBackupServer: plan.carryBackupServer,
                keepTargetBackupKey: !carryBackupKey,
                ...(relayApplied && { relayApplied: true }),
              }),
            },
            60_000,
          )
          if (!applyRes.ok) throw new Error(`applying handover on ${plan.to} failed: ${applyRes.error}`)

          // Step 5: Verify new master (poll until nodes link up or deadline expires)
          step = 'verify'
          const expectedNodes = [plan.from, ...pairedOthers.map(p => p.id)]
          const deadline = Date.now() + (o.verifyTimeoutMs ?? knobMs('BOARD_HANDOVER_VERIFY_MS', 30_000))
          const pollInterval = o.verifyPollMs ?? Math.max(50, Math.round(500 * pace()))
          for (;;) {
            const vr = await fetchJson<HandoverVerifyResult>(
              targetLink,
              '/api/node/handover/verify',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ expectedNodes }),
              },
              15_000,
            )
            if (vr.ok) {
              verify = vr.data
              lastVerify = verify
              if (verify.ok) break
            }
            if (Date.now() >= deadline) {
              const detail = verify
                ? verify.checks
                    .filter(c => !c.ok)
                    .map(c => `${c.name}: ${c.detail}`)
                    .join('; ')
                : 'verification timed out'
              throw new Error(`new master verification failed: ${detail}`)
            }
            await pause(pollInterval)
          }

          // Step 5b: Commit on target (point of no return).
          step = 'commit'
          let commitOutcome: 'committed' | 'not-committed' | 'unknown' = 'unknown'
          let lastCommitError = ''
          const commitBackoffsMs = [250, 500, 1000]
          for (let attempt = 0; attempt <= commitBackoffsMs.length; attempt++) {
            if (attempt > 0) await pause(commitBackoffsMs[attempt - 1] ?? 500)
            const commitRes = await fetchJson<{ ok: boolean }>(
              targetLink,
              '/api/node/handover/commit',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id }),
              },
              attempt === 0 ? 15_000 : 10_000,
            )
            if (commitRes.ok) {
              commitOutcome = 'committed'
              break
            }
            lastCommitError = commitRes.error
            if (commitRes.status === 400 || commitRes.status === 409) {
              commitOutcome = 'not-committed'
              break
            }
            const probe = await fetchJson<TargetCheckResponse>(
              targetLink,
              '/api/node/handover/check',
              { method: 'GET' },
              10_000,
            )
            if (probe.ok) {
              const targetState = probe.data.handoverState
              if (targetState?.id === id && targetState.phase === 'committed') {
                commitOutcome = 'committed'
                break
              }
              if (targetState?.id === id && targetState.phase === 'applied') {
                if (attempt === commitBackoffsMs.length) {
                  commitOutcome = 'not-committed'
                  break
                }
                continue
              }
              commitOutcome = 'not-committed'
              break
            }
          }

          if (commitOutcome === 'not-committed') {
            throw new Error(`commit on ${plan.to} failed: ${lastCommitError}`)
          }
          if (commitOutcome === 'unknown') {
            const error = `commit confirmation from ${plan.to} failed after retries (${lastCommitError}); keeping this master write-frozen to prevent split-brain or losing the master role. Check ${plan.to} with "board master status": if ${plan.to} is master, leave this device stopped; if ${plan.to} did not commit, run "board master rollback" here.`
            lastError = error
            phase = 'failed'
            step = null
            o.log(`handover ${id}: ${error}`)
            return { ok: false, id, from: plan.from, to: plan.to, rolledBack: false, error, plan, verify }
          }
        } catch (err) {
          const error = msg(err)
          lastError = error
          o.log(`handover ${id}: failed (${error}), rolling back`)
          const rb = await autoRollback({
            id,
            targetLink,
            targetPrepared,
            relayApplied,
            relayEndpoint,
            ...(opts.sudoPassword !== undefined && { sudoPassword: opts.sudoPassword }),
            localBackupTaken,
            pairedOthers: pairedOthers.map(p => ({ id: p.id, masterId: p.masterId })),
            enrolledSocket,
            relayCfg: relayEndpoint ? null : nCfg.relay,
          })
          if (rb.relayUndoError) {
            const combined = `${error}; ${rb.relayUndoError}`
            lastError = combined
            rolledBack = false
            phase = 'failed'
            step = null
            return {
              ok: false,
              id,
              from: plan.from,
              to: plan.to,
              rolledBack: false,
              error: combined,
              ...(lastNeed && { need: lastNeed }),
              plan,
              verify: lastVerify,
            }
          }
          rolledBack = true
          phase = 'rolled-back'
          step = null
          return {
            ok: false,
            id,
            from: plan.from,
            to: plan.to,
            rolledBack: true,
            error,
            ...(lastNeed && { need: lastNeed }),
            plan,
            verify: lastVerify,
          }
        }

        // Post-commit point of no return: persist committed state immediately before unpairing peers
        // or updating local files, NEVER autoRollback.
        try {
          writeHandoverState({
            v: 1,
            id,
            role: 'old-master',
            phase: 'committed',
            from: plan.from,
            to: plan.to,
            peerId: plan.to,
            otherNodes: pairedOthers.map(p => p.id),
            ...(enrolledSocket && { enrolledSocket }),
            ...(relayApplied && { relayApplied: true }),
            at: now(),
          })

          for (const p of pairedOthers) {
            const peerLink = linkFor(p.id)
            if (!peerLink) continue
            await fetchJson(peerLink, '/api/node/handover/unpair', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ self: true }),
            }).catch(() => {})
          }

          retireShippedOldMasterState(id)

          if (!oldNodeCfg) throw new Error('missing old master node config')
          const finalOldConfig = buildOldMasterNodeConfig(rawCfg, {
            nodeConfig: oldNodeCfg,
            keepNodesFrozen: false,
          })
          withConfigFile((_, save) => save(finalOldConfig))
          await o.reloadConfig()
          o.setFreeze(false)

          phase = 'done'
          step = null
          o.log(`handover ${id}: completed (${plan.from} -> ${plan.to})`)
          return { ok: true, id, from: plan.from, to: plan.to, verify }
        } catch (finErr) {
          const error = `target committed but old-master finalization failed (keeping freeze active): ${msg(finErr)}`
          lastError = error
          phase = 'failed'
          step = null
          o.log(`handover ${id}: ${error}`)
          return { ok: false, id, from: plan.from, to: plan.to, rolledBack: false, error, plan, verify }
        }
      } catch (err) {
        phase = 'failed'
        step = null
        lastError = msg(err)
        throw err
      } finally {
        busy = false
      }
    },

    async rollback(opts = {}) {
      if (busy) return { ok: false, error: 'handover already in progress' }
      busy = true
      step = 'rollback'
      lastNeed = undefined
      try {
        const state = readHandoverState()
        const id = opts.id ?? state?.id ?? latestHandoverBackupId()
        if (!id) return { ok: false, error: 'no handover backup found to roll back' }

        const localRelayEndpoint = (): { host: string; sshPort: number } => {
          const r = nodesConfig(o.cfg.nodes, hostFn())?.relay
          return { host: r?.host ?? hostFn(), sshPort: r?.sshPort ?? 22 }
        }
        const undoRelay = async (uo: {
          host: string
          sshPort: number
          sudoPassword?: string
        }): Promise<LocalRelayAnswer> =>
          o.undoLocalRelay ? o.undoLocalRelay(uo) : { ok: false, error: 'local relay undo unavailable' }

        if (opts.localOnly) {
          if (state?.role === 'new-master' && state.phase === 'committed' && !opts.discardSinceCommit) {
            return {
              ok: false,
              id,
              error:
                'handover is already committed; rolling back will discard all changes written on this master since commit (pass --discard-since-commit to confirm)',
            }
          }
          if (state?.role === 'new-master' && state.relayApplied) {
            const ur = await undoRelay({
              ...localRelayEndpoint(),
              ...(opts.sudoPassword !== undefined && { sudoPassword: opts.sudoPassword }),
            })
            if (!ur.ok) {
              if (ur.need === 'sudoPassword') lastNeed = 'sudoPassword'
              return { ok: false, id, ...(ur.need && { need: ur.need }), error: ur.error }
            }
          }
          const scope =
            state?.role === 'old-master'
              ? state.phase === 'committed'
                ? 'old-master-committed'
                : 'old-master-precommit'
              : 'all'
          if (scope === 'all') await o.beforeDbReplace()
          let res: { restored: number; removed: number }
          try {
            res = await restoreLocalBackup(id, { scope })
            if (state && state.id === id) {
              writeHandoverState({ ...state, phase: 'rolled-back', at: now() })
            }
          } finally {
            if (scope === 'all') await o.afterDbReplace()
          }
          await o.reloadConfig()
          o.setFreeze(false)
          phase = 'rolled-back'
          rolledBack = true
          return { ok: true, id, ...res }
        }

        if (state && state.role === 'old-master' && state.phase === 'committed') {
          return {
            ok: false,
            id,
            error: `this device is now a node of ${state.peerId}; run "board master rollback" on ${state.peerId} to restore both devices, or pass --local-only`,
          }
        }

        if (state?.role === 'new-master' && state.phase === 'committed') {
          if (!opts.discardSinceCommit) {
            return {
              ok: false,
              id,
              error:
                'handover is already committed; rolling back will discard all changes written on this master since commit (pass --discard-since-commit to confirm)',
            }
          }
          const oldMasterLink = linkFor(state.peerId)
          if (oldMasterLink?.state().state !== 'online') {
            return {
              ok: false,
              id,
              error: `cannot reach previous master ${state.peerId} to roll back both devices (pass --local-only to restore only this device)`,
            }
          }
          if (state.relayApplied && o.checkLocalRelay) {
            const chk = await o.checkLocalRelay({
              ...localRelayEndpoint(),
              ...(opts.sudoPassword !== undefined && { sudoPassword: opts.sudoPassword }),
            })
            if (!chk.ok) {
              if (chk.need === 'sudoPassword') lastNeed = 'sudoPassword'
              return { ok: false, id, ...(chk.need && { need: chk.need }), error: chk.error }
            }
          }
          o.setFreeze(true)
          const remoteRb = await fetchJson<{ ok: boolean }>(oldMasterLink, '/api/node/handover/rollback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, deferRefresh: true }),
          })
          if (!remoteRb.ok) {
            o.setFreeze(false)
            return { ok: false, id, error: `rollback on ${state.peerId} failed: ${remoteRb.error}` }
          }
          for (const otherId of state.otherNodes) {
            const peerLink = linkFor(otherId)
            if (!peerLink) continue
            await fetchJson(peerLink, '/api/node/handover/rollback', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id }),
            }).catch(() => {})
          }
          if (state.enrolledSocket) {
            const curNodes = nodesConfig(o.cfg.nodes, hostFn())
            if (curNodes?.relay) {
              await enrolRemove(curNodes.relay, state.enrolledSocket).catch(() => {})
            }
          }
          if (state.relayApplied) {
            const ur = await undoRelay({
              ...localRelayEndpoint(),
              ...(opts.sudoPassword !== undefined && { sudoPassword: opts.sudoPassword }),
            })
            if (!ur.ok) o.log(`handover ${id}: local relay undo failed: ${ur.error}`)
          }
          await o.beforeDbReplace()
          let res: { restored: number; removed: number }
          try {
            res = await restoreLocalBackup(id)
            writeHandoverState({ ...state, phase: 'rolled-back', at: now() })
          } finally {
            await o.afterDbReplace()
          }
          await o.reloadConfig()
          o.setFreeze(false)
          phase = 'rolled-back'
          rolledBack = true
          return { ok: true, id, ...res }
        }

        // Otherwise: pre-commit or incomplete state on old master.
        let relayUndoError: string | undefined
        if (state?.peerId) {
          const peerLink = linkFor(state.peerId)
          if (peerLink?.state().state === 'online') {
            await fetchJson(peerLink, '/api/node/handover/rollback', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id }),
            }).catch(() => {})
            if (state.relayApplied) {
              const targetEp = relayTargetEndpoint(nodesConfig(o.cfg.nodes, hostFn())?.devices[state.peerId]?.link)
              const ep = targetEp ?? localRelayEndpoint()
              const ur = await fetchJson<{ ok: boolean }>(
                peerLink,
                '/api/node/handover/relay',
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    op: 'undo',
                    host: ep.host,
                    sshPort: ep.sshPort,
                    ...(opts.sudoPassword !== undefined && { sudoPassword: opts.sudoPassword }),
                  }),
                },
                180_000,
              )
              if (!ur.ok) {
                relayUndoError = `target relay undo failed: ${ur.error}`
                o.log(`handover ${id}: ${relayUndoError}`)
                if (ur.need === 'sudoPassword') lastNeed = 'sudoPassword'
              }
            }
          }
        }
        const preScope = state?.role === 'old-master' ? 'old-master-precommit' : 'all'
        if (preScope === 'all') await o.beforeDbReplace()
        let res: { restored: number; removed: number }
        try {
          res = await restoreLocalBackup(id, { scope: preScope })
          if (state && state.id === id && !relayUndoError) {
            writeHandoverState({ ...state, phase: 'rolled-back', at: now() })
          }
        } finally {
          if (preScope === 'all') await o.afterDbReplace()
        }
        await o.reloadConfig()
        o.setFreeze(false)
        if (relayUndoError) {
          phase = 'failed'
          rolledBack = false
          lastError = relayUndoError
          return {
            ok: false,
            id,
            ...(lastNeed && { need: lastNeed }),
            error: relayUndoError,
            ...res,
          }
        }
        phase = 'rolled-back'
        rolledBack = true
        return { ok: true, id, ...res }
      } finally {
        step = null
        busy = false
      }
    },
  }
}
