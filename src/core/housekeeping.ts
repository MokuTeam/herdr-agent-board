// Node housekeeping (#652): a memory guard that safely puts idle sessions to sleep, and a sweep of
// leftover browser tabs. Pure rules only — no I/O, off by default (absent or invalid config fails
// closed). Safe rules are binding: never kill a process, never touch working/blocked/day/keep-awake
// sessions, never close leased/pinned/last/beforeunload/recent tabs, and log URL hosts only.
import type { Item } from './types.ts'
import { matchesAny } from './wake/reaper.ts'

export interface MemoryGuardConfig {
  on: boolean
  /** Warning threshold in MB; null means auto (actionMb + 1024). */
  warnMb: number | null
  /** Action threshold in MB; null means auto (node placer minFreeMemMb, else defaultThresholds). */
  actionMb: number | null
  /** Extra keep-awake names or /regex/ patterns (combined with wake.reaper.exclude). */
  exclude: string[]
  /** Optional session name or key to also deliver memory notices to (useful on headless nodes). */
  notifyTo: string | null
  /** Check interval in seconds (default 60). */
  intervalSec: number
  /** Maximum idle sessions to put to sleep in a single round (default 4). */
  maxSleepPerRound: number
}

export interface BrowserProfileConfig {
  name: string
  cdpPort?: number
}

export interface TabSweepConfig {
  on: boolean
  /** Minimum idle time before a tab is eligible to close, in minutes (default 120 = 2 hours). */
  idleMinutes: number
  /** Sweep interval in minutes (default 30). */
  intervalMin: number
  /** Local mokutab-bridge HTTP port (default 12306). */
  mokutabPort: number
  /** Optional explicit browser profiles; when empty, discovered from ~/browser/profiles/*.env and mokutab. */
  profiles: BrowserProfileConfig[]
}

export interface HousekeepingConfig {
  memory: MemoryGuardConfig
  tabs: TabSweepConfig
}

export interface MemoryThresholds {
  warnMb: number
  actionMb: number
}

export interface MemoryCandidate {
  key: string
  session: string
  pane: string
  name: string
  agent: string
  idleAt: number
  idleMin: number | null
}

export interface MemorySkipped {
  key: string
  name: string
  reason:
    | 'day-master'
    | 'call'
    | 'working'
    | 'dialog'
    | 'unknown-status'
    | 'running-helpers'
    | 'waiting-on-owner'
    | 'keep-awake'
    | 'no-session'
}

export interface MemoryPlan {
  level: 'unknown' | 'ok' | 'warn' | 'action'
  memAvailableMb: number | null
  memTotalMb: number
  thresholds: MemoryThresholds
  shouldWarn: boolean
  recovered: boolean
  candidates: MemoryCandidate[]
  skipped: MemorySkipped[]
}

export interface BrowserTabInfo {
  tabId: number
  windowId: number
  url: string
  pinned: boolean
  active: boolean
  /** Chrome's lastAccessed timestamp (ms), when reported. */
  lastAccessed: number | null
  /** Whether a beforeunload handler was already detected on this tab. */
  beforeUnload?: boolean
}

export interface TabLeaseInfo {
  profile: string
  tabId: number
}

export interface TabCloseCandidate {
  profile: string
  tabId: number
  windowId: number
  /** Host only — never exposes full URL path, query, or fragment in plans or dry-run JSON. */
  host: string
  idleMin: number
}

export interface TabKept {
  profile: string
  tabId: number
  windowId: number
  host: string
  reason: 'pinned' | 'leased' | 'beforeunload' | 'recent' | 'last-tab' | 'duplicate-url' | 'leases-unknown'
}

export interface TabSweepPlan {
  profile: string
  skippedReason?: 'leases-unknown' | 'query-failed'
  close: TabCloseCandidate[]
  kept: TabKept[]
}

export interface HousekeepingLogEntry {
  id?: number
  at: number
  kind: 'memory-warn' | 'memory-sleep' | 'memory-recover' | 'tab-close' | 'tab-skip'
  text: string
}

