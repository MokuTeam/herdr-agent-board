// The owner's git identity and GitHub login on a node (services/node/git-access.ts, #609), with the
// fake gh and git (test/support/fake-gh.ts, fake-git.ts) in a home of the test's own: the identity
// set unless the node's owner set another, a login taken by gh with the token on stdin or by git's
// store where there is no gh, one already there taken over with no second login, a token that did not
// change not given again, and leaving takes out exactly what was given. The token is in no argument,
// record, audit or log line.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitTools } from '../../src/adapters/git-access.ts'
import { createNodeGit } from '../../src/services/node/git-access.ts'
import { fakeGitBins, fakeGitHome } from '../support/fake-git-bin.ts'

const CANARY = 'gho_canaryNodeGitAccess0123456789'
const OTHER = 'gho_ownersOwnTokenOnTheNode987654'
const OWNER = { name: 'Owner Name', email: 'owner@example.com' }

async function rig(o: { gh?: boolean; budgetMs?: number } = {}) {
  const { env } = await fakeGitBins()
  const home = mkdtempSync(join(tmpdir(), 'node-git-'))
  const ghDir = join(home, 'gh-config')
  const tools: GitTools = {
    git: env.BOARD_GIT_BIN_PATH as string,
    gh: o.gh === false ? null : (env.BOARD_GH_BIN_PATH as string),
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      GH_CONFIG_DIR: ghDir,
    },
    platform: process.platform,
    home,
  }
  const audit: Record<string, unknown>[] = []
  const logs: string[] = []
  const state = join(home, 'state', 'node')
  const git = createNodeGit({
    dir: state,
    tools,
    audit: l => audit.push(l),
    log: t => logs.push(t),
    ...(o.budgetMs !== undefined && { loginBudgetMs: o.budgetMs }),
  })
  const fakes = fakeGitHome(home, ghDir)
  const record = (): string => {
    const f = join(state, 'git-access.json')
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }
  /** Nothing the board keeps or says holds the token: the record, the audit, the log, the fakes' argv. */
  const clean = (): void => {
    for (const said of [record(), JSON.stringify(audit), logs.join('\n'), ...fakes.logs()])
      expect(said).not.toContain(CANARY)
  }
  return { git, fakes, home, state, audit, logs, record, clean }
}

const login = (token = CANARY, host = 'github.com', user = 'owner') => [{ host, user, token }]

describe('the identity (#609)', () => {
  test('none on the node: set, recorded; the same again runs no set', async () => {
    const r = await rig()
    expect(await r.git.identity(OWNER, 'm1')).toBe('set')
    expect(r.fakes.git().config).toEqual({ 'user.name': [OWNER.name], 'user.email': [OWNER.email] })
    expect(JSON.parse(r.record()).identity).toEqual({ ...OWNER, master: 'm1' })
    const sets = r.fakes.gitCalls().length
    expect(await r.git.identity(OWNER, 'm1')).toBe('same')
    expect(
      r.fakes
        .gitCalls()
        .slice(sets)
        .every(c => c.argv.includes('--get')),
    ).toBe(true)
  })

  test('the same set by hand: taken over with nothing set; another set by hand: kept; a change on the master follows what the bundle set', async () => {
    const r = await rig()
    r.fakes.seedGit({ 'user.name': [OWNER.name], 'user.email': [OWNER.email] })
    expect(await r.git.identity(OWNER, 'm1')).toBe('same')
    expect(r.fakes.gitCalls().some(c => c.argv.includes('user.name') && !c.argv.includes('--get'))).toBe(false)
    expect(JSON.parse(r.record()).identity.name).toBe(OWNER.name)
    // The master's owner renames himself: the node still has what the bundle set, so it follows.
    const renamed = { name: 'Owner Renamed', email: OWNER.email }
    expect(await r.git.identity(renamed, 'm1')).toBe('set')
    expect(r.fakes.git().config['user.name']).toEqual(['Owner Renamed'])
    // The node's owner sets his own by hand: kept from then on.
    r.fakes.seedGit({ 'user.name': ['Node Owner'], 'user.email': ['node@example.com'] })
    expect(await r.git.identity(OWNER, 'm1')).toBe('kept')
    expect(r.fakes.git().config['user.name']).toEqual(['Node Owner'])
  })

  test('no git on the node: nothing run, said', async () => {
    const r = await rig()
    const git = createNodeGit({
      dir: r.state,
      tools: { git: null, gh: null, env: {}, platform: process.platform, home: r.home },
      audit: () => {},
      log: () => {},
    })
    expect(await git.identity(OWNER, 'm1')).toBe('no-git')
    expect(git.programs()).toEqual([])
  })
})

