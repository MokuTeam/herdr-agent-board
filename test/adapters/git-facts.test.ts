// The git facts the portability rule reads (design: docs/design/nodes, 8.4, and 14, T7), on
// temp repositories with a local bare repository as the remote: no network, no fetch.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchPushed, checkoutFacts } from '../../src/adapters/git.ts'

// Each test runs a dozen git commands; on a busy Windows machine one takes a few hundred ms.
const GIT_MS = 30_000

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(dir)
  return dir
}

const git = (dir: string, args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-C',
      dir,
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )

function commit(dir: string, name: string, text = name) {
  writeFileSync(join(dir, name), `${text}\n`)
  git(dir, ['add', name])
  git(dir, ['commit', '--quiet', '-m', name])
}

// One bare repository with a commit on main and one clone of it, made once: a push or a clone
// costs git seconds on Windows. Each test takes a copy of the clone, whose origin is that bare
// repository, and `record` writes what a push records in the clone (the remote branch and the
// upstream) without the push.
let fixture: { bare: string; clone: string }
const kept: string[] = []
beforeAll(() => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'board-git-facts-')))
  kept.push(top)
  const bare = join(top, 'remote.git')
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare])
  const seed = join(top, 'seed')
  mkdirSync(seed)
  git(seed, ['init', '--quiet', '--initial-branch=main'])
  commit(seed, 'readme.txt')
  git(seed, ['push', '--quiet', bare, 'main'])
  const clone = join(top, 'clone')
  execFileSync('git', ['clone', '--quiet', bare, clone])
  fixture = { bare, clone }
}, 60_000)
afterAll(() => {
  for (const dir of kept) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function cloned() {
  const dir = join(temp('board-clone-'), 'work')
  cpSync(fixture.clone, dir, { recursive: true })
  return { bare: fixture.bare, dir }
}

/** What `git push -u <remote> <branch>` leaves in the clone: the remote branch at the local one, and the upstream. */
function record(dir: string, branch: string, remote = 'origin') {
  git(dir, ['update-ref', `refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`])
  git(dir, ['config', `branch.${branch}.remote`, remote])
  git(dir, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`])
}

describe('checkoutFacts', () => {
  test(
    'a clone: its root, its remote, clean, HEAD pushed; a path remote has no host/path address',
    async () => {
      const { bare, dir } = cloned()
      const facts = await checkoutFacts(dir)
      expect(facts).toEqual({
        root: dir,
        remote: { name: 'origin', url: bare, address: null },
        clean: true,
        headPushed: true,
      })
    },
    GIT_MS,
  )

  test(
    'from a subfolder, the checkout root; a hosted remote is host/path',
    async () => {
      const { dir } = cloned()
      git(dir, ['remote', 'set-url', 'origin', 'git@github.com:MokuTeam/herdr-agent-board.git'])
      const sub = join(dir, 'sub')
      mkdirSync(sub)
      const facts = await checkoutFacts(sub)
      expect(facts?.root).toBe(dir)
      expect(facts?.remote).toEqual({
        name: 'origin',
        url: 'git@github.com:MokuTeam/herdr-agent-board.git',
        address: 'github.com/MokuTeam/herdr-agent-board',
      })
    },
    GIT_MS,
  )

  test(
    'no checkout: null; a checkout with no remote: remote null and HEAD not pushed',
    async () => {
      expect(await checkoutFacts(temp('board-no-git-'))).toBeNull()
      const dir = temp('board-local-')
      git(dir, ['init', '--quiet', '--initial-branch=main'])
      commit(dir, 'a.txt')
      expect(await checkoutFacts(dir)).toEqual({ root: dir, remote: null, clean: true, headPushed: false })
    },
    GIT_MS,
  )

  test(
    'changes in the tree: a changed file, a staged one, an untracked one',
    async () => {
      const { dir } = cloned()
      writeFileSync(join(dir, 'readme.txt'), 'changed\n')
      expect((await checkoutFacts(dir))?.clean).toBe(false)
      git(dir, ['add', 'readme.txt'])
      expect((await checkoutFacts(dir))?.clean).toBe(false)
      git(dir, ['reset', '--quiet', '--hard'])
      expect((await checkoutFacts(dir))?.clean).toBe(true)
      writeFileSync(join(dir, 'new.txt'), 'new\n')
      expect((await checkoutFacts(dir))?.clean).toBe(false)
    },
    GIT_MS,
  )

  test(
    'commits not pushed, then pushed; a branch with no upstream is not pushed',
    async () => {
      const { dir } = cloned()
      commit(dir, 'b.txt')
      expect(await checkoutFacts(dir)).toMatchObject({ clean: true, headPushed: false })
      git(dir, ['push', '--quiet', 'origin', 'main'])
      expect(await checkoutFacts(dir)).toMatchObject({ clean: true, headPushed: true })
      git(dir, ['checkout', '--quiet', '-b', 'topic'])
      expect(await checkoutFacts(dir)).toMatchObject({ headPushed: false, remote: { name: 'origin' } })
      record(dir, 'topic')
      expect(await checkoutFacts(dir)).toMatchObject({ headPushed: true })
    },
    GIT_MS,
  )

  test(
    'the remote the upstream is on, not origin, when they differ',
    async () => {
      const { dir } = cloned()
      git(dir, ['remote', 'add', 'mirror/eu', 'https://example.invalid/team/repo.git'])
      record(dir, 'main', 'mirror/eu')
      expect(await checkoutFacts(dir)).toMatchObject({
        remote: { name: 'mirror/eu', address: 'example.invalid/team/repo' },
        headPushed: true,
      })
    },
    GIT_MS,
  )
})

describe('branchPushed', () => {
  test(
    'a new worktree from a pushed branch, and from one with commits not pushed',
    async () => {
      const { dir } = cloned()
      expect(await branchPushed(dir, 'main')).toBe(true)
      git(dir, ['checkout', '--quiet', '-b', 'nodes/t7'])
      commit(dir, 'c.txt')
      record(dir, 'nodes/t7')
      expect(await branchPushed(dir, 'nodes/t7')).toBe(true)
      commit(dir, 'd.txt')
      expect(await branchPushed(dir, 'nodes/t7')).toBe(false)
      // Asked from a linked worktree of the same repository: the same answer.
      const linked = join(temp('board-linked-'), 'wt')
      git(dir, ['worktree', 'add', '--quiet', '-b', 'side', linked, 'main'])
      expect(await branchPushed(linked, 'nodes/t7')).toBe(false)
      expect(await branchPushed(linked, 'main')).toBe(true)
    },
    GIT_MS,
  )

  test(
    'a branch never pushed, one with no upstream but the same commit on the remote, a remote branch itself',
    async () => {
      const { dir } = cloned()
      git(dir, ['branch', '--quiet', 'local-only'])
      commit(dir, 'e.txt')
      git(dir, ['branch', '--quiet', 'ahead'])
      expect(await branchPushed(dir, 'ahead')).toBe(false)
      // local-only is at origin/main's commit but there is no origin/local-only.
      expect(await branchPushed(dir, 'local-only')).toBe(false)
      git(dir, ['update-ref', 'refs/remotes/origin/local-only', 'refs/heads/local-only'])
      expect(await branchPushed(dir, 'local-only')).toBe(true)
      expect(await branchPushed(dir, 'origin/main')).toBe(true)
      expect(await branchPushed(dir, 'nowhere')).toBe(false)
      expect(await branchPushed(dir, '')).toBe(false)
      expect(await branchPushed(temp('board-no-git-'), 'main')).toBe(false)
    },
    GIT_MS,
  )
})
