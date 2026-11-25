// Node hygiene after a master handover (#777, #726, epic #763 T3), on real boards: a node board
// refuses the forms that add a device and the backup's changes with a plain sentence, and shows no
// backup line, while a board without `node` answers them as before; and a master whose config.json
// loses `nodes` while it runs closes what only a master runs, and makes it again when `nodes` is back.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logged, serveBoard } from '../support/board-server.ts'
import { nodeBoard } from '../support/node-pair.ts'
import { sandbox, until } from '../support/sandbox.ts'

const SETUP = ['/api/nodes/setup', '/api/nodes/relay/setup', '/api/nodes/computer/setup']
const ON_NODE = 'This computer is a node of the master board.'
const configOf = (box: { env: Record<string, string> }): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
/** Waits until `fn` resolves true (sandbox's until takes no promise). */
async function untilAsync(fn: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the board')
    await Bun.sleep(25)
  }
}
const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })

describe('a node board (#777)', () => {
  test('refuses Add a server, Add a computer and the relay form, and every change of the backup, in words', async () => {
    const node = await nodeBoard('server-1', undefined, undefined, box => ({
      backup: { folder: join(box.dir, 'Sync') },
    }))
    for (const path of SETUP) {
      const got = await fetch(`${node.url}${path}`)
      expect(got.status).toBe(409)
      expect(((await got.json()) as { error: string }).error).toContain(ON_NODE)
      const sent = await post(node.url, path, { op: 'cancel' })
      expect(sent.status).toBe(409)
      expect(((await sent.json()) as { error: string }).error).toContain(ON_NODE)
    }
    const view = (await (await fetch(`${node.url}/api/backup`)).json()) as { onNode?: string }
    expect(view.onNode).toContain('backed up on the master')
    for (const op of ['now', 'folder', 'passphrase', 'apply']) {
      const r = await post(node.url, '/api/backup', { op, folder: '' })
      expect(r.status).toBe(409)
      expect(((await r.json()) as { error: string }).error).toContain('backed up on the master')
    }
    const payload = (await (await fetch(`${node.url}/api/board`)).json()) as Record<string, unknown>
    expect(payload.backup).toBeUndefined()
    expect(payload.machine).toBeDefined()
  }, 60_000)
})

describe('a board without node', () => {
  test('answers the forms and the backup as before', async () => {
    const box = await sandbox()
    const { url } = await serveBoard(box, { language: 'en', backup: { folder: join(box.dir, 'Sync') } })
    for (const path of SETUP) expect((await fetch(`${url}${path}`)).status).toBe(200)
    const view = (await (await fetch(`${url}/api/backup`)).json()) as Record<string, unknown>
    expect(view.onNode).toBeUndefined()
    expect(view.needed).toBeDefined()
    const r = await post(url, '/api/backup', { op: 'nope' })
    expect(r.status).toBe(400)
    const payload = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    expect(payload.machine).toBeUndefined()
  }, 60_000)
})

describe('a master whose nodes leave config.json while it runs (#726)', () => {
  test('closes what only a master runs, and makes it again when nodes is back', async () => {
    const box = await sandbox()
    const nodes = { id: 'laptop', devices: {} }
    const file = configOf(box)
    const cfg = { language: 'en', categories: [{ id: 'other', title: 'Other', color: 'gray' }], refreshSec: 3600 }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...cfg, nodes }))
    const { url, proc } = await serveBoard(box, { ...cfg, nodes }, { TEST_LIVE_CONFIG: '1' })
    const devices = async (): Promise<number> => (await fetch(`${url}/api/nodes`)).status
    await untilAsync(async () => (await devices()) === 200)
    writeFileSync(file, JSON.stringify(cfg))
    await until(() => logged(proc, 'nodes: off in config.json, the master links are closed'), 10_000)
    expect(await devices()).toBe(404)
    writeFileSync(file, JSON.stringify({ ...cfg, nodes }))
    await untilAsync(async () => (await devices()) === 200)
  }, 60_000)
})
