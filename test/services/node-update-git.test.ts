// A node whose plugin folder is a git checkout (#793): its update never unpacks over the folder,
// never moves or removes its .git, and never removes a folder beside it that holds one. The checkout
// is updated in place by git (a branch fast-forwarded, a detached HEAD checked out, a worktree's
// .git file kept), or refused with the reason and left exactly as it was: changes in the tree,
// commits no remote has, a commit the remote lacks, a branch that does not lead to the commit. An
// archive install goes down the archive's path as before; a .old or .new holding a .git is kept.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { besidePlugin, holdsGit, removeTree, swapIn, writeTree } from '../../src/adapters/plugin-update.ts'
import { createNodeUpdate, type NodeUpdateDeps } from '../../src/services/node/update.ts'
import { type PluginRepo, pluginRepo, tarOf } from '../support/plugin-tar.ts'

let dir: string
let repo: PluginRepo
let root: string

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
}

function g(at: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-C', at, ...args], {
    env: { ...process.env, ...GIT_ENV, GIT_CONFIG_GLOBAL: join(dir, 'no-gitconfig') },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const stream = (bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> =>
  new Response(bytes).body as ReadableStream<Uint8Array>
const text = (...p: string[]): string => readFileSync(join(...p), 'utf8')
const never = (what: string) => () => {
  throw new Error(`${what} must not run for a checkout`)
}

/** No step of the archive's path runs: nothing is unpacked, installed from it, swapped, copied or guarded. */
const noArchivePath: Partial<NodeUpdateDeps> = {
  unpack: never('unpack'),
  swap: never('swap'),
  backup: async () => never('backup')(),
  check: async () => never('check')(),
  install: async () => never('install')(),
}

/** `archive`: the archive's own steps run as in production (an archive install's tests). */
function make(over: Partial<NodeUpdateDeps> = {}, archive = false) {
  const restarts: string[] = []
  const logs: string[] = []
  const installs: string[] = []
  const update = createNodeUpdate({
    root,
    dir: join(dir, 'state', 'node', 'update'),
    commit: async () => g(root, 'rev-parse', 'HEAD'),
    platform: 'linux',
    canRestart: true,
    restart: old => restarts.push(old),
    installCheckout: async () => {
      installs.push(text(root, 'package.json'))
      return { ok: true, detail: '' }
    },
    log: t => logs.push(t),
    ...(archive ? {} : noArchivePath),
    ...over,
  })
  return { update, restarts, logs, installs }
}

/** The plugin folder as a clone of the plugin's repository, its main branch at commit A. */
function cloneAtA(): void {
  g(dir, 'clone', '-q', repo.dir, root)
  g(root, 'reset', '-q', '--hard', repo.a)
}

async function send(update: ReturnType<typeof make>['update'], commit: string) {
  const archive = repo.archive(repo.b)
  await update.blob(stream(archive), archive.length)
  return update.update({ commit, sha256: sha(archive) })
}

/** Nothing was made or left beside the plugin, and the archive did not stay. */
function nothingBeside(): void {
  const { fresh, old } = besidePlugin(root)
  expect(existsSync(fresh)).toBe(false)
  expect(existsSync(old)).toBe(false)
  expect(readdirSync(join(dir, 'state', 'node', 'update'))).toEqual([])
}

/** The checkout is exactly as it was: .git, HEAD at A on main, the files of A. */
function checkoutAtA(file = 'export const V = 1\n'): void {
  expect(existsSync(join(root, '.git'))).toBe(true)
  expect(g(root, 'rev-parse', 'HEAD')).toBe(repo.a)
  expect(text(root, 'src', 'adapters', 'paths.ts')).toBe(file)
  expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
  expect(existsSync(join(root, '.archive-commit'))).toBe(false)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'node-update-git-'))
  repo = pluginRepo(join(dir, 'repo'))
  root = join(dir, 'home', 'agent-board')
  mkdirSync(join(dir, 'home'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a node whose plugin is a git checkout updates it in place by git', () => {
  test('a branch is fast-forwarded to the commit: .git stays, nothing is unpacked, moved or left beside it', async () => {
    cloneAtA()
    const gitBefore = readdirSync(join(root, '.git')).sort()
    const { update, restarts, logs, installs } = make()
    expect(await send(update, repo.b)).toEqual({ status: 200, body: { ok: true, commit: repo.b, restarting: true } })
    expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true)
    expect(readdirSync(join(root, '.git')).sort()).toEqual(expect.arrayContaining(gitBefore))
    expect(g(root, 'rev-parse', 'HEAD')).toBe(repo.b)
    expect(g(root, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 2\n')
    expect(text(root, 'src', 'b.ts')).toBe('export const B = true\n')
    expect(existsSync(join(root, '.archive-commit'))).toBe(false)
    expect(g(root, 'status', '--porcelain')).toBe('')
    nothingBeside()
    // the lock files did not change: no install
    expect(installs).toEqual([])
    expect(restarts).toEqual([root])
    expect(logs.join('\n')).toContain('updated by git')
    expect(update.busy()).toBe(true)
  })

  test('a detached HEAD checks the commit out, still detached', async () => {
    cloneAtA()
    g(root, 'checkout', '-q', '--detach', repo.a)
    const { update, restarts } = make()
    expect((await send(update, repo.b)).status).toBe(200)
    expect(g(root, 'rev-parse', 'HEAD')).toBe(repo.b)
    expect(Bun.spawnSync(['git', '-C', root, 'symbolic-ref', '-q', 'HEAD']).exitCode).toBe(1)
    expect(existsSync(join(root, '.git'))).toBe(true)
    nothingBeside()
    expect(restarts).toEqual([root])
  })

  test("a worktree's .git file stays, and so does the main clone it points to", async () => {
    const main = join(dir, 'home', 'clone')
    g(dir, 'clone', '-q', repo.dir, main)
    g(main, 'worktree', 'add', '-q', '--detach', root, repo.a)
    expect(readFileSync(join(root, '.git'), 'utf8')).toStartWith('gitdir:')
    const { update } = make()
    expect((await send(update, repo.b)).status).toBe(200)
    expect(readFileSync(join(root, '.git'), 'utf8')).toStartWith('gitdir:')
    expect(g(root, 'rev-parse', 'HEAD')).toBe(repo.b)
    expect(existsSync(join(main, '.git', 'HEAD'))).toBe(true)
    nothingBeside()
  })

  test('changed lock files are checked out and installed before the code moves', async () => {
    writeFileSync(
      join(repo.dir, 'package.json'),
      '{ "name": "scratch-plugin", "version": "0.2.0", "dependencies": {} }\n',
    )
    writeFileSync(join(repo.dir, 'src', 'c.ts'), 'export const C = 1\n')
    g(repo.dir, 'add', '-A')
    g(repo.dir, 'commit', '-q', '-m', 'c')
    const c = g(repo.dir, 'rev-parse', 'HEAD')
    cloneAtA()
    const seen: string[] = []
    const { update, installs } = make({
      installCheckout: async () => {
        // the new package.json is there, the new code not yet
        seen.push(`${text(root, 'package.json').includes('0.2.0')}|${existsSync(join(root, 'src', 'c.ts'))}`)
        return { ok: true, detail: '' }
      },
    })
    expect((await send(update, c)).status).toBe(200)
    expect(seen).toEqual(['true|false'])
    expect(installs).toEqual([])
    expect(g(root, 'rev-parse', 'HEAD')).toBe(c)
    expect(g(root, 'status', '--porcelain')).toBe('')
  })

  test('a failed install puts the lock files back and leaves the checkout where it was', async () => {
    writeFileSync(
      join(repo.dir, 'package.json'),
      '{ "name": "scratch-plugin", "version": "0.2.0", "dependencies": {} }\n',
    )
    g(repo.dir, 'commit', '-q', '-am', 'c')
    const c = g(repo.dir, 'rev-parse', 'HEAD')
    cloneAtA()
    let calls = 0
    const { update, restarts } = make({
      installCheckout: async () => ({ ok: ++calls > 1, detail: 'network down' }),
    })
    expect(await send(update, c)).toEqual({
      status: 500,
      body: { ok: false, error: 'install', detail: 'network down' },
    })
    checkoutAtA()
    expect(g(root, 'status', '--porcelain')).toBe('')
    expect(restarts).toEqual([])
    expect(update.busy()).toBe(false)
  })

  test('on Windows a checkout goes the same way: no copy, no record, no guard', async () => {
    cloneAtA()
    const { update, restarts } = make({ platform: 'win32', guard: never('guard'), go: never('go') })
    expect((await send(update, repo.b)).status).toBe(200)
    expect(g(root, 'rev-parse', 'HEAD')).toBe(repo.b)
    expect(existsSync(join(dir, 'state', 'node', 'update', 'pending.json'))).toBe(false)
    nothingBeside()
    expect(restarts).toEqual([root])
  })
})

describe('lock files a board that died during the install left behind', () => {
  /** A commit C on the remote that changes package.json; the checkout at A as a board that died mid install left it. */
  function diedMidInstall(): string {
    writeFileSync(
      join(repo.dir, 'package.json'),
      '{ "name": "scratch-plugin", "version": "0.2.0", "dependencies": {} }\n',
    )
    g(repo.dir, 'commit', '-q', '-am', 'c')
    const c = g(repo.dir, 'rev-parse', 'HEAD')
    cloneAtA()
    g(root, 'fetch', '-q', 'origin')
    g(root, 'checkout', c, '--', 'package.json')
    const state = join(dir, 'state', 'node', 'update')
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'git-locks.json'),
      `${JSON.stringify({ from: repo.a, to: c, files: ['package.json'] })}\n`,
    )
    return c
  }

  test('are put back by the next update, which then goes through', async () => {
    const c = diedMidInstall()
    const { update, logs } = make()
    expect((await send(update, c)).status).toBe(200)
    expect(logs.join('\n')).toContain('left from an update by git that did not finish')
    expect(g(root, 'rev-parse', 'HEAD')).toBe(c)
    expect(g(root, 'status', '--porcelain')).toBe('')
    nothingBeside()
  })

  test('a file someone changed since is not put back: the record goes, the change stays and is refused as a change', async () => {
    const c = diedMidInstall()
    writeFileSync(join(root, 'package.json'), '{ "name": "mine" }\n')
    const { update } = make()
    expect((await send(update, c)).body.error).toBe('git-dirty')
    expect(text(root, 'package.json')).toBe('{ "name": "mine" }\n')
    expect(g(root, 'rev-parse', 'HEAD')).toBe(repo.a)
    expect(existsSync(join(dir, 'state', 'node', 'update', 'git-locks.json'))).toBe(false)
  })
})

