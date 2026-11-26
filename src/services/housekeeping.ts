// Housekeeping service (#652): periodic memory guard (every minute) and leftover browser tab sweep
// (every 30 minutes), both strictly OFF by default. Safe rules are enforced at runtime:
// - Never kills a process: sleeps idle sessions only through the existing safe sleep path (sleepMany).
// - Never touches working/blocked/day/keep-awake sessions.
// - Never closes pinned, leased, last-in-window, recent, or beforeunload tabs; logs URL host only.
import { hostname } from 'node:os'
import { notify } from '../adapters/herdr.ts'
import {
  type BrowserInspection,
  closeBrowserTabSafely,
  housekeepingTabsFile,
  inspectBrowsers,
  readTabSeen,
  type TabCloseOutcome,
  updateTabSeen,
} from '../adapters/housekeeping-browser.ts'
import { pace } from '../adapters/pacing.ts'
import { addEntry } from '../adapters/schedule-store.ts'
import { type SysLoad, sysLoad } from '../adapters/sysload.ts'
import {
  formatMb,
  formatSleptNotice,
  type HousekeepingConfig,
  type HousekeepingDryRun,
  type HousekeepingLogEntry,
  housekeepingConfig,
  planMemoryGuard,
  planTabSweep,
} from '../core/housekeeping.ts'
import { nodesConfig, parseNodeKey } from '../core/nodes.ts'
import type { Config, Item } from '../core/types.ts'
import { wakeConfig } from '../core/wake/config.ts'
import type { Deps } from './deps.ts'
import { type SleepOutcome, sleepMany } from './sleep.ts'
import { type Clock, realClock } from './tunnel.ts'

export interface HousekeepingView {
  config: HousekeepingConfig
  warned: boolean
  lastMemoryAt: number | null
  lastTabsAt: number | null
  lastMemAvailableMb: number | null
  lastMemTotalMb: number | null
  log: HousekeepingLogEntry[]
}

export interface Housekeeping {
  /**
   * Reload timers when config.json changes (zero timers when both switches are off).
   * Pass `next` after writing config.json directly so `sync()` and `view()` see the update at once
   * without waiting for the config watcher debounce.
   */
  sync(next?: Config['housekeeping']): void
  /** Run one memory-guard check now (no-op unless `force` or `config.memory.on`). */
  checkMemory(force?: boolean): Promise<void>
  /** Run one browser-tab sweep now (no-op unless `force` or `config.tabs.on`). */
  sweepTabs(force?: boolean): Promise<void>
  /** Read-only dry run of both memory guard and tab sweep (never sleeps or closes anything). */
  dryRun(): Promise<HousekeepingDryRun>
  view(): HousekeepingView
  close(): void
}

export interface HousekeepingOptions {
  deps: Deps
  items(): Item[]
  log(text: string): void
  /** Set false for one-shot read-only callers (`board housekeeping --dry-run`) so no timers arm. */
  timers?: boolean
  clock?: Clock
  load?: () => Promise<SysLoad>
  sleep?: (deps: Deps, items: readonly Item[], targets: readonly string[]) => Promise<SleepOutcome[]>
  sendNotice?: (title: string, body: string) => Promise<void>
  /** Queue a reminder onto a local session card (e.g. MokuPilot day session / away channel). */
  deliverToSession?: (item: Item, text: string, now: number) => void
  /** Forward a notice to `notifyTo` on the master over node uplink when not matched locally. */
  notifyRemote?: (target: string, text: string) => Promise<void>
  inspect?: (opts: {
    mokutabPort: number
    configuredProfiles: HousekeepingConfig['tabs']['profiles']
  }) => Promise<BrowserInspection>
  closeTab?: (opts: { cdpPort?: number; url: string }) => Promise<TabCloseOutcome>
  seenFile?: string
  hostName?: string
}

const LOG_MAX = 40

/**
 * Default placer minFreeMemMb from config.json when present:
 * - On a master: `nodes.devices.local.minFreeMemMb`.
 * - On a standalone node whose config.json holds only `node` (not the master's `nodes` table):
 *   returns `null`, so `resolveMemoryThresholds` falls back to `defaultThresholds(hw).minFreeMemMb`
 *   (the same default formula the placer uses) unless `housekeeping.memory.actionMb` is explicitly set.
 */