describe('the GitHub login with gh (#609)', () => {
  test('taken by gh auth login with the token on stdin, then setup-git; recorded without the token', async () => {
    const r = await rig()
    const taken = await r.git.logins(login(), 'm1')
    expect(taken).toEqual({
      logins: [{ host: 'github.com', user: 'owner', via: 'gh' }],
      taken: ['github.com'],
      kept: [],
      refused: [],
      gh: true,
    })
    expect(r.fakes.gh().hosts['github.com']).toEqual({ user: 'owner', token: CANARY })
    const calls = r.fakes.ghCalls()
    const loginCall = calls.find(c => c.argv[1] === 'login')
    expect(loginCall).toEqual({
      argv: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'],
      stdin: true,
    })
    expect(calls.some(c => c.argv.join(' ') === 'auth setup-git --hostname github.com')).toBe(true)
    const rec = JSON.parse(r.record())
    expect(rec.logins).toEqual([
      { host: 'github.com', user: 'owner', sha: expect.stringMatching(/^[0-9a-f]{64}$/), via: 'gh', master: 'm1' },
    ])
    expect(r.audit).toEqual([{ op: 'git-login', master: 'm1', hosts: ['github.com'] }])
    if (process.platform !== 'win32') expect(statSync(join(r.state, 'git-access.json')).mode & 0o777).toBe(0o600)
    r.clean()
  })

  test('a token that did not change is not given again; a new one on the master replaces it', async () => {
    const r = await rig()
    await r.git.logins(login(), 'm1')
    const n = r.fakes.ghCalls().length
    const again = await r.git.logins(login(), 'm1')
    expect(again.taken).toEqual([])
    expect(
      r.fakes
        .ghCalls()
        .slice(n)
        .map(c => c.argv[1]),
    ).toEqual(['token'])
    const next = `${CANARY}Next`
    expect((await r.git.logins(login(next), 'm1')).taken).toEqual(['github.com'])
    expect(r.fakes.gh().hosts['github.com']?.token).toBe(next)
  })

  test('the node set up by hand with the same token: taken over, no second login', async () => {
    const r = await rig()
    r.fakes.seedGh({ 'github.com': { user: 'owner', token: CANARY } })
    const taken = await r.git.logins(login(), 'm1')
    expect([taken.taken, taken.logins]).toEqual([[], [{ host: 'github.com', user: 'owner', via: 'gh' }]])
    expect(r.fakes.ghCalls().some(c => c.argv[1] === 'login')).toBe(false)
    expect(JSON.parse(r.record()).logins[0].host).toBe('github.com')
  })

  test("another login of the node's owner there: kept and said", async () => {
    const r = await rig()
    r.fakes.seedGh({ 'github.com': { user: 'node-owner', token: OTHER } })
    const taken = await r.git.logins(login(), 'm1')
    expect([taken.taken, taken.kept]).toEqual([[], [{ host: 'github.com', why: 'not-owned' }]])
    expect(r.fakes.gh().hosts['github.com']?.token).toBe(OTHER)
    expect(r.record()).toBe('')
  })

  test('two hosts, and entries it will not take', async () => {
    const r = await rig()
    const taken = await r.git.logins(
      [
        ...login(),
        ...login(`${CANARY}Ghe`, 'ghe.example.com', 'worker'),
        { host: 'bad host', user: 'x', token: CANARY },
        { host: 'github.io', user: 'x', token: 'has space' },
      ],
      'm1',
    )
    expect(taken.taken).toEqual(['github.com', 'ghe.example.com'])
    expect(taken.refused).toEqual(['bad host', 'github.io'])
    expect(Object.keys(r.fakes.gh().hosts).sort()).toEqual(['ghe.example.com', 'github.com'])
  })

  test("the status's facts: looked once, again after a request", async () => {
    const r = await rig()
    expect(await r.git.facts()).toEqual({ identity: false, logins: [] })
    const n = r.fakes.gitCalls().length
    await r.git.facts()
    expect(r.fakes.gitCalls().length).toBe(n)
    await r.git.identity(OWNER, 'm1')
    await r.git.logins(login(), 'm1')
    expect(await r.git.facts()).toEqual({ identity: true, logins: [{ host: 'github.com', user: 'owner' }] })
    expect(r.git.programs()).toEqual(['git', 'gh'])
  })
})

