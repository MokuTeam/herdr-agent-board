// Node housekeeping pure rules (#652): off by default, binding memory-guard safety rules,
// longest-idle ordering, warning hysteresis, and browser tab sweep safety rules (host-only logging).
import { describe, expect, test } from 'bun:test'
import {
  formatDryRun,
  formatMb,
  formatSleptNotice,
  housekeepingConfig,
  planMemoryGuard,
  planTabSweep,
  resolveMemoryThresholds,
  tabHost,
} from '../../src/core/housekeeping.ts'
import { localOnly } from '../../src/core/remote.ts'
import type { Item } from '../../src/core/types.ts'

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
    activity: NOW - 30 * MIN,
    ...over,
  }) as Item

describe('housekeepingConfig & thresholds', () => {
  test('off by default; absent, false, or malformed fails closed', () => {
    for (const raw of [undefined, null, false, true, 'on', 42, [], { memory: 'yes', tabs: 1 }]) {
      const cfg = housekeepingConfig(raw)
      expect(cfg.memory.on).toBe(false)
      expect(cfg.tabs.on).toBe(false)
      expect(cfg.memory.intervalSec).toBe(60)
      expect(cfg.tabs.idleMinutes).toBe(120)
      expect(cfg.tabs.intervalMin).toBe(30)
    }
  })

  test('resolves thresholds: explicit config > node placer minFreeMemMb > hardware default, warn >= action', () => {
    const hw = { memTotalMb: 16_000, cpus: 8 }
    expect(resolveMemoryThresholds({ warnMb: null, actionMb: null }, hw)).toEqual({ actionMb: 2400, warnMb: 3424 })
    expect(resolveMemoryThresholds({ warnMb: null, actionMb: null }, hw, 3000)).toEqual({
      actionMb: 3000,
      warnMb: 4024,
    })
    // warnMb below actionMb is clamped up to actionMb.
    expect(resolveMemoryThresholds({ warnMb: 1500, actionMb: 2500 }, hw, 3000)).toEqual({
      actionMb: 2500,
      warnMb: 2500,
    })
  })
})

describe('planMemoryGuard (binding safe rules)', () => {
  const cfg = housekeepingConfig({ memory: { on: true, actionMb: 2500, warnMb: 3500, exclude: ['/^keep-/'] } }).memory

  test('never touches working, blocked, unknown, running-helpers, waiting-on-owner, day-master, keep-awake, or sleeping', () => {
    const plan = planMemoryGuard({
      memAvailableMb: 1800,
      memTotalMb: 16_000,
      cpus: 8,
      cfg,
      warned: false,
      now: NOW,
      wakeExclude: ['Agent-board Master'],
      items: [
        item('working-1', { status: 'working', activity: NOW - 120 * MIN }),
        item('dialog-1', { status: 'blocked', activity: NOW - 120 * MIN }),
        item('unknown-1', { status: 'unknown', activity: NOW - 120 * MIN }),
        item('helpers-1', {
          status: 'idle',
          activity: NOW - 120 * MIN,
          helpers: { running: 1, total: 1, workflows: 0, live: [], at: NOW },
        }),
        item('asking-1', { status: 'idle', attention: 'ask', activity: NOW - 120 * MIN }),
        item('question-1', { status: 'idle', attention: 'question', activity: NOW - 120 * MIN }),
        item('call-1', {
          status: 'idle',
          call: { phase: 'on', since: NOW, parent: null, helpers: null, tasks: [] },
          activity: NOW - 120 * MIN,
        }),
        item('day-1', { status: 'idle', day: true, activity: NOW - 180 * MIN }),
        item('master-1', { name: 'Agent-board Master', status: 'idle', activity: NOW - 180 * MIN }),
        item('keep-regex', { name: 'keep-important', status: 'idle', activity: NOW - 180 * MIN }),
        item('sleeping-1', { status: 'sleeping', sleeping: true, activity: NOW - 300 * MIN }),
        item('no-pane', { status: 'idle', pane: null, activity: NOW - 180 * MIN }),
        item('ben', { status: 'idle', activity: NOW - 45 * MIN }),
        item('anna', { status: 'done', activity: NOW - 90 * MIN }),
        item('cara', { status: 'idle', activity: 0 }),
      ],
    })

    expect(plan.level).toBe('action')
    expect(plan.shouldWarn).toBe(true)
    // Eligible idle sessions ordered longest idle first; unknown idle time goes last.
    expect(plan.candidates.map(c => c.name)).toEqual(['anna', 'ben', 'cara'])
    expect(plan.skipped.map(s => [s.name, s.reason])).toEqual([
      ['working-1', 'working'],
      ['dialog-1', 'dialog'],
      ['unknown-1', 'unknown-status'],
      ['helpers-1', 'running-helpers'],
      ['asking-1', 'waiting-on-owner'],
      ['question-1', 'waiting-on-owner'],
      ['call-1', 'call'],
      ['day-1', 'day-master'],
      ['Agent-board Master', 'keep-awake'],
      ['keep-important', 'keep-awake'],
      ['no-pane', 'no-session'],
    ])
  })

  test('warning fires once until recovery; null memAvailableMb stays unknown (never 0)', () => {
    const warn1 = planMemoryGuard({ memAvailableMb: 3000, memTotalMb: 16_000, cpus: 8, cfg, items: [], warned: false })
    expect([warn1.level, warn1.shouldWarn, warn1.recovered]).toEqual(['warn', true, false])

    const warn2 = planMemoryGuard({ memAvailableMb: 2900, memTotalMb: 16_000, cpus: 8, cfg, items: [], warned: true })
    expect([warn2.level, warn2.shouldWarn, warn2.recovered]).toEqual(['warn', false, false])

    const back = planMemoryGuard({ memAvailableMb: 4000, memTotalMb: 16_000, cpus: 8, cfg, items: [], warned: true })
    expect([back.level, back.shouldWarn, back.recovered]).toEqual(['ok', false, true])

    const unk = planMemoryGuard({ memAvailableMb: null, memTotalMb: 16_000, cpus: 8, cfg, items: [], warned: false })
    expect([unk.level, unk.shouldWarn]).toEqual(['unknown', false])
  })

  test('formats freed memory and dry-run text cleanly', () => {
    expect(formatMb(1126)).toBe('1.1 GB')
    expect(formatMb(450)).toBe('450 MB')
    expect(formatSleptNotice(['anna', 'ben'], 1126, 3200)).toBe('slept anna, ben to free 1.1 GB (3.1 GB available)')
  })
})

