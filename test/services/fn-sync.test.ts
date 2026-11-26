import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, refHead } from '../../src/adapters/fn-git.ts'
import { decide, fnSyncCheck } from '../../src/core/fn-sync.ts'
import { nodeStatusOf } from '../../src/core/nodes.ts'
import { nodeDoorRoutes } from '../../src/server/routes/node.ts'
import { createNodeFunctions, functionsDir } from '../../src/services/node/fn-sync.ts'
import {
  createFnSync,
  type FnReplica,
  fnSyncDevices,
  linkReplica,
  localReplica,
} from '../../src/services/nodes/fn-sync.ts'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const scratch = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'fn-sync-'))
  roots.push(r)
  return r
}
const run = async (dir: string, ...args: string[]): Promise<string> => {
  const r = await git(dir, args)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err}`)
  return r.text.trim()
}

/** The node's door as the master reaches it: the real routes, called in process. */
function doorLink(routes: ReturnType<typeof nodeDoorRoutes>) {
  return {
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      const method = init?.method ?? 'GET'
      const route = routes.find(r => r.method === method && r.path === path)
      if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      const req = new Request(`http://node${path}`, { method, ...(init?.body ? { body: init.body } : {}) })
      return (await route.handle(req, {} as never)) as Response
    },
  }
}

function machine(root: string, id: string, opts: { via?: 'door' | 'local'; repo?: boolean } = {}) {
  const dir = join(root, id, '.mokutab', 'functions')
  mkdirSync(dir, { recursive: true })
  const fns = createNodeFunctions({ dir })
  const replica: FnReplica =
    opts.via === 'door' ? linkReplica(id, doorLink(nodeDoorRoutes({ functions: fns } as never))) : localReplica(id, fns)
  const put = (path: string, text: string): void => {
    const to = join(dir, ...path.split('/'))
    mkdirSync(join(to, '..'), { recursive: true })
    writeFileSync(to, text)
  }
  const commit = async (msg: string, author = 'Owner'): Promise<string> => {
    await run(dir, 'add', '-A')
    await run(dir, '-c', `user.name=${author}`, '-c', 'user.email=owner@example.invalid', 'commit', '-q', '-m', msg)
    return run(dir, 'rev-parse', 'HEAD')
  }
  const get = (path: string): string | null => {
    const at = join(dir, ...path.split('/'))
    return existsSync(at) ? readFileSync(at, 'utf8') : null
  }
  const head = (): Promise<string> => run(dir, 'rev-parse', 'HEAD')
  return { id, dir, fns, replica, put, commit, get, head }
}

async function mesh(ids: string[], door: string[] = []) {
  const root = scratch()
  const ms = ids.map(id => machine(root, id, { via: door.includes(id) ? 'door' : 'local' }))
  const logs: string[] = []
  let only: string[] | null = null
  const sync = createFnSync({
    dir: join(root, 'state', 'fn-sync'),
    replicas: () => ms.filter(m => !only || only.includes(m.id)).map(m => m.replica),
    log: l => logs.push(l),
  })
  return {
    root,
    ms,
    sync,
    logs,
    hub: join(root, 'state', 'fn-sync', 'hub.git'),
    only: (ids_: string[] | null) => {
      only = ids_
    },
  }
}

/** The first machine has the repository, the others an empty folder: the first sync clones it to them. */
async function seeded(ids: string[], door: string[] = []) {
  const m = await mesh(ids, door)
  const first = m.ms[0] as ReturnType<typeof machine>
  await run(first.dir, 'init', '-q', '-b', 'master')
  first.put('README.md', '# Browser functions\n')
  first.put('netsuite/login.yaml', 'name: netsuite.login\nversion: 1\n')
  await first.commit('netsuite.login v1: first')
  const r = await m.sync.syncAll()
  expect(r.ok).toBe(true)
  return m
}

