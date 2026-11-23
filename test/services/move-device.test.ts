// The master carrying a session between two boards (#616, services/nodes/move-device.ts), against a
// stub of this board's halves and a node's door as a fetch: a step that fails or throws before the
// target's start calls the move off at the source (which wakes it again when it was awake), a start
// that fails does too, a door that does not answer a poll is waited on rather than taken for a
// start that is gone, and once the start is on its way what fails is a note and the source is
// finished all the same.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MovePack } from '../../src/core/move-device.ts'
import type { LinkStatus, NodesConfig } from '../../src/core/nodes.ts'
import type { Item } from '../../src/core/types.ts'
import type { MoveIn } from '../../src/services/move-in.ts'
import type { MoveOut } from '../../src/services/move-out.ts'
import { moveToDevice } from '../../src/services/nodes/move-device.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SHA = 'a'.repeat(64)
let dir = ''
let pace: string | undefined
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-move-device-'))
  writeFileSync(join(dir, 't.jsonl'), '{}\n')
  pace = process.env.BOARD_TEST_PACE
  process.env.BOARD_TEST_PACE = '0.01'
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  if (pace === undefined) delete process.env.BOARD_TEST_PACE
  else process.env.BOARD_TEST_PACE = pace
})

const PACK: MovePack = {
  v: 1,
  session: S,
  name: 'Atlas',
  category: 'atlas',
  profile: 'default',
  workspace: 'Atlas',
  cwd: '/w/atlas',
  folder: {
    url: 'git@github.com:anna/atlas.git',
    address: 'github.com/anna/atlas',
    branch: 'feature-x',
    subdir: '',
    head: 'c'.repeat(40),
    deleted: [],
  },
  files: [{ kind: 'transcript', path: '', size: 3, sha256: SHA, mode: 0o644 }],
  entries: [],
  trusted: false,
  from: 'laptop',
}

const NODES = {
  id: 'laptop',
  order: ['server-1', 'local'],
  whenFull: 'local',
  lanes: [],
  relay: null,
  devices: {
    'server-1': { id: 'server-1', title: 'Server 1', link: { kind: 'direct', url: 'http://x' }, profiles: {} },
    local: { id: 'local', title: 'local', link: null, profiles: {} },
  },
  problems: [],
} as unknown as NodesConfig

type Door = (path: string, init: RequestInit) => Promise<Response> | Response
const ok = (body: unknown): Response => Response.json(body)

/** The source here (a stub that says what was asked of it), the target a node answering by `door`. */
function world(door: Door) {
  const asked: string[] = []
  const out: MoveOut = {
    pack: async () => {
      asked.push('pack')
      return { ok: true, pack: PACK, key: S, wasAwake: true }
    },
    file: () => join(dir, 't.jsonl'),
    abort: async () => {
      asked.push('abort')
      return { ok: true, woken: true }
    },
    finish: async () => {
      asked.push('finish')
      return { ok: true, notes: [] }
    },
  }
  const seen: string[] = []
  const link = {
    state: () => ({ state: 'online', since: 0 }) as unknown as LinkStatus,
    fetch: async (path: string, init: RequestInit = {}) => {
      seen.push(`${init.method ?? 'GET'} ${path}`)
      if (init.body instanceof ReadableStream) await new Response(init.body).arrayBuffer()
      return door(path, init)
    },
  }
  const run = () =>
    moveToDevice(
      {
        nodes: () => NODES,
        link: () => link,
        out,
        in: {} as MoveIn,
        items: () => [{ key: S, session: S, name: 'Atlas', agent: 'claude' } as Item],
        rekeyThreads: () => asked.push('rekey'),
        log: () => {},
        startWaitMs: 2000,
      },
      [S],
      'server-1',
    )
  return { asked, seen, run }
}

/** A door that takes every step, with `over` answering some paths its own way. */
const doorWith =
  (over: (path: string) => Response | Promise<Response> | null = () => null): Door =>
  async path => {
    const own = await over(path)
    if (own) return own
    if (path === '/api/node/move/in/check') return ok({ ok: true, cwd: '/n/atlas', missing: [SHA] })
    if (path.startsWith('/api/node/move/in/blob/')) return ok({ ok: true })
    if (path === '/api/node/move/in/commit') return ok({ ok: true, cwd: '/n/atlas', launch: 'L1', notes: [] })
    if (path.startsWith('/api/node/move/in/launch/')) return ok({ state: 'done' })
    if (path === '/api/node/move/in/settle') return ok({ ok: true, entries: 0 })
    return new Response('', { status: 404 })
  }

test('the whole way: checked, the file sent, committed, its start seen, settled, the source finished', async () => {
  const w = world(doorWith())
  const [r] = await w.run()
  expect(r).toMatchObject({ result: 'moved', newKey: `@server-1:${S}` })
  expect(w.asked).toEqual(['pack', 'finish', 'rekey'])
})

test('the node gone while a file goes: called off at the source, which wakes it again', async () => {
  const w = world(
    doorWith(path => {
      if (path.startsWith('/api/node/move/in/blob/')) throw new Error('socket closed')
      return null
    }),
  )
  const [r] = await w.run()
  expect(r?.result).toBe('refused')
  expect(r?.why).toContain('socket closed')
  expect(w.asked).toEqual(['pack', 'abort'])
})

test('its start failed there: called off, nothing settled', async () => {
  const w = world(doorWith(path => (path.startsWith('/api/node/move/in/launch/') ? ok({ state: 'failed' }) : null)))
  const [r] = await w.run()
  expect(r?.result).toBe('refused')
  expect(w.asked).toEqual(['pack', 'abort'])
  expect(w.seen.some(s => s.endsWith('/settle'))).toBe(false)
})

test('a poll the door does not answer is waited on, not taken for a start that is gone', async () => {
  let polls = 0
  const w = world(
    doorWith(path => {
      if (!path.startsWith('/api/node/move/in/launch/')) return null
      polls++
      if (polls === 1) throw new Error('reset')
      if (polls === 2) return new Response('', { status: 503 })
      return ok({ state: polls < 4 ? 'starting' : 'done' })
    }),
  )
  const [r] = await w.run()
  expect(r?.result).toBe('moved')
  expect(polls).toBe(4)
  expect(r?.notes?.some(n => n.includes('no longer shown'))).toBe(false)
})

test('once its start is on its way, a settle that throws is a note and the source is finished all the same', async () => {
  const w = world(
    doorWith(path => {
      if (path === '/api/node/move/in/settle') throw new Error('reset')
      return null
    }),
  )
  const [r] = await w.run()
  expect(r?.result).toBe('moved')
  expect(r?.notes?.some(n => n.startsWith('its schedule entries stayed behind'))).toBe(true)
  expect(w.asked).toEqual(['pack', 'finish', 'rekey'])
})

test('a node without these routes is said to need an update; the source called off', async () => {
  const w = world(path => (path === '/api/node/move/in/check' ? new Response('', { status: 404 }) : ok({})))
  const [r] = await w.run()
  expect(r?.why).toBe('server-1 runs a board without device moves: update it first')
  expect(w.asked).toEqual(['pack', 'abort'])
})
