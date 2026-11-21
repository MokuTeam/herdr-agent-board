// The owner's git identity and GitHub login between running boards (#609): a master and its node as
// sandbox boards (test/support/node-pair.ts) with the fake gh and git (test/support/fake-gh.ts,
// fake-git.ts), each keeping its state in its own sandbox's home. With the device's secrets switch on
// (the default) one sync sets the node's identity and logs its gh in with the master's token, the
// node's status then says so, `board nodes sync` names both, and a revoke takes them out again. With
// it off the identity still goes and no login is asked for. A node without gh keeps the login in
// git's own store and the device's row says it cannot open pull requests. A node set up by hand with
// the same login and identity is taken over with no second login. The token crosses the secrets
// request alone: no other request, log, record, audit or argument of either fake holds it. Without
// `nodes` and `node` neither fake is ever run.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ghConfigDir } from '../../src/adapters/git-access.ts'
import { gitLacks } from '../../src/core/git-access.ts'
import type { DeviceView } from '../../src/core/nodes.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeGitBins, fakeGitHome, NO_PROGRAM } from '../support/fake-git-bin.ts'
import { nodePair, PAIR_ENV, type Pair, type PairNode } from '../support/node-pair.ts'
import { type ChildResult, type Sandbox, sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const CANARY = 'gho_canaryNodeGitBoard0123456789AB'
const OWNER = { 'user.name': ['Owner Name'], 'user.email': ['owner@example.com'] }

const homeOf = (box: Sandbox) => {
  const home = box.env.HOME as string
  return fakeGitHome(home, ghConfigDir({ env: box.env, platform: process.platform, home }))
}
const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
const post = (url: string, body: unknown): Promise<Response> =>
  fetch(`${url}/api/nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })

/** A profile folder to send: the master's ~/.claude with its CLAUDE.md. */
function profile(box: Sandbox): void {
  const dir = join(box.env.HOME as string, '.claude')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), 'rules')
}

/** The master's owner: a profile, a global identity and gh logged in to github.com. */
function owner(box: Sandbox): void {
  profile(box)
  const h = homeOf(box)
  h.seedGit(OWNER)
  h.seedGh({ 'github.com': { user: 'owner', token: CANARY } })
}

/** config.json on the master's disk, which `board nodes sync` reads for the port and a revoke writes into. */
function masterOnDisk(pair: Pair, node: PairNode, device: Record<string, unknown> = {}): void {
  mkdirSync(dirname(configPath(pair.master.box)), { recursive: true })
  writeFileSync(
    configPath(pair.master.box),
    JSON.stringify({
      language: 'en',
      wakeUrl: '',
      port: Number(new URL(pair.master.url).port),
      nodes: {
        id: 'laptop',
        devices: { 'server-1': { link: { kind: 'direct', url: `http://127.0.0.1:${node.proxy.port}` }, ...device } },
      },
    }),
  )
}

function files(dir: string): string[] {
  const out: string[] = []
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
        else out.push(full)
      } catch {}
    }
  }
  walk(dir)
  return out
}

/** Nothing but the secrets request, gh's own keyring and git's own store holds the token. */
function tokenOnlyWhereItBelongs(pair: Pair, node: PairNode): void {
  for (const req of node.proxy.received)
    if (!req.request.endsWith('/secrets')) expect(`${req.request} ${req.body}`).not.toContain(CANARY)
  for (const proc of [pair.master.proc, node.proc]) expect(JSON.stringify(proc.messages)).not.toContain(CANARY)
  for (const box of [pair.master.box, node.box]) {
    for (const f of files(stateFolder(box))) expect(readFileSync(f, 'latin1')).not.toContain(CANARY)
    for (const log of homeOf(box).logs()) expect(log).not.toContain(CANARY)
  }
}

async function sync(pair: Pair) {
  const res = await post(pair.master.url, { op: 'sync', id: 'server-1' })
  return (await res.json()) as {
    ok: boolean
    secrets?: Record<string, unknown>
    lines: { kind: string; name: string; verdict: string; why: string }[]
  }
}

