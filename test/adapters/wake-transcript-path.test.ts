// herdr-wake's transcript-path test, against the board's own reader (createClaudeHome), which
// wake uses in every profile folder.
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeHome } from '../../src/adapters/claude-home.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('transcript path follows the cwd slug, else any project folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-wake-projects-'))
  made.push(root)
  const projects = join(root, 'projects')
  mkdirSync(join(projects, 'C--Work-Acme'), { recursive: true })
  mkdirSync(join(projects, 'C--Elsewhere'))
  writeFileSync(join(projects, 'stray-file.txt'), '')
  writeFileSync(join(projects, 'C--Work-Acme', 'abc.jsonl'), '')
  writeFileSync(join(projects, 'C--Elsewhere', 'moved.jsonl'), '')
  const home = createClaudeHome(root)
  assert.equal(home.transcriptPath('abc', 'C:\\Work\\Acme\\'), join(projects, 'C--Work-Acme', 'abc.jsonl'))
  assert.equal(home.transcriptPath('moved', 'C:\\Work\\Acme'), join(projects, 'C--Elsewhere', 'moved.jsonl'))
  assert.equal(home.transcriptPath('missing', 'C:\\Work\\Acme'), null)
})