describe('a node without gh (#609)', () => {
  test("git's own store for the host, the helper set for it; the same again is not stored again", async () => {
    const r = await rig({ gh: false })
    const taken = await r.git.logins(login(), 'm1')
    expect(taken).toEqual({
      logins: [{ host: 'github.com', user: 'owner', via: 'store' }],
      taken: ['github.com'],
      kept: [],
      refused: [],
      gh: false,
    })
    expect(r.fakes.git().store).toEqual([{ host: 'github.com', username: 'owner', password: CANARY }])
    expect(r.fakes.git().config['credential.https://github.com.helper']).toEqual(['store'])
    if (process.platform !== 'win32') expect(statSync(join(r.home, '.git-credentials')).mode & 0o777).toBe(0o600)
    const approve = r.fakes.gitCalls().find(c => c.argv.includes('approve'))
    expect(approve?.argv).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=store',
      'credential',
      'approve',
    ])
    expect(approve?.stdin).toBe(true)
    const n = r.fakes.gitCalls().length
    expect((await r.git.logins(login(), 'm1')).taken).toEqual([])
    expect(
      r.fakes
        .gitCalls()
        .slice(n)
        .some(c => c.argv.includes('approve')),
    ).toBe(false)
    expect(await r.git.facts()).toEqual({ identity: false, logins: [{ host: 'github.com', user: 'owner' }] })
    expect(r.git.programs()).toEqual(['git'])
    r.clean()
  })
})

describe('leaving takes out what was given (#609)', () => {
  test("gh logged out of the hosts it gave, the identity it set; an owner's change stays", async () => {
    const r = await rig()
    await r.git.identity(OWNER, 'm1')
    await r.git.logins([...login(), ...login(`${CANARY}Ghe`, 'ghe.example.com', 'worker')], 'm1')
    // The node's owner put his own token for one host since: that one stays.
    const state = r.fakes.gh()
    r.fakes.seedGh({ ...state.hosts, 'ghe.example.com': { user: 'worker', token: OTHER } })
    const out = await r.git.leave('m1')
    expect(out).toEqual({ identity: true, logins: ['github.com'] })
    expect(Object.keys(r.fakes.gh().hosts)).toEqual(['ghe.example.com'])
    expect(r.fakes.ghCalls().some(c => c.argv.join(' ') === 'auth logout --hostname github.com --user owner')).toBe(
      true,
    )
    expect(r.fakes.git().config['user.name']).toBeUndefined()
    expect(r.record()).toBe('')
    expect(r.audit.at(-1)).toEqual({ op: 'git-left', master: 'm1', hosts: ['github.com'], identity: true })
  })

  test('an identity the owner changed since stays; a store login goes with its helper; another master keeps its own', async () => {
    const r = await rig({ gh: false })
    await r.git.identity(OWNER, 'm1')
    await r.git.logins(login(), 'm1')
    await r.git.logins(login(`${CANARY}Two`, 'ghe.example.com', 'worker'), 'm2')
    r.fakes.seedGit(
      { ...r.fakes.git().config, 'user.name': ['Node Owner'], 'user.email': ['node@example.com'] },
      r.fakes.git().store,
    )
    const out = await r.git.leave('m1')
    expect(out).toEqual({ identity: false, logins: ['github.com'] })
    expect(r.fakes.git().store.map(s => s.host)).toEqual(['ghe.example.com'])
    expect(r.fakes.git().config['credential.https://github.com.helper']).toBeUndefined()
    expect(r.fakes.git().config['credential.https://ghe.example.com.helper']).toEqual(['store'])
    expect(r.fakes.git().config['user.name']).toEqual(['Node Owner'])
    expect(JSON.parse(r.record()).logins.map((l: { host: string }) => l.host)).toEqual(['ghe.example.com'])
  })
})

