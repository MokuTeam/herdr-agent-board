import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { boardConfig, tool } from '../support/mcp-client.ts'
import { sandbox } from '../support/sandbox.ts'
import { softAuthenticator } from '../support/soft-authenticator.ts'

const path = '/api/owner-services'
const header = 'x-board-owner-service'
const name = 'Atlas 100% · Сервис'
const config = {
  categories: [{ id: 'ops', title: 'Operations', color: 'blue', paths: [] }],
  spawnLimits: { perHour: 1 },
  calendar: { on: true },
  threads: true,
}
const post = (url: string, route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
    body: JSON.stringify(body),
  })

interface Reply {
  id: string
  token: string
  service: { key: string; name: string }
}

test('a passkey issues an isolated MCP identity with attribution, spawn limits and immediate revocation', async () => {
  const box = await sandbox()
  const project = join(box.dir, 'Project 100% 日本語')
  mkdirSync(project)
  const pane = { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' }
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'wB:p4',
              agent: 'claude',
              agent_status: 'idle',
              agent_session: { value: 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6' },
              cwd: project,
              terminal_title_stripped: 'Existing agent',
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
    'workspace list': { result: { workspaces: [{ workspace_id: 'wA', focused: true }] } },
    'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: pane.pane_id, terminal_id: 'term-9' } } },
    'tab rename': { result: null },
    'pane run': { result: null },
    'pane get': { seq: [{ result: { pane: { pane_id: pane.pane_id, agent: null } } }, { result: { pane } }] },
    'agent list': { result: { agents: [{ pane_id: pane.pane_id }] } },
    'agent rename': { result: null },
    'agent prompt': { result: null },
    'pane read': { text: 'Session renamed to: Inventory' },
    'pane send-keys': { result: null },
  })
  const { url } = await serveBoard(box, { ...config, language: 'en' }, { BOARD_TEST_PACE: '0.02' })
  boardConfig(box, url, config)
  const storage = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board')
  const origin = `http://localhost:${new URL(url).port}`
  const key = await softAuthenticator(-7)
  const list = () => fetch(url + path).then(res => res.json())
  const rpc = (headers: Record<string, string>) => post(url, '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, headers)

  const answer = async (id: string, expected: object) => {
    const route = `/api/team/confirm/${id}`
    const res = await fetch(url + route)
    expect(res.status).toBe(200)
    const v = (await res.json()) as { action: unknown; step: string; options: { challenge: string } }
    expect(v.action).toMatchObject(expected)
    const at = { challenge: v.options.challenge, origin, rpId: 'localhost' }
    const credential = v.step === 'create' ? key.register(at) : key.assert(at)
    return post(url, route, { ...credential, type: 'public-key' }, { origin })
  }

  expect(await list()).toEqual({ services: [], hasPasskey: false })
  expect((await post(url, path, { op: 'add', name })).status).toBe(403)
  const register = await post(url, path, { op: 'passkey' })
  expect(register.status).toBe(428)
  expect((await answer(((await register.json()) as Reply).id, { kind: 'passkey-add' })).status).toBe(200)

  // The Team confirmation switch is off and Team itself is disabled. Adding a service still asks.
  const ask = await post(url, path, { op: 'add', name }, { 'x-board-unlock': 'ignored' })
  expect(ask.status).toBe(428)
  expect(await list()).toEqual({ services: [], hasPasskey: true })
  const id = ((await ask.json()) as Reply).id
  const finish = await answer(id, { kind: 'owner-service-add', name })
  expect(finish.status).toBe(200)
  const { service, token } = (await finish.json()) as Reply
  expect(token).toMatch(/^bos_[A-Za-z0-9_-]{43}$/)
  expect(await list()).toEqual({ services: [service], hasPasskey: true })
  expect(readFileSync(join(storage, 'owner-services.json'), 'utf8')).not.toContain(token)
  expect((await post(url, `/api/team/confirm/${id}`, {}, { origin })).status).toBe(404)

  const headers = { [header]: token }
  expect((await rpc(headers)).status).toBe(200)
  expect((await rpc({ [header]: 'invalid' })).status).toBe(401)
  expect((await rpc({ 'x-board-session': service.key })).status).toBe(401)
  expect((await rpc({ ...headers, 'x-board-session': 'pane-wA:p9' })).status).toBe(400)
  expect((await rpc({ ...headers, 'x-board-pane': 'wA:p9' })).status).toBe(400)
  expect((await rpc({ ...headers, origin: 'https://example.com' })).status).toBe(403)
  expect((await fetch(url + path, { headers })).status).toBe(403)
  expect((await post(url, path, { op: 'revoke', key: service.key }, headers)).status).toBe(403)
  for (const route of [
    '/api/settings',
    '/api/team/passkeys',
    '/api/backup',
    '/api/nodes',
    '/api/launch',
    '/api/ns-sessions',
  ])
    expect((await post(url, route, {}, headers)).status).toBe(403)
  for (const name of ['settings', 'secrets', 'backup', 'nodes', 'spend'])
    expect((await tool(url, name, {}, headers)).error).toBe(true)

  expect((await tool(url, 'card', { op: 'cat', lane: 'missing', text: 'New lane' }, headers)).error).toBe(true)
  expect((await tool(url, 'card', { op: 'wait', text: 'probe', probe: 'ignored' }, headers)).error).toBe(true)
  expect((await tool(url, 'card', { op: 'cat', lane: 'missing' }, headers)).error).toBe(true)
  expect((await tool(url, 'card', { op: 'cat', lane: 'ops' }, headers)).error).toBe(false)
  expect((await tool(url, 'card', { op: 'doing', text: 'Inventory 100%' }, headers)).error).toBe(false)
  const noPane = 'Owner services have no pane for scheduled prompts. Use list or unschedule.'
  expect(await tool(url, 'schedule', { op: 'remind', when: 'in 2h', text: 'Inventory' }, headers)).toEqual({
    error: true,
    text: noPane,
  })
  expect(await tool(url, 'schedule', { op: 'every', cron: '0 9 * * *', text: 'Inventory' }, headers)).toEqual({
    error: true,
    text: noPane,
  })
  expect((await tool(url, 'schedule', { op: 'list' }, headers)).text).toBe('nothing scheduled for this session')

  const schedule = join(storage, 'schedule')
  mkdirSync(schedule, { recursive: true })
  const idOfEntry = 'abcdef'
  writeFileSync(
    join(schedule, `${idOfEntry}.json`),
    JSON.stringify({ id: idOfEntry, key: service.key, next: Date.now() + 7200000, text: 'Existing reminder' }),
  )
  expect((await tool(url, 'schedule', { op: 'list' }, headers)).text).toContain('Existing reminder')
  expect(await tool(url, 'schedule', { op: 'unschedule', id: idOfEntry }, headers)).toEqual({
    error: false,
    text: expect.stringContaining('ok · removed abcdef'),
  })
  expect((await tool(url, 'schedule', { op: 'list' }, headers)).text).toBe('nothing scheduled for this session')
  expect((await tool(url, 'agents', { op: 'list' }, headers)).text).toContain('Existing agent')

  const calendar = await tool(url, 'cal', {}, headers)
  expect(calendar, calendar.text).toMatchObject({ error: false })
  const made = await tool(url, 'thread', { op: 'new', title: 'Owner service task' }, headers)
  expect(made, made.text).toMatchObject({ error: false })
  expect((await tool(url, 'threads', { op: 'list' }, headers)).text).toContain('Owner service task')
  expect(
    (
      await tool(
        url,
        'thread',
        {
          op: 'post',
          key: 'missing-1',
          files: [join(storage, 'owner-services.json')],
        },
        headers,
      )
    ).text,
  ).toContain('board uploads')
  expect((await tool(url, 'spawn', { name: 'Inventory', cwd: project, trust: true }, headers)).error).toBe(true)
  const spawned = await tool(url, 'spawn', { name: 'Inventory', cwd: project }, headers)
  expect(spawned, spawned.text).toMatchObject({ error: false })
  expect(spawned.text).toContain('pane=wA:p9')
  expect((await tool(url, 'spawn', { name: 'Another', cwd: project }, headers)).error).toBe(true)
  expect(box.calls().filter(c => c[0] === 'tab' && c[1] === 'create')).toHaveLength(1)
  const ledger = JSON.parse(readFileSync(join(storage, 'spawns.json'), 'utf8'))
  expect(ledger.entries).toEqual([expect.objectContaining({ by: { session: service.key } })])
  const cards = (await (await fetch(`${url}/api/board`)).json()) as { items: unknown[] }
  expect(cards.items).toContainEqual(expect.objectContaining({ key: service.key, by: `service ${name}` }))
  expect(cards.items.find(item => (item as { name?: string }).name === 'Existing agent')).not.toHaveProperty('by')
  const childKey = ledger.entries[0].child.session ?? `pane-${pane.pane_id}`
  const cardFile = join(box.cards, `${childKey.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  expect(JSON.parse(readFileSync(cardFile, 'utf8'))).toMatchObject({ serviceStartBy: `service ${name}` })

  expect((await post(url, path, { op: 'revoke', key: service.key })).status).toBe(200)
  expect((await rpc(headers)).status).toBe(401)
  expect((await rpc({ 'x-board-session': service.key })).status).toBe(401)
  expect(await list()).toEqual({ services: [], hasPasskey: true })
  const hasCard = async () => {
    const board = (await (await fetch(`${url}/api/board`)).json()) as { items: { key: string }[] }
    return board.items.some(item => item.key === service.key)
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (await hasCard())) await Bun.sleep(20)
  expect(await hasCard()).toBe(false)
  const log = readFileSync(join(storage, 'team-audit.jsonl'), 'utf8')
  expect(log).toContain('"op":"add"')
  expect(log).toContain('"op":"spawn"')
  expect(log).toContain('"op":"revoke"')
  expect(log).not.toContain(token)
}, 60_000)
