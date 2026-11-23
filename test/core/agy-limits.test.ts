// Antigravity (Gemini) usage parsing, node-status wire checks, and settings planning (#647).
import { describe, expect, test } from 'bun:test'
import { planAgySettings } from '../../src/core/agy-hooks.ts'
import {
  agyWindowMeta,
  boardAgyLimitsFrom,
  boardAgyLimitsOf,
  digestAgyStatusLine,
  isAgyThirdParty,
  parseAgyLimits,
  pickAgyLimits,
} from '../../src/core/agy-limits.ts'
import { type NodeStatus, nodeStatusOf, statusShown } from '../../src/core/nodes.ts'
import { isBoardPayload } from '../../src/core/payload-check.ts'

const NOW = 1_780_000_000_000

describe('agyWindowMeta & digestAgyStatusLine', () => {
  test('maps bucket ids to clean labels and known window durations', () => {
    expect(isAgyThirdParty('3p-5h')).toBe(true)
    expect(isAgyThirdParty('3p-weekly')).toBe(true)
    expect(isAgyThirdParty('3p_7d')).toBe(true)
    expect(isAgyThirdParty('3p')).toBe(true)
    expect(isAgyThirdParty('gemini-3p-5h')).toBe(true)
    expect(isAgyThirdParty('gemini-5h')).toBe(false)
    expect(isAgyThirdParty('gemini-weekly')).toBe(false)
    expect(isAgyThirdParty('claude-5h')).toBe(false)
    expect(isAgyThirdParty('v3p-5h')).toBe(false)

    expect(agyWindowMeta('gemini-5h')).toEqual({ label: '5h', minutes: 300 })
    expect(agyWindowMeta('gemini-weekly')).toEqual({ label: '7d', minutes: 10080 })
    expect(agyWindowMeta('gemini-pro-weekly')).toEqual({ label: 'Pro 7d', minutes: 10080 })
    expect(agyWindowMeta('gemini-flash')).toEqual({ label: 'Flash', minutes: null })
    expect(agyWindowMeta('claude-5h')).toEqual({ label: 'Claude 5h', minutes: 300 })
    expect(agyWindowMeta('3p-5h')).toEqual({ label: 'Other models 5h', minutes: 300 })
    expect(agyWindowMeta('3p-weekly')).toEqual({ label: 'Other models 7d', minutes: 10080 })
    expect(agyWindowMeta('3p-7d')).toEqual({ label: 'Other models 7d', minutes: 10080 })
    expect(agyWindowMeta('3p')).toEqual({ label: 'Other models', minutes: null })
  })

  test('orders Gemini windows first and third-party 3p windows after them', () => {
    const snap = digestAgyStatusLine(
      {
        quota: {
          '3p-5h': { remaining_fraction: 1 },
          '3p-weekly': { remaining_fraction: 0.88 },
          'gemini-weekly': { remaining_fraction: 0.91 },
          'gemini-5h': { remaining_fraction: 0.65 },
        },
      },
      NOW,
    )
    expect(snap?.windows.map(w => [w.id, w.label, w.usedPercentage])).toEqual([
      ['gemini-5h', '5h', 35],
      ['gemini-weekly', '7d', 9],
      ['3p-5h', 'Other models 5h', 0],
      ['3p-weekly', 'Other models 7d', 12],
    ])
  })

  test('parses official Antigravity statusLine JSON payload without inventing missing fields', () => {
    const resetIso = new Date(NOW + 3_600_000).toISOString()
    const snap = digestAgyStatusLine(
      {
        product: 'antigravity',
        plan_tier: 'Pro',
        quota: {
          'gemini-weekly': {
            remaining_fraction: 0.9378,
            reset_time: '2026-07-06T07:50:32Z',
            reset_in_seconds: 560580,
          },
          'gemini-5h': {
            remaining_fraction: 0.25,
            reset_time: resetIso,
          },
          'gemini-flash': {
            remaining_fraction: 1,
            reset_in_seconds: 1800,
          },
          'disabled-bucket': {
            remaining_fraction: 0,
            disabled: true,
          },
          'bad-fraction': {
            remaining_fraction: 1.5,
          },
          'missing-fraction': {
            reset_in_seconds: 600,
          },
        },
      },
      NOW,
    )
    expect(snap).toEqual({
      fetchedAtMs: NOW,
      planTier: 'Pro',
      windows: [
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 75, resetsAt: NOW + 3_600_000 },
        {
          id: 'gemini-weekly',
          label: '7d',
          minutes: 10080,
          usedPercentage: 6.22,
          resetsAt: Date.parse('2026-07-06T07:50:32Z'),
        },
        { id: 'gemini-flash', label: 'Flash', minutes: null, usedPercentage: 0, resetsAt: NOW + 1_800_000 },
      ],
    })
  })

  test('missing, empty or malformed quota returns null (unknown)', () => {
    expect(digestAgyStatusLine(null, NOW)).toBeNull()
    expect(digestAgyStatusLine({}, NOW)).toBeNull()
    expect(digestAgyStatusLine({ quota: {} }, NOW)).toBeNull()
    expect(digestAgyStatusLine({ quota: { a: { remaining_fraction: -0.1 } } }, NOW)).toBeNull()
    expect(digestAgyStatusLine({ quota: { a: { remaining_fraction: Number.NaN } } }, NOW)).toBeNull()
    expect(digestAgyStatusLine({ quota: { a: { remaining_fraction: 0.5, disabled: true } } }, NOW)).toBeNull()
    // Duplicate trimmed bucket IDs are deduplicated cleanly.
    const dedup = digestAgyStatusLine(
      {
        quota: {
          'gemini-5h': { remaining_fraction: 0.5 },
          ' gemini-5h ': { remaining_fraction: 0.1 },
        },
      },
      NOW,
    )
    expect(dedup?.windows.map(w => [w.id, w.usedPercentage])).toEqual([['gemini-5h', 50]])
  })
})

