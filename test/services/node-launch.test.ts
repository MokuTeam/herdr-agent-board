// A start from the master on a node (#504, docs/design/nodes 6.4): services/node/launch.ts with its
// launch pipeline stood in for, and the real git against a local bare repository as the remote
// (git's url.<base>.insteadOf points the https address at it, so the board's own address rule and
// clone URL are what is tested). Then the route on a node board's door, with its fake herdr.
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneRepo, fetchRepo, moveTo, repoIdentity, repoState, setRepoIdentity } from '../../src/adapters/node-repo.ts'
import type { NodeConfig } from '../../src/core/nodes.ts'
import { profileSet } from '../../src/core/profiles.ts'
import type { StartResult } from '../../src/services/launch/launches.ts'
import {
  cloneUrl,
  createNodeLaunch,
  launchRequestOf,
  type NodeLaunchDeps,
  type RepoOps,
} from '../../src/services/node/launch.ts'

const ID = '5d0c6a1e-1111-4222-8333-444455556666'
const OTHER = '5d0c6a1e-1111-4222-8333-777788889999'

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
  const dir = mkdtempSync(join(tmpdir(), 'node-launch-'))
  scratch.push(dir)
  return dir
}
const setEnv = (vars: Record<string, string>): void => {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in envKept)) envKept[k] = process.env[k]
    process.env[k] = v
  }
}

/** A node with one logged-in profile, its starts recorded instead of run. */
function nodeWith(root: string, over: Partial<NodeLaunchDeps> = {}) {
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, '.credentials.json'), '{}')
  const node: NodeConfig = {
    id: 'server-1',
    port: 12430,
    workRoot: join(root, 'work'),
    listen: 'loopback',
    tls: false,
    relay: null,
  }
  const starts: { body: Record<string, unknown>; session: string }[] = []
  const deps: NodeLaunchDeps = {
    node: () => node,
    start: async (body, session): Promise<StartResult> => {
      starts.push({ body: body as Record<string, unknown>, session })
      return { ok: true, id: session }
    },
    launch: () => undefined,
    profiles: () =>
      profileSet([{ id: 'default', title: 'Default', dir: profileDir, color: 'indigo', hidden: false }], profileDir),
    workspaces: async () => [{ id: 'w7', label: 'atlas' }],
    memAvailableMb: async () => 4000,
    dir: join(root, 'launches'),
    platform: 'linux',
    ...over,
  }
  return { deps, starts, node, profileDir }
}

const repoBody = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'atlas-12',
  category: 'atlas',
  profile: 'default',
  agent: 'claude',
  model: '',
  message: 'Go.',
  source: { kind: 'repo', url: 'https://example.test/acme/atlas.git', ref: 'main', subdir: '', worktree: null },
  ...over,
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()

/** A bare repository with one commit on main (and a src folder), and the https address pointed at it. */
function remote(root: string): { bare: string; seed: string } {
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
    GIT_CONFIG_VALUE_0: 'https://example.test/acme/atlas.git',
  })
  return { bare, seed }
}

test('a start body is checked field by field; the clone URL is the master’s only for the same address over https or ssh', () => {
  assert.deepEqual(launchRequestOf(repoBody()), {
    id: ID,
    name: 'atlas-12',
    category: 'atlas',
    profile: 'default',
    agent: 'claude',
    model: '',
    message: 'Go.',
    workspace: '',
    source: { kind: 'repo', url: 'https://example.test/acme/atlas.git', ref: 'main', subdir: '', worktree: null },
  })
  const field = (over: Record<string, unknown>) => (launchRequestOf(repoBody(over)) as { field?: string }).field
  assert.equal(field({ id: 'not-a-uuid' }), 'id')
  assert.equal(field({ id: ID.toUpperCase() }), 'id')
  assert.equal(field({ source: { kind: 'zip' } }), 'source.kind')
  assert.equal(field({ source: { kind: 'repo', url: '' } }), 'source.url')
  assert.equal(field({ source: { kind: 'repo', url: 'x', ref: 'a..b' } }), 'source.ref')
  for (const subdir of ['../up', 'a/../b', '-x', 'a\\b', 'C:/x', 'a//b'])
    assert.equal(field({ source: { kind: 'repo', url: 'x', subdir } }), 'source.subdir', subdir)
  assert.equal(field({ source: { kind: 'repo', url: 'x', worktree: { branch: 'a b' } } }), 'source.worktree')
  assert.equal(field({ source: { kind: 'path', cwd: '' } }), 'source.cwd')
  assert.equal(field({ message: 5 }), 'message')

  assert.equal(cloneUrl('github.com/a/b', 'https://github.com/a/b.git'), 'https://github.com/a/b.git')
  assert.equal(cloneUrl('github.com/a/b', 'git@github.com:a/b.git'), 'git@github.com:a/b.git')
  assert.equal(cloneUrl('github.com/a/b', 'ssh://git@github.com:22/a/b'), 'ssh://git@github.com:22/a/b')
  // Another address, plain http, a file path, a helper's own scheme: the address's https URL.
  for (const sent of ['https://evil.test/a/b.git', 'http://github.com/a/b', 'file:///srv/b.git', 'ext::sh -c x'])
    assert.equal(cloneUrl('github.com/a/b', sent), 'https://github.com/a/b.git', sent)
})

