// Antigravity (Gemini) usage adapter, statusLine entrypoint, and settings install (#647).
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agySettingsPlan, installAgySettings } from '../../src/adapters/agy-hooks.ts'
import { agyInstalled, agyOnPathCached, localAgyLimits, readAgyUsageFile } from '../../src/adapters/agy-limits.ts'
import type { BoardAgyLimits, BoardDevice, BoardPayload } from '../../src/core/payload.ts'
import { createBoardState } from '../../src/server/board-state.ts'
import type { Deps } from '../../src/services/deps.ts'
import type { Launches } from '../../src/services/launch/launches.ts'

const dirs: string[] = []
function makeDir(prefix = 'agy-limits-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('readAgyUsageFile & localAgyLimits', () => {
  test('returns undefined when agy is not installed (no file reads) and null when installed with no reading', () => {
    const dir = makeDir()
    const file = join(dir, 'agy-limits-latest.json')
    writeFileSync(
      file,
      JSON.stringify({
        fetchedAtMs: Date.now() - 1000,
        windows: [{ id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 30, resetsAt: Date.now() + 60_000 }],
      }),
    )
    // Not installed: strictly gated -> undefined even if a file exists.
    expect(localAgyLimits(undefined, Date.now(), { installed: false, file })).toBeUndefined()
    // Installed without file: null (unknown).
    expect(localAgyLimits(undefined, Date.now(), { installed: true, file: join(dir, 'missing.json') })).toBeNull()
    // Installed with valid file: returns windows.
    const got = localAgyLimits(undefined, Date.now(), { installed: true, file })
    expect(got?.windows[0]?.usedPercentage).toBe(30)
  })

  test('rejects symlinks, oversized files, and corrupt JSON safely', () => {
    const dir = makeDir()
    const real = join(dir, 'real.json')
    const link = join(dir, 'link.json')
    const big = join(dir, 'big.json')
    const bad = join(dir, 'bad.json')
    writeFileSync(
      real,
      JSON.stringify({
        fetchedAtMs: Date.now() - 1000,
        windows: [{ id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 10, resetsAt: null }],
      }),
    )
    symlinkSync(real, link)
    writeFileSync(big, ' '.repeat(70_000))
    writeFileSync(bad, '{not-json')

    expect(readAgyUsageFile(real).available).toBe(true)
    expect(readAgyUsageFile(link).available).toBe(false)
    expect(readAgyUsageFile(big).available).toBe(false)
    expect(readAgyUsageFile(bad).available).toBe(false)
  })
})

