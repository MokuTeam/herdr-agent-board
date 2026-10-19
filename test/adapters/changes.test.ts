import { afterEach, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutChanges, gitInfo } from '../../src/adapters/git.ts'

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'board-git-'))
  cleanups.push(dir)
  // The fixture's files as written (LF), whatever the machine's core.autocrlf: git says nothing
  // about line endings on add.
  const git = (args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-C', dir, ...args],
      { encoding: 'utf8' },
    )
  git(['init', '--quiet'])
  writeFileSync(join(dir, 'tracked.txt'), 'before\n')
  git(['add', 'tracked.txt'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
  return { dir, git }
}

test('preview resolves the exact worktree, includes staged/unstaged names, preserves index and disables external diff', async () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'tracked.txt'), 'staged\n')
  git(['add', 'tracked.txt'])
  writeFileSync(join(dir, 'tracked.txt'), 'unstaged\n')
  writeFileSync(join(dir, 'new.txt'), 'not read')
  git(['config', 'diff.external', 'this-command-must-never-run'])
  const index = readFileSync(join(dir, '.git/index'))
  const out = await checkoutChanges(dir)
  assert.ok(out.available)
  assert.equal(out.root, realpathSync(dir))
  assert.match(out.diff, /unstaged/)
  assert.match(out.status, /new.txt/)
  assert.deepEqual(readFileSync(join(dir, '.git/index')), index)
  const worktree = join(dir, 'sibling')
  git(['worktree', 'add', '--quiet', '-b', 'sibling', worktree])
  writeFileSync(join(worktree, 'tracked.txt'), 'only sibling\n')
  const sibling = await checkoutChanges(worktree)
  assert.ok(sibling.available)
  assert.match(sibling.diff, /only sibling/)
  assert.doesNotMatch(sibling.diff, /unstaged/)
  assert.equal(sibling.branch, 'sibling')
  writeFileSync(join(worktree, 'tracked.txt'), 'x'.repeat(400000))
  const bounded = await checkoutChanges(worktree)
  assert.ok(bounded.available)
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.diff.length <= 256 * 1024)
})

test('missing cwd, non-repository and unborn repository are unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-no-git-'))
  cleanups.push(dir)
  assert.equal((await checkoutChanges(null)).available, false)
  assert.equal((await checkoutChanges(dir)).available, false)
  execFileSync('git', ['init', '--quiet', dir])
  assert.equal((await checkoutChanges(dir)).available, false)
})

test('gitInfo: the checkout root as the OS writes it (git prints C:/x on Windows) and the branch; null outside one', async () => {
  const { dir, git } = repo()
  git(['checkout', '--quiet', '-b', 'topic'])
  const info = await gitInfo(dir)
  expect(info).toEqual({ root: realpathSync(dir), branch: 'topic' })
  const plain = mkdtempSync(join(tmpdir(), 'board-no-git-'))
  cleanups.push(plain)
  expect(await gitInfo(plain)).toBeNull()
})
