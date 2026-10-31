import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  edgeOf,
  ends,
  forkCard,
  type LinkEvent,
  type LinkItem,
  lineEvents,
  newState,
  relate,
} from '../../src/core/links.ts'
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

test('#204: a session woken in a new pane is still the one started in its old pane, by its earlier panes', () => {
  const items = [
    { key: 'm', name: 'Master', autoName: 'Master', pane: 'w:p1' },
    { key: 'c', name: 'case-42', autoName: 'case-42', pane: 'w:p9', formerPanes: ['w:p2'] },
    { key: 's', name: 'case-43', autoName: 'case-43', pane: null, formerPanes: ['w:p3'] },
  ]
  const spawn = (name: string, pane: string): LinkEvent => ({ kind: 'spawn', name, pane, at: 10 })
  const rel = relate(items, it => (it.key === 'm' ? [spawn('case-42', 'w:p2'), spawn('case-43', 'w:p3')] : []))
  assert.deepEqual(
    rel
      .get('m')
      ?.started.map(s => s.key)
      .sort(),
    ['c', 's'],
  )
  assert.deepEqual(rel.get('s')?.from, { key: 'm', name: 'Master', at: 10 })
  // Its old pane under another name is another session's.
  assert.deepEqual(relate(items, it => (it.key === 'm' ? [spawn('other', 'w:p2')] : [])).get('m')?.started, [])
})

const SOURCE = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('a fork’s copied lines are its source’s: the first says whose fork it is, none of them is the fork’s own', () => {
  const st = newState()
  const copied = (o: Line) =>
    JSON.stringify({ ...o, isSidechain: false, forkedFrom: { sessionId: SOURCE, messageUuid: 'u' } })
  // The source's spawn-agent call and what it printed, a message it sent: copied, so no events.
  assert.deepEqual(lineEvents(copied(line.user(1, 'go')), st), [{ kind: 'fork', of: SOURCE, at: T0 + 1000 }])
  assert.deepEqual(
    lineEvents(copied(line.call(2, 'sp', 'Bash', { command: 'spawn-agent -Name case-42 -Cwd C:\\w' })), st),
    [],
  )
  assert.deepEqual(lineEvents(copied(line.result(3, 'sp', 'pane=wP:p3D name=case-42 agent=case-42')), st), [])
  assert.deepEqual(lineEvents(copied(line.call(4, 'sm', 'SendMessage', { to: 'Master', message: 'hi' })), st), [])
  // The fork's own work after them counts as any session's.
  lineEvents(main(line.call(5, 'sp2', 'Bash', { command: 'spawn-agent -Name helper -Cwd C:\\w' })), st)
  assert.deepEqual(lineEvents(main(line.result(6, 'sp2', 'pane=wP:p4 name=helper agent=helper')), st), [
    { kind: 'spawn', name: 'helper', pane: 'wP:p4', at: T0 + 5000 },
  ])
  // A line that only talks about forkedFrom (in a message's text, its quotes escaped) is no copy.
  const talk = main(line.user(7, 'the copies say "forkedFrom":{"sessionId":"x"}'))
  assert.equal(lineEvents(talk, newState()).length, 0)
})

test('a fork links to the session it is a fork of, whoever started it; a source not on the board links nothing', () => {
  const items: LinkItem[] = [
    { key: SOURCE, session: SOURCE, name: 'Acme', pane: 'w:p1' },
    { key: 'f', session: 'f', name: 'Acme · fork', autoName: 'acme-fork', pane: 'w:p2' },
    { key: 'h', session: 'h', name: 'Helper', pane: 'w:p3' },
    { key: 'g', session: 'g', name: 'Orphan', pane: 'w:p4' },
  ]
  const events: Record<string, LinkEvent[]> = {
    // Another session ran spawn-agent --fork: it started the fork, the fork is the source's.
    h: [{ kind: 'spawn', name: 'acme-fork', pane: 'w:p2', at: 20 }],
    f: [{ kind: 'fork', of: SOURCE, at: 10 }],
    g: [{ kind: 'fork', of: 'not-here', at: 10 }],
  }
  const rel = relate(items, it => events[it.key])
  assert.deepEqual(rel.get('f')?.from, { key: SOURCE, name: 'Acme', at: 10, fork: true })
  assert.deepEqual(rel.get(SOURCE)?.started, [{ key: 'f', name: 'Acme · fork', at: 10, fork: true }])
  assert.deepEqual(rel.get('h')?.started, [{ key: 'f', name: 'Acme · fork', at: 20 }])
  assert.equal(rel.get('g')?.from, null)
})