describe('a checkout the node does not move by itself is refused and left as it was', () => {
  test('a lock file added or removed: refused before anything is checked out', async () => {
    mkdirSync(join(repo.dir, 'packages', 'x'), { recursive: true })
    writeFileSync(join(repo.dir, 'packages', 'x', 'package.json'), '{ "name": "x" }\n')
    g(repo.dir, 'add', '-A')
    g(repo.dir, 'commit', '-q', '-m', 'x')
    const x = g(repo.dir, 'rev-parse', 'HEAD')
    cloneAtA()
    const { update, installs, restarts } = make()
    expect((await send(update, x)).body.error).toBe('git-locks')
    checkoutAtA()
    expect(g(root, 'status', '--porcelain')).toBe('')
    expect(installs).toEqual([])
    expect(restarts).toEqual([])
  })

  test('changes in the tree: refused, the changes and the commit untouched', async () => {
    cloneAtA()
    writeFileSync(join(root, 'src', 'adapters', 'paths.ts'), 'export const V = 99\n')
    const { update, restarts } = make()
    const r = await send(update, repo.b)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('git-dirty')
    expect(String(r.body.detail)).toContain('src/adapters/paths.ts')
    checkoutAtA('export const V = 99\n')
    nothingBeside()
    expect(restarts).toEqual([])
    expect(update.busy()).toBe(false)
  })

  test('a commit of its own on no remote: refused, the commit kept', async () => {
    cloneAtA()
    writeFileSync(join(root, 'mine.txt'), 'mine\n')
    g(root, 'add', 'mine.txt')
    g(root, 'commit', '-q', '-m', 'mine')
    const mine = g(root, 'rev-parse', 'HEAD')
    const { update, restarts } = make()
    const r = await send(update, repo.b)
    expect(r.body.error).toBe('git-ahead')
    expect(g(root, 'rev-parse', 'HEAD')).toBe(mine)
    expect(text(root, 'mine.txt')).toBe('mine\n')
    nothingBeside()
    expect(restarts).toEqual([])
  })

  test('a detached HEAD with a commit of its own: refused, not checked out away from it', async () => {
    cloneAtA()
    g(root, 'checkout', '-q', '--detach')
    writeFileSync(join(root, 'mine.txt'), 'mine\n')
    g(root, 'add', 'mine.txt')
    g(root, 'commit', '-q', '-m', 'mine')
    const mine = g(root, 'rev-parse', 'HEAD')
    const { update } = make()
    expect((await send(update, repo.b)).body.error).toBe('git-ahead')
    expect(g(root, 'rev-parse', 'HEAD')).toBe(mine)
  })

  test('a commit the remote does not have: refused', async () => {
    cloneAtA()
    const { update } = make()
    const r = await send(update, 'c'.repeat(40))
    expect(r.body.error).toBe('git-commit')
    checkoutAtA()
    nothingBeside()
  })

  test('a branch that does not lead to the commit: refused, the branch where it was', async () => {
    g(dir, 'clone', '-q', repo.dir, root)
    const { update, restarts } = make()
    // the node is on B already; the master names A, which B does not fast-forward to
    const r = await send(update, repo.a)
    expect(r.body.error).toBe('git-diverged')
    expect(g(root, 'rev-parse', 'HEAD')).toBe(repo.b)
    expect(existsSync(join(root, '.git'))).toBe(true)
    nothingBeside()
    expect(restarts).toEqual([])
  })

  test('a remote that cannot be fetched: refused', async () => {
    cloneAtA()
    g(root, 'remote', 'set-url', 'origin', join(dir, 'gone'))
    const { update } = make()
    expect((await send(update, repo.b)).body.error).toBe('git-fetch')
    checkoutAtA()
  })
})