test('the same id twice is one start: while it is made, after it, and after the node’s board starts again', async () => {
  const root = tmp()
  const { deps, starts } = nodeWith(root, { source: undefined } as Partial<NodeLaunchDeps>)
  // A path start: no git at all.
  const body = { ...repoBody(), source: { kind: 'path', cwd: root, worktree: null } }
  const one = createNodeLaunch(deps)
  const [a, b] = await Promise.all([one.answer(body), one.answer(body)])
  assert.deepEqual([a.status, b.status], [202, 202])
  assert.equal(starts.length, 1)
  assert.equal((await one.answer(body)).status, 202)
  assert.equal(starts.length, 1)
  // A new process: the record under <state>/node/launches says it was taken.
  const again = createNodeLaunch(deps)
  assert.equal((await again.answer(body)).status, 202)
  assert.equal(starts.length, 1)
  assert.deepEqual(readdirSync(join(root, 'launches')), [`${ID}.json`])
  // Past the 10 minutes a retry can come in, the record is gone and the id starts again.
  utimesSync(
    join(root, 'launches', `${ID}.json`),
    new Date(Date.now() - 11 * 60_000),
    new Date(Date.now() - 11 * 60_000),
  )
  assert.equal((await createNodeLaunch(deps).answer(body)).status, 202)
  assert.equal(starts.length, 2)
  // What the node's own pipeline got: the folder, the lane, the profile, the id as the session's.
  assert.deepEqual(starts[0], {
    session: ID,
    body: {
      name: 'atlas-12',
      cwd: root,
      category: 'atlas',
      workspace: { create: root.split(/[\\/]/).at(-1) },
      message: 'Go.',
      worktree: null,
      profile: 'default',
      agent: 'claude',
      model: '',
    },
  })
  // A start the pipeline refuses leaves no record: the master may send it again once fixed.
  const refusing = createNodeLaunch({
    ...deps,
    start: async () => ({ ok: false, field: 'cwd', error: 'There is no folder x' }),
  })
  assert.deepEqual(await refusing.answer({ ...body, id: OTHER }), {
    status: 400,
    body: { error: 'launch', field: 'cwd', detail: 'There is no folder x' },
  })
  assert.deepEqual(readdirSync(join(root, 'launches')), [`${ID}.json`])
})

test('below 512 MB available the node answers full; a profile it lacks or that is not logged in answers profile', async () => {
  const root = tmp()
  const path = { kind: 'path', cwd: root, worktree: null }
  const low = nodeWith(root, { memAvailableMb: async () => 511 })
  assert.deepEqual(await createNodeLaunch(low.deps).answer(repoBody({ source: path })), {
    status: 409,
    body: { error: 'full' },
  })
  assert.equal(low.starts.length, 0)
  // A memory figure the system could not give is no refusal here: the master took it as no room.
  const unknown = nodeWith(root, { memAvailableMb: async () => null })
  assert.equal((await createNodeLaunch(unknown.deps).answer(repoBody({ source: path }))).status, 202)
  const n = nodeWith(tmp())
  assert.deepEqual(await createNodeLaunch(n.deps).answer(repoBody({ id: OTHER, source: path, profile: 'work' })), {
    status: 409,
    body: { error: 'profile', detail: 'missing' },
  })
  rmSync(join(n.profileDir, '.credentials.json'))
  assert.deepEqual(await createNodeLaunch(n.deps).answer(repoBody({ id: OTHER, source: path })), {
    status: 409,
    body: { error: 'profile', detail: 'login' },
  })
  assert.equal(n.starts.length, 0)
})