test('a fork its card names: its events from before it started are its source’s, and it links to that one', () => {
  const items: LinkItem[] = [
    { key: SOURCE, session: SOURCE, name: 'Acme', pane: 'w:p1' },
    { key: 'f', session: 'f', name: 'Acme · fork', pane: 'w:p2', fork: { of: SOURCE, at: 100 } },
    { key: 'c', session: 'c', name: 'Case', autoName: 'case-42', pane: 'w:p3' },
  ]
  const events: Record<string, LinkEvent[]> = {
    // Its source started Case; the fork's transcript has a copy of that call, from before it started.
    [SOURCE]: [{ kind: 'spawn', name: 'case-42', pane: 'w:p3', at: 50 }],
    f: [
      { kind: 'spawn', name: 'case-42', pane: 'w:p3', at: 50 },
      { kind: 'sent', to: 'Case', name: '', summary: '', at: 60 },
      { kind: 'sent', to: 'Case', name: '', summary: '', at: 120 },
    ],
  }
  const rel = relate(items, it => events[it.key])
  assert.deepEqual(rel.get('f')?.from, { key: SOURCE, name: 'Acme', at: 100, fork: true })
  assert.deepEqual(rel.get('f')?.started, [])
  assert.deepEqual(rel.get('f')?.talks, [{ key: 'c', name: 'Case', in: 0, out: 1, at: 120 }])
  assert.deepEqual(rel.get('c')?.from, { key: SOURCE, name: 'Acme', at: 50 })
  assert.deepEqual(
    rel.get(SOURCE)?.started.map(s => s.key),
    ['f', 'c'],
  )
  // A session without a fork on its card goes as before.
  assert.deepEqual(relate([items[0] as LinkItem], it => events[it.key]).get(SOURCE)?.from, null)
})

test('a fork’s card says whose fork it is and since when', () => {
  assert.deepEqual(forkCard(SOURCE, 1234), { forkOf: SOURCE, forkAt: 1234 })
})

test('#281: one Bash call that starts two sessions: both started, both know who started them', () => {
  const st = newState()
  const command = 'spawn-agent --name Orchestrator --cwd ~/o && spawn-agent --name Herdr --cwd ~/h'
  assert.deepEqual(lineEvents(main(line.call(1, 'sp', 'Bash', { command })), st), [])
  const printed = 'pane=w1:p2 name=Orchestrator agent=Orchestrator\npane=w2:p1 name=Herdr agent=Herdr'
  const events = lineEvents(main(line.result(2, 'sp', printed)), st)
  assert.deepEqual(events, [
    { kind: 'spawn', name: 'Orchestrator', pane: 'w1:p2', at: T0 + 1000 },
    { kind: 'spawn', name: 'Herdr', pane: 'w2:p1', at: T0 + 1000 },
  ])
  // One of the two did not start: the one that did.
  lineEvents(
    main(line.call(3, 'sp2', 'Bash', { command: 'spawn-agent --name A --cwd x; spawn-agent --name B --cwd /nope' })),
    st,
  )
  assert.deepEqual(lineEvents(main(line.result(4, 'sp2', 'pane=w3:p1 name=A agent=A\nNo such folder: /nope')), st), [
    { kind: 'spawn', name: 'A', pane: 'w3:p1', at: T0 + 3000 },
  ])

  const items: LinkItem[] = [
    { key: 'me', name: 'Me', pane: 'w0:p1' },
    { key: 'o', name: 'Orchestrator', pane: 'w1:p2' },
    { key: 'pane-w2:p1', name: 'Herdr', pane: 'w2:p1' },
  ]
  const rel = relate(items, it => (it.key === 'me' ? events : []))
  assert.deepEqual(rel.get('o')?.from, { key: 'me', name: 'Me', at: T0 + 1000 })
  assert.deepEqual(rel.get('pane-w2:p1')?.from, { key: 'me', name: 'Me', at: T0 + 1000 })
  assert.deepEqual(
    rel.get('me')?.started.map(x => x.key),
    ['o', 'pane-w2:p1'],
  )
})

