// A start by a repository's address on a computer that already has a checkout of it (#816,
// docs/design/nodes 6.4, 8.4): services/node/launch.ts with its launch pipeline stood in for, the
// real git against a local bare repository as the remote (git's url.<base>.insteadOf points the
// https address at it). The owner's checkout is used as it is only when clean on the branch asked
// for; anything else gets a worktree of its own outside it, and the checkout is left as it was.
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProjects, knownFolders } from '../../src/adapters/known-folders.ts'
import { checkoutOrigin } from '../../src/adapters/node-repo.ts'
import { type NodeConfig, nodeConfig, nodeProblems } from '../../src/core/nodes.ts'
import { profileSet } from '../../src/core/profiles.ts'
import type { StartResult } from '../../src/services/launch/launches.ts'
import { folderName } from '../../src/services/node/checkout.ts'
import { createNodeLaunch, type NodeLaunchDeps } from '../../src/services/node/launch.ts'

const ID = '5d0c6a1e-1111-4222-8333-444455556666'
const ids = (n: number): string => `5d0c6a1e-1111-4222-8333-${String(n).padStart(12, '0')}`
const URL = 'https://example.test/acme/atlas.git'

const scratch: string[] = []
const envKept: Record<string, string | undefined> = {}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(envKept)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete envKept[k]
  }
})
const tmp = (): string => {
  // Real, as git gives a checkout's top (macOS's /var is /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-own-')))
  scratch.push(dir)
  return dir
}
const setEnv = (vars: Record<string, string>): void => {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in envKept)) envKept[k] = process.env[k]
    process.env[k] = v
  }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()
const gitOr = (cwd: string, ...args: string[]): string | null => {
  try {
    return git(cwd, ...args)
  } catch {
    return null
  }
}

