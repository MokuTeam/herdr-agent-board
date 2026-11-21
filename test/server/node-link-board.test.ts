// The node link on running boards (#499): a master and its node as sandbox boards
// (test/support/node-pair.ts), GET /api/nodes on the master's local board, and `board nodes` as an
// agent runs it. Without `nodes`: the route table is the same, /api/nodes is any unknown path, no
// ssh runs and no file is written under the state folder.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { fakeSshBin } from '../support/fake-ssh-bin.ts'
import { DEAD_MS, nodePair, PAIR_ENV } from '../support/node-pair.ts'
import { type ChildResult, root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { routeTable, stateFolder } from '../support/tunnel-board.ts'

const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

function writeConfig(box: Sandbox, value: Record<string, unknown>): void {
  const path = configPath(box)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ language: 'en', wakeUrl: '', port: 9, ...value }, null, 2))
}

const board = (box: Sandbox, args: string[]): Promise<ChildResult> => box.run('cli', { args, env: {} }).exited

/** `board ...` with `input` on its stdin, as a shell pipes it. */
async function piped(box: Sandbox, args: string[], input: string): Promise<ChildResult> {
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'cli.ts'), ...args], {
    cwd: root,
    env: box.env,
    stdin: Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

const portOf = (url: string): number => Number(new URL(url).port)

describe('a master and its node', () => {
  test('GET /api/nodes and board nodes: online, offline when the node goes, online again', async () => {
    const pair = await nodePair()
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const online = await pair.waitDevice(
      'server-1',
      d => d.link?.state === 'online' && d.payloadAt !== null && d.status !== null,
      15_000,
    )
    expect([online.kind, online.status?.id]).toEqual(['direct', 'server-1'])
    expect((await pair.devices()).map(d => [d.id, d.kind])).toEqual([
      ['server-1', 'direct'],
      ['local', null],
    ])
    writeConfig(pair.master.box, {
      port: portOf(pair.master.url),
      nodes: {
        id: 'laptop',
        devices: { 'server-1': { link: { kind: 'direct', url: `http://127.0.0.1:${node.proxy.port}` } } },
      },
    })
    const said = await board(pair.master.box, ['nodes'])
    expect([said.code, said.stderr]).toEqual([0, ''])
    const lines = said.stdout.trim().split('\n')
    expect(lines[0]).toBe('master laptop')
    expect(lines[1]).toMatch(/^server-1 · direct · online since \d\d:\d\d/)
    expect(lines[2]).toBe('local · this computer')

    await node.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline', DEAD_MS * 6)
    expect(((await pair.devices())[0]?.payloadAt ?? 0) > 0).toBe(true)
    node.proxy.restore()
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 15_000)
    expect(node.proxy.peak()).toBe(1)
  }, 60_000)

  test('board nodes token: read from stdin, stored 0600 and never echoed; the link tries again at once', async () => {
    const pair = await nodePair({ tokens: false })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const refused = await pair.waitDevice('server-1', d => d.link?.state === 'refused', 15_000)
    expect(refused.link?.reason).toBe('token')
    writeConfig(pair.master.box, {
      port: portOf(pair.master.url),
      nodes: {
        id: 'laptop',
        devices: { 'server-1': { link: { kind: 'direct', url: `http://127.0.0.1:${node.proxy.port}` } } },
      },
    })
    // A token that is none: refused, the file not written, the value not in what is said.
    const bad = await piped(pair.master.box, ['nodes', 'token', 'server-1'], 'not a token\n')
    expect(bad.code).not.toBe(0)
    expect(bad.stdout + bad.stderr).not.toContain('not a token\n')
    const file = join(stateFolder(pair.master.box), 'nodes', 'server-1', 'token')
    expect(existsSync(file)).toBe(false)
    // No such device.
    const none = await piped(pair.master.box, ['nodes', 'token', 'server-9'], `${node.token}\n`)
    expect([none.code, none.stdout.includes(node.token) || none.stderr.includes(node.token)]).toEqual([1, false])

    const r = await piped(pair.master.box, ['nodes', 'token', 'server-1'], `${node.token}\r\n`)
    expect([r.code, r.stdout, r.stderr]).toEqual([
      0,
      'ok · token for server-1 stored; the board tries the link again now\n',
      '',
    ])
    expect(readFileSync(file, 'utf8')).toBe(`${node.token}\n`)
    // The refusal's minute is not waited out: the stored token is tried now.
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 5000)
  }, 60_000)
})

