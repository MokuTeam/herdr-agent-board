// The master's side of the bundle (services/nodes/bundle-sync.ts, #506, docs/design/nodes 9.2): with
// a fake link and clock. The hash is computed when a sync is asked and on the 5 minute tick while a
// device is online, which sends nothing; each request of a sync has 20 s and the whole sync its own
// limit, whatever the node does (#583); the blobs go a few at a time; a device that is not there or
// offline is said, with no request.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Profile } from '../../src/core/profiles.ts'
import type { Config } from '../../src/core/types.ts'
import { createBundleSync, HASH_MS, SEND_AT_ONCE, SYNC_TOTAL_MS } from '../../src/services/nodes/bundle-sync.ts'
import type { Link } from '../../src/services/nodes/link.ts'

function setup(
  state: 'online' | 'offline',
  answer?: (path: string, init?: RequestInit) => Response | Promise<Response>,
  more: { skills?: number; requestMs?: number; programs?: string[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-sync-'))
  const home = join(root, 'home')
  const dir = join(home, '.claude')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), 'rules')
  for (let i = 0; i < (more.skills ?? 0); i++) {
    mkdirSync(join(dir, 'skills', `skill-${i}`), { recursive: true })
    writeFileSync(
      join(dir, 'skills', `skill-${i}`, 'SKILL.md'),
      `---\nname: skill-${i}\ndescription: d\n---\nbody ${i}\n`,
    )
  }
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
    view: () => ({
      status: {
        platform: 'linux',
        profiles: [{ id: 'default', loggedIn: true, bundle: null }],
        ...(more.programs && { programs: more.programs }),
      },
    }),
    status: async () => null,
    async fetch(path: string, init?: RequestInit) {
      asked.push(path)
      return answer ? answer(path, init) : new Response('{}', { status: 500 })
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
    ...(more.requestMs !== undefined && { requestMs: more.requestMs }),
  })
  return { sync, timers, asked, saved, dir, home, advance: (ms: number) => (now += ms) }
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

  test('a sync that takes longer than its whole limit: timeout, kept as the last report', async () => {
    let s: ReturnType<typeof setup> | null = null
    s = setup('online', () => {
      s?.advance(SYNC_TOTAL_MS + 1000)
      return Response.json({ seq: 0, hash: '', files: {} })
    })
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why, r.seq]).toEqual([false, 'timeout', 0])
    expect(s.asked).toEqual(['/api/node/bundle/default'])
    expect(s.sync.report('server-1', 'default')?.why).toBe('timeout')
  })

  /** A node that takes every blob and the commit. */
  const taking = (path: string): Response =>
    path.endsWith('/commit')
      ? Response.json({ ok: true, applied: [], kept: [], backup: null })
      : path.includes('/blob/')
        ? Response.json({ ok: true })
        : Response.json({ seq: 0, hash: '', files: {} })

  test('a profile of many files over a slow link: over 20 s in all, each request in time, synced (#583)', async () => {
    let s: ReturnType<typeof setup> | null = null
    s = setup(
      'online',
      path => {
        s?.advance(1000)
        return taking(path)
      },
      { skills: 40 },
    )
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why]).toEqual([true, undefined])
    // CLAUDE.md and the 40 skills, the commit after the last of them.
    expect(r.sent).toBe(41)
    expect(s.asked.filter(p => p.includes('/blob/')).length).toBe(41)
    expect(s.asked.at(-1)).toBe('/api/node/bundle/default/commit')
  })

  test('the blobs go several at a time, never more than SEND_AT_ONCE (#583)', async () => {
    let flying = 0
    let most = 0
    const s = setup(
      'online',
      async path => {
        if (!path.includes('/blob/')) return taking(path)
        most = Math.max(most, ++flying)
        await new Promise(r => setTimeout(r, 2))
        flying--
        return taking(path)
      },
      { skills: 40 },
    )
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.sent]).toEqual([true, 41])
    expect(most).toBe(SEND_AT_ONCE)
  })

  test('a request the node never answers ends at its own deadline, with no commit (#583)', async () => {
    const s = setup(
      'online',
      (path, init) =>
        path.includes('/blob/')
          ? new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
            })
          : taking(path),
      { skills: 3, requestMs: 40 },
    )
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why]).toEqual([false, 'timeout'])
    expect(s.asked.some(p => p.endsWith('/commit'))).toBe(false)
  })

  test('a blob the node refuses ends the sync: no commit, and no blob is started after it', async () => {
    let puts = 0
    const s = setup(
      'online',
      async path => {
        if (!path.includes('/blob/')) return taking(path)
        const n = ++puts
        await new Promise(r => setTimeout(r, 2))
        return n === 3 ? Response.json({ error: 'disk' }, { status: 507 }) : taking(path)
      },
      { skills: 40 },
    )
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why, r.detail]).toEqual([false, 'node', 'disk'])
    expect(s.asked.some(p => p.endsWith('/commit'))).toBe(false)
    // Those on their way when it was refused finish; none of the other 30 odd is started.
    expect(puts).toBeLessThanOrEqual(2 * SEND_AT_ONCE)
  })

  test('the first refusal is the answer, whatever came of the blobs on their way with it (#583)', async () => {
    let puts = 0
    const s = setup(
      'online',
      async path => {
        if (!path.includes('/blob/')) return taking(path)
        const n = ++puts
        // The first is refused at once; one beside it is refused later for another reason, one fails.
        if (n === 1) return Response.json({ error: 'disk' }, { status: 507 })
        await new Promise(r => setTimeout(r, 5))
        if (n === 2) return Response.json({ error: 'hash' }, { status: 400 })
        if (n === 3) throw new Error('socket closed')
        return taking(path)
      },
      { skills: 40 },
    )
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why, r.detail]).toEqual([false, 'node', 'disk'])
    expect(s.asked.some(p => p.endsWith('/commit'))).toBe(false)
  })

  test('a request that fails while others are on their way: said as the node, no commit (#583)', async () => {
    let puts = 0
    const s = setup(
      'online',
      async path => {
        if (!path.includes('/blob/')) return taking(path)
        const n = ++puts
        await new Promise(r => setTimeout(r, 2))
        if (n === 2) throw new Error('socket closed')
        return taking(path)
      },
      { skills: 40 },
    )
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why, r.detail]).toEqual([false, 'node', 'error'])
    expect(s.asked.some(p => p.endsWith('/commit'))).toBe(false)
    expect(puts).toBeLessThanOrEqual(2 * SEND_AT_ONCE)
  })

  test('the whole limit passes while the blobs go: timeout, no commit (#583)', async () => {
    let s: ReturnType<typeof setup> | null = null
    let puts = 0
    s = setup(
      'online',
      path => {
        if (path.includes('/blob/') && ++puts === 10) s?.advance(SYNC_TOTAL_MS)
        return taking(path)
      },
      { skills: 40 },
    )
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why]).toEqual([false, 'timeout'])
    expect(s.asked.some(p => p.endsWith('/commit'))).toBe(false)
    expect(puts).toBeLessThan(41)
  })

  test('a commit that names blobs the node no longer has: those go once more, then it commits', async () => {
    const blobs: string[] = []
    let commits = 0
    const s = setup(
      'online',
      path => {
        if (path.includes('/blob/')) {
          blobs.push(path.slice(path.lastIndexOf('/') + 1))
          return taking(path)
        }
        if (!path.endsWith('/commit')) return taking(path)
        return ++commits === 1
          ? Response.json({ error: 'missing-blob', missing: blobs.slice(0, 2) }, { status: 409 })
          : taking(path)
      },
      { skills: 8 },
    )
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.sent, commits]).toEqual([true, 11, 2])
    // The two named are the last two sent, between the commits.
    expect(blobs.slice(9).sort()).toEqual(blobs.slice(0, 2).sort())
    expect(s.asked.at(-1)).toBe('/api/node/bundle/default/commit')
  })

  test("the node's programs and the profile's acknowledgments reach what is committed (#602, #603)", async () => {
    let body = ''
    const s = setup(
      'online',
      (path, init) => {
        if (path.endsWith('/commit')) body = String(init?.body ?? '')
        return taking(path)
      },
      { programs: ['python3'] },
    )
    mkdirSync(join(s.dir, 'hooks'), { recursive: true })
    writeFileSync(join(s.dir, 'hooks', 'save.py'), 'print(1)\n')
    writeFileSync(
      join(s.dir, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: `python ${s.dir.replaceAll('\\', '/')}/hooks/save.py` }] }],
        },
      }),
    )
    writeFileSync(join(s.home, '.claude.json'), JSON.stringify({ codeModeCaveatsAcceptedV1: true, numStartups: 3 }))
    const r = await s.sync.syncIfBehind('server-1')
    expect(r.ok).toBe(true)
    const manifest = JSON.parse(body).manifest
    expect(JSON.stringify(manifest.hooks)).toContain('python3 {{profile-dir}}/hooks/save.py')
    expect(manifest.acks).toEqual(['codeModeCaveatsAcceptedV1'])
    expect(r.lines.filter(l => l.why === 'program-renamed' || l.why === 'acknowledged').map(l => l.name)).toEqual([
      'codeModeCaveatsAcceptedV1',
      'save',
    ])
  })
})
