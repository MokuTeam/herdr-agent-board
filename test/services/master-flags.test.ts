// Feature flags from the master (#775): the master makes them from its config (services/nodes/master-flags.ts),
// its relay runner posts them to the node's door when the stream opens and when they change
// (services/nodes/master-relay.ts), and the node keeps them beside its config, in memory and on disk,
// puts the card-level ones into its live config and keeps the last ones while the master is away
// (services/node/master-flags.ts). Settings writes for those features are refused on a node.
import { describe, expect, onTestFinished, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFile, editFeatures, editThreads, editTodos } from '../../src/adapters/config-file.ts'
import { masterFlagsFile, nodeMasterFlags, readMasterFlags } from '../../src/adapters/master-flags-store.ts'
import { readPresence } from '../../src/adapters/presence-store.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { MasterFlagsWire } from '../../src/core/master-flags.ts'
import type { Config } from '../../src/core/types.ts'
import { createNodeMasterFlags } from '../../src/services/node/master-flags.ts'
import { createMasterRelay } from '../../src/services/node/master-relay.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { masterFlagsFor } from '../../src/services/nodes/master-flags.ts'
import { createMasterRelayRunner } from '../../src/services/nodes/master-relay.ts'
import { isolatedHome } from '../support/env.ts'

const NODE = { id: 'server-1', port: 12430, workRoot: '/tmp' }

describe("the master's flags", () => {
  test('names and switches only: no hub, key or source leaves the master', () => {
    const cfg = {
      threads: { agents: false, cases: true },
      todos: { autoClose: true },
      decisions: { defaults: false },
      watches: true,
      calendar: { sources: [{ id: 'g', kind: 'ics', url: 'https://example.invalid/secret.ics' }] },
      team: { hub: 'ws://hub.invalid:7443', name: 'anna' },
      presence: true,
      journal: { on: false },
      tunnel: { on: true, key: 'secret-key' },
    } as unknown as Config
    const f = masterFlagsFor(cfg, 'laptop')
    expect(f).toEqual({
      master: 'laptop',
      on: ['threads', 'calendar', 'decisions', 'presence', 'team', 'watches', 'todos', 'tunnel'],
      // verify and share always said (#797): a node tells "off" from a master that does not say.
      threads: { agents: false, cases: true, verify: false, share: true },
      todos: { agents: true, autoClose: true },
      decisions: { defaults: false },
    })
    expect(JSON.stringify(f)).not.toMatch(/hub|secret|anna|example/)
  })

  test("presence on: the user's state as the board's view has it, with Settings' mode; off, none", () => {
    const view = { state: 'away' as const, since: 1000, by: 'user' as const, mode: 'suggest' as const, idleMinutes: 15 }
    expect(masterFlagsFor({ presence: { mode: 'suggest' } } as unknown as Config, 'laptop', view).presence).toEqual({
      state: 'away',
      since: 1000,
      by: 'user',
      mode: 'suggest',
    })
    expect(masterFlagsFor({} as Config, 'laptop', view).presence).toBeUndefined()
  })

  test('a master with none of them on sends an empty list', () => {
    expect(masterFlagsFor({} as Config, 'laptop')).toEqual({ master: 'laptop', on: [] })
  })
})

