// The placer and a start a node's session asked for (#760): its folder is that node's, and the rule of
// core/portable.ts runs over what the node read of it. A clean, pushed checkout goes anywhere: to
// another node as a repository, to this computer through a checkout of its own here, back to the node
// as its own folder. Anything else stays on the node in its folder.
import { describe, expect, test } from 'bun:test'
import type { NodeFolderFacts } from '../../src/core/launch/spawn-node.ts'
import type { NodeStatus } from '../../src/core/nodes.ts'
import type { Config } from '../../src/core/types.ts'
import type { LaunchRequest } from '../../src/services/launch/request.ts'
import { type Launch, newLaunch } from '../../src/services/launch/run.ts'
import { createPlacer } from '../../src/services/nodes/placer.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'

const NOW = 1_800_000_000_000
const URL = 'https://example.test/acme/atlas.git'
const NODE_CWD = '/home/anna/work/atlas/parser'

function status(id: string): NodeStatus {
  return {
    api: 1,
    id,
    version: 'v',
    commit: 'c1',
    platform: 'linux',
    arch: 'x64',
    cpus: 4,
    memTotalMb: 16_000,
    memAvailableMb: 12_000,
    load: null,
    sessions: { awake: 0, working: 0, asleep: 0 },
    launches: 0,
    workRootFreeMb: null,
    profiles: [{ id: 'default', loggedIn: true, bundle: null }],
    agents: ['claude'],
    at: NOW,
  }
}

const direct = (port: number) => ({ link: { kind: 'direct', url: `http://127.0.0.1:${port}` } })
const room = { maxSessions: 4, minFreeMemMb: 0, maxLoad: 9 }

function setup(
  order: string[],
  checkout?: (s: unknown) => Promise<{ ok: true; cwd: string } | { ok: false; why: string }>,
) {
  isolatedHome()
  const ran: Launch[] = []
  const sent: { device: string; body: Record<string, unknown> }[] = []
  const checkouts: unknown[] = []
  const link = (id: string) => ({
    view: () => ({ status: status(id) }),
    state: () => ({ state: 'online' }),
    status: async () => status(id),
    fetch: async (_path: string, init: { body: string }) => {
      sent.push({ device: id, body: JSON.parse(init.body) })
      return Response.json({ launch: { id: 'x', state: 'starting' } }, { status: 202 })
    },
  })
  const p = createPlacer({
    cfg: {
      nodes: {
        id: 'server-2',
        order,
        lanes: 'all',
        devices: { 'server-1': { ...direct(1), ...room }, laptop: { ...direct(2), ...room }, local: room },
      },
    } as unknown as Config,
    links: { link: id => link(id) as never, onChange: () => () => {} },
    remote: () => null,
    launches: { runLocal: (l: Launch) => ran.push(l), adopt: () => {}, changed: () => {} } as never,
    items: () => [],
    ownStatus: async () => status('server-2'),
    log: () => {},
    clock: { now: () => NOW, setTimeout, clearTimeout, setInterval, clearInterval } as never,
    hostName: 'server-2',
    commit: async () => 'c1',
    ...(checkout && {
      checkout: async (s: unknown) => {
        checkouts.push(s)
        return checkout(s)
      },
    }),
  })
  return { p, ran, sent, checkouts }
}

function launch(facts: NodeFolderFacts, pin?: string): Launch {
  const request = {
    name: 'Atlas worker',
    label: 'Atlas worker',
    cwd: NODE_CWD,
    category: 'atlas',
    workspaceId: '',
    workspaceLabel: 'Atlas',
    newWorkspace: true,
    message: 'Fix the parser.',
    worktree: null,
    parent: null,
    profile: 'default',
    profileDir: '/x',
    configDir: null,
    profileArgs: [],
    profileCommand: null,
    agent: 'claude',
    model: null,
    remote: 'laptop',
    ...(pin && { pin: { device: pin } }),
  } as unknown as LaunchRequest
  const l = newLaunch(request, [])
  l.originFacts = facts
  return l
}

const pushed: NodeFolderFacts = {
  checkout: { url: URL, clean: true, headPushed: true, branch: 'main', subdir: 'parser' },
  identity: { name: 'Anna', email: 'anna@example.test' },
  localPath: null,
}
const repo = {
  kind: 'repo',
  url: URL,
  ref: 'main',
  subdir: 'parser',
  worktree: null,
  identity: { name: 'Anna', email: 'anna@example.test' },
}

