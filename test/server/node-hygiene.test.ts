// Node hygiene after a master handover (#777, #726, epic #763 T3), on real boards: a node board
// refuses the forms that add a device and the backup's changes with a plain sentence, and shows no
// backup line, while a board without `node` answers them as before; and a master whose config.json
// loses `nodes` while it runs closes what only a master runs, and makes it again when `nodes` is back.

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logged, serveBoard, unusedPort } from '../support/board-server.ts'
import { nodeBoard } from '../support/node-pair.ts'
import { sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

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
    expect(view.onNode).toBe('The board is backed up on master: Settings → Backup there.')
    for (const op of ['now', 'folder', 'passphrase', 'apply']) {
      const r = await post(node.url, '/api/backup', { op, folder: '' })
      expect(r.status).toBe(409)
      expect(((await r.json()) as { error: string }).error).toBe(
        'The board is backed up on master: Settings → Backup there.',
      )
    }
    const payload = (await (await fetch(`${node.url}/api/board`)).json()) as Record<string, unknown>
    expect(payload.backup).toBeUndefined()
    expect(payload.machine).toBeDefined()
  }, 60_000)
})

describe('a node demoted by a handover before #777', () => {
  test('moves the shipped state aside and drops the backup target once, at boot; a second boot changes nothing', async () => {
    const id = 'ho-before-777'
    const box = await sandbox()
    const state = stateFolder(box)
    const backups = join(state, 'handover', 'backups', id)
    mkdirSync(backups, { recursive: true })
    writeFileSync(
      join(state, 'handover', 'state.json'),
      JSON.stringify({
        v: 1,
        id,
        role: 'old-master',
        phase: 'committed',
        from: 'laptop',
        to: 'atlas',
        peerId: 'atlas',
        otherNodes: [],
        at: 1000,
      }),
    )
    writeFileSync(
      join(backups, 'backup-manifest.json'),
      JSON.stringify({ v: 1, id, at: 1000, hadConfig: true, files: [], appliedFiles: [] }),
    )
    new Database(join(state, 'board.db')).close()
    writeFileSync(join(state, 'access.json'), '{"owner":"anna"}')
    const file = configOf(box)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ language: 'en', backup: { folder: join(box.dir, 'Sync') } }))
    const nodeCfg = async () => ({
      language: 'en',
      node: { id: 'laptop', port: await unusedPort(), workRoot: box.dir },
    })
    const first = await serveBoard(box, await nodeCfg())
    const logs = () => JSON.stringify(first.proc.messages)
    await until(() => logged(first.proc, `handover ${id}: moved`), 10_000).catch(err => {
      throw new Error(`${err.message}: ${logs().slice(0, 2000)}`)
    })
    const retired = join(backups, 'retired')
    await until(() => logged(first.proc, 'node door: listening'), 10_000).catch(err => {
      throw new Error(`${err.message}: ${logs().slice(0, 3000)}`)
    })
    expect(existsSync(join(retired, 'access.json'))).toBe(true)
    expect(existsSync(join(retired, 'board.db'))).toBe(true)
    expect(existsSync(join(state, 'access.json'))).toBe(false)
    const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(config.backup).toBeUndefined()
    expect(config.language).toBe('en')

    // a second boot: what the node writes since stays where it is
    first.proc.kill()
    writeFileSync(join(state, 'access.json'), '{"owner":"ben"}')
    const again = await serveBoard(box, await nodeCfg())
    await untilAsync(async () => (await fetch(`${again.url}/api/board`)).ok)
    expect(logged(again.proc, `handover ${id}: moved`)).toBe(false)
    expect(readFileSync(join(state, 'access.json'), 'utf8')).toBe('{"owner":"ben"}')
    expect(readFileSync(join(retired, 'access.json'), 'utf8')).toBe('{"owner":"anna"}')
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