export interface HousekeepingDryRun {
  at: number
  config: HousekeepingConfig
  memory: MemoryPlan
  tabs: {
    profiles: TabSweepPlan[]
    note?: string
  }
}

export const DEFAULT_MEMORY_INTERVAL_SEC = 60
export const DEFAULT_MAX_SLEEP_PER_ROUND = 4
export const DEFAULT_TAB_IDLE_MIN = 120
export const DEFAULT_TAB_INTERVAL_MIN = 30
export const DEFAULT_MOKUTAB_PORT = 12306

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []

function profilesOf(v: unknown): BrowserProfileConfig[] {
  if (!Array.isArray(v)) return []
  const out: BrowserProfileConfig[] = []
  const seen = new Set<string>()
  for (const item of v) {
    const r = record(item)
    const name = typeof r?.name === 'string' ? r.name.trim() : ''
    if (!name || seen.has(name) || name.length > 64) continue
    seen.add(name)
    const cdpPort = intIn(r?.cdpPort, 1, 65535)
    out.push({ name, ...(cdpPort !== null && { cdpPort }) })
  }
  return out
}

/**
 * Parse config.json's `housekeeping` section. Off by default: absent, `false`, or malformed fails
 * closed with both memory guard and tab sweep off.
 */
export function housekeepingConfig(raw: unknown): HousekeepingConfig {
  const root = record(raw)
  const mem = record(root?.memory)
  const tabs = record(root?.tabs)
  const notifyRaw = typeof mem?.notifyTo === 'string' ? mem.notifyTo.trim() : ''
  return {
    memory: {
      on: mem?.on === true,
      warnMb: intIn(mem?.warnMb, 256, 1_048_576),
      actionMb: intIn(mem?.actionMb, 256, 1_048_576),
      exclude: stringList(mem?.exclude),
      notifyTo: notifyRaw ? notifyRaw.slice(0, 120) : null,
      intervalSec: intIn(mem?.intervalSec, 15, 3600) ?? DEFAULT_MEMORY_INTERVAL_SEC,
      maxSleepPerRound: intIn(mem?.maxSleepPerRound, 1, 20) ?? DEFAULT_MAX_SLEEP_PER_ROUND,
    },
    tabs: {
      on: tabs?.on === true,
      idleMinutes: intIn(tabs?.idleMinutes, 5, 10_080) ?? DEFAULT_TAB_IDLE_MIN,
      intervalMin: intIn(tabs?.intervalMin, 5, 1440) ?? DEFAULT_TAB_INTERVAL_MIN,
      mokutabPort: intIn(tabs?.mokutabPort, 1, 65535) ?? DEFAULT_MOKUTAB_PORT,
      profiles: profilesOf(tabs?.profiles),
    },
  }
}

/**
 * Effective memory thresholds: explicit config wins, else on a node the placer's `minFreeMemMb`
 * is the default action threshold, else `defaultThresholds(hw).minFreeMemMb`. Warning is always
 * at least actionMb (defaults to actionMb + 1024).
 */
export function resolveMemoryThresholds(
  cfg: Pick<MemoryGuardConfig, 'warnMb' | 'actionMb'>,
  hw: { memTotalMb: number; cpus: number },
  placerMinFreeMb?: number | null,
): MemoryThresholds {
  // Same hardware default formula as core/nodes.ts defaultThresholds(hw).minFreeMemMb (kept inline
  // so browser bundles importing housekeeping types/formatters never pull in core/nodes.ts or node:crypto).
  const mem = Number.isFinite(hw.memTotalMb) ? hw.memTotalMb : 0
  const hwDefault = Math.max(1024, Math.round(0.15 * mem))
  const defaultAction =
    typeof placerMinFreeMb === 'number' && Number.isFinite(placerMinFreeMb) && placerMinFreeMb >= 256
      ? Math.round(placerMinFreeMb)
      : hwDefault
  const actionMb = cfg.actionMb ?? defaultAction
  const warnMb = Math.max(actionMb, cfg.warnMb ?? actionMb + 1024)
  return { warnMb, actionMb }
}

