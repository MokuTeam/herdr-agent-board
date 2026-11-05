import { onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLinks, type FoundEvent } from '../../src/adapters/links.ts'
import type { LinkEvent } from '../../src/core/links.ts'
import { type Line, line } from '../support/helper-fixtures.ts'

const main = (o: Line) => JSON.stringify({ ...o, isSidechain: false })
const toOf = (events: LinkEvent[]) => events.map(e => (e.kind === 'sent' ? e.to : e.kind))

test('the index reads each transcript once, then only what it gained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-links-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 's.jsonl')
  const big = 'x'.repeat(5 << 20) // a pasted screenshot: longer than a read
  writeFileSync(
    file,
    [main(line.user(0, big)), main(line.call(1, 'sm', 'SendMessage', { to: 'a', message: 'one' })), ''].join('\n'),
  )
  let changes = 0
  const links = createLinks({ onChange: () => changes++ })
  const settle = async () => {
    for (let i = 0; i < 200 && !links.idle(); i++) await new Promise(r => setTimeout(r, 10))
  }
  links.update([file])
  await settle()
  assert.deepEqual(toOf(links.events(file)), ['a'])
  assert.equal(changes, 1)
  // An agent the session named: the scan reads its call too, so a message to it is no session's.
  appendFileSync(
    file,
    [
      main(line.call(1.5, 'ag', 'Agent', { name: 'reviewer', prompt: 'x' })),
      main(line.call(1.6, 'sm9', 'SendMessage', { to: 'reviewer', message: 'more' })),
      '',
    ].join('\n'),
  )
  links.update([file])
  await settle()
  assert.deepEqual(toOf(links.events(file)), ['a'])
  // A line still being written is not read until it is whole.
  appendFileSync(file, main(line.call(2, 'sm2', 'SendMessage', { to: 'b', message: 'two' })).slice(0, 40))
  links.update([file])
  await settle()
  assert.equal(links.events(file).length, 1)
  appendFileSync(file, `${main(line.call(2, 'sm2', 'SendMessage', { to: 'b', message: 'two' })).slice(40)}\n`)
  links.update([file])
  await settle()
  assert.deepEqual(toOf(links.events(file)), ['a', 'b'])
  assert.equal(changes, 2)
  // Nothing new: no change to report.
  links.update([file, join(dir, 'missing.jsonl')])
  await settle()
  assert.equal(changes, 2)
})

test('#280: each new event comes with where it was read, across reads; none without onEvents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-links-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 's-9.jsonl')
  const big = 'x'.repeat(5 << 20) // a line longer than a read: the offsets go on after it
  const lines = [
    main(line.user(0, big)),
    JSON.stringify({
      ...line.call(1, 'sm', 'SendMessage', { to: 'a', message: 'one' }),
      isSidechain: false,
      uuid: 'u1',
      sessionId: 's-9',
    }),
    // no sessionId: the transcript's name says whose
    JSON.stringify({
      ...line.call(2, 'hp', 'Bash', { command: 'herdr pane send-keys w:p2 Enter' }),
      isSidechain: false,
      uuid: 'u2',
    }),
  ]
  writeFileSync(file, `${lines.join('\n')}\n`)
  const found: FoundEvent[] = []
  const links = createLinks({ onEvents: (path, f) => found.push(...f.map(x => ({ ...x, path }))) })
  const settle = async () => {
    for (let i = 0; i < 200 && !links.idle(); i++) await new Promise(r => setTimeout(r, 10))
  }
  links.update([file])
  await settle()
  const start = (i: number) => lines.slice(0, i).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  assert.deepEqual(
    found.map(f => [f.event.kind, f.source.offset, f.source.uuid, f.source.session, f.source.transcript]),
    [
      ['sent', start(1), 'u1', 's-9', file],
      ['prompted', start(2), 'u2', 's-9', file],
    ],
  )
  appendFileSync(file, `${main(line.call(3, 'sm3', 'SendMessage', { to: 'b', message: 'two' }))}\n`)
  links.update([file])
  await settle()
  assert.deepEqual(
    found.slice(2).map(f => [f.event.kind, f.source.offset]),
    [['sent', start(3)]],
  )
  assert.deepEqual(toOf(links.events(file)), ['a', 'prompted', 'b'])
  // A prompt alone changes nothing on the board: no refresh of its own, but it is found.
  let changes = 0
  const quiet = createLinks({ onChange: () => changes++, onEvents: (_p, f) => found.push(...f) })
  quiet.update([file])
  for (let i = 0; i < 200 && !quiet.idle(); i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(changes, 1)
  appendFileSync(file, `${main(line.call(4, 'hp4', 'Bash', { command: 'herdr agent prompt b hi' }))}\n`)
  quiet.update([file])
  for (let i = 0; i < 200 && !quiet.idle(); i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(changes, 1)
  assert.equal(found.at(-1)?.event.kind, 'prompted')
})