test('#280: herdr typing into another pane is an event of its own, and no link on the board', () => {
  const st = newState()
  const call = (s: number, id: string, command: string) => main(line.call(s, id, 'Bash', { command }))
  assert.deepEqual(lineEvents(call(1, 'p1', 'herdr agent prompt Herdr "go" && herdr pane send-keys w:p2 Enter'), st), [
    { kind: 'prompted', target: 'Herdr', verb: 'agent prompt', at: T0 + 1000 },
    { kind: 'prompted', target: 'w:p2', verb: 'pane send-keys', at: T0 + 1000 },
  ])
  // A request record repeats the call: once. A brief that mentions the command: none.
  assert.deepEqual(lineEvents(call(1, 'p1', 'herdr agent prompt Herdr "go"'), st), [])
  assert.deepEqual(lineEvents(call(2, 'p2', "cat > b.md <<'EOF'\nherdr agent prompt Herdr go\nEOF"), st), [])
  // spawn-agent and a prompt in one call: both.
  assert.deepEqual(lineEvents(call(3, 'p3', 'spawn-agent --name case-42 && herdr agent prompt case-42 hi'), st), [
    { kind: 'prompted', target: 'case-42', verb: 'agent prompt', at: T0 + 3000 },
  ])
  assert.deepEqual(lineEvents(main(line.result(4, 'p3', 'pane=w:p2 name=case-42 agent=x')), st), [
    { kind: 'spawn', name: 'case-42', pane: 'w:p2', at: T0 + 3000 },
  ])
  // A message's summary is the one SendMessage gave, never its text.
  assert.deepEqual(lineEvents(main(line.call(5, 'sm', 'SendMessage', { to: 'Herdr', message: 'Secret plan.' })), st), [
    { kind: 'sent', to: 'Herdr', name: '', summary: '', at: T0 + 5000 },
  ])

  // The board's links are the same with prompts among the events as without.
  const items: LinkItem[] = [
    { key: 'm', session: 's-m', name: 'Master', pane: 'w:p1' },
    { key: 'pane-w:p2', session: null, name: 'case 42', autoName: 'case-42', pane: 'w:p2' },
    { key: 'C:\\w\\Кейс 50%', session: 's-k', name: 'Кейс 50%', pane: 'w:p3' },
  ]
  const before: LinkEvent[] = [
    { kind: 'spawn', name: 'case-42', pane: 'w:p2', at: 10 },
    { kind: 'sent', to: 'Кейс 50%', name: '', summary: '', at: 20 },
  ]
  const prompts: LinkEvent[] = [
    { kind: 'prompted', target: 'w:p2', verb: 'pane send-text', at: 30 },
    { kind: 'prompted', target: 'Кейс 50%', verb: 'agent prompt', at: 31 },
  ]
  const without = relate(items, it => (it.key === 'm' ? before : []))
  const with_ = relate(items, it => (it.key === 'm' ? [...before, ...prompts] : []))
  assert.deepEqual([...with_], [...without])

  // Its other end: the session in that pane now, else the one by that name; never itself.
  const end = ends(items)
  const m = { key: 'm' }
  assert.equal(end(m, { kind: 'prompted', target: 'w:p2', verb: 'pane send-keys', at: 0 })?.key, 'pane-w:p2')
  assert.equal(end(m, { kind: 'prompted', target: 'Кейс 50%', verb: 'agent prompt', at: 0 })?.key, 'C:\\w\\Кейс 50%')
  assert.equal(end(m, { kind: 'prompted', target: 'w:p1', verb: 'pane run', at: 0 }), null)
  assert.equal(end(m, { kind: 'prompted', target: '', verb: 'agent prompt', at: 0 }), null)
  assert.equal(end(m, before[0] as LinkEvent)?.key, 'pane-w:p2')

  // The edge log's line: the event without a message's text, both ends as the board has them.
  const src = { transcript: 'C:\\Users\\a b\\.claude\\projects\\x\\s-m.jsonl', offset: 120, uuid: 'u1', session: 's-m' }
  const recv: LinkEvent = { kind: 'received', name: 'Кейс 50%', pipe: 'uds:x', id: 'pm1', text: 'Secret plan.', at: 40 }
  assert.deepEqual(edgeOf(recv, src, items[0] ?? null, items[2] ?? null, 7), {
    seq: 7,
    kind: 'received',
    name: 'Кейс 50%',
    pipe: 'uds:x',
    id: 'pm1',
    at: 40,
    session: 's-m',
    key: 'm',
    sessionName: 'Master',
    toSession: 's-k',
    toKey: 'C:\\w\\Кейс 50%',
    toName: 'Кейс 50%',
    transcript: src.transcript,
    offset: 120,
    uuid: 'u1',
  })
  // No session on the board reads that transcript any more: the line's own session id.
  const gone = edgeOf(prompts[0] as LinkEvent, src, null, items[1] ?? null)
  assert.deepEqual(
    [gone.session, gone.key, gone.sessionName, gone.toSession, gone.toKey],
    ['s-m', null, null, null, 'pane-w:p2'],
  )
})
