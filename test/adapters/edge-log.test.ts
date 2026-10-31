import { onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEdgeLog, type EdgeItem } from '../../src/adapters/edge-log.ts'
import { createLinks, type FoundEvent } from '../../src/adapters/links.ts'
import { type Line, line, T0 } from '../support/helper-fixtures.ts'

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-edges-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
let n = 0
const main = (o: Line) => JSON.stringify({ ...o, isSidechain: false, sessionId: 's-m', uuid: `u${++n}` })

/** The links index over `files`, its events into `log`, read to the end. */
async function readAll(files: string[], add: (path: string, found: FoundEvent[]) => void): Promise<void> {
  const links = createLinks({ onEvents: add })
  links.update(files)
  for (let i = 0; i < 200 && !links.idle(); i++) await new Promise(r => setTimeout(r, 10))
}

test('#280: every event once, across restarts, a crash between the writes and a log in segments', async () => {
  const dir = temp()
  const logDir = join(dir, 'state', 'edge-log')
  // A Windows path with spaces and another alphabet, as Claude Code would name the transcript.
  const file = join(dir, 'Кейс 50% x.jsonl')
  writeFileSync(
    file,
    [
      main(line.user(0, 'Go.')),
      main(line.call(1, 'sp', 'Bash', { command: 'spawn-agent --name "Кейс 42" && herdr agent prompt "Кейс 42" go' })),
      main(line.result(2, 'sp', 'pane=w:p2 name=Кейс 42 agent=x')),
      main(line.call(3, 'sm', 'SendMessage', { to: 'Кейс 42', summary: 'Plan 50%', message: 'Secret plan.' })),
      main(
        line.user(4, 'x', {
          isMeta: true,
          origin: { kind: 'peer', from: 'uds:/tmp/c', name: 'Кейс 42', msg_id: 'pm1', body: 'Secret answer.' },
        }),
      ),
      '',
    ].join('\n'),
  )
  const items: EdgeItem[] = [
    { key: 'm', session: 's-m', name: 'Master one', pane: 'w:p1', transcript: file },
    { key: 'pane-w:p2', session: null, name: 'Кейс 42', pane: 'w:p2', pipe: 'uds:/tmp/c' },
  ]
  const kinds = (log = createEdgeLog({ dir: logDir })) => log.read(0).edges.map(e => e.kind)

  const log = createEdgeLog({ dir: logDir })
  await readAll([file], log.add)
  assert.equal(log.flush(items), 4)
  const { edges, next } = log.read(0)
  assert.deepEqual(
    edges.map(e => [e.seq, e.kind, e.session, e.sessionName, e.toKey, e.toName]),
    [
      [1, 'prompted', 's-m', 'Master one', 'pane-w:p2', 'Кейс 42'],
      [2, 'spawn', 's-m', 'Master one', 'pane-w:p2', 'Кейс 42'],
      [3, 'sent', 's-m', 'Master one', 'pane-w:p2', 'Кейс 42'],
      [4, 'received', 's-m', 'Master one', 'pane-w:p2', 'Кейс 42'],
    ],
  )
  assert.equal(next, 4)
  const first = edges[0]
  assert.equal(first?.transcript, file)
  assert.equal(first?.at, T0 + 1000)
  assert.ok(first?.uuid.startsWith('u'))
  // Its offset is where its line starts in the transcript, the line with its uuid.
  const at = readFileSync(file)
    .subarray(first?.offset ?? 0)
    .toString()
  assert.ok(at.startsWith('{') && (at.split('\n')[0] ?? '').includes(`"uuid":"${first?.uuid}"`))
  // Names and summaries as they are; the messages' text nowhere.
  const text = readFileSync(join(logDir, readdirSync(logDir).find(f => f.endsWith('.jsonl')) ?? ''), 'utf8')
  assert.ok(text.includes('"summary":"Plan 50%"') && text.includes('Кейс 42'))
  assert.ok(!text.includes('Secret'))
  assert.deepEqual(log.read(4), { edges: [], next: 4 })
  assert.deepEqual(
    log.read(1, 2).edges.map(e => e.seq),
    [2, 3],
  )

  // The board starts again: every transcript read from the start, nothing written twice.
  const again = createEdgeLog({ dir: logDir })
  await readAll([file], again.add)
  assert.equal(again.flush(items), 0)
  appendFileSync(file, `${main(line.call(5, 'p5', 'Bash', { command: 'herdr pane send-keys w:p2 Enter' }))}\n`)
  await readAll([file], again.add)
  assert.equal(again.flush(items), 1)
  assert.deepEqual(kinds(), ['prompted', 'spawn', 'sent', 'received', 'prompted'])

  // A crash after the lines went in and before marks.json did: the newest segment says how far.
  rmSync(join(logDir, 'marks.json'))
  const crashed = createEdgeLog({ dir: logDir })
  await readAll([file], crashed.add)
  assert.equal(crashed.flush(items), 0)
  assert.equal(crashed.read(0).next, 5)
})

