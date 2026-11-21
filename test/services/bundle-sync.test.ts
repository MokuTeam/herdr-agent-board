// The master's side of the bundle (services/nodes/bundle-sync.ts, #506, docs/design/nodes 9.2): with
// a fake link and clock. The hash is computed when a sync is asked and on the 5 minute tick while a
// device is online, which sends nothing; a sync answers within 20 s whatever the node does; a device
// that is not there or offline is said, with no request.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Profile } from '../../src/core/profiles.ts'
import type { Config } from '../../src/core/types.ts'
import { createBundleSync, HASH_MS } from '../../src/services/nodes/bundle-sync.ts'
import type { Link } from '../../src/services/nodes/link.ts'

function setup(state: 'online' | 'offline', answer?: (path: string) => Response) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-sync-'))
  const home = join(root, 'home')
  const dir = join(home, '.claude')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), 'rules')
  let now = 1_000_000
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const clock = {
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval(fn: () => void, ms: number) {
      timers.push({ fn, ms, cleared: false })
      return timers.length - 1
    },
    clearInterval(h: unknown) {
      const t = timers[h as number]
      if (t) t.cleared = true
    },
  }
  const asked: string[] = []
  const link = {
    id: 'server-1',
    state: () => ({ state, since: 0, heardAt: null }),
    view: () => ({ status: { platform: 'linux', profiles: [{ id: 'default', loggedIn: true, bundle: null }] } }),
    status: async () => null,
    async fetch(path: string) {
      asked.push(path)
      return answer ? answer(path) : new Response('{}', { status: 500 })
    },
  } as unknown as Link
  const saved: Record<string, unknown>[] = []
  let record: Record<string, unknown> | null = null
  const cfg = {
    nodes: { id: 'laptop', devices: { 'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:9' } } } },
  } as unknown as Config
  const profiles: Profile[] = [{ id: 'default', title: 'Default', dir, color: 'gray', hidden: false }]
  const sync = createBundleSync({
    cfg,
    links: { link: id => (id === 'server-1' ? link : null) },
    profiles: () => profiles,
    store: {
      bundle: () => record,
      setBundle: (_id, v) => {
        record = v
        saved.push(v)
      },
    },
    log: () => {},
    home,
    platform: 'linux',
    boardDir: join(root, 'board'),
    hostName: 'laptop',
    clock,
  })
  return { sync, timers, asked, saved, dir, advance: (ms: number) => (now += ms) }
}

describe('bundle sync', () => {
  test('the 5 minute tick computes the hash of an online device and sends nothing; close ends it', () => {
    const s = setup('online')
    expect(s.timers.map(t => t.ms)).toEqual([HASH_MS])
    s.timers[0]?.fn()
    expect(s.asked).toEqual([])
    const first = s.saved.at(-1) as { profiles: { default: { seq: number; hash: string } } }
    expect(first.profiles.default.seq).toBe(1)
    // The same folder: the same hash, no new seq, nothing written.
    s.timers[0]?.fn()
    expect(s.saved.length).toBe(1)
    writeFileSync(join(s.dir, 'CLAUDE.md'), 'rules, changed')
    s.timers[0]?.fn()
    expect((s.saved.at(-1) as typeof first).profiles.default.seq).toBe(2)
    s.sync.close()
    expect(s.timers[0]?.cleared).toBe(true)
  })

  test('an offline device: no hash on the tick, a sync says offline with no request', async () => {
    const s = setup('offline')
    s.timers[0]?.fn()
    expect(s.saved).toEqual([])
    expect((await s.sync.syncIfBehind('server-1')).why).toBe('offline')
    expect((await s.sync.syncIfBehind('server-9')).why).toBe('device')
    expect((await s.sync.syncIfBehind('server-1', 'work')).why).toBe('profile')
    expect(s.asked).toEqual([])
  })

  test('a node that takes too long: timeout within 20 s, kept as the last report', async () => {
    let s: ReturnType<typeof setup> | null = null
    s = setup('online', () => {
      s?.advance(21_000)
      return Response.json({ seq: 0, hash: '', files: {} })
    })
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why, r.seq]).toEqual([false, 'timeout', 0])
    expect(s.asked).toEqual(['/api/node/bundle/default'])
    expect(s.sync.report('server-1', 'default')?.why).toBe('timeout')
  })
})
