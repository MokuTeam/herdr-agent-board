// A node updates to its master's commit over the link (#590, docs/design/nodes 6.2, 6.5, 11.3), on
// sandbox boards with fake herdrs (test/support/node-pair.ts). Each board's plugin folder is a
// scratch one (BOARD_TEST_PLUGIN_ROOT): the master's a git repository at commit B, the node's an
// archive of commit A with its stamp. The master sees the node on another commit with no session in
// a turn and ships B; the node unpacks, installs, swaps and ends with 75, and is started again as
// run.ts starts it; it comes back on B, and its herdr was never asked to close a pane.
import { describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { ROOT } from '../../src/adapters/paths.ts'
import { besidePlugin, readPending, writeTree } from '../../src/adapters/plugin-update.ts'
import { readTar } from '../../src/core/tar.ts'
import { serveBoard } from '../support/board-server.ts'
import { nodeBoard, nodePair, PAIR_ENV } from '../support/node-pair.ts'
import { gitDir, type PluginRepo, pluginRepo } from '../support/plugin-tar.ts'
import { sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

/** A scratch folder for the test, gone with it. */
async function scratch(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'node-update-board-'))
  const { onTestFinished } = await import('bun:test')
  onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}

/** The node's plugin folder: commit A unpacked from its archive, with the stamp. */
function nodePlugin(repo: PluginRepo, root: string): void {
  const read = readTar(repo.archive(repo.a))
  if ('error' in read) throw new Error(read.error)
  writeTree(root, [
    ...read.entries,
    { kind: 'file', path: '.archive-commit', mode: 0o644, data: new TextEncoder().encode(`${repo.a}\n`) },
  ])
}

// git on Windows may write the archive with CRLF line ends (core.autocrlf): the content is compared as lines.
const text = (...p: string[]): string => readFileSync(join(...p), 'utf8').replaceAll('\r\n', '\n')
const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

