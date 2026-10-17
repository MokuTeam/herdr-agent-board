import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { type LinkEvent, type LinkItem, lineEvents, newState, relate } from '../../src/core/links.ts'
import { type Line, line, T0 } from '../support/helper-fixtures.ts'

const main = (o: Line) => JSON.stringify({ ...o, isSidechain: false })
const peerLine = (s: number, name: string, pipe: string, id: string, body: string) =>
  main(line.user(s, 'x', { isMeta: true, origin: { kind: 'peer', from: pipe, name, msg_id: id, body } }))

test('events in transcript lines: sessions started, messages sent and received', () => {
  const st = newState()
  // spawn-agent: the call waits for what it printed.
  assert.deepEqual(
    lineEvents(main(line.call(1, 'sp', 'Bash', { command: 'spawn-agent -Name case-42 -Cwd C:\\w' })), st),
    [],
  )
  assert.deepEqual(lineEvents(main(line.result(2, 'sp', 'pane=wP:p3D name=case-42 agent=case-42')), st), [
    { kind: 'spawn', name: 'case-42', pane: 'wP:p3D', at: T0 + 1000 },
  ])
  // One that failed starts nothing.
  lineEvents(main(line.call(3, 'sp2', 'Bash', { command: 'spawn-agent -Name x -Cwd y' })), st)
  assert.deepEqual(lineEvents(main(line.result(4, 'sp2', 'No such folder: y')), st), [])
  // A request record repeats the call: one event.
  const send = main(
    line.call(5, 'sm', 'SendMessage', { to: 'Billing-master [3fa9c1]', summary: 'Hours', message: 'All in.' }),
  )
  assert.deepEqual(lineEvents(send, st), [
    { kind: 'sent', to: 'Billing-master', name: '', summary: 'Hours', at: T0 + 5000 },
  ])
  assert.deepEqual(lineEvents(send, st), [])
  // A message in, queued into a turn and then shown again: one event; a reply to its pipe names it.
  const pipe = 'uds:\\\\.\\pipe\\x1'
  assert.deepEqual(lineEvents(peerLine(6, 'Billing-master', pipe, 'm1', 'Done for today?\nmore'), st), [
    { kind: 'received', name: 'Billing-master', pipe, id: 'm1', text: 'Done for today?', at: T0 + 6000 },
  ])
  const queued = {
    type: 'attachment',
    timestamp: new Date(T0).toISOString(),
    attachment: { type: 'queued_command', origin: { kind: 'peer', from: pipe, name: 'Billing-master', msg_id: 'm1' } },
  }
  assert.deepEqual(lineEvents(JSON.stringify(queued), st), [])
  const reply = lineEvents(main(line.call(7, 'rp', 'SendMessage', { to: pipe, message: 'Yes.' })), st)[0]
  assert.equal(reply?.kind === 'sent' && reply.name, 'Billing-master')
  // A broadcast, the session's own side ("main", the team lead) and an agent it named are no session.
  assert.deepEqual(lineEvents(main(line.call(9, 'b1', 'SendMessage', { to: '*', message: 'all' })), st), [])
  lineEvents(main(line.call(10, 'ag', 'Agent', { name: 'reviewer', prompt: 'x' })), st)
  assert.deepEqual(lineEvents(main(line.call(11, 'b2', 'SendMessage', { to: 'reviewer', message: 'more' })), st), [])
  // A subagent's own lines and other records are not the session's.
  assert.deepEqual(lineEvents(JSON.stringify(line.call(8, 'x', 'SendMessage', { to: 'a', message: 'b' })), st), [])
  const blob = {
    type: 'api-request-blob',
    message: { content: [{ type: 'tool_use', id: 'z', name: 'SendMessage', input: { to: 'a', message: 'b' } }] },
  }
  assert.deepEqual(lineEvents(JSON.stringify(blob), st), [])
  assert.deepEqual(lineEvents('{not json', st), [])
})

test("links between the board's sessions", () => {
  const items: LinkItem[] = [
    { key: 'm', name: 'Master', autoName: 'Master', pane: 'w:p1', pipe: '\\\\.\\pipe\\m' },
    { key: 'c', name: 'My case', autoName: 'case-42', pane: 'w:p2', pipe: '\\\\.\\pipe\\c' },
    { key: 'o', name: 'Other', autoName: 'Other', pane: 'w:p3', pipe: '' },
    { key: 'd1', name: 'Twin', autoName: 'Twin', pane: 'w:p4' },
    { key: 'd2', name: 'Twin', autoName: 'Twin', pane: 'w:p5' },
    { key: 'e', name: '🔧', autoName: '🔧', pane: 'w:p6' }, // a name with no letters
  ]
  const sent = (to: string, at: number, name = ''): LinkEvent => ({ kind: 'sent', to, name, summary: '', at })
  const received = (name: string, pipe: string, at: number): LinkEvent => ({
    kind: 'received',
    name,
    pipe,
    id: '',
    text: '',
    at,
  })
  const events: Record<string, LinkEvent[]> = {
    m: [
      { kind: 'spawn', name: 'case-42', pane: 'w:p2', at: 10 },
      { kind: 'spawn', name: 'case-41', pane: 'w:p3', at: 5 }, // that pane holds another session now
      sent('case 42', 20),
      sent('Twin', 21), // two sessions go by that name: no guess
      sent('Nobody', 22),
      sent('🔧', 23), // matches nothing: no letters to match on
      received('renamed meanwhile', 'uds:\\\\.\\pipe\\c', 30),
    ],
    c: [
      received('Master', 'uds:\\\\.\\pipe\\gone', 15), // its old pipe: by name
      sent('uds:\\\\.\\pipe\\gone', 16, 'Master'),
      sent('My case', 17), // itself
    ],
  }
  const rel = relate(items, it => events[it.key])
  assert.deepEqual(rel.get('c')?.from, { key: 'm', name: 'Master', at: 10 })
  assert.deepEqual(rel.get('m')?.started, [{ key: 'c', name: 'My case', at: 10 }])
  assert.equal(rel.get('o')?.from, null)
  assert.deepEqual(rel.get('m')?.talks, [{ key: 'c', name: 'My case', in: 1, out: 1, at: 30 }])
  assert.deepEqual(rel.get('c')?.talks, [{ key: 'm', name: 'Master', in: 1, out: 1, at: 16 }])
  assert.deepEqual(rel.get('d1'), { from: null, started: [], talks: [] })
  assert.deepEqual(rel.get('e')?.talks, [])
})
