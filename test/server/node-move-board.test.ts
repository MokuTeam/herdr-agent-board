// A session moved to another device and back (#616, `board move --device`): a master and its node as
// sandbox boards (test/support/node-pair.ts), each with its fake herdr, and a real git remote reached
// over a fake ssh (a script that runs git's own upload-pack against a bare repository of the test),
// so the checkout's address is the plain `example.com/anna/atlas` a node names its clone by. The
// session sleeps on the master in a clean pushed checkout of branch feature-x. `board move` takes it
// to server-1: the node clones the repository, makes a worktree for the branch, takes the
// conversation (transcript, side folder, file history) into its profile under the new folder and
// resumes it there; its reminder goes with it; the master's card is marked moved and leaves the
// board. Then POST /api/move takes it back: the master's own checkout is fetched and the session
// resumed in it, the node's card marked moved in turn. A checkout with changes is refused first,
// with the reason, and nothing is put to sleep, copied or started.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { Item } from '../../src/core/types.ts'
import { nodePair, type Pair } from '../support/node-pair.ts'
import type { Sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const URL_ = 'ssh://git@example.com/anna/atlas.git'
const scratch = mkdtempSync(join(tmpdir(), 'board-move-git-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** git's ssh for every board and for this test: the command git asks the remote to run, run here on the bare repositories. */
const SSH = join(scratch, 'fake-ssh.sh')
writeFileSync(
  SSH,
  [
    '#!/bin/sh',
    'for last; do :; done',
    `cmd=$(printf '%s' "$last" | sed "s#'/#'$FAKE_GIT_ROOT/#")`,
    'exec sh -c "$cmd"',
    '',
  ].join('\n'),
)
/** The boards' PATH: Bun as the sandbox has it, and git, sh and sed for the clone over the fake ssh. */
const PATH = [
  ...new Set([process.execPath, ...['git', 'sh', 'sed'].map(p => Bun.which(p) as string)].map(p => dirname(p))),
].join(delimiter)
const GIT_ENV = {
  PATH,
  GIT_SSH_COMMAND: `sh '${SSH.replace(/\\/g, '/')}'`,
  FAKE_GIT_ROOT: join(scratch, 'remote').replace(/\\/g, '/'),
  GIT_AUTHOR_NAME: 'Anna',
  GIT_AUTHOR_EMAIL: 'anna@example.com',
  GIT_COMMITTER_NAME: 'Anna',
  GIT_COMMITTER_EMAIL: 'anna@example.com',
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...GIT_ENV } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

// The remote: anna/atlas with main and feature-x, which has a web/ folder.
const bare = join(scratch, 'remote', 'anna', 'atlas.git')
mkdirSync(bare, { recursive: true })
git(bare, 'init', '--bare', '--quiet', '-b', 'main')
const seed = join(scratch, 'seed')
mkdirSync(join(seed, 'web'), { recursive: true })
git(seed, 'init', '--quiet', '-b', 'main')
writeFileSync(join(seed, 'README.md'), 'atlas\n')
writeFileSync(join(seed, '.gitignore'), 'node_modules/\n')
git(seed, 'add', '.')
git(seed, 'commit', '--quiet', '-m', 'first')
git(seed, 'checkout', '--quiet', '-b', 'feature-x')
writeFileSync(join(seed, 'web', 'index.ts'), 'export {}\n')
git(seed, 'add', '.')
git(seed, 'commit', '--quiet', '-m', 'web')
git(seed, 'remote', 'add', 'origin', URL_)
git(seed, 'push', '--quiet', 'origin', 'main', 'feature-x')

const home = (box: Sandbox): string => box.env.HOME as string
const projectDir = (box: Sandbox, cwd: string): string =>
  join(home(box), '.claude', 'projects', cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-'))
const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
const entryFile = (box: Sandbox, id: string): string => join(stateFolder(box), 'schedule', `${id}.json`)
const cardOf = (box: Sandbox): Record<string, unknown> => JSON.parse(readFileSync(join(box.cards, `${S}.json`), 'utf8'))
const calls = (box: Sandbox): string[] => box.calls().map(a => a.join(' '))

/** A fake herdr-wake that lists S asleep, its pane closed, while `asleep()` says so. */
async function fakeWake(cwd: () => string, asleep: () => boolean): Promise<{ url: string; close(): void }> {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const s = {
      session: S,
      pane: '',
      name: 'Atlas',
      workspace: 'Personal',
      cwd: cwd(),
      slept_at: new Date().toISOString(),
    }
    res.end(JSON.stringify(req.url?.startsWith('/sleeping') ? (asleep() ? [s] : []) : {}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

/** herdr ready to resume S in a new tab of workspace wP "Personal", where Claude comes up idle in wP:p9. */
function resumable(box: Sandbox, cwd: string): void {
  const fresh = {
    pane_id: 'wP:p9',
    tab_id: 'wP:t9',
    workspace_id: 'wP',
    agent: 'claude',
    agent_session: { value: S },
    agent_status: 'idle',
    cwd,
  }
  const shell = { pane_id: 'wP:p9', tab_id: 'wP:t9', workspace_id: 'wP', terminal_id: 'term-9', cwd }
  const workspaces = [{ workspace_id: 'wP', label: 'Personal' }]
  box.state({
    'api snapshot': { result: { snapshot: { panes: [shell], tabs: [], workspaces } } },
    'workspace list': { result: { workspaces } },
    'tab create': { result: { tab: { tab_id: 'wP:t9' }, root_pane: { pane_id: 'wP:p9', terminal_id: 'term-9' } } },
    'pane run': { result: null },
    'pane get': { seq: [{ result: { pane: { ...fresh, agent: null } } }, { result: { pane: fresh } }] },
    'pane list': { result: { panes: [shell] } },
    'agent list': { result: { agents: [] } },
    'agent rename': { result: null },
    'agent get': { result: { agent: null } },
  })
}

/** `ok` comes true within 10 s, `poke` (a refresh asked of a board) before each look. */
async function waitFor(ok: () => Promise<boolean>, poke: () => void): Promise<void> {
  for (const end = Date.now() + 10_000; ; ) {
    poke()
    if (await ok()) return
    if (Date.now() > end) throw new Error('never came to that')
    await Bun.sleep(100)
  }
}

const post = async (url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${url}/api/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const items = async (url: string): Promise<Item[]> =>
  ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items

/** The master's checkout of feature-x, S's conversation run in it, its card, and a reminder. */
function masterSession(box: Sandbox): string {
  const cwd = join(box.dir, 'atlas')
  git(box.dir, 'clone', '--quiet', URL_, cwd)
  git(cwd, 'checkout', '--quiet', 'feature-x')
  // It runs in web/ of the checkout: the folder below travels with it.
  const projects = projectDir(box, join(cwd, 'web'))
  mkdirSync(join(projects, S, 'subagents'), { recursive: true })
  const line = {
    type: 'user',
    cwd: join(cwd, 'web'),
    sessionId: S,
    message: { role: 'user', content: 'build the map' },
  }
  writeFileSync(join(projects, `${S}.jsonl`), `${JSON.stringify(line)}\n`)
  writeFileSync(join(projects, S, 'subagents', 'agent-1.jsonl'), '{"sub":1}\n')
  mkdirSync(join(home(box), '.claude', 'file-history', S), { recursive: true })
  writeFileSync(join(home(box), '.claude', 'file-history', S, 'f1@v1'), 'old text\n')
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${S}.json`), JSON.stringify({ key: S, name: 'Atlas', category: 'other' }))
  const entry = {
    id: 'abc123',
    key: S,
    text: 'check the map',
    next: Date.now() + 86_400_000,
    name: 'Atlas',
    by: 'agent',
  }
  mkdirSync(dirname(entryFile(box, 'abc123')), { recursive: true })
  writeFileSync(entryFile(box, 'abc123'), JSON.stringify(entry))
  return cwd
}

async function pairWithSession(): Promise<{
  pair: Pair
  cwd: string
  nodeAsleep: (on: boolean) => void
  close(): void
}> {
  let masterCwd = ''
  let nodeCwd = ''
  let onNode = false
  const masterWake = await fakeWake(
    () => join(masterCwd, 'web'),
    () => true,
  )
  const nodeWake = await fakeWake(
    () => nodeCwd,
    () => onNode,
  )
  const pair = await nodePair({
    env: GIT_ENV,
    masterSetup: box => {
      masterCwd = masterSession(box)
    },
    masterCfg: { wakeUrl: masterWake.url },
    masterPanes: () => [],
    nodeCfg: () => ({ wakeUrl: nodeWake.url }),
    nodeSetup: (_id, box) => {
      mkdirSync(join(home(box), '.claude'), { recursive: true })
      writeFileSync(join(home(box), '.claude', '.credentials.json'), '{}')
    },
    masterEnv: { BOARD_MOVE_START_WAIT_MS: '20000' },
  })
  nodeCwd = join(pair.nodes[0]?.box.dir ?? '', 'example.com', 'anna', 'atlas-feature-x', 'web')
  return {
    pair,
    cwd: masterCwd,
    nodeAsleep: on => {
      onNode = on
    },
    close: () => {
      masterWake.close()
      nodeWake.close()
    },
  }
}

test('board move --device takes a sleeping session in a clean pushed checkout to the node, and POST /api/move brings it back', async () => {
  const { pair, cwd, nodeAsleep, close } = await pairWithSession()
  try {
    const node = pair.nodes[0]
    if (!node) throw new Error('no node')
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 10_000)
    const sub = join(cwd, 'web')
    const nodeWorktree = join(node.box.dir, 'example.com', 'anna', 'atlas-feature-x')
    resumable(node.box, join(nodeWorktree, 'web'))
    // config.json on the master's disk: `board move` reads its port there.
    mkdirSync(dirname(configPath(pair.master.box)), { recursive: true })
    writeFileSync(
      configPath(pair.master.box),
      JSON.stringify({ ...pair.masterConfig, port: Number(new URL(pair.master.url).port) }),
    )
    expect((await items(pair.master.url)).find(i => i.key === S)?.sleeping).toBe(true)

    const cli = await pair.master.box.run('cli', { args: ['move', S, '--device', 'server-1'], env: {} }).exited
    expect(cli.stdout).toContain('ok · 1 moved to server-1')
    expect(cli.stdout).toContain(`Atlas: moved to server-1 (@server-1:${S})`)
    expect(cli.stdout).toContain('1 schedule entry moved')

    // On the node: the clone, a worktree on feature-x, the conversation under the new folder, resumed there.
    expect(git(nodeWorktree, 'symbolic-ref', '--short', 'HEAD')).toBe('feature-x')
    const nodeProjects = projectDir(node.box, join(nodeWorktree, 'web'))
    expect(readFileSync(join(nodeProjects, `${S}.jsonl`), 'utf8')).toContain('build the map')
    expect(readFileSync(join(nodeProjects, S, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{"sub":1}\n')
    expect(readFileSync(join(home(node.box), '.claude', 'file-history', S, 'f1@v1'), 'utf8')).toBe('old text\n')
    expect(calls(node.box)).toContain(
      `tab create --workspace wP --cwd ${join(nodeWorktree, 'web')} --label Atlas --no-focus`,
    )
    expect(calls(node.box).some(c => c.startsWith('pane run wP:p9') && c.endsWith(`--resume ${S}`))).toBe(true)
    // Its reminder went with it; the master's card is marked and leaves the board.
    expect(existsSync(entryFile(pair.master.box, 'abc123'))).toBe(false)
    expect(JSON.parse(readFileSync(entryFile(node.box, 'abc123'), 'utf8'))).toMatchObject({
      key: S,
      text: 'check the map',
    })
    expect(cardOf(pair.master.box).moved).toMatchObject({ to: 'server-1', cwd: sub })
    expect(cardOf(node.box)).toMatchObject({ name: 'Atlas', category: 'other' })
    await waitFor(
      async () => !(await items(pair.master.url)).some(i => i.key === S),
      () => pair.master.proc.send('refresh'),
    )

    // Back: asleep on the node, it comes to the master's own checkout.
    nodeAsleep(true)
    await waitFor(
      async () => (await items(pair.master.url)).some(i => i.key === `@server-1:${S}` && i.sleeping),
      () => node.proc.send('refresh'),
    )
    resumable(pair.master.box, sub)
    const back = await post(pair.master.url, { targets: [`@server-1:${S}`], device: 'local' })
    expect(back.status).toBe(200)
    const r = (back.body.results as Record<string, unknown>[])[0]
    expect(r).toMatchObject({ result: 'moved', newKey: S, from: 'server-1', to: 'local' })
    expect(calls(pair.master.box).some(c => c.startsWith('pane run wP:p9') && c.endsWith(`--resume ${S}`))).toBe(true)
    expect(cardOf(pair.master.box).moved).toBeUndefined()
    expect(cardOf(node.box).moved).toMatchObject({ to: 'laptop' })
    expect(existsSync(entryFile(node.box, 'abc123'))).toBe(false)
    expect(JSON.parse(readFileSync(entryFile(pair.master.box, 'abc123'), 'utf8'))).toMatchObject({ key: S })
  } finally {
    close()
  }
}, 90_000)

test('a branch not pushed is refused with the reason: nothing put to sleep, copied or started', async () => {
  const { pair, cwd, close } = await pairWithSession()
  try {
    const node = pair.nodes[0]
    if (!node) throw new Error('no node')
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 10_000)
    git(cwd, 'commit', '--quiet', '--allow-empty', '-m', 'local only')
    const r = await post(pair.master.url, { targets: [S], device: 'server-1' })
    expect(r.status).toBe(200)
    expect((r.body.results as Record<string, unknown>[])[0]).toMatchObject({
      result: 'refused',
      why: 'its branch feature-x is not pushed: push it first',
    })
    expect(node.proxy.requests.some(p => p.includes('/api/node/move/'))).toBe(false)
    expect(existsSync(join(node.box.dir, 'example.com'))).toBe(false)
    expect(cardOf(pair.master.box).moved).toBeUndefined()
    expect(existsSync(entryFile(pair.master.box, 'abc123'))).toBe(true)
    // A device the master does not have, and this computer for a session already here.
    const none = await post(pair.master.url, { targets: [S], device: 'server-9' })
    expect((none.body.results as Record<string, unknown>[])[0]?.why).toContain('no device server-9')
    // A board without devices (the node's own) takes no move to a device, whatever is asked.
    const fromNode = await post(node.url, { targets: [S], device: 'local' })
    expect([fromNode.status, fromNode.body.error]).toEqual([
      409,
      'a move to another device is made from the master: this board has no devices',
    ])
    const here = await post(pair.master.url, { targets: [S], device: 'local' })
    expect((here.body.results as Record<string, unknown>[])[0]?.why).toBe('it is on this computer already')
  } finally {
    close()
  }
}, 60_000)

test('uncommitted changes are listed first, go with the session, and come back; ignored files never travel', async () => {
  const { pair, cwd, nodeAsleep, close } = await pairWithSession()
  try {
    const node = pair.nodes[0]
    if (!node) throw new Error('no node')
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 10_000)
    const sub = join(cwd, 'web')
    // Changed, untracked, deleted; and an ignored folder that must stay here.
    writeFileSync(join(cwd, 'README.md'), 'atlas, changed\n')
    mkdirSync(join(cwd, 'notes'), { recursive: true })
    writeFileSync(join(cwd, 'notes', 'todo.md'), 'draw the map\n')
    rmSync(join(cwd, '.gitignore'))
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n')
    git(cwd, 'rm', '--quiet', '--cached', 'web/index.ts')
    rmSync(join(cwd, 'web', 'index.ts'))
    mkdirSync(join(cwd, 'node_modules', 'left'), { recursive: true })
    writeFileSync(join(cwd, 'node_modules', 'left', 'index.js'), 'big\n')
    mkdirSync(dirname(configPath(pair.master.box)), { recursive: true })
    writeFileSync(
      configPath(pair.master.box),
      JSON.stringify({ ...pair.masterConfig, port: Number(new URL(pair.master.url).port) }),
    )

    const dry = await pair.master.box.run('cli', { args: ['move', S, '--device', 'server-1', '--dry-run'], env: {} })
      .exited
    expect(dry.stdout).toContain('with 3 uncommitted change(s):')
    expect(dry.stdout).toContain('README.md (1 KB)')
    expect(dry.stdout).toContain('notes/todo.md (1 KB)')
    expect(dry.stdout).toContain('web/index.ts (deleted)')
    expect(dry.stdout).not.toContain('node_modules')
    // Nothing moved, and nothing was made on the node: the card and the reminder are where they were.
    expect(existsSync(join(node.box.dir, 'example.com'))).toBe(false)
    expect(cardOf(pair.master.box).moved).toBeUndefined()
    expect(existsSync(entryFile(pair.master.box, 'abc123'))).toBe(true)

    const nodeWorktree = join(node.box.dir, 'example.com', 'anna', 'atlas-feature-x')
    resumable(node.box, join(nodeWorktree, 'web'))
    const go = await post(pair.master.url, { targets: [S], device: 'server-1' })
    expect((go.body.results as Record<string, unknown>[])[0]).toMatchObject({ result: 'moved' })
    expect(readFileSync(join(nodeWorktree, 'README.md'), 'utf8')).toBe('atlas, changed\n')
    expect(readFileSync(join(nodeWorktree, 'notes', 'todo.md'), 'utf8')).toBe('draw the map\n')
    expect(existsSync(join(nodeWorktree, 'web', 'index.ts'))).toBe(false)
    expect(existsSync(join(nodeWorktree, 'node_modules'))).toBe(false)
    // The changes stay here too, and the card remembers them.
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('atlas, changed\n')
    expect(Object.keys((cardOf(pair.master.box).moved as { changes: object }).changes).sort()).toEqual([
      'README.md',
      'notes/todo.md',
      'web/index.ts',
    ])

    // The session works on there: it writes the note further.
    writeFileSync(join(nodeWorktree, 'notes', 'todo.md'), 'draw the map\nname the hills\n')
    nodeAsleep(true)
    await waitFor(
      async () => (await items(pair.master.url)).some(i => i.key === `@server-1:${S}` && i.sleeping),
      () => node.proc.send('refresh'),
    )
    resumable(pair.master.box, sub)
    // Changed here meanwhile: that edit is this checkout's own, so the move back is refused.
    writeFileSync(join(cwd, 'README.md'), 'atlas, edited here\n')
    const refused = await post(pair.master.url, { targets: [`@server-1:${S}`], device: 'local' })
    expect((refused.body.results as Record<string, unknown>[])[0]?.why).toBe(
      `${cwd} has changes of its own (README.md)`,
    )
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('atlas, edited here\n')
    // As it was when the session left: the move back takes those changes as its own.
    writeFileSync(join(cwd, 'README.md'), 'atlas, changed\n')
    const back = await post(pair.master.url, { targets: [`@server-1:${S}`], device: 'local' })
    expect((back.body.results as Record<string, unknown>[])[0]).toMatchObject({ result: 'moved', newKey: S })
    expect(readFileSync(join(cwd, 'notes', 'todo.md'), 'utf8')).toBe('draw the map\nname the hills\n')
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('atlas, changed\n')
    expect(existsSync(join(cwd, 'web', 'index.ts'))).toBe(false)
    expect(existsSync(join(cwd, 'node_modules', 'left', 'index.js'))).toBe(true)
  } finally {
    close()
  }
}, 90_000)

test('the session commits and pushes there: the move back takes the commit, and the changes it left here go', async () => {
  const { pair, cwd, nodeAsleep, close } = await pairWithSession()
  try {
    const node = pair.nodes[0]
    if (!node) throw new Error('no node')
    await pair.waitDevice('server-1', d => d.link?.state === 'online', 10_000)
    const sub = join(cwd, 'web')
    writeFileSync(join(cwd, 'README.md'), 'atlas, changed\n')
    writeFileSync(join(cwd, 'notes.md'), 'a note\n')
    const nodeWorktree = join(node.box.dir, 'example.com', 'anna', 'atlas-feature-x')
    resumable(node.box, join(nodeWorktree, 'web'))
    const go = await post(pair.master.url, { targets: [S], device: 'server-1' })
    expect((go.body.results as Record<string, unknown>[])[0]).toMatchObject({ result: 'moved' })
    // There, the session commits what it brought and pushes it.
    git(nodeWorktree, 'add', '-A')
    git(nodeWorktree, 'commit', '--quiet', '-m', 'the changes, committed')
    git(nodeWorktree, 'push', '--quiet', 'origin', 'feature-x')
    nodeAsleep(true)
    await waitFor(
      async () => (await items(pair.master.url)).some(i => i.key === `@server-1:${S}` && i.sleeping),
      () => node.proc.send('refresh'),
    )
    resumable(pair.master.box, sub)
    const back = await post(pair.master.url, { targets: [`@server-1:${S}`], device: 'local' })
    expect((back.body.results as Record<string, unknown>[])[0]).toMatchObject({ result: 'moved', newKey: S })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(nodeWorktree, 'rev-parse', 'HEAD'))
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(cwd, 'notes.md'), 'utf8')).toBe('a note\n')
  } finally {
    close()
  }
}, 90_000)
