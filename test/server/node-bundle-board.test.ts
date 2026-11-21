// The profile bundle between running boards (#506, docs/design/nodes 9): a master and its node as
// sandbox boards (test/support/node-pair.ts). The master syncs its default profile through the
// node's door; the node applies it: what it owns replaced or removed, a file of its own kept and
// said, a backup folder per commit, the board's hooks with the node's Bun and folder, only changed
// blobs on a second sync, a path that leaves the folder refused, nothing written when settings.json
// does not parse. With the device's secrets off (#604) a secret of the master's never leaves it.
// Without `nodes` and `node`: no route, no file.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { nodePair } from '../support/node-pair.ts'
import { type ChildResult, root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const CANARY = 'canary-7f3a91c2e0d84b6b'
// The master's own copy of the board, as a Windows master has it: its hooks never travel.
const MASTER_BOARD = 'C:/Users/owner/AppData/Roaming/herdr/plugins/agent-board'
const MASTER_BUN = 'C:/Users/owner/.bun/bin/bun.exe'

const profileDir = (box: Sandbox): string => join(box.env.HOME as string, '.claude')
function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}
const norm = (s: string): string => s.replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase()

/** Every file under `dir` with its text. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string): void => {
    let names: string[] = []
    try {
      names = readdirSync(at)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(at, name)
      try {
        if (statSync(full).isDirectory()) walk(full)
        else out[full] = readFileSync(full, 'latin1')
      } catch {}
    }
  }
  walk(dir)
  return out
}

const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

async function syncNow(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/api/nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'sync', ...body }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

describe('the bundle from a master to its node', () => {
  test('sync, a second sync with one changed file, the status, board nodes sync, a refused path, a settings.json that does not parse', async () => {
    const pair = await nodePair({
      masterSetup(box) {
        const dir = profileDir(box)
        put(dir, 'skills/a/SKILL.md', 'A1')
        put(dir, 'skills/b/SKILL.md', 'B')
        put(dir, 'skills/mine/SKILL.md', 'the master has this')
        put(dir, 'CLAUDE.md', 'rules')
        put(
          dir,
          'settings.json',
          JSON.stringify({
            model: 'opus',
            env: { PLAIN: '1', MY_API_TOKEN: CANARY },
            hooks: {
              Stop: [
                { hooks: [{ type: 'command', command: `"${MASTER_BUN}" "${MASTER_BOARD}/src/entrypoints/hook.ts"` }] },
              ],
            },
          }),
        )
        writeFileSync(
          join(box.env.HOME as string, '.claude.json'),
          JSON.stringify({
            mcpServers: {
              docs: {
                type: 'http',
                url: 'https://docs.example.com/mcp',
                headers: { Authorization: `Bearer ${CANARY}` },
              },
            },
          }),
        )
      },
      // Secrets off (#604): the bundle as it was before the switch.
      deviceCfg: () => ({ giveSecrets: false }),
      nodeSetup(_id, box) {
        const dir = profileDir(box)
        put(dir, 'settings.json', JSON.stringify({ theme: 'dark' }))
        put(dir, 'skills/mine/SKILL.md', 'the node owner wrote this')
      },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
    const nodeDir = profileDir(node.box)
    const nodeState = join(stateFolder(node.box), 'node')

    // The first sync: everything sent, the node's own skill kept and said.
    const first = await syncNow(pair.master.url, { id: 'server-1' })
    expect([first.ok, first.seq, first.sent, first.why]).toEqual([true, 1, 4, undefined])
    expect(first.kept).toEqual([{ path: 'skills/mine/SKILL.md', why: 'not-owned' }])
    expect(first.lines).toContainEqual({
      kind: 'env',
      name: 'MY_API_TOKEN',
      verdict: 'needs-secret',
      why: 'secret-name',
    })
    expect(readFileSync(join(nodeDir, 'skills', 'a', 'SKILL.md'), 'utf8')).toBe('A1')
    expect(readFileSync(join(nodeDir, 'CLAUDE.md'), 'utf8')).toBe('rules')
    expect(readFileSync(join(nodeDir, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('the node owner wrote this')
    const settings = readFileSync(join(nodeDir, 'settings.json'), 'utf8')
    const s = JSON.parse(settings)
    expect([s.theme, s.model, s.env]).toEqual(['dark', 'opus', { PLAIN: '1' }])
    // The board's hooks on the node name the node's Bun and folder, never the master's.
    expect(norm(settings)).toContain(norm(process.execPath))
    expect(norm(settings)).toContain(norm(join(root, 'src', 'entrypoints', 'hook.ts')))
    expect(norm(settings)).not.toContain('c:/users/owner')
    const servers = JSON.parse(readFileSync(join(node.box.env.HOME as string, '.claude.json'), 'utf8')).mcpServers
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the reference the node is given
    expect(servers.docs.headers).toEqual({ Authorization: '${MCP_DOCS_AUTHORIZATION}' })

    // The second sync: one file changed, one gone; only the changed blob travels.
    put(profileDir(pair.master.box), 'skills/a/SKILL.md', 'A2')
    rmSync(join(profileDir(pair.master.box), 'skills', 'b'), { recursive: true })
    const puts = node.proxy.requests.length
    const second = await syncNow(pair.master.url, { id: 'server-1' })
    expect([second.ok, second.seq, second.sent]).toEqual([true, 2, 1])
    expect(node.proxy.requests.slice(puts).filter(r => r.startsWith('PUT '))).toEqual([
      `PUT /api/node/bundle/default/blob/${sha('A2')}`,
    ])
    expect(existsSync(join(nodeDir, 'skills', 'b'))).toBe(false)
    expect(readFileSync(join(nodeDir, 'skills', 'a', 'SKILL.md'), 'utf8')).toBe('A2')
    // One backup folder per commit: settings.json the first time, a and b the second.
    const backups = join(nodeState, 'bundle-backups', 'default')
    expect(readdirSync(backups).sort()).toEqual(['1', '2'])
    expect(readFileSync(join(backups, '2', 'skills', 'b', 'SKILL.md'), 'utf8')).toBe('B')

    // Current: asked, nothing sent, no commit.
    const asked = node.proxy.requests.length
    const third = await syncNow(pair.master.url, { id: 'server-1' })
    expect([third.ok, third.seq, third.sent]).toEqual([true, 2, 0])
    expect(node.proxy.requests.slice(asked)).toEqual(['GET /api/node/bundle/default'])

    // The node's status says its version, and the master's link reads it.
    const seen = await pair.waitDevice('server-1', d => d.status?.profiles[0]?.bundle?.seq === 2, 5000)
    expect(seen.status?.profiles[0]?.bundle?.hash).toBe(third.hash as string)

    // board nodes sync, as an agent runs it: the lines that are not "sent".
    mkdirSync(dirname(configPath(pair.master.box)), { recursive: true })
    writeFileSync(
      configPath(pair.master.box),
      JSON.stringify({
        language: 'en',
        wakeUrl: '',
        port: Number(new URL(pair.master.url).port),
        nodes: {
          id: 'laptop',
          devices: {
            'server-1': { link: { kind: 'direct', url: `http://127.0.0.1:${node.proxy.port}` }, giveSecrets: false },
          },
        },
      }),
    )
    const cli: ChildResult = await pair.master.box.run('cli', { args: ['nodes', 'sync', 'server-1'], env: {} }).exited
    const out = cli.stdout.trim().split('\n')
    expect(out[0]).toBe('ok · server-1 default is current: bundle 2, 0 file(s) sent, 0 changed')
    expect(out).toContain('env MY_API_TOKEN: needs-secret (secret-name)')
    expect(out).toContain(
      'secrets to give by hand (this device is not given them): MY_API_TOKEN, MCP_DOCS_AUTHORIZATION',
    )
    expect(node.proxy.requests.some(r => r.endsWith('/secrets'))).toBe(false)
    expect(out).toContain('kept on the node: skills/mine/SKILL.md (not-owned)')
    expect(out.some(l => l.includes(': sent ('))).toBe(false)

    // A master's word for where a file goes is not trusted: refused whole, nothing written.
    const door = `http://127.0.0.1:${node.proxy.port}/api/node/bundle/default`
    const auth = { authorization: `Bearer ${node.token}`, 'x-board': '1' }
    const evil = 'escape'
    expect((await fetch(`${door}/blob/${sha(evil)}`, { method: 'PUT', headers: auth, body: evil })).status).toBe(200)
    const manifest = {
      format: 1,
      files: [{ path: '../escape.md', sha256: sha(evil), mode: 420 }],
      settings: {},
      hooks: {},
      mcp: {},
      board: { sinks: {} },
    }
    const refused = await fetch(`${door}/commit`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 9, hash: sha('x'), manifest }),
    })
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, 'path'])
    expect(existsSync(join(node.box.env.HOME as string, 'escape.md'))).toBe(false)

    // A settings.json that does not parse on the node: nothing written, the report says why.
    put(nodeDir, 'settings.json', '{ "theme": ')
    put(profileDir(pair.master.box), 'CLAUDE.md', 'rules, changed')
    const broken = await syncNow(pair.master.url, { id: 'server-1' })
    expect([broken.ok, broken.why, String(broken.detail).split(':')[0]]).toEqual([false, 'node', 'settings-parse'])
    expect(readFileSync(join(nodeDir, 'CLAUDE.md'), 'utf8')).toBe('rules')
    expect(readdirSync(backups).sort()).toEqual(['1', '2'])

    // The canary: in no request the node was sent, no file on the node, no log of either board,
    // and nothing the master keeps of the bundle.
    for (const r of node.proxy.received) expect(`${r.request} ${r.body}`).not.toContain(CANARY)
    for (const [file, text] of Object.entries(files(node.box.dir)))
      expect([file, text.includes(CANARY)]).toEqual([file, false])
    for (const proc of [pair.master.proc, node.proc]) expect(JSON.stringify(proc.messages)).not.toContain(CANARY)
    expect(readFileSync(join(stateFolder(pair.master.box), 'nodes', 'server-1', 'bundle.json'), 'utf8')).not.toContain(
      CANARY,
    )
  }, 90_000)
})

describe('without nodes and node', () => {
  test('no bundle route, no sync, no file under the state folder', async () => {
    const box = await sandbox()
    const { url } = await serveBoard(box, { language: 'en' })
    const sync = await fetch(`${url}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'sync', id: 'server-1' }),
    })
    const unknown = await fetch(`${url}/api/no-such-route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: '{}',
    })
    expect(sync.status).toBe(unknown.status)
    const bundle = await fetch(`${url}/api/node/bundle/default`)
    const unknownGet = await fetch(`${url}/api/no-such-route`)
    expect(bundle.status).toBe(unknownGet.status)
    // Nor the secrets' route (#604).
    const secrets = await fetch(`${url}/api/node/bundle/default/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: '{}',
    })
    expect(secrets.status).toBe(unknown.status)
    const state = readdirSync(stateFolder(box))
    expect(state.filter(n => n === 'node' || n === 'nodes')).toEqual([])
  })
})
