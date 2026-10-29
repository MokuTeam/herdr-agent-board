// The local checkout's version without a pack (adapters/board-pack.ts boardHead): its commit, and
// whether its tracked files have changes, as the pack would carry them; none outside a checkout.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boardHead } from '../../src/adapters/board-pack.ts'

test('the commit, then local changes to a tracked file; an untracked one is not one; no checkout: none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-head-'))
  try {
    expect(await boardHead(dir)).toBeNull()
    const git = (...args: string[]): string => {
      const r = Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args])
      if (r.exitCode !== 0) throw new Error(r.stderr.toString())
      return r.stdout.toString().trim()
    }
    git('init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'a')
    const commit = git('rev-parse', 'HEAD')
    expect(await boardHead(dir)).toEqual({ commit, changes: false })
    writeFileSync(join(dir, 'new.txt'), 'untracked\n')
    expect(await boardHead(dir)).toEqual({ commit, changes: false })
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    expect(await boardHead(dir)).toEqual({ commit, changes: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
