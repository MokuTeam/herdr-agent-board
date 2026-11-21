// POST /api/nodes for Settings, Devices (#510, docs/design/nodes 12): each op through editNodes into
// a sandbox config.json, a bad value refused with its field and nothing written, a config.json that
// does not parse left as it is, and GET's settings beside the devices. The ops of before (retry,
// sync) answer as they did.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { configFile, editNodes } from '../../src/adapters/config-file.ts'
import { readLanesSeen, writeLanesSeen } from '../../src/adapters/node-store.ts'
import { configDir } from '../../src/adapters/paths.ts'
import { type DeviceView, nodesConfig } from '../../src/core/nodes.ts'
import type { Route } from '../../src/server/http.ts'
import { type NodesPanel, nodesRoutes } from '../../src/server/routes/nodes.ts'
import type { NodeLinks } from '../../src/services/nodes/links.ts'
import { isolatedHome } from '../support/env.ts'

const NODES = {
  id: 'laptop',
  order: ['server-1', 'local'],
  devices: { 'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:12430' }, maxSessions: 3 } },
}

function seed(raw: unknown): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2))
}
const saved = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))
const savedNodes = () => saved().nodes as Record<string, unknown>

const status = (memTotalMb: number) =>
  ({ memTotalMb, cpus: 4, sessions: { awake: 0, working: 0, asleep: 0 } }) as unknown as DeviceView['status']

function links(on = true): NodeLinks {
  const retried: string[] = []
  return {
    on: () => on,
    view: () => ({
      devices: [
        {
          id: 'server-1',
          title: 'server-1',
          kind: 'direct',
          link: null,
          status: status(8000),
          sameCommit: true,
          payloadAt: null,
        },
        { id: 'local', title: 'local', kind: null, link: null, status: null, sameCommit: null, payloadAt: null },
      ],
      problems: [],
    }),
    retry: (id: string) => {
      retried.push(id)
      return id === 'server-1'
    },
  } as unknown as NodeLinks
}

function panel(): NodesPanel {
  return {
    config: () => nodesConfig(saved().nodes),
    edit: editNodes,
    seen: () => readLanesSeen(),
    keepSeen: ids => writeLanesSeen(ids),
    ownStatus: async () => status(16000) as never,
    // None stored anywhere: only the filter on kind keeps this computer out of noToken.
    hasToken: () => false,
    next: async cfg => (cfg?.whenFull === 'wait' ? null : 'server-1'),
  }
}

function routes(on = true): { get: Route; post: Route } {
  const [get, post] = nodesRoutes(links(on), undefined, panel())
  if (!get || !post) throw new Error('no routes')
  return { get, post }
}