describe("the node's copy", () => {
  const FLAGS: MasterFlagsWire = { master: 'laptop', on: ['threads', 'watches', 'todos'], todos: { agents: true } }

  test('kept beside the config with the time it came; the card-level ones go into the live config', () => {
    isolatedHome()
    const cfg = { node: NODE } as unknown as Config
    let changed = 0
    const holder = createNodeMasterFlags({ cfg, log: () => {}, changed: () => changed++, now: () => 1000 })
    expect(holder.take(FLAGS)).toEqual({ status: 200, body: { ok: true } })
    expect(readMasterFlags()).toEqual({ ...FLAGS, at: 1000 })
    expect(changed).toBe(1)
    expect(cfg.watches).toEqual({})
    expect(cfg.todos).toEqual({})
    expect(cfg.threads).toBeUndefined()
    // The same again: kept with its new time, nothing else moves.
    const again = createNodeMasterFlags({ cfg, log: () => {}, changed: () => changed++, now: () => 2000 })
    expect(again.current()?.at).toBe(1000)
    again.take(FLAGS)
    expect(changed).toBe(1)
    expect(readMasterFlags()?.at).toBe(2000)
    expect(holder.take({ master: '', on: [] }).status).toBe(400)
  })

  test("the master turns one off: it leaves the live config; the node's own section is never touched", () => {
    isolatedHome()
    const cfg = { node: NODE, todos: { agents: false } } as unknown as Config
    const holder = createNodeMasterFlags({ cfg, log: () => {}, changed: () => {} })
    holder.take(FLAGS)
    expect(cfg.watches).toEqual({})
    expect(cfg.todos).toEqual({ agents: false })
    holder.take({ master: 'laptop', on: ['todos'] })
    expect(cfg.watches).toBeUndefined()
    expect(cfg.todos).toEqual({ agents: false })
  })

  test('a reload of config.json: apply puts them back', () => {
    isolatedHome()
    const cfg = { node: NODE } as unknown as Config
    const holder = createNodeMasterFlags({ cfg, log: () => {}, changed: () => {} })
    holder.take(FLAGS)
    // As liveConfig reloads: every key out, the file's back in.
    for (const k of Object.keys(cfg)) delete (cfg as unknown as Record<string, unknown>)[k]
    Object.assign(cfg, { node: NODE })
    holder.apply()
    expect(cfg.watches).toEqual({})
  })

  test('the master away: the last flags stay, read again after a restart, with their age', () => {
    isolatedHome()
    const cfg = { node: NODE } as unknown as Config
    createNodeMasterFlags({ cfg, log: () => {}, changed: () => {}, now: () => 1234 }).take(FLAGS)
    // A new process (the board restarted, the master still away): nothing turned off.
    const cfg2 = { node: NODE } as unknown as Config
    const later = createNodeMasterFlags({ cfg: cfg2, log: () => {}, changed: () => {} })
    later.apply()
    expect(later.current()).toEqual({ ...FLAGS, at: 1234 })
    expect(cfg2.watches).toEqual({})
    expect(nodeMasterFlags(cfg2)?.at).toBe(1234)
  })

  test("the master's presence goes where the node's hooks read it; a change of it alone does not reload the board", () => {
    isolatedHome()
    const cfg = { node: NODE } as unknown as Config
    let changed = 0
    const holder = createNodeMasterFlags({ cfg, log: () => {}, changed: () => changed++ })
    const wire = (state: 'here' | 'away', since: number): MasterFlagsWire => ({
      master: 'laptop',
      on: ['presence'],
      presence: { state, since, by: 'auto', mode: 'auto' },
    })
    holder.take(wire('away', 1000))
    expect(readPresence()).toEqual({ state: 'away', since: 1000, by: 'auto' })
    expect(changed).toBe(1)
    holder.take(wire('here', 2000))
    expect(readPresence()).toEqual({ state: 'here', since: 2000, by: 'auto' })
    expect(readMasterFlags()?.presence?.state).toBe('here')
    expect(changed).toBe(1)
  })

  test('a board without node reads nothing and adds nothing', () => {
    isolatedHome()
    mkdirSync(join(masterFlagsFile(), '..'), { recursive: true })
    writeFileSync(masterFlagsFile(), JSON.stringify({ ...FLAGS, at: 1 }))
    const cfg = {} as Config
    const holder = createNodeMasterFlags({ cfg, log: () => {}, changed: () => {} })
    holder.apply()
    expect(cfg as unknown).toEqual({})
    expect(nodeMasterFlags(cfg)).toBeNull()
  })
})

