// A service agent end to end on a running board (#819): the owner registers it in the Team panel
// (POST /api/team/services), the board gives it a card with no pane in its lane, and the commands the
// MCP's `team` tool runs (`board team post | thread | wait`, here by their functions with the
// service's key as the caller, as X-Board-Session makes it) act as that card: in a lane shared with
// the peer its post reaches them as the owner's agent under its name; a service in a lane not shared
// is held; it waits for what comes in on its thread and reads it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import { teamAgents } from '../../src/entrypoints/team-agents-cli.ts'
import { teamWait, waitFlags } from '../../src/entrypoints/team-inbox-cli.ts'
import { type Harness, msgOf, question, startHarness } from '../hub/harness.ts'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'
import { softAuthenticator } from '../support/soft-authenticator.ts'

setDefaultTimeout(60_000)

const CLAUDE = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'

let hub: Harness
beforeAll(async () => {
  hub = await startHarness()
})
afterAll(() => hub.stop())

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const end = Date.now() + 10_000
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out: ${what} (${JSON.stringify(v)})`)
    await Bun.sleep(50)
  }
}

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })

interface Card {
  key: string
  name: string
  category: string
  pane: string | null
  service?: boolean
}

test('registered in the panel, it posts in its lane as the owner agent, is held outside it, and waits for and reads its answer', async () => {
  const box = await sandbox()
  const me = await generateKey()
  const anna = (await generateKey()) as KeyPair
  ;(await hub.join(me, 'me', undefined, ['threads'])).close()
  const annaClient = await hub.join(anna, 'anna', undefined, ['threads'])
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
  // config.json as the owner's board has it, followed as it changes (the panel writes the services there).
  const cfg = {
    language: 'en',
    categories: [
      { id: 'home', title: 'Home', color: 'green' },
      { id: 'work', title: 'Work', color: 'blue' },
    ],
    wakeUrl: null,
    refreshSec: 1,
    team: { hub: hub.url.replace(/\/v1$/, ''), name: 'me' },
  }
  const file = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg))
  // herdr has one Claude session in a pane: its card stays as it was beside the services'.
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            { pane_id: 'p1', agent: 'claude', agent_session: { value: CLAUDE }, agent_status: 'idle', cwd: box.dir },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const { url } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1' })
  const view = await waitFor(
    async () => (await (await fetch(`${url}/api/team`)).json()) as { state?: string; roster?: unknown[] },
    v => v.state === 'online' && (v.roster?.length ?? 0) > 0,
    'the board online at the hub with anna in the roster',
  )
  // The owner: agents on with anna for the lane home; two services, one in home, one in work.
  expect((await post(url, '/api/team/agents', { peer: anna.pub, on: true, lanes: ['home'] })).status).toBe(200)
  const added = (await (await post(url, '/api/team/services', { add: { name: 'Juno', lane: 'home' } })).json()) as {
    added?: { key: string }
  }
  expect(added.added?.key).toBe('service-juno')
  expect((await post(url, '/api/team/services', { add: { name: 'Ledger', lane: 'work' } })).status).toBe(200)
  expect((await post(url, '/api/team/services', { add: { name: 'Bot', lane: 'nowhere' } })).status).toBe(400)
  const agents = (await (await fetch(`${url}/api/team/agents`)).json()) as { services: unknown[] }
  expect(agents.services).toEqual([
    { key: 'service-juno', name: 'Juno', lane: 'home' },
    { key: 'service-ledger', name: 'Ledger', lane: 'work' },
  ])

  // Their cards: no pane, in their lanes, marked a service.
  const cards = await waitFor(
    async () => ((await (await fetch(`${url}/api/board`)).json()) as { items: Card[] }).items,
    items => items.filter(i => i.service).length === 2 && items.some(i => i.key === CLAUDE),
    'two service cards on the board',
  )
  expect(cards.find(i => i.key === 'service-juno')).toMatchObject({
    name: 'Juno',
    category: 'home',
    pane: null,
    service: true,
  })
  expect(cards.find(i => i.key === CLAUDE)).toMatchObject({ pane: 'p1' })
  expect(cards.find(i => i.key === CLAUDE)?.service).toBeUndefined()

  const ctx = (key: string) => ({
    webPort: Number(new URL(url).port),
    roster: view.roster ?? [],
    self: async () => ({ key }),
    find: () => Promise.reject(new Error('not asked')),
  })

  // In its lane: it goes out, to anna, as the owner's agent Juno.
  const said = await teamAgents(
    'post',
    ['--new', 'Groceries', '--', 'anna', 'Milk is out, shall I order?'],
    ctx('service-juno'),
  )
  expect(said).toStartWith('ok · sent to anna in thread ')
  const env = (await annaClient.take('deliver', 5000)).env
  const got = msgOf(env)
  expect(got.body).toMatchObject({ via: 'agent', agent: 'Juno', text: 'Milk is out, shall I order?' })
  const thread = got.body.thread as { id: string; title?: string }
  expect(thread.title).toBe('Groceries')

  // Outside its lane: held for the owner, nothing reaches anna.
  const held = await teamAgents('post', ['--', 'anna', 'The invoice is paid'], ctx('service-ledger'))
  expect(held).toStartWith('held · ')
  expect((await annaClient.settle(300)).filter(f => f.t === 'deliver')).toEqual([])

  // Nothing new yet on the thread it handles: the wait says so when its time is up.
  const w = waitFlags(['--timeout', '1'])
  if (!w) throw new Error('flags')
  expect(await teamWait(ctx('service-juno'), { ...w, self: ctx('service-juno').self, everyMs: 50 })).toBe(
    'nothing new in 1 s: wait again',
  )

  // anna answers in the thread: the wait returns it at once, and the service reads it.
  annaClient.send({
    t: 'send',
    env: await question(anna, me.pub, 'yes, order two', { body: { text: 'yes, order two', thread } }),
  })
  const waited = await teamWait(ctx('service-juno'), {
    json: false,
    timeoutMs: 10_000,
    self: ctx('service-juno').self,
    everyMs: 50,
  })
  const ref = thread.id.slice(0, 8)
  expect(waited).toContain(`${ref} · with anna · "Groceries" · 1 unread`)
  expect(waited).not.toContain('order two')
  // Another session waiting sees nothing of a thread it does not handle.
  expect(
    await teamWait(ctx('service-ledger'), {
      json: false,
      timeoutMs: 1000,
      self: ctx('service-ledger').self,
      everyMs: 50,
    }),
  ).toBe('nothing new in 1 s: wait again')
  const read = await teamAgents('thread', ['--read', '--', ref], ctx('service-juno'))
  expect(read).toContain('handled here by Juno')
  expect(read).toContain('  | yes, order two')
  expect(read).toContain("this board's agent (Juno) wrote")
  expect(read.endsWith('(marked read)')).toBe(true)
  // Read: the next wait waits for what is new.
  expect(
    JSON.parse(
      await teamWait(ctx('service-juno'), {
        json: true,
        timeoutMs: 1000,
        self: ctx('service-juno').self,
        everyMs: 50,
      }),
    ),
  ).toEqual({ threads: [], waited: 1 })
  // The role command uses the same guarded Team setting as the panel and updates the live card.
  expect(await teamAgents('mark-master', [], ctx(CLAUDE))).toBe('ok · marked as master')
  const marked = await waitFor(
    async () => ((await (await fetch(`${url}/api/board`)).json()) as { items: (Card & { teamMaster?: true })[] }).items,
    items => items.some(i => i.key === CLAUDE && i.teamMaster === true),
    'the marked master card',
  )
  expect(marked.find(i => i.key === 'service-juno')).not.toHaveProperty('teamMaster')
  expect(await teamAgents('mark-master', ['off'], ctx(CLAUDE))).toBe('ok · master flag removed')
  expect((await post(url, '/api/team/agents', { master: { key: 'absent', on: true } })).status).toBe(400)

  annaClient.close()
})

/** config.json with the team on, followed as it changes, and the board's key where it keeps it. */
async function teamBoard(box: Sandbox, me: KeyPair, name = 'owner2'): Promise<string> {
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
  const cfg = {
    language: 'en',
    categories: [{ id: 'home', title: 'Home', color: 'green' }],
    wakeUrl: null,
    refreshSec: 1,
    team: { hub: hub.url.replace(/\/v1$/, ''), name },
  }
  const file = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg))
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  const { url } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1' })
  await waitFor(
    async () => ((await (await fetch(`${url}/api/team`)).json()) as { state?: string }).state,
    v => v === 'online',
    'the board online at the hub',
  )
  return url
}

test('with "Confirm with a passkey" on, adding a service agent waits for the owner; removing it does not; both are in the team log', async () => {
  const box = await sandbox()
  const me = await generateKey()
  ;(await hub.join(me, 'owner2', undefined, ['threads'])).close()
  const url = await teamBoard(box, me)
  const key = await softAuthenticator(-7)
  const local = `http://localhost:${new URL(url).port}`
  type Reply = Record<string, unknown>
  const answer = async (res: Promise<Response>): Promise<[number, Reply]> => {
    const r = await res
    return [r.status, (await r.json()) as Reply]
  }
  /** The confirmation window on localhost: signs with the owner's passkey (or makes it). */
  const confirm = async (id: string): Promise<[number, Reply]> => {
    const v = (await (await fetch(`${url}/api/team/confirm/${id}`)).json()) as {
      step: string
      options: { challenge: string }
      action: Reply
    }
    const at = { challenge: v.options.challenge, origin: local, rpId: 'localhost' }
    const cred = v.step === 'create' ? key.register(at) : key.assert(at)
    return answer(
      fetch(`${url}/api/team/confirm/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1', origin: local },
        body: JSON.stringify({ ...cred, type: 'public-key' }),
      }),
    )
  }
  const services = async (): Promise<unknown[]> =>
    ((await (await fetch(`${url}/api/team/agents`)).json()) as { services: unknown[] }).services
  // The owner adds a passkey and turns the switch on.
  const [, add] = await answer(post(url, '/api/team/passkeys', { op: 'add' }))
  expect(await confirm(add.id as string)).toEqual([200, { ok: true, done: true }])
  const [, on] = await answer(post(url, '/api/team/passkeys', { op: 'on' }))
  expect(await confirm(on.id as string)).toEqual([200, { ok: true, done: true }])

  expect(await answer(post(url, '/api/team/agents', { mastersOnly: true }))).toEqual([200, { ok: true }])
  const [widened, widening] = await answer(post(url, '/api/team/agents', { mastersOnly: false }))
  expect(widened).toBe(428)
  const policy = async () => (await (await fetch(`${url}/api/team/agents`)).json()) as Reply
  expect((await policy()).mastersOnly).toBe(true)
  expect(await confirm(widening.id as string)).toEqual([200, { ok: true, done: true }])
  expect(await policy()).not.toHaveProperty('mastersOnly')

  // A wrong lane is said at once; a good one waits for the passkey, and nothing is added meanwhile.
  expect(await answer(post(url, '/api/team/services', { add: { name: 'Juno', lane: 'nowhere' } }))).toEqual([
    400,
    { ok: false, error: 'lane' },
  ])
  const [status, asked] = await answer(post(url, '/api/team/services', { add: { name: 'Juno', lane: 'home' } }))
  expect(status).toBe(428)
  expect(asked).toMatchObject({ ok: false, error: 'confirm' })
  expect(await services()).toEqual([])
  const shown = (await (await fetch(`${url}/api/team/confirm/${asked.id}`)).json()) as { action: Reply }
  expect(shown.action).toEqual({ kind: 'service-add', name: 'Juno', lane: 'Home' })
  const [done, reply] = await confirm(asked.id as string)
  expect(done).toBe(200)
  expect(reply).toMatchObject({ ok: true, added: { key: 'service-juno', name: 'Juno', lane: 'home' } })
  expect(await services()).toEqual([{ key: 'service-juno', name: 'Juno', lane: 'home' }])

  // Removing narrows: at once.
  expect(await answer(post(url, '/api/team/services', { remove: 'service-juno' }))).toEqual([
    200,
    { ok: true, services: [] },
  ])
  const log = readFileSync(
    join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'team-audit.jsonl'),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Reply)
    .filter(e => e.action === 'service')
  expect(log).toEqual([
    expect.objectContaining({ by: 'ui', op: 'add', key: 'service-juno', lane: 'home' }),
    expect.objectContaining({ by: 'ui', op: 'remove', key: 'service-juno', lane: 'home' }),
  ])
})

test('a published alias reaches the exposed service over the hub and is withdrawn without changing its canonical address', async () => {
  const owner = await generateKey()
  const peer = await generateKey()
  const other = await generateKey()
  ;(await hub.join(owner, 'Ops Board', undefined, ['threads'])).close()
  ;(await hub.join(peer, 'Peer Board', undefined, ['threads'])).close()
  const outsider = await hub.join(other, 'Outside Board', undefined, ['threads'])
  try {
    const ownerUrl = await teamBoard(await sandbox(), owner, 'Ops Board')
    const peerUrl = await teamBoard(await sandbox(), peer, 'Peer Board')
    const change = (body: unknown) => post(ownerUrl, '/api/team/agents', body)
    expect((await change({ peer: peer.pub, on: true, lanes: ['home'] })).status).toBe(200)
    expect((await post(ownerUrl, '/api/team/services', { add: { name: 'Report Service', lane: 'home' } })).status).toBe(
      200,
    )
    const directory = async () => {
      const res = await fetch(`${peerUrl}/api/team/directory`)
      const { peers } = (await res.json()) as { peers: { peer: string; agents: { code: string; alias?: string }[] }[] }
      return peers.find(p => p.peer === owner.pub)?.agents ?? []
    }
    const code = 'report-service'
    await waitFor(directory, entries => entries.some(a => a.code === code), 'canonical handle')
    const alias = (name: string | null) => change({ publishAlias: { key: 'service-report-service', name } })
    expect((await alias('invalid.alias')).status).toBe(400)
    expect((await change({ publishAlias: { key: 'service-missing', name: 'Reports' } })).status).toBe(400)
    expect((await alias('Reports')).status).toBe(200)
    await waitFor(directory, entries => entries.some(a => a.alias === 'Reports'), 'published alias')
    const send = await post(peerUrl, '/api/team/send', { to: 'team', text: '@rEpOrTs prepare the report' })
    expect(send.status).toBe(200)
    const { thread: key } = (await send.json()) as { thread: string }
    const thread = key.slice(key.indexOf('/') + 1)
    const incoming = async () => {
      const res = await fetch(`${ownerUrl}/api/team/threads/${peer.pub}/${thread}`)
      return (await res.json()) as { thread?: { handler?: { key: string } }; lines?: { text: string }[] }
    }
    const got = await waitFor(incoming, v => !!v.thread?.handler, 'service handles direct topic')
    expect(got.thread?.handler?.key).toBe('service-report-service')
    expect(got.lines?.some(l => l.text === '@OpsBoard.report-service prepare the report')).toBe(true)
    const reply = await post(ownerUrl, '/api/team/post', {
      to: peer.pub,
      thread: { id: thread },
      session: { key: 'service-report-service' },
      text: 'Report ready',
    })
    expect(reply.status).toBe(200)
    const echoed = async () => {
      const res = await fetch(`${peerUrl}/api/team/threads/${key}`)
      return (await res.json()) as { lines?: { from: string; text: string; via?: string; agent?: string }[] }
    }
    const answered = await waitFor(echoed, v => !!v.lines?.some(l => l.text === 'Report ready'), 'service reply')
    expect(answered.lines?.find(l => l.text === 'Report ready')).toMatchObject({
      from: owner.pub,
      via: 'agent',
      agent: 'Report Service',
    })
    expect((await outsider.settle(100)).filter(f => f.t === 'deliver')).toEqual([])
    expect((await alias('OutsideBoard')).status).toBe(200)
    await waitFor(directory, entries => entries.some(a => a.code === code && !a.alias), 'roster collision')
    expect((await alias('Reports')).status).toBe(200)
    await waitFor(directory, entries => entries.some(a => a.alias === 'Reports'), 'alias republished')
    expect((await alias(null)).status).toBe(200)
    await waitFor(directory, entries => entries.some(a => a.code === code && !a.alias), 'alias removed')
    expect(
      (await post(peerUrl, '/api/team/send', { to: 'team', text: '@OpsBoard.report-service follow up' })).status,
    ).toBe(200)
  } finally {
    outsider.close()
  }
})
