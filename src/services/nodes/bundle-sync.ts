// The bundle from the master (#506, docs/design/nodes 9.1 to 9.3): per device and profile, build the
// bundle from the profile folder (adapters/bundle-files.ts walks it, core/bundle.ts classifies it
// with the device's `mcp` and `accept` and the board's slice with its sinks), keep its version in
// `<state>/nodes/<id>/bundle.json` (per profile: seq, hash, the last report), ask the node what it
// has, send only the blobs it lacks, and commit. Made by server/app.ts only once `nodes` is on.
//
// The hash is computed when a sync is asked and every 5 minutes while a device is online, never on
// a prompt (9.2). Each request of a sync is answered within 20 s and the whole sync within 15
// minutes, whatever the node does: a profile's first bundle is hundreds of files, sent a few at a
// time (#583). Nothing of a profile's settings goes out but what the classifiers let through: a
// value that looks like a secret stays here, and the log and the record name files and verdicts,
// never a value.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { readProfile, type WalkedFile } from '../../adapters/bundle-files.ts'
import type { DeviceStore } from '../../adapters/node-store.ts'
import { ROOT } from '../../adapters/paths.ts'
import {
  type BundleContext,
  type BundleManifest,
  type BundleVersion,
  buildManifest,
  bundleHash,
  nextVersion,
  type ReportEntry,
} from '../../core/bundle.ts'
import { claudeStateFile } from '../../core/move.ts'
import { type DeviceConfig, LOCAL, nodesConfig } from '../../core/nodes.ts'
import { DEFAULT_PROFILE, type Profile } from '../../core/profiles.ts'
import type { Config } from '../../core/types.ts'
import { type Clock, realClock } from '../tunnel.ts'
import type { Link } from './link.ts'

/** What a sync came to: the node current, or why not; what it sent and what the node kept. */
export interface SyncReport {
  ok: boolean
  device: string
  /** The master's profile id, and the node's it maps to (`nodes.devices.<id>.profiles`). */
  profile: string
  nodeProfile: string
  seq: number
  hash: string
  /**
   * Why not: `device` (no such device with a link), `profile` (no such profile here), `offline`,
   * `build` (the profile folder could not be read), `changed` (a file changed while it was sent),
   * `node` (the node refused; `detail` is its code), `timeout` (a request not answered within 20 s,
   * or the whole sync not done within 15 minutes).
   */
  why?: 'device' | 'profile' | 'offline' | 'build' | 'changed' | 'node' | 'timeout'
  detail?: string
  /** Blobs sent this time. */
  sent: number
  /** Files the node wrote or removed. */
  applied: string[]
  /** Files of the node's own it left alone, with its reason. */
  kept: { path: string; why: string }[]
  /** The node's backup folder of this commit, or null. */
  backup: string | null
  /** The bundle's report (9.1): what travels, what stays and why. */
  lines: ReportEntry[]
  at: number
}

export interface BundleSync {
  /** The node made current for this profile, or why not, within SYNC_TOTAL_MS. */
  syncIfBehind(device: string, profile?: string): Promise<SyncReport>
  /** The last report of a device's profile, for doctor; null before the first sync. */
  report(device: string, profile: string): SyncReport | null
  close(): void
}

export interface BundleSyncOptions {
  /** The live config: `nodes` and the board's slice. */
  cfg: Config
  links: { link(id: string): Link | null }
  /** This board's shown profiles. */
  profiles(): readonly Profile[]
  store: Pick<DeviceStore, 'bundle' | 'setBundle'>
  log(text: string): void
  home?: string
  platform?: string
  /** The board's own folder: a hook running a file in it is the board's (core/bundle.ts isBoardHook). */
  boardDir?: string
  hostName?: string
  clock?: Clock
  /** How long one request to the node may take (SYNC_MS). */
  requestMs?: number
}

/** Each request of a sync is answered within this long (9.2). A deadline, never paced. */
export const SYNC_MS = 20_000
/** A whole sync is done within this long: a first bundle over a slow link is minutes, not hours. */
export const SYNC_TOTAL_MS = 15 * 60_000
/** Blobs on their way to the node at once: one at a time is a round trip each, for hundreds of files. */
export const SEND_AT_ONCE = 6
/** The hash is computed this often while a device is online (9.2). */
export const HASH_MS = 5 * 60_000

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const said = (v: unknown): string =>
  String(v)
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 80)

/** One profile's part of bundle.json, read again: the version, and the last report as it was kept. */
function entryOf(v: unknown): { version: BundleVersion | null; report: SyncReport | null } {
  if (!isRecord(v)) return { version: null, report: null }
  const version =
    Number.isInteger(v.seq) && (v.seq as number) > 0 && typeof v.hash === 'string'
      ? { seq: v.seq as number, hash: v.hash }
      : null
  const report = isRecord(v.report) && typeof v.report.ok === 'boolean' ? (v.report as unknown as SyncReport) : null
  return { version, report }
}

class Late extends Error {}