describe('parseAgyLimits, boardAgyLimitsFrom, boardAgyLimitsOf, pickAgyLimits', () => {
  test('parses cached readings, drops expired windows, and rejects future or corrupt data', () => {
    const raw = {
      fetchedAtMs: NOW - 60_000,
      planTier: 'Pro',
      windows: [
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 40, resetsAt: NOW - 1000 },
        { id: 'gemini-weekly', label: '7d', minutes: 10080, usedPercentage: 12.5, resetsAt: NOW + 86_400_000 },
      ],
    }
    const parsed = parseAgyLimits(raw, NOW)
    expect(parsed.available).toBe(true)
    expect(parsed.stale).toBe(true) // because one window is expired
    expect(parsed.windows?.map(w => [w.id, w.expired])).toEqual([
      ['gemini-5h', true],
      ['gemini-weekly', false],
    ])

    // boardAgyLimitsFrom drops the expired 5h window and keeps the live 7d window.
    const board = boardAgyLimitsFrom(parsed, NOW)
    expect(board).toEqual({
      source: 'statusline',
      observedAt: NOW - 60_000,
      stale: false,
      planTier: 'Pro',
      windows: [
        {
          id: 'gemini-weekly',
          label: '7d',
          minutes: 10080,
          usedPercentage: 12.5,
          resetsAt: NOW + 86_400_000,
          expired: false,
        },
      ],
    })

    // Future fetchedAtMs (> 5s ahead) stays unavailable.
    expect(parseAgyLimits({ ...raw, fetchedAtMs: NOW + 10_000 }, NOW).available).toBe(false)
    expect(parseAgyLimits(null, NOW).available).toBe(false)
  })

  test('boardAgyLimitsOf rejects untrusted/malformed node values', () => {
    expect(boardAgyLimitsOf(null, NOW)).toBeNull()
    expect(boardAgyLimitsOf({ source: 'other', observedAt: NOW, windows: [] }, NOW)).toBeNull()
    expect(
      boardAgyLimitsOf(
        {
          source: 'statusline',
          observedAt: NOW - 5000,
          stale: false,
          windows: [
            { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 101, resetsAt: null },
            { id: 'gemini-weekly', label: '7d', minutes: 10080, usedPercentage: 33, resetsAt: NOW + 60_000 },
          ],
        },
        NOW,
      ),
    ).toEqual({
      source: 'statusline',
      observedAt: NOW - 5000,
      stale: false,
      windows: [
        {
          id: 'gemini-weekly',
          label: '7d',
          minutes: 10080,
          usedPercentage: 33,
          resetsAt: NOW + 60_000,
          expired: false,
        },
      ],
    })
  })

  test('pickAgyLimits omits when agy is not installed anywhere, returns null when unknown, and picks freshest reading', () => {
    expect(pickAgyLimits([undefined, undefined], NOW)).toBeUndefined()
    expect(pickAgyLimits([undefined, null], NOW)).toBeNull()
    const older = boardAgyLimitsOf(
      {
        source: 'statusline',
        observedAt: NOW - 120_000,
        stale: false,
        windows: [{ id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 20, resetsAt: NOW + 60_000 }],
      },
      NOW,
    )
    const newer = boardAgyLimitsOf(
      {
        source: 'statusline',
        observedAt: NOW - 10_000,
        stale: false,
        windows: [{ id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 55, resetsAt: NOW + 60_000 }],
      },
      NOW,
    )
    expect(pickAgyLimits([undefined, older, newer, null], NOW)?.windows[0]?.usedPercentage).toBe(55)
  })

  test('upgrades legacy cached 3p labels and puts Gemini windows first', () => {
    const legacy = {
      fetchedAtMs: NOW - 10_000,
      windows: [
        { id: '3p-5h', label: '3p 5h', minutes: 300, usedPercentage: 0, resetsAt: NOW + 60_000 },
        { id: '3p-weekly', label: '3p 7d', minutes: 10080, usedPercentage: 15, resetsAt: NOW + 86_400_000 },
        { id: 'gemini-weekly', label: '7d', minutes: 10080, usedPercentage: 9, resetsAt: NOW + 86_400_000 },
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 35, resetsAt: NOW + 60_000 },
      ],
    }
    const parsed = parseAgyLimits(legacy, NOW)
    expect(parsed.windows?.map(w => [w.id, w.label])).toEqual([
      ['gemini-5h', '5h'],
      ['gemini-weekly', '7d'],
      ['3p-5h', 'Other models 5h'],
      ['3p-weekly', 'Other models 7d'],
    ])

    const wire = boardAgyLimitsOf(
      { source: 'statusline', observedAt: NOW - 10_000, stale: false, windows: legacy.windows },
      NOW,
    )
    expect(wire?.windows.map(w => [w.id, w.label])).toEqual([
      ['gemini-5h', '5h'],
      ['gemini-weekly', '7d'],
      ['3p-5h', 'Other models 5h'],
      ['3p-weekly', 'Other models 7d'],
    ])
  })
})