describe('a node updates to its master’s commit', () => {
  test('shipped by itself, the node comes back on the new commit, and its panes were never closed', async () => {
    const dir = await scratch()
    const repo = pluginRepo(join(dir, 'repo'))
    const root = join(dir, 'node', 'agent-board')
    nodePlugin(repo, root)
    const pair = await nodePair({
      env: { BOARD_TEST_PLUGIN_ROOT: root, BOARD_TEST_PLATFORM: 'linux' },
      // git for the master's commit and its archive; the node has none, so its stamp says its commit
      masterEnv: { BOARD_TEST_PLUGIN_ROOT: repo.dir, PATH: [dirname(process.execPath), gitDir()].join(delimiter) },
    })
    const node = pair.nodes[0]
    if (!node) throw new Error('no node')
    // The node's board ends with 75 once the new copy is in place, as it does under run.ts.
    const ended = await Promise.race([node.proc.exited, Bun.sleep(60_000).then(() => null)])
    expect(ended?.code).toBe(75)
    expect(text(root, '.archive-commit')).toBe(`${repo.b}\n`)
    expect(text(root, 'src', 'b.ts')).toBe('export const B = true\n')
    expect(text(besidePlugin(root).old, '.archive-commit')).toBe(`${repo.a}\n`)
    // run.ts starts it again from the plugin's folder: here the test does
    await serveBoard(
      node.box,
      { language: 'en', node: { id: node.id, port: node.doorPort, workRoot: node.box.dir } },
      {
        ...PAIR_ENV,
        BOARD_TEST_PLUGIN_ROOT: root,
        BOARD_TEST_PLATFORM: 'linux',
      },
    )
    const back = await pair.waitDevice('server-1', d => d.sameCommit === true && d.update === undefined, 20_000)
    expect(back.status?.commit).toBe(repo.b)
    // herdr was asked to read, never to close a pane, stop or restart anything
    const asked = node.box.calls().map(c => c.join(' '))
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.filter(c => /\b(close|kill|stop|restart|quit|exit)\b/.test(c))).toEqual([])
    // and its session is still on the master's board, once the node's payload came again
    let keys: string[] = []
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(50)) {
      const board = (await (await fetch(`${pair.master.url}/api/board`)).json()) as { items: { key: string }[] }
      keys = board.items.map(i => i.key)
      if (keys.includes('@server-1:s-server-1')) break
    }
    expect(keys).toContain('@server-1:s-server-1')
  }, 120_000)

  test('asked by `board nodes update`: a node on this commit is current; one whose update fails says so on its row', async () => {
    const dir = await scratch()
    const repo = pluginRepo(join(dir, 'repo'))
    const root = join(dir, 'node', 'agent-board')
    nodePlugin(repo, root)
    const pair = await nodePair({
      env: { BOARD_TEST_PLUGIN_ROOT: root, BOARD_TEST_PLATFORM: 'linux' },
      masterEnv: { BOARD_TEST_PLUGIN_ROOT: repo.dir, PATH: [dirname(process.execPath), gitDir()].join(delimiter) },
      // the node's session is in a turn: nothing goes by itself
      panes: (id, box) => [
        { pane_id: 'p1', agent: 'claude', agent_session: { value: `s-${id}` }, agent_status: 'working', cwd: box.dir },
      ],
    })
    const node = pair.nodes[0]
    if (!node) throw new Error('no node')
    await pair.waitDevice('server-1', d => d.sameCommit === false, 10_000)
    await Bun.sleep(500)
    expect(node.proxy.requests.filter(r => r.includes('/api/node/update'))).toEqual([])
    // asked: the node refuses the archive (the proxy answers for it), and the row says why
    node.proxy.intercept = async (method, path) =>
      method === 'POST' && path === '/api/node/update'
        ? Response.json({ ok: false, error: 'install', detail: 'no network' }, { status: 500 })
        : null
    // The CLI finds the running board by the port in config.json on disk: the master's config as it runs.
    const onDisk = join(
      pair.master.box.env.APPDATA as string,
      'herdr',
      'plugins',
      'config',
      'agent-board',
      'config.json',
    )
    mkdirSync(dirname(onDisk), { recursive: true })
    writeFileSync(
      onDisk,
      JSON.stringify({
        ...pair.masterConfig,
        port: Number(new URL(pair.master.url).port),
        categories: [{ id: 'other', title: 'Other', color: 'gray' }],
        wakeUrl: null,
        refreshSec: 3600,
      }),
    )
    const cli = (args: string[]) => pair.master.box.run('cli', { args, env: { CLAUDE_CODE_SESSION_ID: '' } }).exited
    const r = await cli(['nodes', 'update', 'server-1'])
    expect(r.stdout).toBe(
      'not updated · server-1: bun install --production failed on the node (it needs the network); the old copy stays (no network)\n',
    )
    expect(r.code).toBe(1)
    const usage = await cli(['nodes', 'update', 'local'])
    expect(usage.code).not.toBe(0)
    expect(usage.stdout + usage.stderr).toContain('no device local with a link')
    const failed = await pair.waitDevice('server-1', d => d.update?.state === 'failed')
    expect(failed.update).toMatchObject({ commit: repo.b, error: 'install' })
    // the payload's device row carries it too, for the panel
    const board = (await (await fetch(`${pair.master.url}/api/board`)).json()) as {
      devices: { id: string; update?: { state: string } }[]
    }
    expect(board.devices.find(d => d.id === 'server-1')?.update?.state).toBe('failed')
    // the node's plugin is as it was
    expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
  }, 60_000)

  test("through the door only with the master's token; a wrong sha256 leaves the old copy; the board's own listener has no such route", async () => {
    const dir = await scratch()
    const repo = pluginRepo(join(dir, 'repo'))
    const root = join(dir, 'node', 'agent-board')
    nodePlugin(repo, root)
    const node = await nodeBoard('server-1', {
      ...PAIR_ENV,
      BOARD_TEST_PLUGIN_ROOT: root,
      BOARD_TEST_PLATFORM: 'linux',
    })
    const door = `http://127.0.0.1:${node.proxy.port}`
    const archive = repo.archive(repo.b)
    const auth = { authorization: `Bearer ${node.token}`, 'x-board': '1' }
    expect(
      (await fetch(`${door}/api/node/update/blob`, { method: 'PUT', headers: { 'x-board': '1' }, body: archive }))
        .status,
    ).toBe(401)
    const put = await fetch(`${door}/api/node/update/blob`, { method: 'PUT', headers: auth, body: archive })
    expect(await put.json()).toEqual({ ok: true, sha256: sha(archive), size: archive.length })
    const wrong = await fetch(`${door}/api/node/update`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ commit: repo.b, sha256: 'f'.repeat(64) }),
    })
    expect(wrong.status).toBe(409)
    expect(await wrong.json()).toEqual({ ok: false, error: 'sha256' })
    const current = await fetch(`${door}/api/node/update`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ commit: repo.a, sha256: sha(archive) }),
    })
    expect(await current.json()).toEqual({ ok: true, current: true, commit: repo.a })
    expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
    expect(existsSync(besidePlugin(root).fresh)).toBe(false)
    // not on the board's own listener, which phones and the tunnel share
    const at = async (method: string, path: string): Promise<number> =>
      (await fetch(`${node.url}${path}`, { method, headers: { 'x-board': '1' }, body: '{}' })).status
    expect(await at('PUT', '/api/node/update/blob')).toBe(await at('PUT', '/api/node/no-such-route'))
    expect(await at('POST', '/api/node/update')).toBe(await at('POST', '/api/node/no-such-route'))
    expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
  }, 60_000)
})