test('#280: segments by size, read on across them, none removed', () => {
  const dir = temp()
  const log = createEdgeLog({ dir, segmentBytes: 900 })
  const at = (i: number): FoundEvent => ({
    event: { kind: 'prompted', target: `w:p${i}`, verb: 'pane send-text', at: i },
    source: { transcript: 'C:\\t\\s.jsonl', offset: i * 100, uuid: `u${i}`, session: 's' },
  })
  for (let i = 0; i < 12; i++) {
    log.add('C:\\t\\s.jsonl', [at(i)])
    log.flush([])
  }
  const segments = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
  assert.ok(segments.length > 2, segments.join())
  assert.equal(segments[0], 'edges-000000000001.jsonl')
  // From any cursor, a page at a time, every line in order.
  const seen: number[] = []
  for (let since = 0, guard = 0; guard < 20; guard++) {
    const page = createEdgeLog({ dir }).read(since, 5)
    if (!page.edges.length) break
    seen.push(...page.edges.map(e => e.seq))
    since = page.next
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 12 }, (_, i) => i + 1),
  )
  // Numbering goes on after a restart, in the newest segment or a new one.
  const later = createEdgeLog({ dir, segmentBytes: 900 })
  later.add('C:\\t\\s.jsonl', [at(20)])
  later.flush([])
  assert.deepEqual(
    later.read(12).edges.map(e => [e.seq, e.offset]),
    [[13, 2000]],
  )
  // A line read already, or an older one, is not added again.
  later.add('C:\\t\\s.jsonl', [at(20), at(3)])
  assert.equal(later.flush([]), 0)
})

test("#280: a fork's copied events are its source's, not logged as the fork's", () => {
  const dir = temp()
  const log = createEdgeLog({ dir })
  const src = (offset: number) => ({ transcript: '/t/f.jsonl', offset, uuid: `u${offset}`, session: 's-f' })
  log.add('/t/f.jsonl', [
    { event: { kind: 'sent', to: 'Other', name: '', summary: '', at: 5 }, source: src(0) },
    { event: { kind: 'fork', of: 's-m', at: 5 }, source: src(10) },
    { event: { kind: 'sent', to: 'Other', name: '', summary: '', at: 50 }, source: src(20) },
  ])
  const items: EdgeItem[] = [
    { key: 'f', session: 's-f', name: 'Fork', fork: { of: 's-m', at: 40 }, transcript: '/t/f.jsonl' },
    { key: 'm', session: 's-m', name: 'Master' },
  ]
  assert.equal(log.flush(items), 2)
  assert.deepEqual(
    log.read(0).edges.map(e => [e.kind, e.at, e.toKey]),
    [
      ['fork', 5, 'm'],
      ['sent', 50, null],
    ],
  )
})