describe('the link carries them', () => {
  test('posted when the stream opens, again on a change, not again when nothing changed', async () => {
    isolatedHome()
    const cfg = { node: NODE } as unknown as Config
    const relay = createMasterRelay({ cfg, items: () => [], log: () => {} })
    onTestFinished(() => relay.close())
    const holder = createNodeMasterFlags({ cfg, log: () => {}, changed: () => {} })
    const posts: unknown[] = []
    const link = {
      id: 'server-1',
      state: () => ({ state: 'online', since: 0, heardAt: 0 }),
      async fetch(path: string, init?: RequestInit) {
        const req = new Request(`http://door${path}`, init)
        if (path === '/api/node/master-relay') return relay.stream(req)
        if (path === '/api/node/master-flags') {
          const body = await req.json()
          posts.push(body)
          const a = holder.take(body)
          return Response.json(a.body, { status: a.status })
        }
        return new Response('', { status: 404 })
      },
    } as unknown as Link
    let flags: MasterFlagsWire = { master: 'laptop', on: ['watches'] }
    const runner = createMasterRelayRunner({
      links: { link: id => (id === 'server-1' ? link : null), onChange: () => () => {} },
      log: () => {},
      deviceIds: () => ['server-1'],
      selfId: () => 'laptop',
      ownerAllowed: () => true,
      sessionKnown: () => false,
      replay: async () => new Response(''),
      flags: () => flags,
    })
    onTestFinished(() => runner.close())
    runner.sync()
    const until = async (n: number) => {
      const deadline = Date.now() + 3000
      while (posts.length < n && Date.now() < deadline) await Bun.sleep(10)
      expect(posts.length).toBe(n)
    }
    await until(1)
    expect(holder.current()?.on).toEqual(['watches'])
    expect(cfg.watches).toEqual({})
    runner.sync()
    await Bun.sleep(50)
    expect(posts.length).toBe(1)
    flags = { master: 'laptop', on: ['watches', 'decisions'], decisions: { defaults: true } }
    runner.sync()
    await until(2)
    expect(holder.current()?.on).toEqual(['decisions', 'watches'])
    expect(cfg.decisions).toEqual({})
    // The user's presence changed at the master: told at once, not at the next config change.
    flags = {
      ...flags,
      on: ['decisions', 'presence', 'watches'],
      presence: { state: 'away', since: 7, by: 'auto', mode: 'auto' },
    }
    runner.flagsChanged()
    await until(3)
    expect(holder.current()?.presence?.state).toBe('away')
    runner.flagsChanged()
    await Bun.sleep(50)
    expect(posts.length).toBe(3)
  })

  test('a runner without flags posts none (a master as before)', async () => {
    const paths: string[] = []
    const link = {
      id: 'server-1',
      state: () => ({ state: 'online', since: 0, heardAt: 0 }),
      async fetch(path: string) {
        paths.push(path)
        return new Response('', { status: 404 })
      },
    } as unknown as Link
    const runner = createMasterRelayRunner({
      links: { link: () => link, onChange: () => () => {} },
      log: () => {},
      deviceIds: () => ['server-1'],
      selfId: () => 'laptop',
      ownerAllowed: () => true,
      sessionKnown: () => false,
      replay: async () => new Response(''),
    })
    onTestFinished(() => runner.close())
    runner.sync()
    await Bun.sleep(50)
    runner.sync()
    expect(paths.every(p => p === '/api/node/master-relay')).toBe(true)
  })
})

describe('Settings on a node: set on the master', () => {
  function config(raw: Record<string, unknown>): void {
    mkdirSync(join(configFile(), '..'), { recursive: true })
    writeFileSync(configFile(), JSON.stringify(raw))
  }

  test("the feature switches, tasks and threads are refused with the master's name; config.json stays", () => {
    isolatedHome()
    useLanguage('ru')
    onTestFinished(() => useLanguage('en'))
    config({ language: 'ru', node: NODE })
    mkdirSync(join(masterFlagsFile(), '..'), { recursive: true })
    writeFileSync(masterFlagsFile(), JSON.stringify({ master: 'laptop', on: ['watches'], at: 1 }))
    const before = readFileSync(configFile(), 'utf8')
    for (const r of [editFeatures({ watches: true }), editTodos({ mode: 'agents' }), editThreads({ mode: 'agents' })])
      expect(r).toMatchObject({ ok: false, error: 'Настраивается на мастере laptop' })
    expect(readFileSync(configFile(), 'utf8')).toBe(before)
  })

  test('a board without node writes them as before', () => {
    isolatedHome()
    config({ language: 'en' })
    expect(editFeatures({ watches: true })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).watches).toBe(true)
    expect(existsSync(masterFlagsFile())).toBe(false)
  })
})
