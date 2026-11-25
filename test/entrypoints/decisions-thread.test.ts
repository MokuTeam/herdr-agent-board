// `board thread ask` with decisions (#487), in this process: options and a default only on the
// session's own question; the default goes into the schedule before the thread's question is
// written, so at the session's cap nothing is written and the open question keeps its buttons; on a
// node the flags go to the master, which holds the question (#781).
import { expect, test } from 'bun:test'
import { readCard } from '../../src/adapters/cards.ts'
import { getDecision } from '../../src/adapters/decision-store.ts'
import { addEntry, listEntries } from '../../src/adapters/schedule-store.ts'
import { entriesOf, threadByKey } from '../../src/adapters/work-thread-store.ts'
import { decisionsConfig } from '../../src/core/decisions.ts'
import { MAX_PER_SESSION } from '../../src/core/schedule-rules.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { askThreadDecision, releaseDecision, reserveThreadDecision } from '../../src/entrypoints/decisions-cli.ts'
import { type NodeCall, type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { withDecisionsDb } from '../../src/services/decisions.ts'
import { isolatedHome } from '../support/env.ts'

const ANNA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const me: Party = { kind: 'session', key: ANNA, name: 'anna' }

/** `board thread <args>` as anna, with decisions on, the way the board command wires it. */
async function run(args: string[], over: Partial<ThreadCmdContext> = {}) {
  const out: string[] = []
  const err: string[] = []
  const calls: NodeCall[] = []
  const code = await threadCmd(args, {
    cfg: { threads: true, port: 9 },
    actor: me,
    lane: 'atlas',
    findSession: async () => null,
    decisions: decisionsConfig(true),
    setAsk: async (question, decision) =>
      decision
        ? askThreadDecision({ key: ANNA, name: 'anna', lane: 'atlas' }, question, decision, Date.now())
        : undefined,
    reserveAsk: async spec => reserveThreadDecision({ key: ANNA, name: 'anna' }, spec, Date.now()),
    releaseAsk: r => releaseDecision(r),
    own: async () => true,
    out: l => out.push(l),
    err: l => err.push(l),
    call: async body => {
      calls.push(body)
      return { state: 'answered', code: 0, out: ['ok'], err: [] }
    },
    ...over,
  })
  return { code, out, err, calls }
}

const thread = (key: string) => withDecisionsDb(db => threadByKey(db, key))
const asks = (key: string) =>
  withDecisionsDb(db => entriesOf(db, (threadByKey(db, key) as { id: string }).id)).filter(e => e.type === 'ask')

test("--session for another session's thread question: options and a default refused, nothing written", async () => {
  isolatedHome()
  expect((await run(['new', '--lane', 'atlas', 'Release'])).code).toBe(0)
  const r = await run(
    ['ask', 'atlas-1', 'Ship it?', '--option', 'yes', '--option', 'no', '--recommend', '1', '--default-after', '2h'],
    {
      own: async () => false,
    },
  )
  expect(r.code).toBe(1)
  expect(r.err.join('\n')).toContain("--option and --default-after are for the session's own question")
  // One line, no help after it.
  expect(r.err.join('\n').split('\n')).toHaveLength(1)
  expect(asks('atlas-1')).toEqual([])
  expect(thread('atlas-1')?.status).not.toBe('owner')
  expect(listEntries()).toEqual([])
  expect(readCard(ANNA)?.ask).toBeUndefined()
  // A plain question for it goes as before.
  expect((await run(['ask', 'atlas-1', 'Ship it?'], { own: async () => false })).code).toBe(0)
})

test("at the session's schedule cap: nothing written in the thread, the open question keeps its buttons and stays the thread's", async () => {
  isolatedHome()
  await run(['new', '--lane', 'atlas', 'Release'])
  const first = await run([
    'ask',
    'atlas-1',
    'Ship it?',
    '--option',
    'yes',
    '--option',
    'no',
    '--recommend',
    '1',
    '--default-after',
    '2h',
  ])
  expect(first.code).toBe(0)
  const firstId = /decision ([0-9a-f]{8})/.exec(first.out.join('\n'))?.[1] as string
  expect(firstId).toBeTruthy()
  for (let i = listEntries().length; i < MAX_PER_SESSION; i++)
    addEntry({ key: ANNA, text: `reminder ${i}`, at: Date.now(), next: Date.now() + 3_600_000 })
  const second = await run([
    'ask',
    'atlas-1',
    'Which day?',
    '--option',
    'Mon',
    '--option',
    'Tue',
    '--recommend',
    '2',
    '--default-after',
    '1h',
  ])
  expect(second.code).toBe(1)
  expect(second.err.join('\n')).toContain(`${MAX_PER_SESSION} entries already`)
  // The thread still asks the first question, and the card still offers its buttons.
  expect(asks('atlas-1').map(e => e.text)).toEqual(['Ship it?'])
  expect(thread('atlas-1')?.waitingOn).toBe('Ship it?')
  expect((readCard(ANNA)?.decision as { id?: string } | undefined)?.id).toBe(firstId)
  expect((readCard(ANNA)?.decision as { options?: string[] } | undefined)?.options).toEqual(['yes', 'no'])
  expect(withDecisionsDb(db => getDecision(db, firstId))?.answeredAt).toBeNull()
  expect(
    listEntries()
      .filter(e => e.decision !== undefined)
      .map(e => e.decision),
  ).toEqual([firstId])
})

test('a thread question the thread refuses gives its reserved default back', async () => {
  isolatedHome()
  expect((await run(['new', '--lane', 'atlas', 'Release'])).code).toBe(0)
  // A thread a pi task board mirrors: only the board's copying writes it, so askOwner refuses.
  withDecisionsDb(db =>
    db.db
      .query('UPDATE threads SET origin = ? WHERE key = ?')
      .run(JSON.stringify({ mirrored: true, agentBoard: { harness: 'pi', session: 'day-1', id: 'b1' } }), 'atlas-1'),
  )
  let reserved = 0
  const r = await run(
    ['ask', 'atlas-1', 'Ship it?', '--option', 'yes', '--option', 'no', '--recommend', '1', '--default-after', '2h'],
    {
      reserveAsk: async spec => {
        reserved++
        return reserveThreadDecision({ key: ANNA, name: 'anna' }, spec, Date.now())
      },
    },
  )
  expect(r.code).toBe(1)
  // It got as far as the reserve, and gave it back.
  expect(reserved).toBe(1)
  expect(listEntries()).toEqual([])
  expect(asks('atlas-1')).toEqual([])
  expect(readCard(ANNA)).toBeNull()
})

test('on a node the flags go to the master with the question, and its decision goes on the card (#781)', async () => {
  isolatedHome()
  const node = { node: { id: 'server-1', port: 12430, workRoot: '/srv/work' }, port: 12422 }
  const held = { id: 'd1', options: ['yes', 'no'], recommend: 1 }
  const plain: string[] = []
  const carded: [string, unknown][] = []
  const sides = {
    setAsk: async (q: string) => {
      plain.push(q)
      return undefined
    },
    setNodeAsk: (q: string, d: unknown) => {
      carded.push([q, d])
    },
  }
  const r = await run(['ask', 'atlas-1', 'Ship it?', '--option', 'yes', '--option', 'no', '--recommend', '1'], {
    cfg: node,
    ...sides,
    call: async body => {
      expect(body.argv).toEqual(['ask', 'atlas-1', 'Ship it?', '--option', 'yes', '--option', 'no', '--recommend', '1'])
      return { state: 'answered', code: 0, out: ['ok · atlas-1 · owner', 'decision d1'], err: [], decision: held }
    },
  })
  expect(r.code).toBe(0)
  expect(r.out).toEqual(['ok · atlas-1 · owner', 'decision d1'])
  // The question without the flags, with the master's decision; nothing of it in this computer's schedule.
  expect(carded).toEqual([['Ship it?', held]])
  expect(plain).toEqual([])
  expect(listEntries()).toEqual([])
  // The master kept no decision (an older one, or decisions off there): a plain ask, as before.
  carded.length = 0
  const old = await run(['ask', 'atlas-1', 'Ship it?', '--option', 'yes'], { cfg: node, ...sides })
  expect(old.code).toBe(0)
  expect(plain).toEqual(['Ship it?'])
  expect(carded).toEqual([])
  // The master away (#784): refused in words, nothing on the card, never kept to go later without
  // its options; a plain thread ask is still kept.
  for (const answer of [{ state: 'kept', id: 'k1' }, { state: 'unreachable' }] as const) {
    const away = await run(['ask', 'atlas-1', 'Later?', '--option', 'a', '--option', 'b'], {
      cfg: node,
      ...sides,
      call: async () => answer,
    })
    expect(away.code).toBe(1)
    expect(away.out).toEqual([])
    expect(away.err).toEqual(['the head is not reachable, ask again later'])
  }
  const awayJson = await run(['ask', 'atlas-1', 'Later?', '--default-after', '1h', '--json'], {
    cfg: node,
    ...sides,
    call: async () => ({ state: 'unreachable' }),
  })
  expect(awayJson.out.map(l => JSON.parse(l))).toEqual([
    { ok: false, error: 'unreachable', message: 'the head is not reachable, ask again later' },
  ])
  const keptPlain = await run(['ask', 'atlas-1', 'Later?'], {
    cfg: node,
    ...sides,
    call: async () => ({ state: 'kept', id: 'k2' }),
  })
  expect(keptPlain.code).toBe(0)
  expect(plain).toEqual(['Ship it?', 'Later?'])
  expect(carded).toEqual([])
  // Decisions off on the node: it goes to the master as on main, which answers as on main.
  const off = await run(['ask', 'atlas-1', 'Ship it?', '--option', 'yes'], { cfg: node, decisions: null })
  expect(off.calls.map(c => c.argv)).toEqual([['ask', 'atlas-1', 'Ship it?', '--option', 'yes']])
  // After a lone --, the words are the question's.
  const text = await run(['ask', 'atlas-1', '--', 'Ship it with --option x?'], { cfg: node })
  expect(text.code).toBe(0)
  expect(text.calls.map(c => c.argv)).toEqual([['ask', 'atlas-1', '--', 'Ship it with --option x?']])
})
