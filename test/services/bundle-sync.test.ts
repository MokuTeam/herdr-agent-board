// The master's side of the bundle (services/nodes/bundle-sync.ts, #506, docs/design/nodes 9.2): with
// a fake link and clock. The hash is computed when a sync is asked and on the 5 minute tick while a
// device is online, which sends nothing; each request of a sync has 20 s and the whole sync its own
// limit, whatever the node does (#583); the blobs go a few at a time; a device that is not there or
// offline is said, with no request.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MasterGit } from '../../src/adapters/git-access.ts'
import type { Profile } from '../../src/core/profiles.ts'
import type { Config } from '../../src/core/types.ts'
import { createBundleSync, HASH_MS, SEND_AT_ONCE, SYNC_TOTAL_MS } from '../../src/services/nodes/bundle-sync.ts'
import type { Link } from '../../src/services/nodes/link.ts'

function setup(
  state: 'online' | 'offline',
  answer?: (path: string, init?: RequestInit) => Response | Promise<Response>,
  more: {
    skills?: number
    requestMs?: number
    programs?: string[]
    device?: Record<string, unknown>
    git?: MasterGit
    /** The node's status says it keeps its own profiles (#802). */
    own?: boolean
  } = {},
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
        ...(more.own && { ownProfiles: true }),
      },
    }),
    status: async () => null,
    async fetch(path: string, init?: RequestInit) {
      asked.push(path)
      return answer ? answer(path, init) : new Response('{}', { status: 500 })
    },
  } as unknown as Link
  const saved: Record<string, unknown>[] = []
  const logs: string[] = []
  const audits: Record<string, unknown>[] = []
  let record: Record<string, unknown> | null = null
  const cfg = {
    nodes: {
      id: 'laptop',
      devices: { 'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:9' }, ...more.device } },
    },
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
    log: text => logs.push(text),
    audit: line => audits.push(line),
    home,
    platform: 'linux',
    boardDir: join(root, 'board'),
    hostName: 'laptop',
    clock,
    ...(more.requestMs !== undefined && { requestMs: more.requestMs }),
    ...(more.git && { git: more.git }),
  })
  return {
    sync,
    timers,
    asked,
    saved,
    dir,
    home,
    advance: (ms: number) => (now += ms),
    record: () => record,
    logs,
    audits,
  }
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

  describe('the secrets with the sync (#604)', () => {
    const CANARY = 'canary-sync-secrets-77c4'
    /** A profile with an MCP header, a secret-named env and a hook whose script reads a secret config beside it. */
    const withSecrets = (s: ReturnType<typeof setup>): void => {
      mkdirSync(join(s.dir, 'mem'), { recursive: true })
      writeFileSync(join(s.dir, 'mem', 'save.mjs'), "const c = new URL('./config.json', import.meta.url)\n")
      writeFileSync(join(s.dir, 'mem', 'config.json'), JSON.stringify({ token: CANARY }))
      writeFileSync(
        join(s.dir, 'settings.json'),
        JSON.stringify({
          env: { API_TOKEN: `${CANARY}-env` },
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: `bun ${s.dir.replaceAll('\\', '/')}/mem/save.mjs` }] }],
          },
        }),
      )
      writeFileSync(
        join(s.home, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            mem: { type: 'http', url: 'https://m.example/mcp', headers: { Authorization: `Bearer ${CANARY}` } },
          },
        }),
      )
    }
    /** A node that takes the secrets and says their names. */
    const node = (bodies: string[]) => (path: string, init?: RequestInit) => {
      if (!path.endsWith('/secrets')) return taking(path)
      bodies.push(String(init?.body ?? ''))
      return Response.json({
        ok: true,
        env: ['API_TOKEN', 'MCP_MEM_AUTHORIZATION'],
        written: ['API_TOKEN', 'MCP_MEM_AUTHORIZATION'],
        removed: [],
        files: ['mem/config.json'],
        filesWritten: ['mem/config.json'],
        filesRemoved: [],
        kept: [],
        refused: [],
      })
    }

    test('on (absent): the values in a request of their own, first; the report and the audit with names only', async () => {
      const bodies: string[] = []
      const s = setup('online', node(bodies))
      withSecrets(s)
      const r = await s.sync.syncIfBehind('server-1')
      expect(r.ok).toBe(true)
      expect(s.asked[0]).toBe('/api/node/bundle/default/secrets')
      expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
        env: { API_TOKEN: `${CANARY}-env`, MCP_MEM_AUTHORIZATION: `Bearer ${CANARY}` },
        files: [{ path: 'mem/config.json', text: JSON.stringify({ token: CANARY }) }],
        keep: [],
      })
      expect(r.secrets).toEqual({
        given: ['API_TOKEN', 'MCP_MEM_AUTHORIZATION'],
        files: ['mem/config.json'],
        kept: [],
        refused: [],
      })
      expect(s.audits).toEqual([
        {
          op: 'bundle-sent',
          device: 'server-1',
          profile: 'default',
          names: ['API_TOKEN', 'MCP_MEM_AUTHORIZATION'],
          removed: [],
          files: ['mem/config.json'],
          filesRemoved: [],
        },
      ])
      expect(s.sync.secrets('server-1')).toEqual({
        given: ['API_TOKEN', 'MCP_MEM_AUTHORIZATION', 'mem/config.json'],
        toGive: [],
      })
      // Not in the manifest, a blob, the record, the report, a log line.
      const others = s.asked.filter(p => !p.endsWith('/secrets'))
      expect(others.some(p => p.includes(CANARY))).toBe(false)
      for (const said of [JSON.stringify(s.record()), JSON.stringify(r), s.logs.join('\n'), JSON.stringify(s.audits)])
        expect(said).not.toContain(CANARY)
    })

    test('a value that changed with no file changing still goes: each sync sends them', async () => {
      const bodies: string[] = []
      const s = setup('online', node(bodies))
      withSecrets(s)
      await s.sync.syncIfBehind('server-1')
      await s.sync.syncIfBehind('server-1')
      expect(bodies.length).toBe(2)
    })

    test('off: no request, no secrets in the report, the names to give by hand, as main', async () => {
      const bodies: string[] = []
      const s = setup('online', node(bodies), { device: { giveSecrets: false } })
      withSecrets(s)
      const r = await s.sync.syncIfBehind('server-1')
      expect(r.ok).toBe(true)
      expect(bodies).toEqual([])
      expect(s.asked.some(p => p.endsWith('/secrets'))).toBe(false)
      expect('secrets' in r).toBe(false)
      expect(s.sync.secrets('server-1')).toEqual({
        given: [],
        toGive: ['API_TOKEN', 'MCP_MEM_AUTHORIZATION', 'mem/config.json'],
      })
      expect(s.audits).toEqual([])
    })

    test('nothing to give and nothing given before: no request', async () => {
      const s = setup('online', taking)
      const r = await s.sync.syncIfBehind('server-1')
      expect(r.ok).toBe(true)
      expect(s.asked.some(p => p.endsWith('/secrets'))).toBe(false)
    })

    test('a node of an older board (no such route): the sync goes on, the report says so', async () => {
      const s = setup('online', path =>
        path.endsWith('/secrets') ? Response.json({ error: 'not found' }, { status: 404 }) : taking(path),
      )
      withSecrets(s)
      const r = await s.sync.syncIfBehind('server-1')
      expect([r.ok, r.secrets?.error]).toEqual([true, 'not found'])
      expect(s.sync.secrets('server-1').toGive).toEqual(['API_TOKEN', 'MCP_MEM_AUTHORIZATION', 'mem/config.json'])
    })

    test('a failed sync does not forget what the node holds; off afterwards, the row says given, not to give', async () => {
      const bodies: string[] = []
      let fail = false
      const answer = node(bodies)
      const s = setup('online', (path, init) =>
        fail && path.endsWith('/secrets') ? Promise.reject(new Error('cut')) : answer(path, init),
      )
      withSecrets(s)
      await s.sync.syncIfBehind('server-1')
      fail = true
      const broken = await s.sync.syncIfBehind('server-1')
      expect(broken.ok).toBe(false)
      expect(s.sync.secrets('server-1').given).toEqual(['API_TOKEN', 'MCP_MEM_AUTHORIZATION', 'mem/config.json'])
      // Nothing to give any more: the node still holds them, so it is told to take them out.
      fail = false
      writeFileSync(join(s.dir, 'settings.json'), '{}')
      writeFileSync(join(s.home, '.claude.json'), '{}')
      writeFileSync(join(s.dir, 'mem', 'config.json'), '{}')
      await s.sync.syncIfBehind('server-1')
      expect(JSON.parse(bodies.at(-1) ?? '{}')).toEqual({ env: {}, files: [], keep: [] })
    })

    test('a secret file this board cannot read is named in keep, so the node does not take its copy out', async () => {
      const bodies: string[] = []
      const s = setup('online', node(bodies))
      withSecrets(s)
      writeFileSync(join(s.dir, 'mem', 'config.json'), JSON.stringify({ token: 'x'.repeat(1024 * 1024 + 1) }))
      const r = await s.sync.syncIfBehind('server-1')
      expect(JSON.parse(bodies[0] ?? '{}').keep).toEqual(['mem/config.json'])
      expect(JSON.parse(bodies[0] ?? '{}').files).toEqual([])
      expect(r.secrets?.refused).toContain('mem/config.json')
    })
  })

  describe("the owner's git identity and GitHub login (#609)", () => {
    const CANARY = 'gho_canarySyncGitLogin0123456789'
    const OWNER = { name: 'Owner Name', email: 'owner@example.com' }
    /** The master's git: its identity, its logins, and how often each was asked. */
    const git = (o: { identity?: typeof OWNER | null; none?: 'no-gh' | 'no-login'; hosts?: string[] } = {}) => {
      const asked = { identity: 0, logins: 0 }
      let identity = o.identity === undefined ? OWNER : o.identity
      const master: MasterGit = {
        identity: async () => {
          asked.identity++
          return identity
        },
        logins: async () => {
          asked.logins++
          if (o.none) return { logins: [], none: o.none }
          return {
            logins: (o.hosts ?? ['github.com']).map(host => ({ host, user: 'owner', token: `${CANARY}${host}` })),
          }
        },
      }
      return { master, asked, set: (v: typeof OWNER | null) => (identity = v) }
    }
    /** A node that takes what it is sent and says the logins it took. */
    const node = (sent: Record<string, string[]>) => (path: string, init?: RequestInit) => {
      const kind = path.endsWith('/secrets') ? 'secrets' : path.endsWith('/commit') ? 'commit' : null
      if (kind) sent[kind] = [...(sent[kind] ?? []), String(init?.body ?? '')]
      if (kind !== 'secrets') return taking(path)
      const logins = (JSON.parse(String(init?.body)).logins ?? []) as { host: string; user: string }[]
      return Response.json({
        ok: true,
        env: [],
        written: [],
        removed: [],
        files: [],
        filesWritten: [],
        filesRemoved: [],
        kept: [],
        refused: [],
        logins: logins.map(l => ({ host: l.host, user: l.user, via: 'gh' })),
        loginsTaken: logins.map(l => l.host),
        loginsKept: [],
        loginsRefused: [],
        gh: true,
      })
    }

    test('the identity in the manifest committed and a report line, the login in the secrets request alone', async () => {
      const sent: Record<string, string[]> = {}
      const g = git()
      const s = setup('online', node(sent), { git: g.master })
      const r = await s.sync.syncIfBehind('server-1')
      expect(r.ok).toBe(true)
      expect(JSON.parse(sent.commit?.[0] ?? '{}').manifest.git).toEqual(OWNER)
      expect(r.lines).toContainEqual({ kind: 'git', name: 'identity', verdict: 'sent', why: 'identity' })
      expect(JSON.parse(sent.secrets?.[0] ?? '{}').logins).toEqual([
        { host: 'github.com', user: 'owner', token: `${CANARY}github.com` },
      ])
      expect(s.asked[0]).toBe('/api/node/bundle/default/secrets')
      expect(r.secrets).toEqual({
        given: [],
        files: [],
        kept: [],
        refused: [],
        logins: [{ host: 'github.com', user: 'owner', via: 'gh' }],
        loginsKept: [],
        gh: true,
      })
      expect(s.audits).toEqual([
        {
          op: 'bundle-sent',
          device: 'server-1',
          profile: 'default',
          names: [],
          removed: [],
          files: [],
          filesRemoved: [],
          logins: ['github.com'],
        },
      ])
      // The token: in the secrets request and nowhere else.
      expect(sent.commit?.join('')).not.toContain(CANARY)
      for (const said of [JSON.stringify(s.record()), JSON.stringify(r), s.logs.join('\n'), JSON.stringify(s.audits)])
        expect(said).not.toContain(CANARY)
    })

    test('two hosts go, each with its token', async () => {
      const sent: Record<string, string[]> = {}
      const s = setup('online', node(sent), { git: git({ hosts: ['github.com', 'ghe.example.com'] }).master })
      const r = await s.sync.syncIfBehind('server-1')
      expect(JSON.parse(sent.secrets?.[0] ?? '{}').logins.map((l: { host: string }) => l.host)).toEqual([
        'github.com',
        'ghe.example.com',
      ])
      expect(r.secrets?.logins?.map(l => l.host)).toEqual(['github.com', 'ghe.example.com'])
    })

    test('the switch off: no login asked or sent, the identity still goes', async () => {
      const sent: Record<string, string[]> = {}
      const g = git()
      const s = setup('online', node(sent), { git: g.master, device: { giveSecrets: false } })
      const r = await s.sync.syncIfBehind('server-1')
      expect(r.ok).toBe(true)
      expect(sent.secrets).toBeUndefined()
      expect(g.asked.logins).toBe(0)
      expect('secrets' in r).toBe(false)
      expect(JSON.parse(sent.commit?.[0] ?? '{}').manifest.git).toEqual(OWNER)
    })

    test('no gh here, or no login: no request when nothing else goes, and the report says there was none', async () => {
      for (const none of ['no-gh', 'no-login'] as const) {
        const sent: Record<string, string[]> = {}
        const s = setup('online', node(sent), { git: git({ none }).master })
        const r = await s.sync.syncIfBehind('server-1')
        expect(sent.secrets).toBeUndefined()
        expect(r.secrets).toEqual({ given: [], files: [], kept: [], refused: [], noLogin: none })
      }
    })

    test('no identity here: none in the manifest, a report line', async () => {
      const sent: Record<string, string[]> = {}
      const s = setup('online', node(sent), { git: git({ identity: null }).master })
      const r = await s.sync.syncIfBehind('server-1')
      expect('git' in JSON.parse(sent.commit?.[0] ?? '{}').manifest).toBe(false)
      expect(r.lines).toContainEqual({ kind: 'git', name: 'identity', verdict: 'not-sent', why: 'no-identity' })
    })

    test('what the node did with the identity is the report; one that did not take is tried again by a commit with no blob', async () => {
      const outcomes = ['failed', 'set']
      let have: { seq: number; hash: string; files: Record<string, string> } = { seq: 0, hash: '', files: {} }
      let commits = 0
      const s = setup(
        'online',
        (path, init) => {
          if (path.endsWith('/commit')) {
            commits++
            const body = JSON.parse(String(init?.body))
            const files = Object.fromEntries(
              (body.manifest.files as { path: string; sha256: string }[]).map(f => [f.path, f.sha256]),
            )
            have = { seq: body.seq, hash: body.hash, files }
            return Response.json({ ok: true, applied: [], kept: [], backup: null, git: outcomes.shift() ?? 'same' })
          }
          if (path.includes('/blob/')) return Response.json({ ok: true })
          if (path.endsWith('/secrets')) return Response.json({ error: 'not found' }, { status: 404 })
          return Response.json(have)
        },
        { git: git({ none: 'no-login' }).master },
      )
      expect((await s.sync.syncIfBehind('server-1')).identity).toBe('failed')
      const blobs = s.asked.filter(p => p.includes('/blob/')).length
      expect((await s.sync.syncIfBehind('server-1')).identity).toBe('set')
      expect(s.asked.filter(p => p.includes('/blob/')).length).toBe(blobs)
      expect((await s.sync.syncIfBehind('server-1')).identity).toBe('set')
      expect(commits).toBe(2)
    })

    test('a node of an older board takes the request and none of the logins: said', async () => {
      const s = setup(
        'online',
        path =>
          path.endsWith('/secrets')
            ? Response.json({
                ok: true,
                env: [],
                written: [],
                removed: [],
                files: [],
                filesWritten: [],
                filesRemoved: [],
                kept: [],
                refused: [],
              })
            : taking(path),
        { git: git().master },
      )
      const r = await s.sync.syncIfBehind('server-1')
      expect(r.secrets?.logins).toEqual([])
      expect(r.secrets?.loginsKept).toEqual([{ host: 'github.com', why: 'older' }])
    })

    test("a change of the owner's identity moves the hash on the 5 minute tick, with no request", async () => {
      const g = git()
      const s = setup('online', taking, { git: g.master })
      await s.sync.syncIfBehind('server-1')
      const seq = (s.record() as { profiles: { default: { seq: number } } }).profiles.default.seq
      const asked = s.asked.length
      g.set({ name: 'Owner Renamed', email: OWNER.email })
      s.timers[0]?.fn()
      await Bun.sleep(20)
      expect((s.record() as { profiles: { default: { seq: number } } }).profiles.default.seq).toBe(seq + 1)
      expect(s.asked.length).toBe(asked)
    })
  })
})