export function createBundleSync(o: BundleSyncOptions): BundleSync {
  const home = o.home ?? homedir()
  const platform = o.platform ?? process.platform
  const boardDir = o.boardDir ?? ROOT
  const host = o.hostName ?? hostname()
  const clock = o.clock ?? realClock
  const requestMs = o.requestMs ?? SYNC_MS
  const running = new Map<string, Promise<SyncReport>>()

  const devices = (): Record<string, DeviceConfig> => nodesConfig(o.cfg.nodes, host)?.devices ?? {}
  const profiles = (id: string): Record<string, unknown> => {
    const rec = o.store.bundle(id)
    return isRecord(rec?.profiles) ? rec.profiles : {}
  }
  function save(id: string, profile: string, part: { version: BundleVersion; report?: SyncReport }): void {
    const all = { ...profiles(id) }
    const was = entryOf(all[profile])
    all[profile] = { ...part.version, report: part.report ?? was.report }
    o.store.setBundle(id, { profiles: all })
  }

  /** The bundle of `profile` for `device` on a node of platform `to`, and its version, kept. */
  function build(
    device: DeviceConfig,
    profile: Profile,
    to: string,
  ):
    | { ok: true; manifest: BundleManifest; files: WalkedFile[]; version: BundleVersion }
    | { ok: false; detail: string } {
    const read = readProfile(profile.dir, {
      to,
      home,
      boardDir,
      claudeJson: claudeStateFile(profile.dir, home, platform),
      platform,
    })
    if (!read.ok) return { ok: false, detail: read.why }
    const ctx: BundleContext = {
      from: platform,
      to,
      profileDir: profile.dir,
      home,
      boardDir,
      mcp: device.mcp,
      accept: device.accept,
    }
    const manifest = buildManifest(read.parts, { config: o.cfg, sinks: device.sinks }, ctx)
    const was = entryOf(profiles(device.id)[profile.id]).version
    const version = nextVersion(was, bundleHash(manifest))
    if (!was || was.seq !== version.seq || was.hash !== version.hash) save(device.id, profile.id, { version })
    return { ok: true, manifest, files: read.parts.files, version }
  }

  async function run(deviceId: string, profileId: string): Promise<SyncReport> {
    const deadline = clock.now() + SYNC_TOTAL_MS
    const device = devices()[deviceId]
    const nodeProfile = device?.profiles[profileId] ?? profileId
    const base: SyncReport = {
      ok: false,
      device: deviceId,
      profile: profileId,
      nodeProfile,
      seq: 0,
      hash: '',
      sent: 0,
      applied: [],
      kept: [],
      backup: null,
      lines: [],
      at: clock.now(),
    }
    const not = (why: NonNullable<SyncReport['why']>, detail?: string): SyncReport => ({
      ...base,
      why,
      ...(detail !== undefined && { detail: said(detail) }),
    })
    if (!device?.link || deviceId === LOCAL) return not('device')
    const profile = o.profiles().find(p => p.id === profileId)
    if (!profile) return not('profile')
    const link = o.links.link(deviceId)
    if (link?.state().state !== 'online') return not('offline')
    const left = (): AbortSignal => {
      const ms = deadline - clock.now()
      if (ms <= 0) throw new Late()
      return AbortSignal.timeout(Math.min(ms, requestMs))
    }
    const at = `/api/node/bundle/${encodeURIComponent(nodeProfile)}`
    const ask = async (
      path: string,
      init: RequestInit = {},
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await link.fetch(path, { ...init, signal: left() })
      const body: unknown = await res.json().catch(err => {
        // Cut off after the headers: the deadline, not the node's answer.
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw err
        return {}
      })
      return { status: res.status, body: isRecord(body) ? body : {} }
    }
    try {
      const to = link.view().status?.platform ?? (await link.status())?.platform
      if (!to) return not('offline')
      const built = build(device, profile, to)
      if (!built.ok) return not('build', built.detail)
      const { manifest, files, version } = built
      const done = { ...base, seq: version.seq, hash: version.hash, lines: manifest.report }
      const have = await ask(at)
      if (have.status !== 200) return { ...done, why: 'node', detail: said(have.body.error ?? have.status) }
      if (have.body.hash === version.hash && have.body.seq === version.seq) {
        // Current: what the node kept of this version, as its commit said.
        const last = entryOf(profiles(deviceId)[profileId]).report
        return finish({ ...done, ok: true, kept: last?.ok && last.hash === version.hash ? last.kept : [] })
      }
      const there = new Set(isRecord(have.body.files) ? Object.values(have.body.files) : [])
      const bySha = new Map(files.map(f => [f.sha256, f]))
      let sent = 0
      const sendOne = async (sha: string): Promise<SyncReport | null> => {
        const f = bySha.get(sha)
        if (!f) return { ...done, why: 'node', detail: 'missing-blob' }
        const bytes = readFileSync(f.source)
        if (sha256(bytes) !== sha) return { ...done, why: 'changed', detail: f.path }
        const put = await ask(`${at}/blob/${sha}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        })
        if (put.status !== 200) return { ...done, why: 'node', detail: said(put.body.error ?? put.status) }
        sent++
        return null
      }
      /**
       * SEND_AT_ONCE at a time. The first the node refuses ends it: no other is started, those on
       * their way finish, and that refusal is the answer, whatever came of the others.
       */
      const send = async (shas: Iterable<string>): Promise<SyncReport | null> => {
        const queue = [...shas]
        let failed: SyncReport | null = null
        let threw: { err: unknown } | null = null
        const worker = async (): Promise<void> => {
          for (let sha = queue.shift(); sha !== undefined && !failed && !threw; sha = queue.shift()) {
            try {
              const refused = await sendOne(sha)
              if (refused) failed ??= refused
            } catch (err) {
              threw ??= { err }
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(SEND_AT_ONCE, queue.length) }, worker))
        if (failed) return failed
        if (threw) throw (threw as { err: unknown }).err
        return null
      }
      const failed = await send(new Set(manifest.files.map(f => f.sha256).filter(sha => !there.has(sha))))
      if (failed) return finish({ ...failed, sent })
      // The report stays here: it is doctor's (9.4), and the node needs none of it.
      const body = JSON.stringify({ seq: version.seq, hash: version.hash, manifest: { ...manifest, report: [] } })
      const commit = () =>
        ask(`${at}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      let res = await commit()
      // The node pruned a blob it had said it had: those, once more.
      if (res.status === 409 && res.body.error === 'missing-blob' && Array.isArray(res.body.missing)) {
        const again = await send(res.body.missing.map(String))
        if (again) return finish({ ...again, sent })
        res = await commit()
      }
      if (res.status !== 200 || res.body.ok !== true) {
        // What the node names with its refusal: the path, the file that does not parse, how many blobs.
        const what =
          res.body.path ??
          res.body.file ??
          (Array.isArray(res.body.missing) ? `${res.body.missing.length} blob(s)` : '')
        const code = String(res.body.error ?? res.status)
        return finish({ ...done, sent, why: 'node', detail: said(what ? `${code}: ${what}` : code) })
      }
      const applied = Array.isArray(res.body.applied) ? res.body.applied.map(String) : []
      const kept = Array.isArray(res.body.kept)
        ? res.body.kept.filter(isRecord).map(k => ({ path: said(k.path), why: said(k.why) }))
        : []
      const backup = typeof res.body.backup === 'string' ? res.body.backup : null
      o.log(
        `node bundle ${deviceId}/${profileId}: bundle ${version.seq} applied, ${sent} file(s) sent, ${applied.length} changed, ${kept.length} kept`,
      )
      return finish({ ...done, ok: true, sent, applied, kept, backup })
    } catch (err) {
      if (err instanceof Late || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')))
        return finish(not('timeout'))
      o.log(`node bundle ${deviceId}/${profileId}: ${messageOf(err)}`)
      return finish(not('node', 'error'))
    }
  }

  /** The report kept beside the version it is about. */
  function finish(r: SyncReport): SyncReport {
    const was = entryOf(profiles(r.device)[r.profile]).version
    const version = r.seq ? { seq: r.seq, hash: r.hash } : was
    if (version) save(r.device, r.profile, { version, report: r })
    return r
  }

  /** The answer when a sync did not settle in time at all. */
  function lateReport(device: string, profile: string): SyncReport {
    const nodeProfile = devices()[device]?.profiles[profile] ?? profile
    return {
      ok: false,
      device,
      profile,
      nodeProfile,
      seq: 0,
      hash: '',
      why: 'timeout',
      sent: 0,
      applied: [],
      kept: [],
      backup: null,
      lines: [],
      at: clock.now(),
    }
  }

  /** Every 5 minutes, for each device online: each profile it has that this board has too, its hash. */
  function tick(): void {
    for (const device of Object.values(devices())) {
      if (!device.link) continue
      const link = o.links.link(device.id)
      const status = link?.state().state === 'online' ? link.view().status : null
      if (!status) continue
      const theirs = new Set(status.profiles.map(p => p.id))
      for (const profile of o.profiles()) {
        const key = `${device.id}\n${profile.id}`
        if (profile.hidden || running.has(key) || !theirs.has(device.profiles[profile.id] ?? profile.id)) continue
        try {
          build(device, profile, status.platform)
        } catch (err) {
          o.log(`node bundle ${device.id}/${profile.id}: ${messageOf(err)}`)
        }
      }
    }
  }
  const timer = clock.setInterval(tick, HASH_MS)

  return {
    syncIfBehind(device, profile = DEFAULT_PROFILE) {
      const key = `${device}\n${profile}`
      const on = running.get(key)
      if (on) return on
      // A request that ignored its signal does not hold this device and profile for good.
      let guard: unknown
      const late = new Promise<SyncReport>(resolve => {
        guard = clock.setTimeout(() => resolve({ ...lateReport(device, profile) }), SYNC_TOTAL_MS + 1000)
      })
      const next = Promise.race([run(device, profile), late]).finally(() => {
        clock.clearTimeout(guard)
        running.delete(key)
      })
      running.set(key, next)
      return next
    },
    report: (device, profile) => {
      try {
        return entryOf(profiles(device)[profile]).report
      } catch {
        return null
      }
    },
    close: () => clock.clearInterval(timer),
  }
}