describe('what the review found (#609)', () => {
  test("a gh that cannot read its token (older than 2.17): the owner's login is kept; one the bundle gave is not given again", async () => {
    const r = await rig()
    r.fakes.seedGh({ 'github.com': { user: 'node-owner', token: OTHER } }, { fail: 'auth token' })
    const own = await r.git.logins(login(), 'm1')
    expect([own.taken, own.kept]).toEqual([[], [{ host: 'github.com', why: 'unreadable' }]])
    expect(r.fakes.gh().hosts['github.com']?.token).toBe(OTHER)

    const given = await rig()
    await given.git.logins(login(), 'm1')
    given.fakes.seedGh(given.fakes.gh().hosts, { fail: 'auth token' })
    const again = await given.git.logins(login(), 'm1')
    expect([again.taken, again.kept]).toEqual([[], []])
    expect(given.fakes.ghCalls().filter(c => c.argv[1] === 'login').length).toBe(1)
  })

  test('a host gh cannot reach: the request ends within its budget, and that host is not tried again for a while', async () => {
    const r = await rig({ budgetMs: 1500 })
    r.fakes.seedGh({}, { hang: 'auth login' })
    const at = Date.now()
    const first = await r.git.logins([...login(), ...login(`${CANARY}Ghe`, 'ghe.example.com', 'worker')], 'm1')
    expect(Date.now() - at).toBeLessThan(9000)
    expect(first.kept).toEqual([
      { host: 'github.com', why: 'gh' },
      { host: 'ghe.example.com', why: 'timeout' },
    ])
    const second = await r.git.logins(login(), 'm1')
    expect(second.kept).toEqual([{ host: 'github.com', why: 'failed-recently' }])
    expect(r.record()).toBe('')
  }, 30_000)

  test('a logout that fails on leave: said, and the login stays in the record for the next leave', async () => {
    const r = await rig()
    await r.git.logins(login(), 'm1')
    r.fakes.seedGh(r.fakes.gh().hosts, { fail: 'auth logout' })
    const out = await r.git.leave('m1')
    expect(out).toEqual({ identity: false, logins: [], failed: ['github.com'] })
    expect(JSON.parse(r.record()).logins.map((l: { host: string }) => l.host)).toEqual(['github.com'])
    r.fakes.seedGh(r.fakes.gh().hosts)
    expect(await r.git.leave('m1')).toEqual({ identity: false, logins: ['github.com'] })
    expect(r.record()).toBe('')
  })

  test('only user.name set by hand: kept, the email not filled in around it', async () => {
    const r = await rig()
    r.fakes.seedGit({ 'user.name': ['Node Owner'] })
    expect(await r.git.identity(OWNER, 'm1')).toBe('kept')
    expect(r.fakes.git().config).toEqual({ 'user.name': ['Node Owner'] })
  })
})
