// Server BoardPayload housekeeping state (#652, #682): omitted when both switches are off,
// included with { memory, tabs } whenever either memory guard or tab sweep is enabled.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import type { Config } from '../../src/core/types.ts'
import { createBoardState } from '../../src/server/board-state.ts'
import type { Deps } from '../../src/services/deps.ts'
import type { Launches } from '../../src/services/launch/launches.ts'

describe('createBoardState housekeeping payload (#682)', () => {
  test('omits housekeeping when both switches are off and includes it when either is on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-state-hk-'))
    try {
      const cfg: Config = { categories: [], port: 12422 } as unknown as Config
      const deps = {
        cfg,
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
      const state = createBoardState({ deps, launches, version: () => '1', push: () => {} })

      state.publish()
      expect('housekeeping' in (JSON.parse(state.payload()) as BoardPayload)).toBe(false)

      cfg.housekeeping = { memory: { on: false }, tabs: { on: false } }
      state.publish()
      expect('housekeeping' in (JSON.parse(state.payload()) as BoardPayload)).toBe(false)

      cfg.housekeeping = { memory: { on: true } }
      state.publish()
      expect((JSON.parse(state.payload()) as BoardPayload).housekeeping).toEqual({ memory: true, tabs: false })

      cfg.housekeeping = { memory: { on: false }, tabs: { on: true } }
      state.publish()
      expect((JSON.parse(state.payload()) as BoardPayload).housekeeping).toEqual({ memory: false, tabs: true })

      cfg.housekeeping = { memory: { on: true }, tabs: { on: true } }
      state.publish()
      expect((JSON.parse(state.payload()) as BoardPayload).housekeeping).toEqual({ memory: true, tabs: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
