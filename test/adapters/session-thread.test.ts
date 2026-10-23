// A session's thread and its queue from one read of its transcript (upstream's
// test/queue.test.mjs at b5a96b8: "the thread and the queue come from one read").
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeHome, readConversation, readSessionThread } from '../../src/adapters/claude-home.ts'
import { parseTranscriptTail, THREAD_TEXT_BUDGET } from '../../src/core/transcript.ts'
import { busy, jsonl, q, said, user } from '../support/queue-fixtures.ts'

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

test('messages come whole; a pasted log is cut to the thread budget; the card stays short (#174)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-whole-'))
  made.push(dir)
  const file = join(dir, 's1.jsonl')
  const prompt = `${'please read this '.repeat(400)}end of prompt`
  const answer = `${'here is what I found '.repeat(400)}end of answer`
  const log = `<pasted_content id="1">\n${'2026-10-22 build step ok\n'.repeat(12_000)}</pasted_content id="1">`
  const lines = [user(1, prompt), said(2, answer), user(3, `the log:\n${log}`), said(4, 'Read it.')]
  writeFileSync(file, jsonl(lines))
  const texts = readSessionThread(file, 40).conversation.map(m => ('text' in m ? m.text : m.role))
  assert.equal(texts.length, 4)
  assert.deepEqual([texts[0], texts[1], texts[3]], [prompt, answer, 'Read it.'])
  // The log alone is over the budget: only it is cut, and the thread's messages fit.
  assert.ok(texts[2]?.startsWith('the log:\n2026-10-22 build step ok'))
  assert.ok(texts[2]?.endsWith('…'))
  assert.equal(texts.join('').length, THREAD_TEXT_BUDGET)
  // The card reads the same end, as short as before.
  const card = parseTranscriptTail(jsonl(lines.slice(0, 2)).split('\n'))
  assert.equal(card.lastText, `${answer.slice(0, 699)}…`)
})