/**
 * Plan what the memory guard would do now. Binding safe rules:
 * - Only sessions the board sees idle (`idle` or `done`, not `working`, not `blocked`, no running
 *   helpers, not waiting on an owner ask/decision).
 * - Never the owner's day master (`item.day === true`).
 * - Never sessions matching the keep-awake list (`wakeExclude` + `cfg.exclude`).
 * - Sorted longest-idle first.
 */
export function planMemoryGuard(input: {
  memAvailableMb: number | null
  memTotalMb: number
  cpus: number
  cfg: MemoryGuardConfig
  placerMinFreeMb?: number | null
  items: readonly Item[]
  wakeExclude?: readonly string[]
  warned: boolean
  now?: number
}): MemoryPlan {
  const now = input.now ?? Date.now()
  const thresholds = resolveMemoryThresholds(
    input.cfg,
    { memTotalMb: input.memTotalMb, cpus: input.cpus },
    input.placerMinFreeMb,
  )
  const exclude = [...(input.wakeExclude ?? []), ...input.cfg.exclude]
  const candidates: MemoryCandidate[] = []
  const skipped: MemorySkipped[] = []

  for (const item of input.items) {
    if (item.sleeping) continue
    const name = item.name || item.autoName || item.key.slice(0, 8)
    if (item.day) {
      skipped.push({ key: item.key, name, reason: 'day-master' })
      continue
    }
    if (item.call) {
      skipped.push({ key: item.key, name, reason: 'call' })
      continue
    }
    if (matchesAny(exclude, [item.name, item.autoName, item.workspace, item.key, item.session])) {
      skipped.push({ key: item.key, name, reason: 'keep-awake' })
      continue
    }
    if (item.status === 'working') {
      skipped.push({ key: item.key, name, reason: 'working' })
      continue
    }
    if (item.status === 'blocked') {
      skipped.push({ key: item.key, name, reason: 'dialog' })
      continue
    }
    if (item.status !== 'idle' && item.status !== 'done') {
      skipped.push({ key: item.key, name, reason: 'unknown-status' })
      continue
    }
    if ((item.helpers?.running ?? 0) > 0) {
      skipped.push({ key: item.key, name, reason: 'running-helpers' })
      continue
    }
    if (item.attention === 'decision' || item.attention === 'ask' || item.attention === 'question') {
      skipped.push({ key: item.key, name, reason: 'waiting-on-owner' })
      continue
    }
    if (!item.session || !item.pane) {
      skipped.push({ key: item.key, name, reason: 'no-session' })
      continue
    }
    const rawAt = item.activity || item.lastAt || 0
    const idleAt = typeof rawAt === 'number' && Number.isFinite(rawAt) && rawAt > 0 ? rawAt : 0
    const idleMin = idleAt > 0 ? Math.max(0, Math.round((now - idleAt) / 60_000)) : null
    candidates.push({
      key: item.key,
      session: item.session,
      pane: item.pane,
      name,
      agent: item.agent ?? 'claude',
      idleAt,
      idleMin,
    })
  }

  // Longest idle first: smallest positive idleAt first; unknown idleAt (0) goes last.
  candidates.sort((a, b) => {
    const ka = a.idleAt > 0 ? a.idleAt : Number.POSITIVE_INFINITY
    const kb = b.idleAt > 0 ? b.idleAt : Number.POSITIVE_INFINITY
    return ka - kb || a.name.localeCompare(b.name)
  })

  if (input.memAvailableMb === null || !Number.isFinite(input.memAvailableMb)) {
    return {
      level: 'unknown',
      memAvailableMb: null,
      memTotalMb: input.memTotalMb,
      thresholds,
      shouldWarn: false,
      recovered: false,
      candidates,
      skipped,
    }
  }

  const level: MemoryPlan['level'] =
    input.memAvailableMb < thresholds.actionMb ? 'action' : input.memAvailableMb < thresholds.warnMb ? 'warn' : 'ok'

  return {
    level,
    memAvailableMb: input.memAvailableMb,
    memTotalMb: input.memTotalMb,
    thresholds,
    shouldWarn: level !== 'ok' && !input.warned,
    recovered: level === 'ok' && input.warned,
    candidates,
    skipped,
  }
}

