// A session's thread and its queue from one read of its transcript (upstream's
// test/queue.test.mjs at b5a96b8: "the thread and the queue come from one read").
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeHome, readConversation, readSessionThread } from '../../src/adapters/claude-home.ts'
import { busy, jsonl, q } from '../support/queue-fixtures.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('the thread and the queue come from one read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-queue-'))
  made.push(dir)
  const file = join(dir, 's1.jsonl')
  writeFileSync(file, jsonl([...busy, q(10, 'enqueue', 'later please')]))
  const { conversation, queued: waiting } = readSessionThread(file, 40)
  assert.deepEqual(
    conversation.map(m => m.role),
    ['user', 'tool'],
  )
  assert.deepEqual(
    waiting.map(m => m.text),
    ['later please'],
  )
  assert.deepEqual(readSessionThread(join(dir, 'none.jsonl')), { conversation: [], queued: [] })
  // The same through a home; its conversation() keeps its result.
  const home = createClaudeHome(dir)
  assert.deepEqual(home.sessionThread(file, 40), { conversation, queued: waiting })
  assert.deepEqual(home.conversation(file, 40), conversation)
  assert.deepEqual(readConversation(file, 40), conversation)
})