describe('planTabSweep (binding safe rules & host-only logging)', () => {
  test('never closes pinned, leased, beforeunload, recent, or last tab in a window; logs host only', () => {
    expect(tabHost('https://secret.example.com/private/path?token=xyz#frag')).toBe('secret.example.com')
    expect(tabHost('chrome://extensions')).toBe('chrome')
    expect(tabHost('not a url')).toBe('(other)')

    const plan = planTabSweep({
      profile: 'bsd',
      now: NOW,
      idleMinutes: 120,
      leasesKnown: true,
      leases: [{ profile: 'bsd', tabId: 2 }],
      seenAt: {},
      tabs: [
        // Window 1: 6 tabs — pinned (1), leased (2), beforeunload (3), recent (4), old eligible (5),
        // duplicate URL of pinned tab (9) MUST be skipped as duplicate-url!
        {
          tabId: 1,
          windowId: 1,
          url: 'https://pinned.example.com/a',
          pinned: true,
          active: false,
          lastAccessed: NOW - 300 * MIN,
        },
        {
          tabId: 9,
          windowId: 1,
          url: 'https://pinned.example.com/a',
          pinned: false,
          active: false,
          lastAccessed: NOW - 300 * MIN,
        },
        {
          tabId: 2,
          windowId: 1,
          url: 'https://leased.example.com/b',
          pinned: false,
          active: false,
          lastAccessed: NOW - 300 * MIN,
        },
        {
          tabId: 3,
          windowId: 1,
          url: 'https://form.example.com/c',
          pinned: false,
          active: false,
          lastAccessed: NOW - 300 * MIN,
          beforeUnload: true,
        },
        {
          tabId: 4,
          windowId: 1,
          url: 'https://fresh.example.com/d',
          pinned: false,
          active: true,
          lastAccessed: NOW - 30 * MIN,
        },
        {
          tabId: 5,
          windowId: 1,
          url: 'https://stale.example.com/secret?k=1',
          pinned: false,
          active: false,
          lastAccessed: NOW - 180 * MIN,
        },
        // Window 2: 2 old eligible tabs — oldest (6) closes, newest (7) MUST stay as last tab of window 2!
        {
          tabId: 6,
          windowId: 2,
          url: 'https://older.example.com/1',
          pinned: false,
          active: false,
          lastAccessed: NOW - 240 * MIN,
        },
        {
          tabId: 7,
          windowId: 2,
          url: 'https://newer.example.com/2',
          pinned: false,
          active: false,
          lastAccessed: NOW - 150 * MIN,
        },
        // Window 3: 1 old tab — MUST stay as last tab of window 3!
        {
          tabId: 8,
          windowId: 3,
          url: 'https://only.example.com/3',
          pinned: false,
          active: true,
          lastAccessed: NOW - 400 * MIN,
        },
      ],
    })

    expect(plan.close.map(c => [c.tabId, c.host])).toEqual([
      [6, 'older.example.com'],
      [5, 'stale.example.com'],
    ])
    // Public plan NEVER exposes full URLs (query strings / paths).
    expect(JSON.stringify(plan)).not.toContain('secret?k=1')
    expect(plan.kept.map(k => [k.tabId, k.reason])).toEqual([
      [8, 'last-tab'],
      [1, 'pinned'],
      [2, 'leased'],
      [3, 'beforeunload'],
      [9, 'duplicate-url'],
      [7, 'last-tab'],
      [4, 'recent'],
    ])

    // Dry run report never includes query strings / paths.
    const lines = formatDryRun({
      at: NOW,
      config: housekeepingConfig(undefined),
      memory: planMemoryGuard({
        memAvailableMb: 6000,
        memTotalMb: 16_000,
        cpus: 8,
        cfg: housekeepingConfig(undefined).memory,
        items: [],
        warned: false,
      }),
      tabs: { profiles: [plan] },
    }).join('\n')
    expect(lines).toContain('stale.example.com')
    expect(lines).not.toContain('secret?k=1')
  })

  test('fails closed and skips entire profile whenever leases are unknown', () => {
    const plan = planTabSweep({
      profile: 'bb',
      now: NOW,
      idleMinutes: 120,
      leasesKnown: false,
      leases: [],
      seenAt: {},
      tabs: [
        {
          tabId: 1,
          windowId: 1,
          url: 'https://a.example.com',
          pinned: false,
          active: false,
          lastAccessed: NOW - 300 * MIN,
        },
        {
          tabId: 2,
          windowId: 1,
          url: 'https://b.example.com',
          pinned: false,
          active: false,
          lastAccessed: NOW - 300 * MIN,
        },
      ],
    })
    expect(plan.skippedReason).toBe('leases-unknown')
    expect(plan.close).toEqual([])
  })

  test('/api/housekeeping is strictly local-only', () => {
    expect(localOnly('/api/housekeeping')).toBe(true)
  })
})