describe('NodeStatus & BoardPayload wire compatibility', () => {
  const baseStatus: NodeStatus = {
    api: 1,
    id: 'server-2',
    version: '0.1.0',
    commit: 'abc1234',
    platform: 'linux',
    arch: 'x64',
    cpus: 8,
    memTotalMb: 16000,
    memAvailableMb: 8000,
    load: [0.5, 0.4, 0.3],
    sessions: { awake: 2, working: 1, asleep: 0 },
    launches: 0,
    workRootFreeMb: 50000,
    profiles: [{ id: 'default', loggedIn: true, bundle: null }],
    agents: ['claude'],
    at: NOW,
  }

  test('a node without agy omits agyLimits and keeps statusShown identical', () => {
    const parsed = nodeStatusOf(baseStatus)
    expect(parsed).toEqual(baseStatus)
    expect('agyLimits' in (parsed as object)).toBe(false)
    expect(statusShown(parsed)).toBe(statusShown(baseStatus))
  })

  test('a node with agy propagates agyLimits (null or reading) and updates statusShown when usage changes', () => {
    const unknown = nodeStatusOf({ ...baseStatus, agyLimits: null })
    expect(unknown?.agyLimits).toBeNull()
    const withReading = nodeStatusOf({
      ...baseStatus,
      agyLimits: {
        source: 'statusline',
        observedAt: Date.now() - 5000,
        stale: false,
        planTier: 'Pro',
        windows: [{ id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 42, resetsAt: Date.now() + 3_600_000 }],
      },
    })
    expect(withReading?.agyLimits?.windows[0]?.usedPercentage).toBe(42)
    expect(statusShown(unknown)).not.toBe(statusShown(withReading))

    // Non-object garbage agyLimits is omitted instead of marking agy installed.
    const garbage = nodeStatusOf({ ...baseStatus, agyLimits: 'garbage' })
    expect(garbage && 'agyLimits' in garbage).toBe(false)

    // statusShown stays stable across minor observedAt/resetsAt jitter inside the bucket (no 30 s SSE churn).
    const t0 = 1_780_000_200_000 // middle of a 5-min bucket
    const r0 = t0 + 3_600_000
    const s1 = {
      ...baseStatus,
      agyLimits: {
        source: 'statusline' as const,
        observedAt: t0,
        stale: false,
        windows: [{ id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 42, resetsAt: r0, expired: false }],
      },
    }
    const s2 = {
      ...baseStatus,
      agyLimits: {
        source: 'statusline' as const,
        observedAt: t0 + 30_000,
        stale: false,
        windows: [
          { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 42, resetsAt: r0 + 5000, expired: false },
        ],
      },
    }
    expect(statusShown(s1)).toBe(statusShown(s2))
  })

  test('isBoardPayload accepts omitted, null, and valid agyLimits, and rejects malformed non-object agyLimits', () => {
    const base = {
      version: '1',
      stale: false,
      items: [],
      launches: [],
      categories: [],
      swatches: [],
      columns: [],
      schedules: [],
      scheduleLog: [],
    }
    expect(isBoardPayload(base)).toBe(true)
    expect(isBoardPayload({ ...base, agyLimits: null })).toBe(true)
    expect(
      isBoardPayload({ ...base, agyLimits: { source: 'statusline', observedAt: NOW, stale: false, windows: [] } }),
    ).toBe(true)
    expect(isBoardPayload({ ...base, agyLimits: 'bad' })).toBe(false)
  })
})

