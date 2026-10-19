import { onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLinks } from '../../src/adapters/links.ts'
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