async function call(route: Route, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctx = { body: async () => body ?? {}, rawBody: async () => body } as never
  const res = (await route.handle(new Request('http://127.0.0.1/api/nodes', { method: route.method }), ctx)) as Response
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('POST /api/nodes, the panel’s ops (#510)', () => {
  test('order, set, lanes and whenFull write config.json’s nodes; the rest of the file stays', async () => {
    isolatedHome()
    seed({ language: 'en', port: 9, nodes: NODES })
    const { post } = routes()
    expect((await call(post, { op: 'order', ids: ['local', 'server-1'] })).status).toBe(200)
    expect(savedNodes().order).toEqual(['local', 'server-1'])
    expect((await call(post, { op: 'set', id: 'server-1', paused: true, minFreeMemMb: 1500 })).status).toBe(200)
    expect((savedNodes().devices as Record<string, unknown>)['server-1']).toMatchObject({
      paused: true,
      minFreeMemMb: 1500,
      maxSessions: 3,
    })
    expect((await call(post, { op: 'set', id: 'local', drain: true, maxSessions: 8 })).status).toBe(200)
    expect((savedNodes().devices as Record<string, unknown>).local).toEqual({ drain: true, maxSessions: 8 })
    const lanes = await call(post, { op: 'lanes', lanes: ['atlas'], shown: ['atlas', 'tools'] })
    expect(lanes.status).toBe(200)
    expect(savedNodes().lanes).toEqual(['atlas'])
    expect(readLanesSeen()).toEqual(['atlas', 'tools'])
    const full = await call(post, { op: 'whenFull', whenFull: 'wait' })
    // The next device is asked by the section just written, not by the live config that follows it later.
    expect(full.body).toMatchObject({ ok: true, settings: { whenFull: 'wait', lanes: ['atlas'], next: null } })
    expect((await call(post, { op: 'whenFull', whenFull: 'local' })).body).toMatchObject({
      settings: { next: 'server-1' },
    })
    expect((await call(post, { op: 'whenFull', whenFull: 'wait' })).status).toBe(200)
    expect(savedNodes().whenFull).toBe('wait')
    expect(saved()).toMatchObject({ language: 'en', port: 9 })
  })

  test('a bad value is refused with its field, and nothing is written', async () => {
    isolatedHome()
    seed({ language: 'en', nodes: NODES })
    const before = readFileSync(configFile(), 'utf8')
    const { post } = routes()
    const refusals: [unknown, string][] = [
      [{ op: 'order', ids: ['server-1'] }, 'ids'],
      [{ op: 'order', ids: ['server-1', 'local', 'server-9'] }, 'ids'],
      [{ op: 'set', id: 'server-1', maxSessions: 0 }, 'maxSessions'],
      [{ op: 'set', id: 'server-1', maxLoad: -1 }, 'maxLoad'],
      [{ op: 'set', id: 'server-1', drain: 'yes' }, 'drain'],
      [{ op: 'set', id: 'server-9', paused: true }, 'id'],
      [{ op: 'set', id: 'local', paused: true }, 'paused'],
      [{ op: 'lanes', lanes: [''] }, 'lanes'],
      [{ op: 'lanes', lanes: 'some' }, 'lanes'],
      [{ op: 'whenFull', whenFull: 'never' }, 'whenFull'],
    ]
    for (const [body, field] of refusals)
      expect(await call(post, body)).toEqual({ status: 400, body: { error: field } })
    expect(readFileSync(configFile(), 'utf8')).toBe(before)
    expect(readLanesSeen()).toBeNull()
  })

  test('a config.json that does not parse is not written', async () => {
    isolatedHome()
    const broken = '{ "language": "en", "nodes": { "id": "laptop", }, }'
    seed(broken)
    const { post } = routes()
    for (const body of [
      { op: 'order', ids: ['local'] },
      { op: 'set', id: 'local', maxSessions: 4 },
      { op: 'lanes', lanes: 'all', shown: ['atlas'] },
      { op: 'whenFull', whenFull: 'wait' },
    ])
      expect((await call(post, body)).status).toBe(409)
    expect(readFileSync(configFile(), 'utf8')).toBe(broken)
    expect(readLanesSeen()).toBeNull()
  })

  test('GET: the devices and, beside them, the settings and the board’s figures', async () => {
    isolatedHome()
    seed({ language: 'en', nodes: { ...NODES, lanes: ['atlas'], whenFull: 'wait' } })
    writeLanesSeen(['atlas', 'tools'])
    const { body } = await call(routes().get)
    expect((body.devices as DeviceView[]).map(d => d.id)).toEqual(['server-1', 'local'])
    expect(body.settings).toEqual({
      whenFull: 'wait',
      lanes: ['atlas'],
      seen: ['atlas', 'tools'],
      defaults: {
        'server-1': { maxSessions: 4, minFreeMemMb: 1200, maxLoad: 0.9 },
        local: { maxSessions: 9, minFreeMemMb: 2400, maxLoad: 0.9 },
      },
      next: null,
      // A device with no token stored is named; this computer never is.
      noToken: ['server-1'],
    })
  })

  test('with nodes off: 404 for every op, as before; retry and sync answer as they did', async () => {
    isolatedHome()
    seed({ language: 'en', nodes: NODES })
    const off = routes(false)
    expect(await call(off.post, { op: 'whenFull', whenFull: 'wait' })).toEqual({
      status: 404,
      body: { error: 'nodes' },
    })
    expect((await call(off.get)).status).toBe(404)
    const { post } = routes()
    expect(await call(post, { op: 'retry', id: 'server-1' })).toEqual({ status: 200, body: { ok: true } })
    expect(await call(post, { op: 'retry', id: 'server-9' })).toEqual({ status: 404, body: { error: 'device' } })
    expect(await call(post, { op: 'nope', id: 'server-1' })).toEqual({ status: 400, body: { error: 'op' } })
    expect(await call(post, { op: 'whenFull' })).toEqual({ status: 400, body: { error: 'whenFull' } })
  })

  test('without the panel (as `board nodes` had it): GET is the devices alone, no op of the panel', async () => {
    isolatedHome()
    seed({ language: 'en', nodes: NODES })
    const [get, post] = nodesRoutes(links())
    if (!get || !post) throw new Error('no routes')
    expect(Object.keys((await call(get)).body)).toEqual(['devices', 'problems'])
    expect(await call(post, { op: 'whenFull', whenFull: 'wait' })).toEqual({ status: 400, body: { error: 'op' } })
  })
})
