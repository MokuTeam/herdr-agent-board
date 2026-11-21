// The commit a plugin unpacked from `git archive` was made at (#509, adapters/git.ts archiveStamp):
// the node's status reports it where git finds no checkout, so the placer sees the master's commit.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveStamp } from '../../src/adapters/git.ts'
import { ARCHIVE_COMMIT_FILE } from '../../src/core/node-texts.ts'

test('the stamp a node install wrote is the commit; anything else, or none, is no commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-stamp-'))
  try {
    expect(archiveStamp(dir)).toBeNull()
    writeFileSync(join(dir, ARCHIVE_COMMIT_FILE), `${'ab'.repeat(20)}\n`)
    expect(archiveStamp(dir)).toBe('ab'.repeat(20))
    writeFileSync(join(dir, ARCHIVE_COMMIT_FILE), 'main\n')
    expect(archiveStamp(dir)).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
