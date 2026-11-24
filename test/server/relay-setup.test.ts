// "Relay on the server" on a real board (#511, server/routes/nodes.ts, server/app.ts):
// - Without `nodes` and `node`: shared route table has no relay/nodes entries, /api/board payload
//   stays untouched, local GET/POST /api/nodes/relay/setup enforces X-Board + Origin and creates no
//   files or ssh calls until asked, and a node's door refuses /api/nodes/relay/setup.
// - End to end through fake-ssh + fake-root: Look, Apply, nodes.relay written, Undo cleanly removes.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RelaySetupView } from '../../src/core/relay-setup.ts'
import { RELAY_FENCE, RELAY_MASTER_KEYS, RELAY_MASTER_USER } from '../../src/core/relay-texts.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeRoot, sh } from '../support/fake-root.ts'
import { fakeSshBin } from '../support/fake-ssh-bin.ts'
import { nodeBoard, PAIR_ENV } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'
import { routeTable, stateFolder } from '../support/tunnel-board.ts'

const configOf = (box: { env: Record<string, string> }): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

const post = (url: string, body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
  fetch(`${url}/api/nodes/relay/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const getView = async (url: string): Promise<RelaySetupView> =>
  (await (await fetch(`${url}/api/nodes/relay/setup`)).json()) as RelaySetupView

describe('without nodes or node', () => {
  test('route table and payload stay unchanged; local setup route enforces guards and is lazy', async () => {
    const box = await sandbox()
    const bin = await fakeSshBin()
    const log = join(box.dir, 'ssh-calls.jsonl')
    const { url, proc } = await serveBoard(
      box,
      { language: 'en' },
      {
        TEST_ROUTE_TABLE: '1',
        BOARD_SSH_BIN_PATH: bin,
        BOARD_SSH_KEYGEN_BIN_PATH: bin,
        FAKE_SSH_LOG: log,
      },
    )
    expect(routeTable(proc).filter(r => r.path.includes('relay') || r.path.includes('nodes'))).toEqual([])
    const boardBefore = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    expect(Object.keys(boardBefore)).not.toContain('devices')

    const v = await getView(url)
    expect(v.phase).toBe('idle')
    expect(existsSync(log)).toBe(false)
    expect(existsSync(join(stateFolder(box), 'nodes'))).toBe(false)
    expect(await (await fetch(`${url}/api/board`)).json()).toEqual(boardBefore)

    // Write guards
    expect((await post(url, { op: 'cancel' }, {})).status).toBe(403)
    expect((await post(url, { op: 'cancel' }, { 'x-board': '1', origin: 'https://evil.example' })).status).toBe(403)
    expect(await (await post(url, { op: 'bad' })).json()).toEqual({ ok: false, error: 'op' })
    expect((await post(url, { op: 'look', host: '', user: 'admin' })).status).toBe(409)
    expect(existsSync(log)).toBe(false)
  }, 60_000)

  test('section 17 comparison: local sessions with spaces, Cyrillic, % and pane keys stay identical', async () => {
    const box = await sandbox()
    const cardsDir = join(stateFolder(box), 'cards')
    mkdirSync(cardsDir, { recursive: true })
    writeFileSync(
      join(cardsDir, 'pane-12.json'),
      JSON.stringify({ key: 'pane-12', name: 'Анна % test', doing: 'работа 100%', category: 'other' }),
    )
    const { url } = await serveBoard(box, { language: 'en' })
    const before = (await (await fetch(`${url}/api/board`)).json()) as { items: unknown[] }
    await getView(url)
    const after = (await (await fetch(`${url}/api/board`)).json()) as { items: unknown[] }
    expect(after).toEqual(before)
  }, 60_000)

  test("node's door refuses /api/nodes/relay/setup with or without token", async () => {
    const node = await nodeBoard('server-1')
    const door = `http://127.0.0.1:${node.doorPort}`
    for (const headers of [{}, { authorization: `Bearer ${node.token}` }]) {
      expect((await fetch(`${door}/api/nodes/relay/setup`, { headers })).status).toBe(headers.authorization ? 404 : 401)
      expect(
        (
          await fetch(`${door}/api/nodes/relay/setup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
            body: JSON.stringify({ op: 'look', host: 'relay.example.com', user: 'admin' }),
          })
        ).status,
      ).toBe(headers.authorization ? 404 : 401)
    }
  }, 60_000)
})

describe.skipIf(!sh)('relay setup HTTP end to end', () => {
  test('Look, Apply and Undo via fake ssh write and remove nodes.relay and server artifacts', async () => {
    const root = fakeRoot('include', { relay: true })
    const bin = await fakeSshBin()
    const box = await sandbox()
    const sshState = join(box.dir, 'ssh-state.json')
    const sshLog = join(box.dir, 'ssh-calls.jsonl')
    writeFileSync(sshState, JSON.stringify({ admin: { root: { R: root.R, dir: root.path('') } } }))
    const port = await unusedPort()
    const cfg = {
      language: 'en',
      port,
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
    }
    mkdirSync(join(configOf(box), '..'), { recursive: true })
    writeFileSync(configOf(box), JSON.stringify(cfg, null, 2))
    await serveBoard(box, cfg, {
      ...PAIR_ENV,
      TEST_LIVE_CONFIG: '1',
      BOARD_SSH_BIN_PATH: bin,
      BOARD_SSH_KEYGEN_BIN_PATH: bin,
      FAKE_SSH_STATE: sshState,
      FAKE_SSH_LOG: sshLog,
      REAL_BUN: process.execPath.replaceAll('\\', '/'),
      FAKE_SH: sh as string,
    })
    const url = `http://127.0.0.1:${port}`
    const lookRes = await post(url, { op: 'look', host: 'ssh.example.com', user: 'admin' })
    expect([lookRes.status, await lookRes.json()]).toEqual([200, { ok: true }])
    const looked = await getView(url)
    expect(looked.phase).toBe('plan')
    expect(looked.hostKey?.pinnedNow).toBe(true)

    expect((await post(url, { op: 'apply', plan: looked.plan?.id })).status).toBe(200)
    const end = Date.now() + 60_000
    let v = await getView(url)
    while (v.phase !== 'done' && v.phase !== 'failed' && Date.now() < end) {
      await Bun.sleep(100)
      v = await getView(url)
    }
    expect([v.phase, v.error, v.run?.result]).toEqual(['done', null, 'applied'])
    expect(existsSync(root.path(RELAY_FENCE))).toBe(true)
    expect(existsSync(root.path(RELAY_MASTER_KEYS))).toBe(true)
    const written = JSON.parse(readFileSync(configOf(box), 'utf8')) as { nodes: Record<string, unknown> }
    expect(written.nodes.relay).toEqual({ host: 'ssh.example.com', sshPort: 22, user: RELAY_MASTER_USER })

    // Undo
    expect((await post(url, { op: 'undo-look', host: 'ssh.example.com', user: 'admin' })).status).toBe(200)
    const undoLooked = await getView(url)
    expect(undoLooked.phase).toBe('plan')
    expect((await post(url, { op: 'undo', plan: undoLooked.plan?.id })).status).toBe(200)
    const endUndo = Date.now() + 60_000
    v = await getView(url)
    while (v.phase !== 'undone' && v.phase !== 'failed' && Date.now() < endUndo) {
      await Bun.sleep(100)
      v = await getView(url)
    }
    expect([v.phase, v.run?.result]).toEqual(['undone', 'undone'])
    expect(existsSync(root.path(RELAY_FENCE))).toBe(false)
    const afterUndo = JSON.parse(readFileSync(configOf(box), 'utf8')) as { nodes: Record<string, unknown> }
    expect(afterUndo.nodes).not.toHaveProperty('relay')
  }, 90_000)
})
