// Settings → Housekeeping… route tests (#652): local-only enforcement, X-Board guard,
// immediate fresh view & timer sync on POST settings, read-only dry-run, and error validation.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFile } from '../../src/adapters/config-file.ts'
import type { Config } from '../../src/core/types.ts'
import { dispatch } from '../../src/server/http.ts'
import { housekeepingRoutes } from '../../src/server/routes/housekeeping.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import type { Deps } from '../../src/services/deps.ts'
import { createHousekeeping } from '../../src/services/housekeeping.ts'
import { isolatedHome } from '../support/env.ts'

const STATE = { port: 12422, token: '', stale: () => false }
const readRawConfig = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))

function freshConfig(raw: Record<string, unknown>): void {
  isolatedHome()
  mkdirSync(join(configFile(), '..'), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(raw))
}

describe('/api/housekeeping route', () => {
  test('stays strictly local-only, enforces X-Board, returns fresh view immediately after settings, and supports dry-run', async () => {
    for (const owner of [false, true]) {
      expect(remoteRefusal('/api/housekeeping', '/api/housekeeping', false, owner, owner)?.status).toBe(403)
    }

    freshConfig({ language: 'en' })
    const cfg: Config = { language: 'en' } as Config
    let intervals = 0
    let clears = 0
    let changed = 0
    const hk = createHousekeeping({
      deps: { cfg } as unknown as Deps,
      items: () => [],
      log: () => {},
      clock: {
        now: () => 1_780_000_000_000,
        setTimeout,
        clearTimeout,
        setInterval: () => ++intervals,
        clearInterval: () => {
          clears++
        },
      },
      load: async () => ({ cpus: 8, memTotalMb: 16_000, memAvailableMb: 6000, load: [0.3, 0.3, 0.3] }),
      inspect: async () => ({ reachable: true, leasesKnown: true, leases: [], profiles: [] }),
    })

    const routes = housekeepingRoutes({
      housekeeping: hk,
      changed: () => {
        changed++
      },
    })
    const call = async (method: string, body?: unknown, headers: Record<string, string> = { 'x-board': '1' }) => {
      const url = new URL('http://127.0.0.1:12422/api/housekeeping')
      const req = new Request(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      const res = await dispatch(routes, req, url, url.pathname, STATE)
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    // Initial GET: off by default, zero timers armed.
    const initial = await call('GET')
    expect(initial.status).toBe(200)
    expect((initial.body.config as { memory: { on: boolean }; tabs: { on: boolean } }).memory.on).toBe(false)
    expect(intervals).toBe(0)

    // POST without X-Board -> 403 and config untouched.
    expect((await call('POST', { op: 'settings', memory: { on: true } }, {})).status).toBe(403)
    expect('housekeeping' in readRawConfig()).toBe(false)

    // POST settings -> writes config AND immediately updates view + arms timer without waiting for watcher.
    const enabled = await call('POST', { op: 'settings', memory: { on: true, warnMb: 3500, actionMb: 2500 } })
    expect(enabled.status).toBe(200)
    expect(enabled.body.ok).toBe(true)
    expect(changed).toBe(1)
    expect(intervals).toBe(1)
    expect(
      (enabled.body.view as { config: { memory: { on: boolean; warnMb: number; actionMb: number } } }).config.memory,
    ).toMatchObject({
      on: true,
      warnMb: 3500,
      actionMb: 2500,
    })

    // Invalid settings (warnMb < actionMb) -> 400 and keeps previous values.
    const bad = await call('POST', { op: 'settings', memory: { warnMb: 1000, actionMb: 2500 } })
    expect(bad.status).toBe(400)
    expect(bad.body.ok).toBe(false)

    // Turn back off -> clears timer and returns off immediately.
    const disabled = await call('POST', { op: 'settings', memory: { on: false } })
    expect(disabled.status).toBe(200)
    expect(clears).toBe(1)
    expect((disabled.body.view as { config: { memory: { on: boolean } } }).config.memory.on).toBe(false)

    // Dry run returns report cleanly.
    const dry = await call('POST', { op: 'dry-run' })
    expect(dry.status).toBe(200)
    expect(dry.body.ok).toBe(true)
    expect((dry.body.report as { memory: { level: string } }).memory.level).toBe('ok')

    // Unknown op -> 400.
    expect((await call('POST', { op: 'bogus' })).status).toBe(400)

    hk.close()
  })
})