function placerMinFreeOf(cfg: Config): number | null {
  const n = nodesConfig(cfg.nodes)
  const local = n?.devices.local
  if (local && typeof local.minFreeMemMb === 'number') return local.minFreeMemMb
  return null
}

function matchNotifyItem(items: readonly Item[], target: string): Item | undefined {
  const low = target.trim().toLowerCase()
  if (!low) return undefined
  return items.find(
    i =>
      i.key.toLowerCase() === low ||
      i.session?.toLowerCase() === low ||
      (i.name && i.name.toLowerCase() === low) ||
      (i.autoName && i.autoName.toLowerCase() === low),
  )
}

export function createHousekeeping(o: HousekeepingOptions): Housekeeping {
  const clock = o.clock ?? realClock
  const armTimers = o.timers !== false
  const load = o.load ?? sysLoad
  const sleep = o.sleep ?? ((deps, items, targets) => sleepMany(deps, items, targets, { by: 'housekeeping' }))
  const sendDesktopNotice = o.sendNotice ?? ((title, body) => notify(title, body).catch(() => {}))
  const deliverToSession =
    o.deliverToSession ??
    ((item, text, now) => {
      const local = !parseNodeKey(item.key)
      addEntry({
        key: item.key,
        name: item.name || item.autoName || item.key.slice(0, 8),
        ...(local && item.pane && { pane: item.pane }),
        ...(local && item.cwd && { cwd: item.cwd }),
        text,
        at: now,
        next: now,
        by: 'housekeeping',
        from: { key: 'housekeeping', name: 'housekeeping' },
      })
    })
  const inspect = o.inspect ?? (opts => inspectBrowsers(opts))
  const closeTab = o.closeTab ?? closeBrowserTabSafely
  const seenFile = o.seenFile ?? housekeepingTabsFile()
  const host = o.hostName ?? hostname()

  let memTimer: unknown = null
  let tabTimer: unknown = null
  let memIntervalMs = 0
  let tabIntervalMs = 0
  let memBusy = false
  let tabBusy = false
  let closed = false

  let warned = false
  let lastMemoryAt: number | null = null
  let lastTabsAt: number | null = null
  let lastMemAvailableMb: number | null = null
  let lastMemTotalMb: number | null = null
  let nextEntryId = 1
  const entries: HousekeepingLogEntry[] = []

  const cfgNow = (): HousekeepingConfig => housekeepingConfig(o.deps.cfg.housekeeping)

  function record(kind: HousekeepingLogEntry['kind'], text: string): void {
    entries.unshift({ id: nextEntryId++, at: clock.now(), kind, text })
    if (entries.length > LOG_MAX) entries.length = LOG_MAX
    o.log(`housekeeping: ${text}`)
  }

  /**
   * Deliver one notice to the owner:
   * 1. Local herdr desktop notification (best-effort; harmless on headless nodes).
   * 2. Card of the board's master/day session (`item.day`, which MokuPilot also relays when away)
   *    and/or an explicitly configured `housekeeping.memory.notifyTo` session (local or via node uplink).
   */
  async function notifyOwner(title: string, body: string, cfg: HousekeepingConfig, now: number): Promise<void> {
    await sendDesktopNotice(title, body)
    const items = o.items()
    const delivered = new Set<string>()
    const day = items.find(i => i.day)
    if (day) {
      try {
        deliverToSession(day, body, now)
        delivered.add(day.key)
      } catch (err) {
        o.log(`housekeeping notice (day): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const targetName = cfg.memory.notifyTo
    if (targetName) {
      const localTarget = matchNotifyItem(items, targetName)
      if (localTarget && !delivered.has(localTarget.key)) {
        try {
          deliverToSession(localTarget, body, now)
          delivered.add(localTarget.key)
        } catch (err) {
          o.log(`housekeeping notice (${targetName}): ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (!localTarget && o.notifyRemote) {
        await o.notifyRemote(targetName, body).catch(err => {
          o.log(`housekeeping notice (remote ${targetName}): ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }
  }

  async function checkMemory(force = false): Promise<void> {
    if (closed || memBusy) return
    const cfg = cfgNow()
    if (!force && !cfg.memory.on) return
    memBusy = true
    try {
      const hw = await load()
      const now = clock.now()
      lastMemoryAt = now
      lastMemAvailableMb = hw.memAvailableMb
      lastMemTotalMb = hw.memTotalMb
      const wakeExclude = wakeConfig(o.deps.cfg.wake).reaper.exclude
      const plan = planMemoryGuard({
        memAvailableMb: hw.memAvailableMb,
        memTotalMb: hw.memTotalMb,
        cpus: hw.cpus,
        cfg: cfg.memory,
        placerMinFreeMb: placerMinFreeOf(o.deps.cfg),
        items: o.items(),
        wakeExclude,
        warned,
        now,
      })

      if (plan.recovered) {
        warned = false
        record('memory-recover', `memory recovered on ${host} (${formatMb(hw.memAvailableMb ?? 0)} available)`)
        return
      }

      if (plan.level === 'warn' && plan.shouldWarn) {
        warned = true
        const msg = `Low memory on ${host}: ${formatMb(hw.memAvailableMb ?? 0)} available (warning below ${formatMb(plan.thresholds.warnMb)})`
        record('memory-warn', msg)
        await notifyOwner('Housekeeping: low memory', msg, cfg, now)
        return
      }

      if (plan.level !== 'action') return

      // Below action threshold: put idle sessions to sleep one by one (longest idle first) via the
      // existing safe sleep path until available memory is back above the action threshold, capping
      // actual sleeps (not skipped/'kept' outcomes) at `maxSleepPerRound`.
      const beforeAvail = hw.memAvailableMb ?? 0
      const slept: string[] = []
      let afterAvail: number | null = beforeAvail

      for (const candidate of plan.candidates) {
        if (closed || slept.length >= cfg.memory.maxSleepPerRound) break
        const outcomes = await sleep(o.deps, o.items(), [candidate.key])
        if (outcomes[0]?.result === 'asleep') {
          slept.push(candidate.name)
          const check = await load()
          lastMemAvailableMb = check.memAvailableMb
          afterAvail = check.memAvailableMb
          if (afterAvail !== null && afterAvail >= plan.thresholds.actionMb) break
        }
      }

      if (slept.length) {
        const freedMb = afterAvail !== null ? Math.max(0, afterAvail - beforeAvail) : 0
        const summary = formatSleptNotice(slept, freedMb, afterAvail)
        warned = afterAvail === null || afterAvail < plan.thresholds.warnMb
        record('memory-sleep', `${host}: ${summary}`)
        await notifyOwner('Housekeeping: slept idle sessions', `${host}: ${summary}`, cfg, now)
      } else if (plan.shouldWarn) {
        warned = true
        const msg = `Low memory on ${host}: ${formatMb(beforeAvail)} available (action < ${formatMb(plan.thresholds.actionMb)}), no eligible idle sessions to sleep`
        record('memory-warn', msg)
        await notifyOwner('Housekeeping: low memory', msg, cfg, now)
      }
    } catch (err) {
      o.log(`housekeeping memory: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      memBusy = false
    }
  }

  async function sweepTabs(force = false): Promise<void> {
    if (closed || tabBusy) return
    const cfg = cfgNow()
    if (!force && !cfg.tabs.on) return
    tabBusy = true
    try {
      const now = clock.now()
      lastTabsAt = now
      const browser = await inspect({
        mokutabPort: cfg.tabs.mokutabPort,
        configuredProfiles: cfg.tabs.profiles,
      })
      const prevSeen = readTabSeen(seenFile)
      const seenAt = updateTabSeen(prevSeen, browser.profiles, now, seenFile, true, browser.reachable)

      for (const profile of browser.profiles) {
        if (profile.error) {
          record('tab-skip', `profile ${profile.name}: skipped (query-failed)`)
          continue
        }
        const plan = planTabSweep({
          profile: profile.name,
          tabs: profile.tabs,
          leases: browser.leases,
          leasesKnown: browser.leasesKnown,
          idleMinutes: cfg.tabs.idleMinutes,
          seenAt,
          now,
        })
        if (plan.skippedReason) {
          record('tab-skip', `profile ${profile.name}: skipped (${plan.skippedReason})`)
          continue
        }
        const urlByTabId = new Map(profile.tabs.map(t => [t.tabId, t.url]))
        for (const tab of plan.close) {
          if (closed) break
          const url = urlByTabId.get(tab.tabId)
          if (!url) continue
          const res = await closeTab({
            ...(profile.cdpPort !== undefined && { cdpPort: profile.cdpPort }),
            url,
          })
          if (res.closed) {
            record('tab-close', `closed idle tab in ${profile.name} (host: ${tab.host}, ${tab.idleMin}m idle)`)
          } else {
            const extra = res.detail ? `: ${res.detail}` : ''
            record('tab-skip', `kept tab in ${profile.name} (host: ${tab.host}: ${res.reason}${extra})`)
          }
        }
      }
    } catch (err) {
      o.log(`housekeeping tabs: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      tabBusy = false
    }
  }

  async function dryRun(): Promise<HousekeepingDryRun> {
    const cfg = cfgNow()
    const now = clock.now()
    const [hw, browser] = await Promise.all([
      load(),
      inspect({
        mokutabPort: cfg.tabs.mokutabPort,
        configuredProfiles: cfg.tabs.profiles,
      }).catch(
        (err): BrowserInspection => ({
          reachable: false,
          leasesKnown: false,
          leases: [],
          profiles: [],
          note: err instanceof Error ? err.message : String(err),
        }),
      ),
    ])
    const wakeExclude = wakeConfig(o.deps.cfg.wake).reaper.exclude
    const memory = planMemoryGuard({
      memAvailableMb: hw.memAvailableMb,
      memTotalMb: hw.memTotalMb,
      cpus: hw.cpus,
      cfg: cfg.memory,
      placerMinFreeMb: placerMinFreeOf(o.deps.cfg),
      items: o.items(),
      wakeExclude,
      warned,
      now,
    })
    const prevSeen = readTabSeen(seenFile)
    const seenAt = updateTabSeen(prevSeen, browser.profiles, now, seenFile, false, browser.reachable)
    const profiles = browser.profiles.map(p =>
      p.error
        ? { profile: p.name, skippedReason: 'query-failed' as const, close: [], kept: [] }
        : planTabSweep({
            profile: p.name,
            tabs: p.tabs,
            leases: browser.leases,
            leasesKnown: browser.leasesKnown,
            idleMinutes: cfg.tabs.idleMinutes,
            seenAt,
            now,
          }),
    )
    return {
      at: now,
      config: cfg,
      memory,
      tabs: {
        profiles,
        ...(browser.note && { note: browser.note }),
      },
    }
  }

  function sync(...args: [] | [Config['housekeeping']]): void {
    if (args.length > 0) o.deps.cfg.housekeeping = args[0]
    if (closed || !armTimers) return
    const cfg = cfgNow()
    const wantMemMs = cfg.memory.on ? Math.max(20, Math.round(cfg.memory.intervalSec * 1000 * pace())) : 0
    if (wantMemMs !== memIntervalMs) {
      if (memTimer !== null) {
        clock.clearInterval(memTimer)
        memTimer = null
      }
      memIntervalMs = wantMemMs
      if (wantMemMs > 0) memTimer = clock.setInterval(() => void checkMemory(), wantMemMs)
    }

    const wantTabMs = cfg.tabs.on ? Math.max(20, Math.round(cfg.tabs.intervalMin * 60_000 * pace())) : 0
    if (wantTabMs !== tabIntervalMs) {
      if (tabTimer !== null) {
        clock.clearInterval(tabTimer)
        tabTimer = null
      }
      tabIntervalMs = wantTabMs
      if (wantTabMs > 0) tabTimer = clock.setInterval(() => void sweepTabs(), wantTabMs)
    }
  }

  sync()

  return {
    sync,
    checkMemory,
    sweepTabs,
    dryRun,
    view: () => ({
      config: cfgNow(),
      warned,
      lastMemoryAt,
      lastTabsAt,
      lastMemAvailableMb,
      lastMemTotalMb,
      log: [...entries],
    }),
    close() {
      closed = true
      if (memTimer !== null) {
        clock.clearInterval(memTimer)
        memTimer = null
      }
      if (tabTimer !== null) {
        clock.clearInterval(tabTimer)
        tabTimer = null
      }
    },
  }
}
