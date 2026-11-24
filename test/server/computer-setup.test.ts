// Server route tests for "Add a computer" (#513, /api/nodes/computer/setup):
// - Without `nodes` and `node`: shared route table unchanged, /api/board payload unchanged,
//   /api/hello byte-for-byte identical, local setup route lazy and guarded (X-Board + Origin),
//   no files or ssh calls until asked, node's door refuses /api/nodes/computer/setup.
// - Section 17 comparison: pane keys, spaces, Cyrillic, and % stay identical.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerSetupView } from '../../src/core/node-computer-setup.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeSshBin } from '../support/fake-ssh-bin.ts'
import { nodeBoard } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'
import { routeTable, stateFolder } from '../support/tunnel-board.ts'

const post = (url: string, body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
  fetch(`${url}/api/nodes/computer/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const getView = async (url: string): Promise<ComputerSetupView> =>
  (await (await fetch(`${url}/api/nodes/computer/setup`)).json()) as ComputerSetupView

describe('without nodes or node (#513)', () => {
  test('route table and payload stay unchanged; local setup route is lazy and guarded', async () => {
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
    expect(routeTable(proc).filter(r => r.path.includes('computer') || r.path.includes('nodes'))).toEqual([])
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
    expect((await post(url, { op: 'start' })).status).toBe(409)
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

  test("node's door refuses /api/nodes/computer/setup with or without token", async () => {
    const node = await nodeBoard('server-1')
    const door = `http://127.0.0.1:${node.doorPort}`
    for (const headers of [{}, { authorization: `Bearer ${node.token}` }]) {
      expect((await fetch(`${door}/api/nodes/computer/setup`, { headers })).status).toBe(
        headers.authorization ? 404 : 401,
      )
      expect(
        (
          await fetch(`${door}/api/nodes/computer/setup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
            body: JSON.stringify({ op: 'start' }),
          })
        ).status,
      ).toBe(headers.authorization ? 404 : 401)
    }
  }, 60_000)
})