test('board nodes key: the device link key made once, its public half printed', async () => {
  const box = await sandbox()
  const fake = await fakeSshBin()
  box.env.BOARD_SSH_KEYGEN_BIN_PATH = fake
  box.env.BOARD_SSH_BIN_PATH = fake
  writeConfig(box, {
    nodes: {
      id: 'laptop',
      devices: {
        'server-1': { link: { kind: 'ssh', host: 'ssh.example.com', user: 'agent-board-link' } },
        'server-2': { link: { kind: 'direct', url: 'http://127.0.0.1:9' } },
      },
    },
  })
  const key = join(stateFolder(box), 'nodes', 'server-1', 'link-key')
  const first = await board(box, ['nodes', 'key', 'server-1'])
  expect([first.code, first.stdout, first.stderr]).toEqual([
    0,
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEY agent-board laptop to server-1\n',
    '',
  ])
  expect(existsSync(key)).toBe(true)
  const made = readFileSync(key, 'utf8')
  const again = await board(box, ['nodes', 'key', 'server-1'])
  expect([again.code, again.stdout]).toEqual([0, first.stdout])
  expect(readFileSync(key, 'utf8')).toBe(made)
  const direct = await board(box, ['nodes', 'key', 'server-2'])
  expect([direct.code, direct.stderr.trim()]).toEqual([
    1,
    'board: server-2 has no ssh link: only an ssh link takes a key',
  ])
}, 30_000)

test('board nodes on a board that is not a master: one line, nothing read or written', async () => {
  const box = await sandbox()
  writeConfig(box, {})
  for (const args of [['nodes'], ['nodes', 'token', 'server-1'], ['nodes', 'key', 'server-1']]) {
    const r = await board(box, args)
    expect([args, r.code, r.stdout, r.stderr]).toEqual([
      args,
      0,
      'this board is not a master: config.json has no `nodes`\n',
      '',
    ])
  }
  expect(existsSync(join(stateFolder(box), 'nodes'))).toBe(false)
}, 30_000)

test('without nodes: the same route table, /api/nodes as any unknown path, no ssh, no nodes folder', async () => {
  const plain = await sandbox()
  const master = await sandbox()
  const fake = await fakeSshBin()
  for (const box of [plain, master]) {
    box.env.BOARD_SSH_BIN_PATH = fake
    box.env.BOARD_SSH_KEYGEN_BIN_PATH = fake
    box.env.FAKE_SSH_LOG = join(box.dir, 'ssh-calls.jsonl')
  }
  const env = { ...PAIR_ENV, TEST_ROUTE_TABLE: '1' }
  const a = await serveBoard(plain, { language: 'en' }, env)
  const b = await serveBoard(
    master,
    {
      language: 'en',
      nodes: {
        id: 'laptop',
        devices: { 'server-1': { link: { kind: 'ssh', host: 'ssh.example.com', user: 'agent-board-link' } } },
      },
    },
    env,
  )
  expect(routeTable(a.proc)).toEqual(routeTable(b.proc))
  const answer = async (url: string): Promise<[number, string]> => {
    const res = await fetch(url)
    return [res.status, await res.text()]
  }
  expect(await answer(`${a.url}/api/nodes`)).toEqual(await answer(`${a.url}/api/nodez`))
  // The master has it; through its route list only on its own board.
  expect((await fetch(`${b.url}/api/nodes`)).status).toBe(200)
  await Bun.sleep(500)
  expect(existsSync(join(stateFolder(plain), 'nodes'))).toBe(false)
  expect(existsSync(join(plain.dir, 'ssh-calls.jsonl'))).toBe(false)
}, 60_000)