describe('decide', () => {
  test('only fast-forwards; dirty, another branch and diverged stop', () => {
    const hub = { branch: 'master', head: 'a'.repeat(40) }
    const repo = (head: string, dirty: string[] = [], branch = 'master') => ({
      state: 'repo' as const,
      branch,
      head,
      dirty,
    })
    const rel = (o: Partial<{ known: boolean; behind: boolean; ahead: boolean }>) => ({
      known: true,
      behind: false,
      ahead: false,
      ...o,
    })
    expect(decide({ look: { state: 'none' }, hub, relation: null })).toEqual({ do: 'skip' })
    expect(decide({ look: { state: 'empty' }, hub, relation: null })).toEqual({ do: 'clone' })
    expect(decide({ look: { state: 'not-repo' }, hub, relation: null })).toEqual({ do: 'stop', why: 'not-repo' })
    expect(decide({ look: repo('b'.repeat(40)), hub: null, relation: null })).toEqual({ do: 'seed' })
    expect(decide({ look: repo('a'.repeat(40)), hub, relation: null })).toEqual({ do: 'current' })
    expect(decide({ look: repo('b'.repeat(40), [], 'dev'), hub, relation: null })).toEqual({
      do: 'stop',
      why: 'branch',
    })
    expect(decide({ look: repo('b'.repeat(40)), hub, relation: rel({ known: false }) })).toEqual({ do: 'fetch' })
    expect(decide({ look: repo('b'.repeat(40)), hub, relation: rel({ ahead: true }) })).toEqual({ do: 'take' })
    expect(decide({ look: repo('b'.repeat(40)), hub, relation: rel({ behind: true }) })).toEqual({ do: 'give' })
    expect(decide({ look: repo('b'.repeat(40), ['x.yaml']), hub, relation: rel({ behind: true }) })).toEqual({
      do: 'stop',
      why: 'dirty',
    })
    expect(decide({ look: repo('b'.repeat(40)), hub, relation: rel({}) })).toEqual({ do: 'stop', why: 'diverged' })
  })
})

