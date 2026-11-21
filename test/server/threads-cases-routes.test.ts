// Case files (#488) on the page's route: GET /api/threads/<key> carries the thread's sessions and
// where the board sees them only while case files are on; off, the view is what it was.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { SessionLive } from '../../src/core/work-cases.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { dispatch } from '../../src/server/http.ts'
import { revStream, type ThreadsApp, threadsRoutes } from '../../src/server/routes/threads.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-20T14:00:00Z')
const anna: Party = { kind: 'session', key: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'anna' }
const ben: Party = { kind: 'session', key: 'pane-wA:p3', name: 'ben cooper' }
const STATE = { port: 12422, token: '', stale: () => false }

function setUp(threads: unknown) {
  isolatedHome()
  const asked: string[][] = []
  const app: ThreadsApp = {
    cfg: { threads },
    changed: () => {},
    tell: async () => ({ ok: true }),
    clearAsk: () => {},
    now: () => NOW,
    caseLive: keys => {
      asked.push([...keys])
      return new Map<string, SessionLive>([[keys[0] as string, { state: 'asleep', name: 'anna', cwd: '/work/atlas' }]])
    },
  }
  const routes = threadsRoutes(app, revStream())
  const get = async (path: string) => {
    const url = new URL(`http://127.0.0.1:12422${path}`)
    const res = await dispatch(routes, new Request(url), url, decodeURIComponent(url.pathname), STATE)
    return (await res.json()) as Record<string, unknown> & { head: Record<string, unknown> }
  }
  const cli = async (actor: Party, args: string[]) =>
    threadCmd(args, {
      cfg: { threads, port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async w => ({ anna, 'ben cooper': ben })[w] ?? null,
      out: () => {},
      err: () => {},
      now: NOW,
    })
  return { get, cli, asked }
}

test('case files on: the view carries the sessions with where they are, and the head its reference and state', async () => {
  const { get, cli, asked } = setUp({ cases: true })
  await cli({ kind: 'owner' }, ['new', '--ref', 'ABC-12', '--to', 'anna', 'Import mapping'])
  await cli(anna, ['post', 'atlas-1', '--state', 'Mapped.'])
  await cli(ben, ['post', 'atlas-1', 'a note'])
  const v = await get('/api/threads/atlas-1')
  assert.equal(v.head.ref, 'ABC-12')
  assert.deepEqual(v.head.state, { text: 'Mapped.', at: NOW, by: anna })
  assert.deepEqual(
    (v.case as { sessions: { key: string; state: string; holds: boolean }[] }).sessions.map(s => [
      s.key,
      s.state,
      s.holds,
    ]),
    [
      [anna.kind === 'session' ? anna.key : '', 'asleep', true],
      ['pane-wA:p3', 'unknown', false],
    ],
  )
  assert.equal(asked.length, 1)
})

test('case files off: no case in the view, nobody asked where sessions are', async () => {
  const { get, cli, asked } = setUp(true)
  await cli({ kind: 'owner' }, ['new', '--to', 'anna', 'Import mapping'])
  await cli(anna, ['post', 'atlas-1', 'a note'])
  const v = await get('/api/threads/atlas-1')
  assert.equal('case' in v, false)
  assert.deepEqual(Object.keys(v).sort(), ['ask', 'children', 'earlier', 'entries', 'head', 'ok', 'rev'])
  assert.equal('ref' in v.head || 'state' in v.head, false)
  assert.deepEqual(asked, [])
})

test('case files on, a thread that is no case: no case in the view and nobody asked, as show has it', async () => {
  const { get, cli, asked } = setUp({ cases: true })
  await cli({ kind: 'owner' }, ['new', '--to', 'anna', 'Import mapping'])
  await cli(anna, ['post', 'atlas-1', 'a note'])
  const v = await get('/api/threads/atlas-1')
  assert.equal('case' in v, false)
  assert.deepEqual(asked, [])
})