describe('planAgySettings', () => {
  test('installs statusLine with stack_with_default when absent or ours, and preserves foreign statusLine', () => {
    const script = '/repo/herdr-agent-board/src/entrypoints/agy-statusline.ts'
    const fresh = planAgySettings({ permissions: { allow: ['command(board)'] } }, '/usr/bin/bun', script)
    expect(fresh.statusLineSet).toBe(true)
    expect(fresh.settings.permissions).toEqual({ allow: ['command(board)'] })
    expect(fresh.settings.statusLine).toEqual({
      type: 'command',
      command: `"/usr/bin/bun" "${script}"`,
      stack_with_default: true,
    })

    // Updating our own earlier command replaces it cleanly.
    const moved = planAgySettings(
      { statusLine: { type: 'command', command: 'bun "/old/agent-board/src/entrypoints/agy-statusline.ts"' } },
      '/usr/bin/bun',
      script,
    )
    expect(moved.statusLineSet).toBe(true)
    expect((moved.settings.statusLine as { command: string }).command).toContain(script)

    // Foreign user statusLine (command or non-command object like { enabled: false }) is left untouched.
    const foreign = planAgySettings(
      { statusLine: { type: 'command', command: '~/.gemini/antigravity-cli/my-custom.sh' } },
      '/usr/bin/bun',
      script,
    )
    expect(foreign.statusLineSet).toBe(false)
    expect(foreign.settings.statusLine).toEqual({
      type: 'command',
      command: '~/.gemini/antigravity-cli/my-custom.sh',
    })
    const nonCmd = planAgySettings({ statusLine: { enabled: false } }, '/usr/bin/bun', script)
    expect(nonCmd.statusLineSet).toBe(false)
    expect(nonCmd.settings.statusLine).toEqual({ enabled: false })

    // Windows paths, spaces, %, and Cyrillic survive quoting and re-recognition.
    const winScript = 'C:\\Users\\Анна 100%\\herdr-agent-board\\src\\entrypoints\\agy-statusline.ts'
    const winBun = 'C:\\Users\\Анна 100%\\.bun\\bin\\bun.exe'
    const winPlan = planAgySettings({}, winBun, winScript)
    expect(winPlan.statusLineSet).toBe(true)
    expect((winPlan.settings.statusLine as { command: string }).command).toBe(
      '"C:/Users/Анна 100%/.bun/bin/bun.exe" "C:/Users/Анна 100%/herdr-agent-board/src/entrypoints/agy-statusline.ts"',
    )
    expect(planAgySettings(winPlan.settings, winBun, winScript).statusLineSet).toBe(true)
  })
})