describe('functions sync through the master', () => {
  test('a commit on a node reaches the master and the other node, its author kept', async () => {
    const m = await seeded(['server-2', 'laptop', 'desk'], ['laptop', 'desk'])
    const [master, laptop, desk] = m.ms as ReturnType<typeof machine>[] as [
      ReturnType<typeof machine>,
      ReturnType<typeof machine>,
      ReturnType<typeof machine>,
    ]
    expect(laptop.get('netsuite/login.yaml')).toBe('name: netsuite.login\nversion: 1\n')
    laptop.put('jira/worklog.add.yaml', 'name: jira.worklog.add\n')
    const sha = await laptop.commit('jira.worklog.add v1: new', 'Vault Author')
    const r = await m.sync.syncAll()
    expect(r.ok).toBe(true)
    expect(r.head).toBe(sha)
    expect(await master.head()).toBe(sha)
    expect(await desk.head()).toBe(sha)
    expect(desk.get('jira/worklog.add.yaml')).toBe('name: jira.worklog.add\n')
    expect(await run(desk.dir, 'log', '-1', '--format=%an %s')).toBe('Vault Author jira.worklog.add v1: new')
    expect(r.rounds.find(x => x.device === 'laptop')?.did).toBe('take')
    expect(r.rounds.find(x => x.device === 'desk')?.did).toBe('give')
    // Nothing to do: every machine current.
    const quiet = await m.sync.syncAll()
    expect(quiet.rounds.map(x => x.did)).toEqual(['current', 'current', 'current'])
  })

  test('a delete travels as the commit it is', async () => {
    const m = await seeded(['server-2', 'laptop'], ['laptop'])
    const [master, laptop] = m.ms as [ReturnType<typeof machine>, ReturnType<typeof machine>]
    rmSync(join(master.dir, 'netsuite', 'login.yaml'))
    await master.commit('netsuite.login: deleted')
    await m.sync.syncAll()
    expect(laptop.get('netsuite/login.yaml')).toBeNull()
    expect(laptop.get('README.md')).toBe('# Browser functions\n')
  })

  test('changes not committed are never written over: the sync stops there and says so', async () => {
    const m = await seeded(['server-2', 'laptop'], ['laptop'])
    const [master, laptop] = m.ms as [ReturnType<typeof machine>, ReturnType<typeof machine>]
    laptop.put('netsuite/login.yaml', 'name: netsuite.login\nversion: local edit\n')
    master.put('netsuite/login.yaml', 'name: netsuite.login\nversion: 2\n')
    await master.commit('netsuite.login v2')
    const before = await laptop.head()
    const r = await m.sync.syncAll()
    expect(r.ok).toBe(false)
    expect(r.rounds.find(x => x.device === 'laptop')).toMatchObject({ did: 'stop', why: 'dirty' })
    expect(await laptop.head()).toBe(before)
    expect(laptop.get('netsuite/login.yaml')).toBe('name: netsuite.login\nversion: local edit\n')
  })

  test('two machines that committed apart: the first goes in, the other stops with its commit kept in the hub', async () => {
    const m = await seeded(['server-2', 'laptop', 'desk'], ['laptop', 'desk'])
    const [master, laptop, desk] = m.ms as [
      ReturnType<typeof machine>,
      ReturnType<typeof machine>,
      ReturnType<typeof machine>,
    ]
    laptop.put('outlook/mail.send.yaml', 'v: laptop\n')
    const a = await laptop.commit('mail.send from the laptop')
    desk.put('outlook/mail.send.yaml', 'v: desk\n')
    const b = await desk.commit('mail.send from the desk')
    const r = await m.sync.syncAll()
    expect(await master.head()).toBe(a)
    expect(r.rounds.find(x => x.device === 'desk')).toMatchObject({ did: 'stop', why: 'diverged' })
    // Nothing written on the desk; its commit is not lost.
    expect(await desk.head()).toBe(b)
    expect(desk.get('outlook/mail.send.yaml')).toBe('v: desk\n')
    expect(await refHead(m.hub, 'refs/conflicts/desk')).toBe(b)
    // board doctor names it.
    const state = JSON.parse(readFileSync(join(m.root, 'state', 'fn-sync', 'state.json'), 'utf8'))
    const t = ((k: string, v?: Record<string, unknown>) => (v ? `${k} ${JSON.stringify(v)}` : k)) as never
    const check = fnSyncCheck(state, t)
    expect(check?.level).toBe('warn')
    expect(check?.detail).toContain('desk (fnSync.stop.diverged)')
    // The owner brings the desk back onto the registry: the next sync is clean.
    await run(desk.dir, 'fetch', '-q', laptop.dir, 'master')
    await run(desk.dir, 'reset', '-q', '--hard', a)
    const again = await m.sync.syncAll()
    expect(again.ok).toBe(true)
    expect(
      fnSyncCheck(JSON.parse(readFileSync(join(m.root, 'state', 'fn-sync', 'state.json'), 'utf8')), t)?.level,
    ).toBe('ok')
  })

  test('a commit bringing a file that looks like a secret is refused and named, and goes nowhere', async () => {
    const m = await seeded(['server-2', 'laptop', 'desk'], ['laptop', 'desk'])
    const [master, laptop, desk] = m.ms as [
      ReturnType<typeof machine>,
      ReturnType<typeof machine>,
      ReturnType<typeof machine>,
    ]
    const before = await master.head()
    laptop.put('centium/leak.yaml', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n')
    await laptop.commit('leak')
    const r = await m.sync.syncAll()
    expect(r.rounds.find(x => x.device === 'laptop')).toMatchObject({
      did: 'stop',
      why: 'refused',
      refused: [{ path: 'centium/leak.yaml', why: 'secret: a GitHub token' }],
    })
    expect(await master.head()).toBe(before)
    expect(await desk.head()).toBe(before)
    expect(JSON.stringify(r)).not.toContain('ghp_')
    expect(m.logs.join('\n')).not.toContain('ghp_')
    expect(readFileSync(join(m.root, 'state', 'fn-sync', 'state.json'), 'utf8')).not.toContain('ghp_')
  })

  test('a file larger than 256 KB is refused', async () => {
    const m = await seeded(['server-2', 'laptop'], ['laptop'])
    const [, laptop] = m.ms as [ReturnType<typeof machine>, ReturnType<typeof machine>]
    laptop.put('big.yaml', 'x'.repeat(300 * 1024))
    await laptop.commit('big')
    const r = await m.sync.syncAll()
    expect(r.rounds.find(x => x.device === 'laptop')?.refused).toEqual([{ path: 'big.yaml', why: 'too-large' }])
  })

  test('without the folder a machine takes no part; a folder that is no repository is left alone', async () => {
    const m = await seeded(['server-2', 'laptop', 'desk'], ['laptop', 'desk'])
    const [, laptop, desk] = m.ms as [
      ReturnType<typeof machine>,
      ReturnType<typeof machine>,
      ReturnType<typeof machine>,
    ]
    rmSync(laptop.dir, { recursive: true })
    rmSync(join(desk.dir, '.git'), { recursive: true, force: true })
    const r = await m.sync.syncAll()
    expect(r.rounds.find(x => x.device === 'laptop')).toMatchObject({ did: 'skip', why: 'no-folder' })
    expect(r.rounds.find(x => x.device === 'desk')).toMatchObject({ did: 'stop', why: 'not-repo' })
    expect(existsSync(laptop.dir)).toBe(false)
    expect(existsSync(join(desk.dir, '.git'))).toBe(false)
  })

  test('a machine on another branch is left alone', async () => {
    const m = await seeded(['server-2', 'laptop'], ['laptop'])
    const [, laptop] = m.ms as [ReturnType<typeof machine>, ReturnType<typeof machine>]
    await run(laptop.dir, 'checkout', '-q', '-b', 'try')
    const r = await m.sync.syncAll()
    expect(r.rounds.find(x => x.device === 'laptop')).toMatchObject({ did: 'stop', why: 'branch' })
  })

  test('a dry run says what would move and writes nothing', async () => {
    const m = await seeded(['server-2', 'laptop'], ['laptop'])
    const [master, laptop] = m.ms as [ReturnType<typeof machine>, ReturnType<typeof machine>]
    laptop.put('a.yaml', 'v: 1\n')
    await laptop.commit('a')
    const before = await master.head()
    const state = readFileSync(join(m.root, 'state', 'fn-sync', 'state.json'), 'utf8')
    const r = await m.sync.syncAll({ dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(r.rounds.find(x => x.device === 'laptop')?.did).toBe('new-commits')
    expect(await master.head()).toBe(before)
    expect(readFileSync(join(m.root, 'state', 'fn-sync', 'state.json'), 'utf8')).toBe(state)
  })

  test('a node of an older board, without the routes, is said and skipped', async () => {
    const root = scratch()
    const sync = createFnSync({
      dir: join(root, 'fn-sync'),
      replicas: () => [linkReplica('old', doorLink([]))],
      log: () => {},
    })
    const r = await sync.syncAll()
    expect(r.rounds).toEqual([{ device: 'old', did: 'skip', why: 'older', refused: [] }])
  })
})

describe('who takes part', () => {
  test("only the owner's own devices with a link online: never owner false, revoked, or local", () => {
    const dev = (id: string, extra: Record<string, unknown> = {}) => ({ id, link: { kind: 'ssh' }, ...extra })
    const nodes = {
      id: 'server-2',
      order: ['local', 'laptop', 'peer-box', 'gone', 'away', 'plain'],
      devices: {
        local: { id: 'local', link: null },
        laptop: dev('laptop'),
        'peer-box': dev('peer-box', { owner: false }),
        gone: dev('gone', { revoked: true }),
        away: dev('away'),
        plain: { id: 'plain', link: null },
      },
    } as never
    expect(fnSyncDevices(nodes, id => id !== 'away')).toEqual(['laptop'])
    expect(fnSyncDevices(null, () => true)).toEqual([])
  })
})

describe('the node status', () => {
  test("carries the folder's stamp, which moves with a commit; none without the folder", async () => {
    const root = scratch()
    const dir = join(root, 'functions')
    const fns = createNodeFunctions({ dir })
    expect(fns.stamp()).toBeUndefined()
    mkdirSync(dir)
    await run(dir, 'init', '-q', '-b', 'master')
    writeFileSync(join(dir, 'a.yaml'), 'v: 1\n')
    await run(dir, 'add', '-A')
    await run(dir, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-m', 'a')
    const one = fns.stamp()
    writeFileSync(join(dir, 'a.yaml'), 'v: 2\n')
    await run(dir, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-am', 'b')
    const two = fns.stamp()
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    expect(two).not.toBe(one)
    const status = {
      api: 1,
      id: 'laptop',
      version: '1',
      commit: '',
      platform: 'linux',
      arch: 'x64',
      cpus: 1,
      memTotalMb: 1,
      memAvailableMb: null,
      load: null,
      sessions: { awake: 0, working: 0, asleep: 0 },
      launches: 0,
      workRootFreeMb: null,
      profiles: [],
      agents: [],
      at: 1,
    }
    expect(nodeStatusOf({ ...status, functions: two })?.functions).toBe(two as string)
    expect(nodeStatusOf(status)?.functions).toBeUndefined()
    expect(nodeStatusOf({ ...status, functions: 'not a stamp' })?.functions).toBeUndefined()
  })

  test('the folder is MOKUTAB_DATA_DIR/functions, else ~/.mokutab/functions', () => {
    expect(functionsDir({ MOKUTAB_DATA_DIR: '/data/mt' }, '/home/u')).toBe(join('/data/mt', 'functions'))
    expect(functionsDir({}, '/home/u')).toBe(join('/home/u', '.mokutab', 'functions'))
  })
})

describe('when a sync runs by itself', () => {
  function manualClock() {
    let t = 0
    let next = 1
    const timers = new Map<number, { at: number; fn: () => void; every?: number }>()
    return {
      now: () => t,
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++
        timers.set(id, { at: t + ms, fn })
        return id
      },
      clearTimeout: (h: unknown) => timers.delete(h as number),
      setInterval: (fn: () => void, ms: number) => {
        const id = next++
        timers.set(id, { at: t + ms, fn, every: ms })
        return id
      },
      clearInterval: (h: unknown) => timers.delete(h as number),
      advance(ms: number) {
        const end = t + ms
        for (;;) {
          const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
          if (!due) break
          const [id, x] = due
          t = x.at
          if (x.every) x.at += x.every
          else timers.delete(id)
          x.fn()
        }
        t = end
      },
    }
  }

  test('a device coming online, a moved stamp and a change here ask for one; a quiet mesh asks nothing', async () => {
    const clock = manualClock()
    let calls = 0
    const stamps: Record<string, string> = {}
    const sync = {
      syncAll: async () => {
        calls++
        return { ok: true, dryRun: false, branch: 'master', head: null, rounds: [], at: 0 }
      },
      stamp: (d: string) => stamps[d],
      setStamp: (d: string, s: string) => {
        stamps[d] = s
      },
    }
    const st: Record<string, { state: string; functions?: string }> = { laptop: { state: 'offline' } }
    let changed: (id: string) => void = () => {}
    const links = {
      link: (id: string) =>
        st[id]
          ? ({
              state: () => ({ state: st[id]?.state }),
              view: () => ({ status: st[id]?.functions ? { functions: st[id]?.functions } : null }),
            } as never)
          : null,
      onChange: (fn: (id: string) => void) => {
        changed = fn
        return () => {}
      },
    }
    let local = 'a'.repeat(64)
    const nodes = {
      id: 'server-2',
      order: ['local', 'laptop'],
      devices: { local: { id: 'local', link: null }, laptop: { id: 'laptop', link: { kind: 'ssh' } } },
    } as never
    const { createFnSyncRunner } = await import('../../src/services/nodes/fn-sync.ts')
    const runner = createFnSyncRunner({
      sync,
      local: { stamp: () => local } as never,
      nodes: () => nodes,
      links,
      log: () => {},
      clock,
      tickMs: 1000,
      settleMs: 100,
    })
    clock.advance(200)
    await Promise.resolve()
    expect(calls).toBe(1) // at start
    clock.advance(5000)
    await Promise.resolve()
    expect(calls).toBe(1) // quiet
    st.laptop = { state: 'online', functions: 'b'.repeat(64) }
    changed('laptop')
    clock.advance(200)
    await Promise.resolve()
    expect(calls).toBe(2) // came online
    sync.setStamp('laptop', 'b'.repeat(64))
    clock.advance(3000)
    await Promise.resolve()
    expect(calls).toBe(2)
    st.laptop = { state: 'online', functions: 'c'.repeat(64) }
    changed('laptop')
    clock.advance(200)
    await Promise.resolve()
    expect(calls).toBe(3) // its folder moved
    sync.setStamp('laptop', 'c'.repeat(64))
    local = 'd'.repeat(64)
    clock.advance(1200)
    await Promise.resolve()
    expect(calls).toBe(4) // the master's own folder moved
    runner.close()
  })
})