describe('a folder beside the plugin that holds a .git is kept', () => {
  /** An archive install at A, as the node has it. */
  function archiveAtA(): void {
    mkdirSync(join(root, 'src', 'adapters'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{ "name": "scratch-plugin", "version": "0.1.0", "dependencies": {} }\n')
    writeFileSync(join(root, 'src', 'adapters', 'paths.ts'), 'export const V = 1\n')
    writeFileSync(join(root, '.archive-commit'), `${repo.a}\n`)
  }
  const stub = { install: async () => ({ ok: true, detail: '' }), check: async () => ({ ok: true, detail: '' }) }

  for (const platform of ['linux', 'win32']) {
    test(`a .old with a .git: the update is refused, the .old and its .git kept (${platform})`, async () => {
      archiveAtA()
      const { old } = besidePlugin(root)
      g(dir, 'clone', '-q', repo.dir, old)
      const { update, restarts } = make(
        { commit: async () => repo.a, platform, guard: () => never('guard')(), ...stub },
        true,
      )
      const r = await send(update, repo.b)
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('kept-old')
      expect(String(r.body.detail)).toContain(old)
      expect(g(old, 'rev-parse', 'HEAD')).toBe(repo.b)
      expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
      expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
      expect(existsSync(besidePlugin(root).fresh)).toBe(false)
      expect(restarts).toEqual([])
      expect(update.busy()).toBe(false)
    })
  }

  test('a .new with a .git file (a worktree) is kept too', async () => {
    archiveAtA()
    const { fresh } = besidePlugin(root)
    mkdirSync(fresh)
    writeFileSync(join(fresh, '.git'), 'gitdir: /somewhere/else\n')
    const { update } = make({ commit: async () => repo.a, ...stub }, true)
    expect((await send(update, repo.b)).body.error).toBe('kept-old')
    expect(text(fresh, '.git')).toBe('gitdir: /somewhere/else\n')
  })

  test('an archive that carries a .git is refused before anything is written', async () => {
    archiveAtA()
    const { update } = make({ commit: async () => repo.a, ...stub }, true)
    const archive = tarOf(
      [
        { name: '.git/', type: '5' },
        { name: '.git/HEAD', data: 'ref' },
        { name: 'src/adapters/paths.ts', data: 'export const V = 9\n' },
      ],
      { comment: repo.b },
    )
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r).toEqual({ status: 422, body: { ok: false, error: 'archive', detail: 'the archive holds a .git' } })
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(existsSync(besidePlugin(root).fresh)).toBe(false)
  })

  test('an archive install with a plain .old goes the archive way as before: the .old replaced', async () => {
    archiveAtA()
    const { old } = besidePlugin(root)
    mkdirSync(old)
    writeFileSync(join(old, 'stale.ts'), 'stale')
    const { update, restarts } = make({ commit: async () => repo.a, ...stub }, true)
    expect(await send(update, repo.b)).toEqual({ status: 200, body: { ok: true, commit: repo.b, restarting: true } })
    expect(text(root, '.archive-commit')).toBe(`${repo.b}\n`)
    expect(text(root, 'src', 'b.ts')).toBe('export const B = true\n')
    expect(existsSync(join(old, 'stale.ts'))).toBe(false)
    expect(text(old, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(restarts).toEqual([old])
  })
})

describe('the update files never remove or move a .git', () => {
  test('holdsGit: a .git folder or a .git file; nothing else', () => {
    const a = join(dir, 'a')
    mkdirSync(join(a, '.git'), { recursive: true })
    const b = join(dir, 'b')
    mkdirSync(b)
    writeFileSync(join(b, '.git'), 'gitdir: x\n')
    const c = join(dir, 'c')
    mkdirSync(c)
    expect([holdsGit(a), holdsGit(b), holdsGit(c), holdsGit(join(dir, 'none'))]).toEqual([true, true, false, false])
  })

  test('swapIn refuses a plugin or a .old with a .git before anything moves', () => {
    const r = join(dir, 'p')
    const fresh = join(dir, 'p.new')
    const old = join(dir, 'p.old')
    for (const at of [r, fresh, old]) mkdirSync(at)
    writeFileSync(join(r, 'a.ts'), 'A')
    writeFileSync(join(fresh, 'a.ts'), 'B')
    mkdirSync(join(old, '.git'))
    writeFileSync(join(old, '.git', 'HEAD'), 'ref')
    expect(() => swapIn(r, fresh, old)).toThrow('.git')
    expect(text(old, '.git', 'HEAD')).toBe('ref')
    expect(text(r, 'a.ts')).toBe('A')
    rmSync(join(old, '.git'), { recursive: true })
    writeFileSync(join(r, '.git'), 'gitdir: x\n')
    expect(() => swapIn(r, fresh, old)).toThrow('.git')
    expect(text(r, '.git')).toBe('gitdir: x\n')
    expect(text(r, 'a.ts')).toBe('A')
  })

  test('removeTree and writeTree keep a folder that holds a .git', () => {
    const at = join(dir, 'x')
    mkdirSync(join(at, '.git'), { recursive: true })
    writeFileSync(join(at, '.git', 'HEAD'), 'ref')
    expect(() => removeTree(at)).toThrow('.git')
    expect(() => writeTree(at, [])).toThrow('.git')
    expect(text(at, '.git', 'HEAD')).toBe('ref')
  })
})

describe('the installer after a checkout was updated by git', () => {
  const markFile = (): string => join(dir, 'state', 'node', 'update', 'installer.json')
  const steps = () => {
    const calls: string[] = []
    return {
      calls,
      deps: {
        backupSettings: () => {
          calls.push('backup')
          return []
        },
        installer: async () => {
          calls.push('installer')
          return { ok: true, detail: '' }
        },
      } satisfies Partial<NodeUpdateDeps>,
    }
  }

  test('a refused update leaves no file; the one that moves the checkout leaves it, and the board that comes back runs the installer', async () => {
    const { calls, deps } = steps()
    cloneAtA()
    writeFileSync(join(root, 'src', 'adapters', 'paths.ts'), 'export const V = 99\n')
    const refused = make(deps)
    expect((await send(refused.update, repo.b)).body.error).toBe('git-dirty')
    expect(existsSync(markFile())).toBe(false)
    g(root, 'checkout', '-q', '--', 'src/adapters/paths.ts')
    const { update, restarts } = make(deps)
    expect((await send(update, repo.b)).status).toBe(200)
    expect(restarts).toEqual([root])
    expect(JSON.parse(text(markFile()))).toMatchObject({ from: repo.a, to: repo.b })
    // the board that handed it over leaves the file to the one that comes back
    await update.started()
    expect(calls).toEqual([])
    const back = make(deps)
    await back.update.started()
    expect(calls).toEqual(['backup', 'installer'])
    expect(existsSync(markFile())).toBe(false)
    expect(back.logs.join('\n')).toContain(`the installer ran after the update to ${repo.b.slice(0, 12)}`)
  })

  test('on Windows, with no record and no guard, the file alone lets the installer run', async () => {
    const { calls, deps } = steps()
    cloneAtA()
    const win = { platform: 'win32', guard: never('guard'), go: never('go'), ...deps }
    expect((await send(make(win).update, repo.b)).status).toBe(200)
    expect(existsSync(join(dir, 'state', 'node', 'update', 'pending.json'))).toBe(false)
    expect(existsSync(markFile())).toBe(true)
    await make(win).update.started()
    expect(calls).toEqual(['backup', 'installer'])
    expect(existsSync(markFile())).toBe(false)
  })
})