describe('a device with its own profiles (#802)', () => {
  const taking = (path: string): Response =>
    path.endsWith('/commit')
      ? Response.json({ ok: true, applied: [], kept: [], backup: null })
      : path.includes('/blob/')
        ? Response.json({ ok: true })
        : Response.json({ seq: 0, hash: '', files: {} })

  test('marked in config.json: a sync sends nothing, not even the secrets, and says own; the tick builds nothing', async () => {
    const s = setup('online', taking, { device: { ownProfiles: true } })
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why]).toEqual([false, 'own'])
    expect(s.asked).toEqual([])
    s.timers[0]?.fn()
    expect(s.saved).toEqual([])
  })

  test('said by its status: the same', async () => {
    const s = setup('online', taking, { own: true })
    const r = await s.sync.syncIfBehind('server-1')
    expect([r.ok, r.why]).toEqual([false, 'own'])
    expect(s.asked).toEqual([])
    s.timers[0]?.fn()
    expect(s.saved).toEqual([])
  })

  test('a helper without the mark syncs as before', async () => {
    const s = setup('online', taking)
    const r = await s.sync.syncIfBehind('server-1')
    expect(r.ok).toBe(true)
    expect(s.asked[0]).toBe('/api/node/bundle/default')
    expect(s.asked.at(-1)).toBe('/api/node/bundle/default/commit')
  })
})