test('a Codex start is not turned away for a Claude profile the node lacks or has not logged in (#902)', async () => {
  const root = tmp()
  const path = { kind: 'path', cwd: root, worktree: null }
  const n = nodeWith(root)
  rmSync(join(n.profileDir, '.credentials.json'))
  // A Zenbook with Codex logged in and no Claude: its `default` profile has no login.
  const codex = await createNodeLaunch(n.deps).answer(repoBody({ source: path, agent: 'codex' }))
  assert.equal(codex.status, 202, JSON.stringify(codex))
  const missing = await createNodeLaunch(n.deps).answer(
    repoBody({ id: OTHER, source: path, agent: 'codex', profile: 'work' }),
  )
  assert.equal(missing.status, 202, JSON.stringify(missing))
  assert.deepEqual(
    n.starts.map(s => s.body.agent),
    ['codex', 'codex'],
  )
  // A Claude start there is turned away as before.
  const claude = await createNodeLaunch(nodeWith(tmp(), { profiles: n.deps.profiles }).deps).answer(
    repoBody({ id: '5d0c6a1e-1111-4222-8333-000000000002', source: path }),
  )
  assert.deepEqual(claude, { status: 409, body: { error: 'profile', detail: 'login' } })
})

test('a repository missing on the node is cloned under <workRoot>/<host>/<path>; a checkout with changes answers repo', async () => {
  const root = tmp()
  const { seed } = remote(root)
  const { deps, starts, node } = nodeWith(root)
  const launch = createNodeLaunch(deps)
  const r = await launch.answer(repoBody({ source: { ...repoBody().source, subdir: 'src' } }))
  assert.equal(r.status, 202, JSON.stringify(r))
  const checkout = join(node.workRoot, 'example.test', 'acme', 'atlas')
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'))
  assert.equal(starts[0]?.body.cwd, join(checkout, 'src'))
  // The master's workspace label wins over the repository's name; one herdr has is used.
  assert.deepEqual(starts[0]?.body.workspace, { id: 'w7', label: 'atlas' })

  // The remote moves on: a clean checkout is fetched and fast-forwarded.
  writeFileSync(join(seed, 'README.md'), 'atlas two\n')
  git(seed, 'commit', '--quiet', '-am', 'two')
  git(seed, 'push', '--quiet', 'origin', 'main')
  const two = await launch.answer(repoBody({ id: OTHER }))
  assert.equal(two.status, 202, JSON.stringify(two))
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'))

  // Changes of the node's own in the checkout: a start without a worktree is refused, nothing moves.
  writeFileSync(join(seed, 'README.md'), 'atlas three\n')
  git(seed, 'commit', '--quiet', '-am', 'three')
  git(seed, 'push', '--quiet', 'origin', 'main')
  writeFileSync(join(checkout, 'notes.txt'), 'mine\n')
  const third = '5d0c6a1e-1111-4222-8333-000000000003'
  assert.deepEqual(await launch.answer(repoBody({ id: third })), {
    status: 409,
    body: { error: 'repo', detail: 'changes' },
  })
  assert.notEqual(git(checkout, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'))
  // A new worktree needs the branch at its remote commit, which a checkout with changes behind it is not.
  const wt = { ...repoBody().source, worktree: { branch: 'atlas-12' } }
  assert.equal((await launch.answer(repoBody({ id: third, source: wt }))).status, 409)
  // Caught up by hand, the same changes do not stand in a new worktree's way.
  rmSync(join(checkout, 'notes.txt'))
  git(checkout, 'pull', '--quiet', '--ff-only')
  writeFileSync(join(checkout, 'notes.txt'), 'mine\n')
  const fourth = await launch.answer(repoBody({ id: third, source: wt }))
  assert.equal(fourth.status, 202, JSON.stringify(fourth))
  assert.deepEqual(starts.at(-1)?.body.worktree, { branch: 'atlas-12' })
  assert.equal(starts.length, 3)
}, 30_000)

test('an address the board’s rule refuses, a remote that cannot be cloned, a branch it lacks: repo, nothing made', async () => {
  const root = tmp()
  remote(root)
  const { deps, starts, node } = nodeWith(root)
  const launch = createNodeLaunch(deps)
  const at = (url: string, ref = 'main') => launch.answer(repoBody({ source: { ...repoBody().source, url, ref } }))
  assert.deepEqual(await at('C:/srv/atlas.git'), { status: 409, body: { error: 'repo', detail: 'address' } })
  // A host of dots would climb out of the work folder.
  for (const url of ['https://../projects/x.git', '..:projects/x', 'ssh://git@../x/y'])
    assert.deepEqual(await at(url), { status: 409, body: { error: 'repo', detail: 'address' } }, url)
  assert.deepEqual(await at('https://example.test/../etc/x.git'), {
    status: 409,
    body: { error: 'repo', detail: 'address' },
  })
  const nowhere = await at('https://example.test/acme/nowhere.git')
  assert.equal(nowhere.status, 409)
  assert.equal((nowhere.body as { error: string }).error, 'repo')
  const branch = await at('https://example.test/acme/atlas.git', 'gone')
  assert.deepEqual(branch, { status: 409, body: { error: 'repo', detail: 'no branch gone' } })
  assert.equal(starts.length, 0)
  assert.deepEqual(readdirSync(join(node.workRoot, 'example.test', 'acme')), ['atlas'])
}, 30_000)

// ---------------------------------------------------------------- the author of the master's checkout (#611)

const AUTHOR = { name: 'Атлас Author %s', email: 'atlas@example.test' }
const NODE_OWNER = { name: 'Node Owner', email: 'node@example.test' }

/** The node's global config a file of the test's own, holding the node owner's identity; git's system one off. */
function nodeGlobal(root: string): string {
  const file = join(root, 'global.gitconfig')
  writeFileSync(file, `[user]\n\tname = ${NODE_OWNER.name}\n\temail = ${NODE_OWNER.email}\n`)
  setEnv({ GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' })
  return file
}

/** The real git a start needs, with the identity's calls counted. */
function countedRepo(over: Partial<RepoOps> = {}) {
  const calls = { identity: 0, setIdentity: 0 }
  const repo: RepoOps = {
    clone: cloneRepo,
    fetch: fetchRepo,
    state: repoState,
    move: moveTo,
    identity: dir => {
      calls.identity++
      return repoIdentity(dir)
    },
    setIdentity: (dir, id) => {
      calls.setIdentity++
      return (over.setIdentity ?? setRepoIdentity)(dir, id)
    },
  }
  return { repo, calls }
}

/** A key of the checkout's own config, or null when it has none. */
function local(checkout: string, key: string): string | null {
  try {
    return git(checkout, 'config', '--local', '--get', key)
  } catch {
    return null
  }
}

const withAuthor = (id: string, identity: unknown = AUTHOR) =>
  repoBody({ id, source: { ...repoBody().source, identity } })

test('the author the master’s checkout gives goes into the clone’s own config, worktrees too; none sent asks nothing; the same writes nothing (#611)', async () => {
  const root = tmp()
  remote(root)
  const global = nodeGlobal(root)
  const before = readFileSync(global, 'utf8')
  const { repo, calls } = countedRepo()
  const { deps, starts, node } = nodeWith(root, { repo })
  const launch = createNodeLaunch(deps)
  const checkout = join(node.workRoot, 'example.test', 'acme', 'atlas')

  // No identity sent (none on the master, or an older one): nothing asked, nothing written.
  assert.equal((await launch.answer(repoBody())).status, 202)
  assert.deepEqual(calls, { identity: 0, setIdentity: 0 })
  assert.equal(local(checkout, 'user.email'), null)

  // Another author than git gives here: set in the clone's own config, the global one untouched.
  const two = await launch.answer(withAuthor(OTHER))
  assert.equal(two.status, 202, JSON.stringify(two))
  assert.deepEqual([local(checkout, 'user.name'), local(checkout, 'user.email')], [AUTHOR.name, AUTHOR.email])
  assert.equal(git(checkout, 'config', 'user.email'), AUTHOR.email)
  assert.equal(readFileSync(global, 'utf8'), before)
  // A worktree of the clone, as the node's launch pipeline makes one, commits as the same author.
  const wt = join(root, 'wt')
  git(checkout, 'worktree', 'add', '--quiet', '-b', 'atlas-12', wt)
  assert.equal(git(wt, 'config', 'user.email'), AUTHOR.email)

  // The same author again: asked, nothing written.
  const third = '5d0c6a1e-1111-4222-8333-000000000003'
  assert.equal((await launch.answer(withAuthor(third))).status, 202)
  assert.deepEqual(calls, { identity: 2, setIdentity: 1 })
  assert.equal(starts.length, 3)

  // A fresh clone whose node gives the same author already: nothing written there either.
  const fresh = countedRepo()
  const other = nodeWith(tmp(), { repo: fresh.repo })
  const r = await createNodeLaunch(other.deps).answer(withAuthor(ID, NODE_OWNER))
  assert.equal(r.status, 202, JSON.stringify(r))
  const freshCheckout = join(other.node.workRoot, 'example.test', 'acme', 'atlas')
  assert.deepEqual(fresh.calls, { identity: 1, setIdentity: 0 })
  assert.equal(local(freshCheckout, 'user.email'), null)
  assert.equal(git(freshCheckout, 'config', 'user.email'), NODE_OWNER.email)
}, 30_000)

test('an author that does not fit is refused as the body; one that cannot be set turns the start away as repo, saying identity (#611)', async () => {
  assert.deepEqual((launchRequestOf(withAuthor(ID)) as { source: unknown }).source, {
    ...repoBody().source,
    identity: AUTHOR,
  })
  // null is none, as from a master that has no identity there.
  assert.deepEqual((launchRequestOf(withAuthor(ID, null)) as { source: unknown }).source, repoBody().source)
  const field = (identity: unknown) => (launchRequestOf(withAuthor(ID, identity)) as { field?: string }).field
  for (const identity of [
    'Atlas Author <atlas@example.test>',
    { name: AUTHOR.name },
    { email: AUTHOR.email },
    { name: '', email: AUTHOR.email },
    { name: 'Atlas\nAuthor', email: AUTHOR.email },
    { name: AUTHOR.name, email: 'atlas@example.test\r' },
    { name: 'a'.repeat(257), email: AUTHOR.email },
    { name: AUTHOR.name, email: 5 },
  ])
    assert.equal(field(identity), 'source.identity', JSON.stringify(identity))

  const root = tmp()
  remote(root)
  nodeGlobal(root)
  const { repo, calls } = countedRepo({ setIdentity: async () => ({ ok: false, why: 'could not lock config file' }) })
  const { deps, starts, node } = nodeWith(root, { repo })
  const launch = createNodeLaunch(deps)
  assert.deepEqual(await launch.answer(withAuthor(ID)), {
    status: 409,
    body: { error: 'repo', detail: 'identity not set: could not lock config file' },
  })
  assert.equal(calls.setIdentity, 1)
  assert.equal(starts.length, 0)
  // Nothing accepted: the master may send it again, to this node or the next.
  assert.equal(existsSync(join(root, 'launches', `${ID}.json`)), false)
  const checkout = join(node.workRoot, 'example.test', 'acme', 'atlas')
  assert.equal(local(checkout, 'user.email'), null)

  // A start turned away for anything else (changes of the node's own) asks and writes nothing.
  const counted = countedRepo()
  writeFileSync(join(checkout, 'notes.txt'), 'mine\n')
  assert.deepEqual(await createNodeLaunch({ ...deps, repo: counted.repo }).answer(withAuthor(OTHER)), {
    status: 409,
    body: { error: 'repo', detail: 'changes' },
  })
  assert.deepEqual(counted.calls, { identity: 0, setIdentity: 0 })
  assert.equal(local(checkout, 'user.email'), null)
}, 30_000)

test('a key the clone has twice is replaced whole (#611)', async () => {
  const root = tmp()
  nodeGlobal(root)
  const dir = join(root, 'clone')
  mkdirSync(dir)
  git(dir, 'init', '--quiet')
  git(dir, 'config', '--local', '--add', 'user.email', 'one@example.test')
  git(dir, 'config', '--local', '--add', 'user.email', 'two@example.test')
  assert.deepEqual(await setRepoIdentity(dir, AUTHOR), { ok: true })
  assert.equal(git(dir, 'config', '--local', '--get-all', 'user.email'), AUTHOR.email)
  assert.deepEqual(await repoIdentity(dir), AUTHOR)
})

// ---------------------------------------------------------------- spawn-agent --trust (#798)

test('trust is read as a boolean: true is kept, false or none leaves no key, any other type is refused as trust (#798)', () => {
  const plain = launchRequestOf(repoBody())
  assert.deepEqual(launchRequestOf(repoBody({ trust: true })), { ...plain, trust: true })
  for (const body of [repoBody(), repoBody({ trust: false })]) {
    const r = launchRequestOf(body)
    assert.equal('trust' in r, false)
    assert.deepEqual(r, plain)
  }
  const field = (trust: unknown) => (launchRequestOf(repoBody({ trust })) as { field?: string }).field
  for (const trust of ['true', 'yes', 1, 0, null, {}, []]) assert.equal(field(trust), 'trust', JSON.stringify(trust))
})

test('a start with trust gives the node’s own pipeline the option; with none of it the call has two arguments, as before (#798)', async () => {
  const root = tmp()
  const calls: unknown[][] = []
  const { deps } = nodeWith(root, {
    start: async (...args: unknown[]): Promise<StartResult> => {
      calls.push(args)
      return { ok: true, id: String(args[1]) }
    },
  })
  const launch = createNodeLaunch(deps)
  const [third, fourth, fifth] = [3, 4, 5].map(n => `5d0c6a1e-1111-4222-8333-00000000000${n}`) as [
    string,
    string,
    string,
  ]
  const path = { kind: 'path', cwd: root, worktree: null }
  const answer = (id: string, more: Record<string, unknown> = {}) =>
    launch.answer(repoBody({ id, source: path, ...more }))

  assert.equal((await answer(ID, { trust: true })).status, 202)
  assert.equal((await answer(OTHER, { exactSession: true, trust: true })).status, 202)
  assert.equal((await answer(third, { exactSession: true })).status, 202)
  assert.equal((await answer(fourth)).status, 202)
  assert.equal((await answer(fifth, { trust: false })).status, 202)
  assert.equal(calls.length, 5)

  assert.deepEqual(
    calls.map(c => c[1]),
    [ID, OTHER, third, fourth, fifth],
  )
  assert.deepEqual(calls[0]?.[2], { trust: true })
  assert.deepEqual(calls[1]?.[2], { exactSession: true, trust: true })
  // The starts without trust are the calls they were before: one option for the exact session, none otherwise.
  assert.deepEqual(calls[2]?.[2], { exactSession: true })
  assert.equal(calls[3]?.length, 2)
  assert.equal(calls[4]?.length, 2)
  // The start's body is the same with or without trust: it is an option of the start, not a field of it.
  assert.deepEqual(calls[0]?.[0], calls[3]?.[0])
  assert.equal('trust' in ((calls[0]?.[0] ?? {}) as object), false)
})

test('an owner service start carries its attribution into the node launch pipeline', async () => {
  const root = tmp()
  const calls: unknown[][] = []
  const { deps } = nodeWith(root, {
    start: async (...args: unknown[]): Promise<StartResult> => {
      calls.push(args)
      return { ok: true, id: String(args[1]) }
    },
  })
  const launch = createNodeLaunch(deps)
  const by = 'service Atlas %'
  const body = repoBody({ source: { kind: 'path', cwd: root, worktree: null }, by })
  assert.deepEqual(launchRequestOf({ ...body, by: 'owner' }), { field: 'by' })
  assert.equal((await launch.answer(body)).status, 202)
  assert.deepEqual(calls[0]?.[2], { by })
})