describe('a node’s start on its master’s placer (#760)', () => {
  test('a pushed checkout goes to the first device with room, another node getting the repository', async () => {
    const { p, sent, ran } = setup(['server-1', 'laptop', 'local'])
    p.take(launch(pushed), false)
    await until(() => sent.length === 1)
    expect(sent[0]?.device).toBe('server-1')
    expect(sent[0]?.body.source).toEqual(repo)
    expect(ran).toEqual([])
    p.close()
  })

  test('back on the node itself it is the node’s own folder, not a clone', async () => {
    const { p, sent } = setup(['laptop', 'server-1', 'local'])
    p.take(launch(pushed), false)
    await until(() => sent.length === 1)
    expect(sent[0]?.device).toBe('laptop')
    expect(sent[0]?.body.source).toEqual({ kind: 'path', cwd: NODE_CWD, worktree: null })
    p.close()
  })

  test('on this computer it runs in a checkout of its own here; one that cannot be had sends it on', async () => {
    const here = setup(['local', 'server-1'], async () => ({
      ok: true,
      cwd: '/srv/work/example.test/acme/atlas/parser',
    }))
    here.p.take(launch(pushed), false)
    await until(() => here.ran.length === 1)
    expect(here.checkouts).toEqual([repo])
    expect(here.ran[0]?.cwd).toBe('/srv/work/example.test/acme/atlas/parser')
    expect(here.ran[0]?.remote).toBeUndefined()
    here.p.close()

    const turned = setup(['local', 'server-1'], async () => ({ ok: false, why: 'changes' }))
    turned.p.take(launch(pushed), false)
    await until(() => turned.sent.length === 1)
    expect(turned.sent[0]?.device).toBe('server-1')
    expect(turned.ran).toEqual([])
    turned.p.close()

    const none = setup(['local', 'server-1'])
    none.p.take(launch(pushed), false)
    await until(() => none.sent.length === 1)
    expect(none.sent[0]?.device).toBe('server-1')
    none.p.close()
  })

  test('changes, commits not pushed, no remote or a brief naming a file of the node: it stays on the node', async () => {
    for (const facts of [
      { ...pushed, checkout: { ...(pushed.checkout as object), clean: false } },
      { ...pushed, checkout: { ...(pushed.checkout as object), headPushed: false } },
      { ...pushed, checkout: { ...(pushed.checkout as object), url: null } },
      { ...pushed, checkout: null },
      { ...pushed, localPath: '/home/anna/notes.md' },
    ] as NodeFolderFacts[]) {
      const { p, sent, ran } = setup(['server-1', 'local', 'laptop'], async () => ({ ok: true, cwd: '/x' }))
      p.take(launch(facts), false)
      await until(() => sent.length === 1)
      expect(sent[0]?.device).toBe('laptop')
      expect(sent[0]?.body.source).toEqual({ kind: 'path', cwd: NODE_CWD, worktree: null })
      expect(ran).toEqual([])
      p.close()
    }
  })

  test('pinned here and no checkout to be had: it fails here before anything ran, saying why', async () => {
    const { p, sent, ran, checkouts } = setup(['local', 'server-1'], async () => ({
      ok: false,
      why: 'authentication failed',
    }))
    const l = launch(pushed, 'local')
    p.take(l, false)
    await until(() => l.state === 'failed')
    expect(l.place?.checkout).toBe('authentication failed')
    expect(l.error).toBe(`this computer could not check out ${URL}: authentication failed`)
    expect(checkouts.length).toBe(1)
    expect([sent, ran]).toEqual([[], []])
    p.close()
  })

  test('pinned elsewhere while it must stay on the node: refused, nothing sent', async () => {
    const { p, sent, ran } = setup(['server-1', 'local', 'laptop'])
    const l = launch({ ...pushed, checkout: null }, 'server-1')
    p.take(l, false)
    await until(() => l.state === 'failed')
    expect(l.place?.refuse).toEqual({
      kind: 'pinned-away',
      pin: { device: 'server-1' },
      origin: 'laptop',
      home: { kind: 'no-remote' },
    })
    expect([sent, ran]).toEqual([[], []])
    p.close()
  })
})