describe('agy-statusline entrypoint & installAgySettings', () => {
  test('agy-statusline.ts saves validated quota windows silently and keeps last good reading on empty/bad stdin', async () => {
    const dir = makeDir('agy-sl-')
    const entrypoint = join(import.meta.dir, '..', '..', 'src', 'entrypoints', 'agy-statusline.ts')
    const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir }
    const outFile = join(dir, 'herdr', 'plugins', 'agent-board', 'agy-limits-latest.json')

    const run = async (stdin: string) => {
      const proc = Bun.spawn([process.execPath, entrypoint], {
        env,
        stdin: new Blob([stdin]),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, code }
    }

    const r1 = await run(
      JSON.stringify({
        product: 'antigravity',
        plan_tier: 'Pro',
        quota: {
          'gemini-5h': { remaining_fraction: 0.6, reset_in_seconds: 3600 },
          'gemini-weekly': { remaining_fraction: 0.9, reset_time: new Date(Date.now() + 86_400_000).toISOString() },
        },
      }),
    )
    expect(r1).toEqual({ stdout: '', stderr: '', code: 0 })
    expect(existsSync(outFile)).toBe(true)
    const saved = JSON.parse(readFileSync(outFile, 'utf8'))
    expect(saved.planTier).toBe('Pro')
    expect(saved.windows.map((w: { id: string; usedPercentage: number }) => [w.id, w.usedPercentage])).toEqual([
      ['gemini-5h', 40],
      ['gemini-weekly', 10],
    ])

    // Subsequent payload without quota or broken JSON keeps the last good file and exits cleanly.
    const r2 = await run('not json')
    expect(r2).toEqual({ stdout: '', stderr: '', code: 0 })
    expect(JSON.parse(readFileSync(outFile, 'utf8')).windows).toHaveLength(2)
  })

  test('installAgySettings writes settings.json with backup and stays idempotent', () => {
    const dir = makeDir('agy-settings-')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ trustedWorkspaces: ['/work'] }, null, 2))

    const p1 = agySettingsPlan(dir, '/usr/bin/bun', '/repo/agent-board/src/entrypoints/agy-statusline.ts')
    expect(p1.statusLineSet).toBe(true)
    installAgySettings(p1)
    expect(existsSync(`${file}.bak-agent-board`)).toBe(true)

    const p2 = agySettingsPlan(dir, '/usr/bin/bun', '/repo/agent-board/src/entrypoints/agy-statusline.ts')
    expect(p2.before).toBe(p2.after)
  })

  test('agyOnPathCached & agyInstalled respect custom env PATH and launch.agy', () => {
    const emptyBin = makeDir('no-agy-bin-')
    const agyBin = makeDir('with-agy-bin-')
    const fakeAgy = join(agyBin, 'agy')
    writeFileSync(fakeAgy, '#!/bin/sh\nexit 0\n')
    chmodSync(fakeAgy, 0o755)

    expect(agyOnPathCached({ PATH: emptyBin })).toBe(false)
    expect(agyInstalled(undefined, { PATH: emptyBin })).toBe(false)
    expect(agyInstalled({ agy: 'agy' }, { PATH: emptyBin })).toBe(true)
    expect(agyOnPathCached({ PATH: agyBin })).toBe(true)
    expect(agyInstalled(undefined, { PATH: agyBin })).toBe(true)
  })

  test('createBoardState propagates remote node agyLimits to master without local agy, and omits when none has agy', () => {
    const dir = makeDir('board-state-agy-')
    const deps = {
      cfg: { categories: [], port: 12422 },
      log: () => {},
      profiles: () => ({ list: [], inherited: null, inheritedDir: dir }),
      homes: {
        forDir: () => ({
          localUsage: () => ({
            context: { available: false, observedAt: null, source: null },
            limits: { available: false, observedAt: null, source: '', sessionAccountVerified: false },
          }),
        }),
      },
    } as unknown as Deps
    const launches = { decorate: <T>(x: T) => x, list: () => [], observe: () => {} } as unknown as Launches
    const now = Date.now()
    const deviceWith = (
      id: string,
      agyLimits?: BoardAgyLimits | null,
      revoked?: { told: boolean; kept: boolean },
    ): BoardDevice =>
      ({
        id,
        title: id,
        kind: id === 'local' ? null : 'ssh',
        link: null,
        status: {
          api: 1,
          id,
          version: '0.1.0',
          commit: 'abc',
          platform: 'linux',
          arch: 'x64',
          cpus: 4,
          memTotalMb: 8000,
          memAvailableMb: 4000,
          load: null,
          sessions: { awake: 0, working: 0, asleep: 0 },
          launches: 0,
          workRootFreeMb: 10000,
          profiles: [],
          agents: ['claude'],
          ...(agyLimits !== undefined && { agyLimits }),
          at: now,
        },
        sameCommit: true,
        payloadAt: now,
        paused: false,
        drain: false,
        maxSessions: null,
        minFreeMemMb: null,
        maxLoad: null,
        ...(revoked && { revoked }),
      }) as BoardDevice

    let devices: BoardDevice[] = [deviceWith('local'), deviceWith('server-1')]
    const state = createBoardState({
      deps,
      launches,
      version: () => '1',
      push: () => {},
      agyLimits: () => undefined,
      nodes: () => ({ part: () => ({ items: [], launches: [], schedules: [], devices }), find: () => undefined }),
    })

    // Neither local nor any node has agy -> omitted from payload.
    state.publish()
    const p0 = JSON.parse(state.payload()) as BoardPayload
    expect('agyLimits' in p0).toBe(false)

    // Remote node has agy installed with no reading yet -> agyLimits: null.
    devices = [deviceWith('local'), deviceWith('server-2', null)]
    state.publish()
    const p1 = JSON.parse(state.payload()) as BoardPayload
    expect(p1.agyLimits).toBeNull()

    // Two active nodes + a revoked node with newer timestamp -> picks freshest active remote node, ignores revoked & local copy.
    const older: BoardAgyLimits = {
      source: 'statusline',
      observedAt: now - 120_000,
      stale: false,
      windows: [
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 15, resetsAt: now + 3_600_000, expired: false },
      ],
    }
    const newer: BoardAgyLimits = {
      source: 'statusline',
      observedAt: now - 10_000,
      stale: false,
      planTier: 'Pro',
      windows: [
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 64, resetsAt: now + 3_600_000, expired: false },
      ],
    }
    const revokedNewer: BoardAgyLimits = {
      source: 'statusline',
      observedAt: now - 1000,
      stale: false,
      windows: [
        { id: 'gemini-5h', label: '5h', minutes: 300, usedPercentage: 99, resetsAt: now + 3_600_000, expired: false },
      ],
    }
    devices = [
      deviceWith('local', revokedNewer),
      deviceWith('server-1', older),
      deviceWith('server-2', newer),
      deviceWith('server-3', revokedNewer, { told: true, kept: false }),
    ]
    state.publish()
    const p2 = JSON.parse(state.payload()) as BoardPayload
    expect(p2.agyLimits?.windows[0]?.usedPercentage).toBe(64)
    expect(p2.agyLimits?.planTier).toBe('Pro')
  })
})