/** Format freed MB as "1.1 GB" (from 1024 MB up) or "450 MB". */
export function formatMb(mb: number): string {
  const n = Math.max(0, Math.round(mb))
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`
}

/** Human-readable summary after putting idle sessions to sleep under memory pressure. */
export function formatSleptNotice(
  sleptNames: readonly string[],
  freedMb: number,
  afterAvailMb?: number | null,
): string {
  if (!sleptNames.length) return ''
  const names = sleptNames.join(', ')
  const freed = freedMb > 0 ? ` to free ${formatMb(freedMb)}` : ''
  const after =
    typeof afterAvailMb === 'number' && Number.isFinite(afterAvailMb) ? ` (${formatMb(afterAvailMb)} available)` : ''
  return `slept ${names}${freed}${after}`
}

/** Extract host only for safe logging (never logs path, query, fragment or credentials). */
export function tabHost(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host || '(empty)'
    return u.protocol.replace(/:$/, '') || '(other)'
  } catch {
    return '(other)'
  }
}

/** Key for tracking when a tab was first/last seen across sweeps. */
export const tabSeenKey = (profile: string, tabId: number): string => `${profile}:${tabId}`

/**
 * Plan which leftover browser tabs in one profile are safe to close. Binding safe rules:
 * - Fail closed: never close any tab when mokutab lease information is unavailable.
 * - Never close a tab held by a mokutab lease.
 * - Never close pinned tabs.
 * - Never close tabs with a known beforeunload handler.
 * - Never close tabs touched within `idleMinutes`.
 * - Never close the last remaining tab of a window.
 * - Never close a tab whose exact URL is shared by another tab in the same profile (prevents
 *   ambiguous CDP target matching from touching a pinned/leased/recent/last tab).
 */
export function planTabSweep(input: {
  profile: string
  tabs: readonly BrowserTabInfo[]
  leases: readonly TabLeaseInfo[]
  leasesKnown: boolean
  idleMinutes: number
  seenAt: Readonly<Record<string, number>>
  now?: number
}): TabSweepPlan {
  const now = input.now ?? Date.now()
  const maxIdleMs = input.idleMinutes * 60_000
  const kept: TabKept[] = []
  const close: TabCloseCandidate[] = []

  if (!input.leasesKnown) {
    for (const t of input.tabs) {
      kept.push({
        profile: input.profile,
        tabId: t.tabId,
        windowId: t.windowId,
        host: tabHost(t.url),
        reason: 'leases-unknown',
      })
    }
    return { profile: input.profile, skippedReason: 'leases-unknown', close, kept }
  }

  const leasedTabs = new Set(input.leases.filter(l => l.profile === input.profile).map(l => l.tabId))
  const remainingByWindow = new Map<number, number>()
  const urlCount = new Map<string, number>()
  for (const t of input.tabs) {
    remainingByWindow.set(t.windowId, (remainingByWindow.get(t.windowId) ?? 0) + 1)
    urlCount.set(t.url, (urlCount.get(t.url) ?? 0) + 1)
  }

  // Order oldest-touched first so if a window has N > 1 eligible tabs, the newest one survives as last tab.
  const ordered = [...input.tabs].sort((a, b) => {
    const ta = a.lastAccessed ?? input.seenAt[tabSeenKey(input.profile, a.tabId)] ?? now
    const tb = b.lastAccessed ?? input.seenAt[tabSeenKey(input.profile, b.tabId)] ?? now
    return ta - tb || a.tabId - b.tabId
  })

  for (const t of ordered) {
    const host = tabHost(t.url)
    if (t.pinned) {
      kept.push({ profile: input.profile, tabId: t.tabId, windowId: t.windowId, host, reason: 'pinned' })
      continue
    }
    if (leasedTabs.has(t.tabId)) {
      kept.push({ profile: input.profile, tabId: t.tabId, windowId: t.windowId, host, reason: 'leased' })
      continue
    }
    if (t.beforeUnload) {
      kept.push({ profile: input.profile, tabId: t.tabId, windowId: t.windowId, host, reason: 'beforeunload' })
      continue
    }
    const touchedAt = t.lastAccessed ?? input.seenAt[tabSeenKey(input.profile, t.tabId)] ?? now
    const idleMs = Math.max(0, now - touchedAt)
    if (idleMs < maxIdleMs) {
      kept.push({ profile: input.profile, tabId: t.tabId, windowId: t.windowId, host, reason: 'recent' })
      continue
    }
    if ((urlCount.get(t.url) ?? 0) > 1) {
      kept.push({ profile: input.profile, tabId: t.tabId, windowId: t.windowId, host, reason: 'duplicate-url' })
      continue
    }
    const left = remainingByWindow.get(t.windowId) ?? 0
    if (left <= 1) {
      kept.push({ profile: input.profile, tabId: t.tabId, windowId: t.windowId, host, reason: 'last-tab' })
      continue
    }
    remainingByWindow.set(t.windowId, left - 1)
    close.push({
      profile: input.profile,
      tabId: t.tabId,
      windowId: t.windowId,
      host,
      idleMin: Math.round(idleMs / 60_000),
    })
  }

  return { profile: input.profile, close, kept }
}

/** Human-readable lines for `board housekeeping --dry-run`. */
export function formatDryRun(report: HousekeepingDryRun): string[] {
  const lines: string[] = []
  const m = report.memory
  const avail = m.memAvailableMb === null ? 'unknown' : formatMb(m.memAvailableMb)
  lines.push(
    `memory guard (${report.config.memory.on ? 'on' : 'off'}): ${avail} available / ${formatMb(m.memTotalMb)} total · warn < ${formatMb(m.thresholds.warnMb)} · action < ${formatMb(m.thresholds.actionMb)} · state: ${m.level}`,
  )
  if (m.level === 'action') {
    if (m.candidates.length) {
      lines.push(
        `  would sleep (longest idle first): ${m.candidates.map(c => `${c.name}${c.idleMin !== null ? ` (${c.idleMin}m idle)` : ''}`).join(', ')}`,
      )
    } else {
      lines.push('  would sleep: none (no eligible idle sessions)')
    }
  } else if (m.candidates.length) {
    lines.push(
      `  eligible if below action threshold: ${m.candidates.map(c => `${c.name}${c.idleMin !== null ? ` (${c.idleMin}m idle)` : ''}`).join(', ')}`,
    )
  }
  if (m.skipped.length) {
    lines.push(`  protected: ${m.skipped.map(s => `${s.name} (${s.reason})`).join(', ')}`)
  }

  lines.push(
    `browser tabs (${report.config.tabs.on ? 'on' : 'off'}): idle >= ${report.config.tabs.idleMinutes} min · every ${report.config.tabs.intervalMin} min`,
  )
  if (report.tabs.note) lines.push(`  note: ${report.tabs.note}`)
  if (!report.tabs.profiles.length) {
    lines.push('  no browser profiles inspected')
  }
  for (const p of report.tabs.profiles) {
    if (p.skippedReason) {
      lines.push(`  profile ${p.profile}: skipped (${p.skippedReason})`)
      continue
    }
    const closeDesc = p.close.length ? p.close.map(c => `${c.host} (${c.idleMin}m idle)`).join(', ') : 'none'
    lines.push(`  profile ${p.profile}: would close ${p.close.length} (${closeDesc}); keeping ${p.kept.length}`)
  }
  return lines
}