const nodesSync = async (pair: Pair): Promise<string[]> => {
  const cli: ChildResult = await pair.master.box.run('cli', { args: ['nodes', 'sync', 'server-1'], env: {} }).exited
  expect(cli.stdout).not.toContain(CANARY)
  return cli.stdout.trim().split('\n')
}

describe("the owner's git identity and GitHub login on a node (#609)", () => {
  test('secrets on: identity and login after one sync, the status and board nodes sync say so, a revoke takes them out', async () => {
    const { env } = await fakeGitBins()
    const pair = await nodePair({ env, masterSetup: owner })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
    // Before: the node has git and gh, and neither an identity nor a login.
    const before = await pair.waitDevice('server-1', d => d.status?.git !== undefined, 5000)
    expect(gitLacks(before.status)).toEqual(['identity', 'login'])

    const r = await sync(pair)
    expect(r.ok).toBe(true)
    expect(r.secrets?.logins).toEqual([{ host: 'github.com', user: 'owner', via: 'gh' }])
    expect(r.lines).toContainEqual({ kind: 'git', name: 'identity', verdict: 'sent', why: 'identity' })
    const there = homeOf(node.box)
    expect(there.gh().hosts['github.com']).toEqual({ user: 'owner', token: CANARY })
    expect(there.gh().setupGit).toEqual(['github.com'])
    expect(there.git().config).toMatchObject(OWNER)
    expect(there.ghCalls().find(c => c.argv[1] === 'login')?.stdin).toBe(true)

    // The status, looked again after the secrets request: nothing lacking any more.
    const after = await pair.waitDevice(
      'server-1',
      d => d.status?.git?.identity === true && d.status.git.logins.length > 0,
      5000,
    )
    expect(after.status?.git).toEqual({ identity: true, logins: [{ host: 'github.com', user: 'owner' }] })
    expect(after.status?.programs).toEqual(expect.arrayContaining(['git', 'gh']))
    expect(gitLacks(after.status)).toEqual([])

    masterOnDisk(pair, node)
    const out = await nodesSync(pair)
    expect(out).toContain('GitHub login given: github.com (owner)')
    expect(out).toContain('git identity given')
    // The second sync gave the same token: no second login.
    expect(there.ghCalls().filter(c => c.argv[1] === 'login').length).toBe(1)
    tokenOnlyWhereItBelongs(pair, node)

    // Revoke: the node logs out of what the master gave and takes its identity out.
    const res = await post(pair.master.url, { op: 'revoke', id: 'server-1' })
    expect(((await res.json()) as { told: boolean }).told).toBe(true)
    expect(there.gh().hosts).toEqual({})
    expect(there.git().config['user.name']).toBeUndefined()
    expect(existsSync(join(stateFolder(node.box), 'node', 'git-access.json'))).toBe(false)
  }, 90_000)

  test('secrets off: the identity goes, no login is asked for, and the row says agents there cannot push', async () => {
    const { env } = await fakeGitBins()
    const pair = await nodePair({ env, masterSetup: owner, deviceCfg: () => ({ giveSecrets: false }) })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
    const r = await sync(pair)
    expect(r.ok).toBe(true)
    expect('secrets' in r).toBe(false)
    expect(node.proxy.requests.some(p => p.endsWith('/secrets'))).toBe(false)
    expect(
      homeOf(pair.master.box)
        .ghCalls()
        .some(c => c.argv[1] === 'token'),
    ).toBe(false)
    expect(homeOf(node.box).git().config).toMatchObject(OWNER)
    expect(homeOf(node.box).gh().hosts).toEqual({})
    const view: DeviceView = await pair.waitDevice('server-1', d => d.status?.git?.identity === true, 5000)
    expect(gitLacks(view.status)).toEqual(['login'])
    tokenOnlyWhereItBelongs(pair, node)
  }, 90_000)

  test("a node without gh: git's own store, the report and the row say pull requests need gh there", async () => {
    const { env } = await fakeGitBins()
    const pair = await nodePair({ env, masterSetup: owner, nodeEnv: () => ({ BOARD_GH_BIN_PATH: NO_PROGRAM }) })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
    const r = await sync(pair)
    expect(r.secrets?.logins).toEqual([{ host: 'github.com', user: 'owner', via: 'store' }])
    expect(r.secrets?.gh).toBe(false)
    expect(homeOf(node.box).git().store).toEqual([{ host: 'github.com', username: 'owner', password: CANARY }])
    const view = await pair.waitDevice(
      'server-1',
      d => (d.status?.git?.logins.length ?? 0) > 0 && d.status?.git?.identity === true,
      5000,
    )
    expect(view.status?.programs).not.toContain('gh')
    expect(gitLacks(view.status)).toEqual(['gh'])
    masterOnDisk(pair, node)
    expect(await nodesSync(pair)).toContain(
      "GitHub login given: github.com (owner), in git's own store: pushes work, pull requests need gh there",
    )
  }, 90_000)

  test('a node set up by hand with the same login and identity: taken over, no second login, nothing set', async () => {
    const { env } = await fakeGitBins()
    const pair = await nodePair({ env, masterSetup: owner, nodeSetup: (_id, box) => owner(box) })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
    const r = await sync(pair)
    expect(r.secrets?.logins).toEqual([{ host: 'github.com', user: 'owner', via: 'gh' }])
    const there = homeOf(node.box)
    expect(there.ghCalls().some(c => c.argv[1] === 'login')).toBe(false)
    expect(there.gitCalls().some(c => c.argv.includes('user.name') && !c.argv.includes('--get'))).toBe(false)
    const record = JSON.parse(readFileSync(join(stateFolder(node.box), 'node', 'git-access.json'), 'utf8'))
    expect([record.identity?.name, record.logins.map((l: { host: string }) => l.host)]).toEqual([
      'Owner Name',
      ['github.com'],
    ])
  }, 90_000)

  test('board node leave on the node takes out what the master gave, alone', async () => {
    const { env } = await fakeGitBins()
    // The node's config.json on its disk, which the command reads: the board runs on the test's.
    const pair = await nodePair({
      env,
      masterSetup: owner,
      nodeSetup: (id, box) => {
        mkdirSync(dirname(configPath(box)), { recursive: true })
        writeFileSync(configPath(box), JSON.stringify({ language: 'en', wakeUrl: '', port: 9, node: { id, port: 1 } }))
      },
    })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
    expect((await sync(pair)).ok).toBe(true)
    const r = await node.box.run('cli', { args: ['node', 'leave'], env }).exited
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('taken out what it gave: the GitHub login for github.com; the git identity')
    const there = homeOf(node.box)
    expect(there.gh().hosts).toEqual({})
    expect(there.git().config['user.name']).toBeUndefined()
  }, 90_000)

  test('no gh and no identity on the master: board nodes sync says there was none to give', async () => {
    const { env } = await fakeGitBins()
    const pair = await nodePair({ env, masterSetup: profile, masterEnv: { BOARD_GH_BIN_PATH: NO_PROGRAM } })
    const node = pair.nodes[0] as PairNode
    await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
    masterOnDisk(pair, node)
    const out = await nodesSync(pair)
    expect(out).toContain('no GitHub login to give: gh is not on this computer')
    expect(out).toContain(
      "no git identity to give: this computer has no global user.name and user.email, and the node's commits carry its own",
    )
    expect(node.proxy.requests.some(p => p.endsWith('/secrets'))).toBe(false)
  }, 90_000)
})

describe('without nodes and node', () => {
  test('a board runs neither gh nor git for this, and keeps no record of it', async () => {
    const { env } = await fakeGitBins()
    const box = await sandbox()
    const { url } = await serveBoard(box, { language: 'en' }, { ...PAIR_ENV, ...env })
    const res = await fetch(`${url}/api/board`)
    expect(res.ok).toBe(true)
    await Bun.sleep(500)
    const h = homeOf(box)
    expect([h.ghCalls(), h.gitCalls()]).toEqual([[], []])
    expect(existsSync(join(stateFolder(box), 'node'))).toBe(false)
  }, 60_000)
})