describe('a node on Windows', () => {
  /**
   * A master and a Windows node on commit A, the master on B. The node's plugin folder holds this
   * code's own src besides commit A's files, so the copy of it the board makes carries the guard it
   * starts from there. The node's board does not end on its own here (no run.ts): the tests end it.
   */
  async function windowsPair(guardMs: string) {
    const dir = await scratch()
    const repo = pluginRepo(join(dir, 'repo'))
    const root = join(dir, 'node', 'agent-board')
    nodePlugin(repo, root)
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true })
    const env = { BOARD_TEST_PLUGIN_ROOT: root, BOARD_TEST_PLATFORM: 'win32', BOARD_NODE_GUARD_MS: guardMs }
    const pair = await nodePair({
      env,
      masterEnv: { BOARD_TEST_PLUGIN_ROOT: repo.dir, PATH: [dirname(process.execPath), gitDir()].join(delimiter) },
    })
    const node = pair.nodes[0]
    if (!node) throw new Error('no node')
    const state = stateFolder(node.box)
    const pending = join(state, 'node', 'update', 'pending.json')
    const stamp = (): string => (existsSync(join(root, '.archive-commit')) ? text(root, '.archive-commit') : '')
    return { repo, root, pair, node, env, pending, weblog: join(state, 'web.log'), stamp }
  }

  test('the guard puts the new copy in place; the board that comes back on the new commit settles it', async () => {
    const { repo, root, pair, node, env, pending, stamp } = await windowsPair('60000')
    await until(() => stamp() === `${repo.b}\n`, 30_000)
    expect(text(root, 'src', 'b.ts')).toBe('export const B = true\n')
    expect(text(besidePlugin(root).old, '.archive-commit')).toBe(`${repo.a}\n`)
    expect(existsSync(besidePlugin(root).fresh)).toBe(false)
    expect(readPending(pending)?.phase).toBe('applied')
    // run.ts ends the board on the code change and starts it again from the plugin's folder: here the test does
    node.proc.kill()
    await node.proc.exited
    await serveBoard(
      node.box,
      { language: 'en', node: { id: node.id, port: node.doorPort, workRoot: node.box.dir } },
      { ...PAIR_ENV, ...env },
    )
    const back = await pair.waitDevice('server-1', d => d.sameCommit === true && d.update === undefined, 20_000)
    expect(back.status?.commit).toBe(repo.b)
    await until(() => !existsSync(pending), 10_000)
    expect(stamp()).toBe(`${repo.b}\n`)
    const asked = node.box.calls().map(c => c.join(' '))
    expect(asked.filter(c => /\b(close|kill|stop|restart|quit|exit)\b/.test(c))).toEqual([])
  }, 120_000)

  test('a board that does not come back on the new commit: the guard puts the copy before back, its own files too', async () => {
    const { repo, root, node, weblog, pending, stamp } = await windowsPair('1500')
    await until(() => stamp() === `${repo.b}\n`, 30_000)
    await until(() => stamp() === `${repo.a}\n`, 30_000)
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
    expect(existsSync(join(root, 'src', 'entrypoints', 'node-update-guard.ts'))).toBe(true)
    await until(() => !existsSync(pending), 10_000)
    expect(existsSync(`${pending}.alive`)).toBe(false)
    expect(readFileSync(weblog, 'utf8')).toContain('is back in place')
    node.proc.kill()
  }, 120_000)
})

describe('Without node and nodes', () => {
  test('no update route on the listener, none in the route table, no /api/nodes op, no update in the payload', async () => {
    const box = await sandbox()
    const { url, proc } = await serveBoard(box, { language: 'en' }, { TEST_ROUTE_TABLE: '1' })
    await until(() => proc.messages.some(m => (m as { routes?: unknown }).routes))
    const routes = (proc.messages.find(m => (m as { routes?: unknown }).routes) as { routes: { path: string }[] })
      .routes
    expect(routes.filter(r => r.path.includes('node') && r.path.includes('update'))).toEqual([])
    // answered as a path the board has no route for
    const none = async (method: string, path: string): Promise<number> =>
      (await fetch(`${url}${path}`, { method, headers: { 'x-board': '1' }, body: '{}' })).status
    expect(await none('PUT', '/api/node/update/blob')).toBe(await none('PUT', '/api/node/no-such-route'))
    expect(await none('POST', '/api/node/update')).toBe(await none('POST', '/api/node/no-such-route'))
    const nodes = await fetch(`${url}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'update', id: 'server-1' }),
    })
    expect(nodes.status).toBe(await none('POST', '/api/no-such-route'))
    const board = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    expect('devices' in board).toBe(false)
    expect(JSON.stringify(board)).not.toContain('"update"')
  }, 30_000)
})
