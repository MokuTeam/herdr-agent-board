// The board's own messages at the foot of the thread until the transcript shows them (upstream's
// test/queue.test.mjs at b5a96b8, its web/outbox.js part).
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { holds, messageKey, newestAt, type OutState, sentKey, unsettled } from '../../web/src/models/outbox.ts'
import { T0 } from '../support/queue-fixtures.ts'

test("the board's message is found in what the transcript shows", () => {
  // Claude Code's paste wrapper, image marks, paths (sometimes changed on the way), blank lines.
  assert.equal(
    messageKey(
      '[Image #1]\n\n<pasted_content id="7952">\nFirst  line\n\nSecond\nFiles:\nC:\\w\\pluginsgent-board\\a.txt\n</pasted_content id="7952">',
    ),
    'First line Second Files:',
  )
  const key = sentKey('First line\n\nSecond', 'Files:')
  assert.equal(key, 'First line Second')
  assert.ok(
    holds(
      '[Image #1]\n\n<pasted_content id="7952">\nFirst line\nSecond\nFiles:\n</pasted_content id="7952">\n\nplain one',
      key,
    ),
  )
  assert.ok(
    holds(
      '[Image #1]\n\n<pasted_content id="7952">\nFirst line\nSecond\nFiles:\n</pasted_content id="7952">\n\nplain one',
      sentKey('plain one', 'Files:'),
    ),
  )
  assert.ok(!holds('First line Secondary', key)) // words, not letters
  assert.ok(!holds('anything', ''))
  // Only files: the line that names them.
  assert.equal(sentKey('', 'Files:'), 'Files:')
  assert.ok(holds('[Image #2]\nFiles:', sentKey('', 'Files:')))
  // A long message comes clipped.
  const long = 'word '.repeat(700).trim()
  assert.ok(holds(`${long.slice(0, 2999)}…`, sentKey(long, 'Files:')))
})

test("the board's bubble stays until the transcript shows the message after it was sent", () => {
  const entry = (id: string, text: string, state: OutState = 'sending', more = {}) => ({
    id,
    text,
    key: sentKey(text, 'Files:'),
    after: T0 + 5_000,
    state,
    sentAt: 0,
    ...more,
  })
  const list = [entry('a', 'ok'), entry('b', 'second thing', 'sent', { sentAt: 1000 }), entry('c', 'broken', 'failed')]
  const ids = (left: { id: string }[]) => left.map(e => e.id)
  // An older "ok" is not this one.
  assert.deepEqual(ids(unsettled(list, { conversation: [{ role: 'user', text: 'ok', at: T0 }] }, 2000)), [
    'a',
    'b',
    'c',
  ])
  // In the queue now, or a user line already (an idle session takes it at once).
  assert.deepEqual(
    ids(
      unsettled(
        list,
        {
          queued: [{ text: 'ok', at: T0 + 6_000 }],
          conversation: [{ role: 'user', text: 'second thing', at: T0 + 7_000 }],
        },
        2000,
      ),
    ),
    ['c'],
  )
  // An assistant's words are not the message.
  assert.deepEqual(ids(unsettled(list, { conversation: [{ role: 'assistant', text: 'ok', at: T0 + 6_000 }] }, 2000)), [
    'a',
    'b',
    'c',
  ])
  // Sent, but never seen in the transcript: it goes after a while; a failed one stays.
  assert.deepEqual(ids(unsettled(list, {}, 40_000)), ['a', 'c'])
  assert.equal(
    newestAt({
      conversation: [
        { role: 'user', at: 5 },
        { role: 'tool', at: 9 },
      ],
      queued: [{ text: '', at: 7 }],
    }),
    9,
  )
  assert.equal(newestAt(null), 0)
})