/** A bare repository with one commit on main (and a src folder), the https address pointed at it. */
function remote(root: string): { seed: string } {
  const seed = join(root, 'seed')
  mkdirSync(join(seed, 'src'), { recursive: true })
  git(seed, 'init', '--quiet', '-b', 'main')
  writeFileSync(join(seed, 'README.md'), 'atlas\n')
  writeFileSync(join(seed, 'src', 'a.ts'), 'export {}\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '--quiet', '-m', 'one')
  const bare = join(root, 'atlas.git')
  git(root, 'clone', '--quiet', '--bare', seed, bare)
  git(seed, 'remote', 'add', 'origin', bare)
  setEnv({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${bare.replace(/\\/g, '/')}.insteadOf`,
    GIT_CONFIG_VALUE_0: URL,
  })
  return { seed }
}

/** The remote moved on by one commit. */
function push(seed: string, text: string): void {
  writeFileSync(join(seed, 'README.md'), `${text}\n`)
  git(seed, 'commit', '--quiet', '-am', text)
  git(seed, 'push', '--quiet', 'origin', 'main')
}

/** The owner's own checkout, cloned by its https address (as the owner would), in a folder of their choice. */
function ownersCheckout(root: string, name = 'atlas'): string {
  const dir = join(root, 'Projects', name)
  mkdirSync(join(root, 'Projects'), { recursive: true })
  git(root, 'clone', '--quiet', URL, dir)
  return dir
}

/** A node with one logged-in profile, its starts recorded instead of run. */
function nodeWith(root: string, over: Partial<NodeConfig> = {}, deps: Partial<NodeLaunchDeps> = {}) {
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, '.credentials.json'), '{}')
  const node: NodeConfig = {
    id: 'mac',
    port: 12430,
    workRoot: join(root, 'work'),
    listen: 'loopback',
    tls: false,
    relay: null,
    ...over,
  }
  const starts: { body: Record<string, unknown>; session: string }[] = []
  const all: NodeLaunchDeps = {
    node: () => node,
    start: async (body, session): Promise<StartResult> => {
      starts.push({ body: body as Record<string, unknown>, session })
      return { ok: true, id: session }
    },
    launch: () => undefined,
    profiles: () =>
      profileSet([{ id: 'default', title: 'Default', dir: profileDir, color: 'indigo', hidden: false }], profileDir),
    workspaces: async () => [],
    memAvailableMb: async () => 4000,
    dir: join(root, 'launches'),
    platform: 'linux',
    ...deps,
  }
  return { launch: createNodeLaunch(all), starts, node, clone: join(node.workRoot, 'example.test', 'acme', 'atlas') }
}

const body = (id: string, source: Record<string, unknown> = {}, name = 'atlas-12') => ({
  id,
  name,
  category: 'atlas',
  profile: 'default',
  agent: 'claude',
  model: '',
  message: 'Go.',
  source: { kind: 'repo', url: URL, ref: 'main', subdir: '', worktree: null, ...source },
})

test('a checkout the node’s sessions ran in is used as it is when clean on the branch: no clone, behind is fast-forwarded, the master’s author not written', async () => {
  const root = tmp()
  const { seed } = remote(root)
  const own = ownersCheckout(root)
  // A session ran below the checkout once: its folder leads to the checkout.
  const n = nodeWith(root, {}, { known: () => ['/nowhere/at/all', join(own, 'src')] })
  const r = await n.launch.answer(
    body(ID, { subdir: 'src', identity: { name: 'Master Owner', email: 'master@example.test' } }),
  )
  assert.equal(r.status, 202, JSON.stringify(r))
  assert.equal(n.starts[0]?.body.cwd, join(own, 'src'))
  assert.equal(n.starts[0]?.body.worktree, null)
  // The workspace is named after the owner's folder.
  assert.deepEqual(n.starts[0]?.body.workspace, { create: 'atlas' })
  assert.equal(existsSync(n.clone), false, 'nothing cloned under workRoot')
  assert.equal(gitOr(own, 'config', '--local', '--get', 'user.email'), null, 'the owner’s config untouched')

  // The remote moves on; the checkout is clean on main and behind: fast-forwarded and used.
  push(seed, 'two')
  const two = await n.launch.answer(body(ids(2)))
  assert.equal(two.status, 202, JSON.stringify(two))
  assert.equal(git(own, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'))
  assert.equal(n.starts[1]?.body.cwd, own)
}, 30_000)

test('the owner’s checkout with changes, on another branch, or with commits of its own is left as it was: the start gets a detached worktree from the remote branch under <workRoot>/worktree', async () => {
  const root = tmp()
  const { seed } = remote(root)
  const own = ownersCheckout(root)
  const n = nodeWith(root, {}, { known: () => [own] })
  push(seed, 'two')
  const target = git(seed, 'rev-parse', 'HEAD')

  // Changes of the owner's: nothing moves, nothing of theirs is touched.
  writeFileSync(join(own, 'notes.txt'), 'mine\n')
  const before = git(own, 'rev-parse', 'HEAD')
  const r = await n.launch.answer(body(ID, { subdir: 'src' }))
  assert.equal(r.status, 202, JSON.stringify(r))
  const wt = join(n.node.workRoot, 'worktree', 'atlas', 'atlas-12')
  assert.equal(n.starts[0]?.body.cwd, join(wt, 'src'))
  assert.equal(n.starts[0]?.body.worktree, null)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), target)
  assert.equal(gitOr(wt, 'symbolic-ref', '--quiet', 'HEAD'), null, 'detached')
  assert.equal(git(own, 'rev-parse', 'HEAD'), before)
  assert.equal(readFileSync(join(own, 'notes.txt'), 'utf8'), 'mine\n')
  assert.equal(existsSync(n.clone), false)

  // Another start of the same name: a folder of its own beside the first.
  const again = await n.launch.answer(body(ids(2)))
  assert.equal(again.status, 202, JSON.stringify(again))
  assert.equal(n.starts[1]?.body.cwd, join(n.node.workRoot, 'worktree', 'atlas', 'atlas-12-2'))

  // On another branch, clean: not switched.
  rmSync(join(own, 'notes.txt'))
  git(own, 'checkout', '--quiet', '-b', 'mine')
  const third = await n.launch.answer(body(ids(3), {}, 'other task'))
  assert.equal(third.status, 202, JSON.stringify(third))
  assert.equal(git(own, 'symbolic-ref', '--short', 'HEAD'), 'mine')
  assert.equal(n.starts[2]?.body.cwd, join(n.node.workRoot, 'worktree', 'atlas', 'other-task'))

  // On main with a commit of its own: no fast-forward possible, nothing rewritten.
  git(own, 'checkout', '--quiet', 'main')
  writeFileSync(join(own, 'mine.txt'), 'x\n')
  git(own, 'add', '.')
  git(own, 'commit', '--quiet', '-m', 'mine')
  const local = git(own, 'rev-parse', 'HEAD')
  const fourth = await n.launch.answer(body(ids(4), {}, 'fourth'))
  assert.equal(fourth.status, 202, JSON.stringify(fourth))
  assert.equal(git(own, 'rev-parse', 'HEAD'), local)
  assert.equal(git(join(n.node.workRoot, 'worktree', 'atlas', 'fourth'), 'rev-parse', 'HEAD'), target)
}, 30_000)

test('a worktree asked for is made from the remote branch under node.worktreeRoot, with no upstream; the same branch again opens it; a branch checked out elsewhere is refused', async () => {
  const root = tmp()
  const { seed } = remote(root)
  const own = ownersCheckout(root)
  const worktreeRoot = join(root, 'worktree')
  const n = nodeWith(root, { worktreeRoot }, { known: () => [own] })
  push(seed, 'two')
  const target = git(seed, 'rev-parse', 'HEAD')
  // The owner's checkout is clean on main but behind: a worktree does not need it moved.
  const before = git(own, 'rev-parse', 'HEAD')
  const r = await n.launch.answer(body(ID, { worktree: { branch: 'feat/x-1' } }))
  assert.equal(r.status, 202, JSON.stringify(r))
  const wt = join(worktreeRoot, 'atlas', 'feat-x-1')
  assert.equal(n.starts[0]?.body.cwd, wt)
  // The pipeline makes no second worktree.
  assert.equal(n.starts[0]?.body.worktree, null)
  assert.equal(git(wt, 'symbolic-ref', '--short', 'HEAD'), 'feat/x-1')
  assert.equal(git(wt, 'rev-parse', 'HEAD'), target)
  assert.equal(gitOr(own, 'rev-parse', '--abbrev-ref', 'feat/x-1@{upstream}'), null, 'no upstream')
  assert.equal(git(own, 'rev-parse', 'HEAD'), before)

  // The same branch again (a start after a restart): the worktree it has.
  const again = await n.launch.answer(body(ids(2), { worktree: { branch: 'feat/x-1' } }))
  assert.equal(again.status, 202, JSON.stringify(again))
  assert.equal(n.starts[1]?.body.cwd, wt)

  // A branch checked out in the owner's own checkout: refused, nothing made.
  git(own, 'checkout', '--quiet', '-b', 'busy')
  assert.deepEqual(await n.launch.answer(body(ids(3), { worktree: { branch: 'busy' } })), {
    status: 409,
    body: { error: 'repo', detail: `branch busy is checked out at ${git(own, 'rev-parse', '--show-toplevel')}` },
  })
  assert.equal(existsSync(join(worktreeRoot, 'atlas', 'busy')), false)

  // A worktree folder inside the owner's checkout is refused.
  const inside = nodeWith(tmp(), { worktreeRoot: join(own, '.wt') }, { known: () => [own] })
  const refused = await inside.launch.answer(body(ids(4), { worktree: { branch: 'y' } }))
  assert.equal(refused.status, 409)
  assert.match((refused.body as { detail: string }).detail, /is inside/)
}, 30_000)

test('node.repos names the checkout first, its address in any case; a linked worktree leads to its main checkout; no known checkout clones under workRoot as before', async () => {
  const root = tmp()
  remote(root)
  const own = ownersCheckout(root)
  const other = ownersCheckout(root, 'atlas-copy')
  // The map wins over the sessions' folders.
  const n = nodeWith(root, { repos: { 'Example.test/ACME/atlas': other } }, { known: () => [own] })
  assert.equal((await n.launch.answer(body(ID))).status, 202)
  assert.equal(n.starts[0]?.body.cwd, other)

  // A session ran in a linked worktree of the checkout: the main checkout is the one used.
  const linked = join(root, 'linked')
  git(own, 'worktree', 'add', '--quiet', '-b', 'side', linked)
  const w = nodeWith(tmp(), {}, { known: () => [linked] })
  assert.equal((await w.launch.answer(body(ids(2)))).status, 202)
  assert.equal(w.starts[0]?.body.cwd, git(own, 'rev-parse', '--show-toplevel'))

  // A folder of another repository, a missing one, the map pointing nowhere: the clone, as before.
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  git(elsewhere, 'init', '--quiet')
  git(elsewhere, 'remote', 'add', 'origin', 'https://example.test/acme/other.git')
  const c = nodeWith(tmp(), { repos: { 'example.test/acme/atlas': '/no/such/folder' } }, { known: () => [elsewhere] })
  const r = await c.launch.answer(body(ids(3), { worktree: { branch: 'atlas-12' } }))
  assert.equal(r.status, 202, JSON.stringify(r))
  assert.equal(c.starts[0]?.body.cwd, c.clone)
  // There the launch pipeline still makes the worktree.
  assert.deepEqual(c.starts[0]?.body.worktree, { branch: 'atlas-12' })
}, 30_000)

test('the board’s own clone found among the known folders is still the clone: a checkout with changes answers repo as before', async () => {
  const root = tmp()
  remote(root)
  const n = nodeWith(root, {}, { known: () => [] })
  assert.equal((await n.launch.answer(body(ID))).status, 202)
  writeFileSync(join(n.clone, 'notes.txt'), 'node\n')
  const again = nodeWith(root, {}, { known: () => [n.clone] })
  assert.deepEqual(await again.launch.answer(body(ids(2))), { status: 409, body: { error: 'repo', detail: 'changes' } })
}, 30_000)

test('checkoutOrigin reads origin only, as configured, before insteadOf; no origin is null; a folder in no checkout is null', async () => {
  const root = tmp()
  remote(root)
  const own = ownersCheckout(root)
  git(own, 'remote', 'add', 'fork', 'git@github.com:someone/atlas.git')
  const top = git(own, 'rev-parse', '--show-toplevel')
  assert.deepEqual(await checkoutOrigin(join(own, 'src')), { root: top, origin: 'example.test/acme/atlas' })
  git(own, 'remote', 'remove', 'origin')
  assert.deepEqual(await checkoutOrigin(own), { root: top, origin: null })
  const plain = join(root, 'plain')
  mkdirSync(plain)
  assert.equal(await checkoutOrigin(plain), null)
})

const FORK = 'https://example.test/someone/atlas.git'

/** A fork of the remote with a commit of its own (fork.txt), its https address pointed at it too. */
function fork(root: string, seed: string): void {
  const work = join(root, 'fork-work')
  git(root, 'clone', '--quiet', seed, work)
  writeFileSync(join(work, 'fork.txt'), 'fork only\n')
  git(work, 'add', '.')
  git(work, 'commit', '--quiet', '-m', 'fork')
  const bare = join(root, 'fork.git')
  git(root, 'clone', '--quiet', '--bare', work, bare)
  setEnv({
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_1: `url.${bare.replace(/\\/g, '/')}.insteadOf`,
    GIT_CONFIG_VALUE_1: FORK,
  })
}

test('a checkout whose origin is a fork and whose upstream is the repository asked for is not used: the start clones under workRoot, no fork code', async () => {
  const root = tmp()
  const { seed } = remote(root)
  fork(root, seed)
  const own = join(root, 'Projects', 'atlas')
  mkdirSync(join(root, 'Projects'), { recursive: true })
  git(root, 'clone', '--quiet', FORK, own)
  git(own, 'remote', 'add', 'upstream', URL)
  const n = nodeWith(root, {}, { known: () => [own] })
  const r = await n.launch.answer(body(ID))
  assert.equal(r.status, 202, JSON.stringify(r))
  assert.equal(n.starts[0]?.body.cwd, n.clone)
  assert.equal(existsSync(join(n.clone, 'fork.txt')), false, 'none of the fork’s code')
  assert.equal(existsSync(join(n.node.workRoot, 'worktree')), false, 'no worktree of the fork')
}, 30_000)

test('a checkout with the address only as upstream, or whose fetch fails, falls back to the clone under workRoot and is left as it was', async () => {
  const root = tmp()
  remote(root)
  // No origin at all, the address as upstream: not the repository's checkout.
  const upstreamOnly = ownersCheckout(root, 'atlas-up')
  git(upstreamOnly, 'remote', 'rename', 'origin', 'upstream')
  const u = nodeWith(root, {}, { known: () => [upstreamOnly] })
  const r = await u.launch.answer(body(ID))
  assert.equal(r.status, 202, JSON.stringify(r))
  assert.equal(u.starts[0]?.body.cwd, u.clone)

  // Origin is the repository, but its fetch fails (a refspec git refuses): the clone, not 409.
  const broken = ownersCheckout(root, 'atlas-broken')
  git(broken, 'config', 'remote.origin.fetch', 'not a refspec::')
  const before = git(broken, 'rev-parse', 'HEAD')
  const b = nodeWith(tmp(), {}, { known: () => [broken] })
  const again = await b.launch.answer(body(ids(2)))
  assert.equal(again.status, 202, JSON.stringify(again))
  assert.equal(b.starts[0]?.body.cwd, b.clone)
  assert.equal(git(broken, 'rev-parse', 'HEAD'), before)
  assert.equal(existsSync(join(b.node.workRoot, 'worktree')), false)
}, 30_000)

test('node.repos and node.worktreeRoot check out or are named; a node config without them is as before', () => {
  const base = { id: 'mac', workRoot: '~' }
  assert.deepEqual(nodeConfig(base), {
    id: 'mac',
    port: 12430,
    workRoot: '~',
    listen: 'loopback',
    tls: false,
    relay: null,
  })
  const withBoth = nodeConfig({
    ...base,
    repos: { 'github.com/Mayk05s/tripio': '~/Projects/Personal/tripio' },
    worktreeRoot: '~/worktree',
  })
  assert.deepEqual({ ...withBoth?.repos }, { 'github.com/Mayk05s/tripio': '~/Projects/Personal/tripio' })
  assert.equal(withBoth?.worktreeRoot, '~/worktree')
  for (const repos of [[], 'x', { 'https://github.com/a/b': '/x' }, { 'github.com/a/b': '' }, { '../x': '/x' }])
    assert.deepEqual(nodeProblems({ ...base, repos }), [{ key: 'repos', why: 'type' }], JSON.stringify(repos))
  assert.deepEqual(nodeProblems({ ...base, worktreeRoot: 5 }), [{ key: 'worktreeRoot', why: 'type' }])
})

test('known folders: sessions, then the archive, then the folders each Claude profile was used in; each once, paths of this computer only', () => {
  const home = tmp()
  const defaultDir = join(home, '.claude')
  const other = join(home, 'profiles', 'work')
  mkdirSync(other, { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ projects: { '/a/live': {}, 'ssh:hermes@host:/srv/x': {}, '/u/claude': {} } }),
  )
  writeFileSync(join(other, '.claude.json'), JSON.stringify({ projects: { '/w/one': {} } }))
  assert.deepEqual(
    knownFolders({
      sessions: [{ cwd: '/a/live' }, { cwd: '' }, { cwd: '/a/live' }],
      archived: [{ cwd: '/b/archived' }, {}],
      profileDirs: [defaultDir, other, join(home, 'missing')],
      home,
      platform: 'linux',
    }),
    ['/a/live', '/b/archived', '/u/claude', '/w/one'],
  )
  writeFileSync(join(other, '.claude.json'), '{not json')
  assert.deepEqual(claudeProjects(join(other, '.claude.json')), [])
  assert.equal(folderName('feat/x 1'), 'feat-x-1')
  assert.equal(folderName('..'), 'task')
})
