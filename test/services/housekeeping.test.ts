// Node housekeeping service, browser profile discovery, dry-run, and config editing (#652).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editHousekeeping, loadConfig } from '../../src/adapters/config-file.ts'
import { discoverBrowserProfiles } from '../../src/adapters/housekeeping-browser.ts'
import type { Item } from '../../src/core/types.ts'
import type { Deps } from '../../src/services/deps.ts'
import { createHousekeeping } from '../../src/services/housekeeping.ts'
import type { SleepOutcome } from '../../src/services/sleep.ts'
import { isolatedHome } from '../support/env.ts'

const dirs: string[] = []
function makeDir(prefix = 'hk-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const NOW = 1_780_000_000_000
const MIN = 60_000

const item = (key: string, over: Partial<Item> = {}): Item =>
  ({
    key,
    session: key,
    pane: `w1:p-${key}`,
    workspace: 'Work',
    cwd: '/work',
    status: 'idle',
    name: key,
    autoName: key,
    category: 'work',
    categorySet: false,
    column: 'idle',
    attention: '',
    agent: 'claude',
    activity: NOW - 60 * MIN,
    ...over,
  }) as Item

describe('createHousekeeping', () => {
  test('off by default: schedules zero timers and runs nothing', async () => {
    let intervals = 0
    let loadCalls = 0
    let inspectCalls = 0
    const hk = createHousekeeping({
      deps: { cfg: {} } as unknown as Deps,
      items: () => [],
      log: () => {},
      clock: {
        now: () => NOW,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: () => {
          intervals++
          return 1
        },
        clearInterval: () => {},
      },
      load: async () => {
        loadCalls++
        return { cpus: 8, memTotalMb: 16_000, memAvailableMb: 1000, load: [0.5, 0.5, 0.5] }
      },
      inspect: async () => {
        inspectCalls++
        return { reachable: true, leasesKnown: true, leases: [], profiles: [] }
      },
    })
    await hk.checkMemory()
    await hk.sweepTabs()
    hk.close()
    expect(intervals).toBe(0)
    expect(loadCalls).toBe(0)
    expect(inspectCalls).toBe(0)
  })

  test('timers: false (offline --dry-run) arms zero timers even when enabled in config.json', () => {
    let intervals = 0
    const hk = createHousekeeping({
      deps: { cfg: { housekeeping: { memory: { on: true }, tabs: { on: true } } } } as unknown as Deps,
      items: () => [],
      log: () => {},
      timers: false,
      clock: {
        now: () => NOW,
        setTimeout,
        clearTimeout,
        setInterval: () => {
          intervals++
          return 1
        },
        clearInterval: () => {},
      },
    })
    hk.sync({ memory: { on: true }, tabs: { on: true } })
    hk.close()
    expect(intervals).toBe(0)
  })

  test('memory guard warns once until recovery, delivers to day session + notifyTo, skips kept sessions, and sleeps longest-idle until above actionMb', async () => {
    let availMb = 3100
    const sleptTargets: string[] = []
    const notices: [string, string][] = []
    const delivered: [string, string][] = []
    const remoteNotices: [string, string][] = []
    const logs: string[] = []
    const items = [
      item('day-1', { status: 'idle', day: true, activity: NOW - 240 * MIN }),
      item('working', { status: 'working', activity: NOW - 200 * MIN }),
      item('codex-old', { status: 'idle', agent: 'codex', activity: NOW - 150 * MIN }),
      item('anna', { status: 'idle', activity: NOW - 120 * MIN }),
      item('ben', { status: 'idle', activity: NOW - 90 * MIN }),
      item('cara', { status: 'idle', activity: NOW - 30 * MIN }),
    ]

    const hk = createHousekeeping({
      deps: {
        cfg: {
          housekeeping: {
            memory: { on: true, warnMb: 3500, actionMb: 2500, maxSleepPerRound: 2, notifyTo: 'Master-Remote' },
          },
        },
      } as unknown as Deps,
      items: () => items,
      log: l => logs.push(l),
      hostName: 'server-2',
      clock: {
        now: () => NOW,
        setTimeout,
        clearTimeout,
        setInterval: () => 1,
        clearInterval: () => {},
      },
      load: async () => ({ cpus: 8, memTotalMb: 16_000, memAvailableMb: availMb, load: [0.4, 0.4, 0.4] }),
      sleep: async (_deps, _items, targets): Promise<SleepOutcome[]> => {
        const target = targets[0] as string
        // codex-old is kept (notClaude) and must not count toward maxSleepPerRound!
        if (target === 'codex-old') return [{ target, result: 'kept', why: 'notClaude' }]
        sleptTargets.push(target)
        availMb += 550
        return [{ target, result: 'asleep' }]
      },
      sendNotice: async (title, body) => {
        notices.push([title, body])
      },
      deliverToSession: (target, text) => {
        delivered.push([target.key, text])
      },
      notifyRemote: async (target, text) => {
        remoteNotices.push([target, text])
      },
    })

    // 1. Below warning threshold: warns once, delivers to desktop + day session + remote notifyTo.
    await hk.checkMemory()
    await hk.checkMemory()
    expect(notices).toHaveLength(1)
    expect(notices[0]?.[1]).toContain('Low memory on server-2')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.[0]).toBe('day-1')
    expect(remoteNotices).toHaveLength(1)
    expect(remoteNotices[0]?.[0]).toBe('Master-Remote')
    expect(sleptTargets).toEqual([])

    // 2. Drops below action threshold (1600 MB < 2500 MB): codex-old kept, sleeps anna (+550 -> 2150) then ben (+550 -> 2700 >= 2500), stops before cara!
    availMb = 1600
    await hk.checkMemory()
    expect(sleptTargets).toEqual(['anna', 'ben'])
    expect(notices).toHaveLength(2)
    expect(notices[1]?.[1]).toContain('slept anna, ben to free 1.1 GB')
    expect(delivered).toHaveLength(2)

    // 3. Recovers above warnMb -> clears warned state, logs recovery.
    availMb = 4200
    await hk.checkMemory()
    expect(hk.view().warned).toBe(false)
    hk.close()
  })

  test('tab sweep closes only eligible tabs, keeps beforeunload/error tabs with logs, logs host only, and dryRun touches nothing', async () => {
    const dir = makeDir()
    const seenFile = join(dir, 'tabs-seen.json')
    const closedUrls: string[] = []
    const logs: string[] = []

    const hk = createHousekeeping({
      deps: {
        cfg: { housekeeping: { tabs: { on: true, idleMinutes: 120 } } },
      } as unknown as Deps,
      items: () => [item('worker', { status: 'working' })],
      log: l => logs.push(l),
      seenFile,
      clock: {
        now: () => NOW,
        setTimeout,
        clearTimeout,
        setInterval: () => 1,
        clearInterval: () => {},
      },
      load: async () => ({ cpus: 8, memTotalMb: 16_000, memAvailableMb: 7000, load: [0.2, 0.2, 0.2] }),
      inspect: async () => ({
        reachable: true,
        leasesKnown: true,
        leases: [{ profile: 'bsd', tabId: 1 }],
        profiles: [
          {
            name: 'bsd',
            cdpPort: 9223,
            tabs: [
              {
                tabId: 1,
                windowId: 1,
                url: 'https://leased.example.com/secret',
                pinned: false,
                active: false,
                lastAccessed: NOW - 300 * MIN,
              },
              {
                tabId: 2,
                windowId: 1,
                url: 'https://close-me.example.com/private?token=abc',
                pinned: false,
                active: false,
                lastAccessed: NOW - 200 * MIN,
              },
              {
                tabId: 3,
                windowId: 1,
                url: 'https://unsaved.example.com/edit',
                pinned: false,
                active: false,
                lastAccessed: NOW - 250 * MIN,
              },
              {
                tabId: 4,
                windowId: 1,
                url: 'https://keep.example.com/home',
                pinned: true,
                active: true,
                lastAccessed: NOW - 300 * MIN,
              },
            ],
          },
        ],
      }),
      closeTab: async ({ url }) => {
        if (url.includes('unsaved.example.com')) return { closed: false, reason: 'beforeunload' }
        closedUrls.push(url)
        return { closed: true }
      },
    })

    // Dry run first: closes NOTHING and exposes NO full URLs in JSON.
    const dry = await hk.dryRun()
    expect(closedUrls).toEqual([])
    expect(dry.tabs.profiles[0]?.close.map(c => c.host)).toEqual(['unsaved.example.com', 'close-me.example.com'])
    expect(JSON.stringify(dry)).not.toContain('token=abc')

    // Real sweep: closes close-me, respects beforeunload on unsaved, logs hosts only (no query/token!).
    await hk.sweepTabs()
    expect(closedUrls).toEqual(['https://close-me.example.com/private?token=abc'])
    expect(logs.join('\n')).toContain('host: close-me.example.com')
    expect(logs.join('\n')).toContain('beforeunload')
    expect(logs.join('\n')).not.toContain('token=abc')
    hk.close()
  })

  test('discoverBrowserProfiles parses ~/browser/profiles/*.env and editHousekeeping validates and prunes settings', () => {
    const home = makeDir('hk-home-')
    const profDir = join(home, 'browser', 'profiles')
    mkdirSync(profDir, { recursive: true })
    writeFileSync(join(profDir, 'bsd.env'), 'PROFILE=bsd\nCDP_PORT=9223\nMOKUTAB_PORT=12306\n')
    writeFileSync(join(profDir, 'bb.env'), 'PROFILE=bb\nCDP_PORT=9224\n')
    expect(discoverBrowserProfiles(home)).toEqual([
      { name: 'bb', cdpPort: 9224 },
      { name: 'bsd', cdpPort: 9223, mokutabPort: 12306 },
    ])

    isolatedHome()
    expect(editHousekeeping({ memory: { on: 'yes' } }).ok).toBe(false)
    expect(editHousekeeping({ memory: { warnMb: 50 } }).ok).toBe(false)
    expect(editHousekeeping({ memory: { warnMb: 1500, actionMb: 2500 } }).ok).toBe(false)
    expect(
      editHousekeeping({ memory: { on: true, warnMb: 3500, actionMb: 2500 }, tabs: { on: true, idleMinutes: 90 } }).ok,
    ).toBe(true)
    expect(loadConfig().housekeeping).toEqual({
      memory: { on: true, warnMb: 3500, actionMb: 2500 },
      tabs: { on: true, idleMinutes: 90 },
    })
    // Turning everything back off and clearing overrides prunes empty housekeeping section.
    expect(
      editHousekeeping({
        memory: { on: false, warnMb: null, actionMb: null },
        tabs: { on: false, idleMinutes: null },
      }).ok,
    ).toBe(true)
    expect(loadConfig().housekeeping).toBeUndefined()
  })
})
