// `board thread ask` with decisions (#487), in this process: options and a default only on the
// session's own question; the default goes into the schedule before the thread's question is
// written, so at the session's cap nothing is written and the open question keeps its buttons; on a
// node the flags go to the master, which holds the question (#781).
import { expect, test } from 'bun:test'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { getDecision } from '../../src/adapters/decision-store.ts'
import { addEntry, listEntries } from '../../src/adapters/schedule-store.ts'
import { entriesOf, threadByKey } from '../../src/adapters/work-thread-store.ts'
import { cardDecisionOf, decisionsConfig } from '../../src/core/decisions.ts'
import { MAX_PER_SESSION } from '../../src/core/schedule-rules.ts'
import type { Card, Item } from '../../src/core/types.ts'
import type { Party } from '../../src/core/work-threads.ts'
import {
  askThreadDecision,
  releaseDecision,
  reserveThreadDecision,
  settleThreadAsk,
} from '../../src/entrypoints/decisions-cli.ts'
import { type NodeCall, type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { closeOnPrompt, decisionsFromCards, decisionsPayload, withDecisionsDb } from '../../src/services/decisions.ts'
import { isolatedHome } from '../support/env.ts'

const ANNA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const BEN = 'bbbbbbbb-0000-4000-8000-00000000000b'
const me: Party = { kind: 'session', key: ANNA, name: 'anna' }

/** `board thread <args>` as anna (or `over.actor`), with decisions on by default, the way the board command wires it. */
async function run(args: string[], over: Partial<ThreadCmdContext> = {}) {
  const actor = over.actor ?? me
  const actorKey = actor.kind === 'session' ? actor.key : ''
  const actorName = actor.kind === 'session' ? actor.name : ''
  const out: string[] = []
  const err: string[] = []
  const calls: NodeCall[] = []
  const code = await threadCmd(args, {
    cfg: { threads: true, port: 9 },
    actor,
    lane: 'atlas',
    findSession: async () => null,
    decisions: decisionsConfig(true),
    setAsk: async (question, decision) => {
      if (!actorKey) return undefined
      if (!decision || over.decisions === null) {
        writeCard(actorKey, { ask: question, askSince: Date.now(), by: 'agent', decision: '' })
        return undefined
      }
      return askThreadDecision({ key: actorKey, name: actorName, lane: 'atlas' }, question, decision, Date.now())
    },
    settleAsk: async info => {
      const clearPlain = (who: string | undefined): void => {
        if (!who || !info.question) return
        const card = readCard(who)
        if (card && card.decision === undefined && card.ask === info.question) writeCard(who, { ask: '', askSince: '' })
      }
      if (over.decisions === null) {
        clearPlain(info.session ?? info.asker)
        return
      }
      const settled = settleThreadAsk(info.thread, Date.now(), {
        ...(info.session && { session: info.session }),
        by: actorKey ? 'agent' : 'owner',
      })
      const plainKey = info.session ?? info.asker
      if (plainKey && !settled.includes(plainKey)) clearPlain(plainKey)
    },
    reserveAsk: async spec =>
      actorKey ? reserveThreadDecision({ key: actorKey, name: actorName }, spec, Date.now()) : undefined,
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

test('thread done / --status done by the asking session settles its decision, default and card (#844)', async () => {
  for (const args of [
    ['post', 'atlas-1', '--status', 'done', '--summary', 'sent by itself'],
    ['done', 'atlas-1', 'sent by itself'],
  ]) {
    isolatedHome()
    await run(['new', '--lane', 'atlas', 'Draft'])
    const asked = await run([
      'ask',
      'atlas-1',
      'Press Send?',
      '--option',
      'Send',
      '--option',
      'Cancel',
      '--recommend',
      '1',
      '--default-after',
      '2h',
    ])
    expect(asked.code).toBe(0)
    const id = /decision ([0-9a-f]{8})/.exec(asked.out.join('\n'))?.[1] as string
    expect(id).toBeTruthy()
    const done = await run(args)
    expect(done.code).toBe(0)
    expect(done.out[0]).toBe('ok · atlas-1 · owner · proposed done, the owner confirms')
    expect(withDecisionsDb(db => getDecision(db, id))).toMatchObject({
      answeredBy: 'withdrawn',
      via: 'cleared',
      answer: null,
    })
    expect(listEntries()).toEqual([])
    expect(readCard(ANNA)?.ask).toBeUndefined()
    expect(readCard(ANNA)?.decision).toBeUndefined()
    const cards = new Map<string, Card>([[ANNA, readCard(ANNA) ?? ({ key: ANNA } as Card)]])
    const items = [{ key: ANNA, session: ANNA, name: 'anna', attention: '' }] as Item[]
    expect(decisionsPayload(items, cards, { now: Date.now(), defaults: true, seen: 0 }).items).toEqual([])
    expect(decisionsFromCards(cards)).toEqual([])
    // A subsequent owner chat message never gets recorded as the answer to the settled ask.
    closeOnPrompt(readCard(ANNA), 'next task please', Date.now())
    expect(withDecisionsDb(db => getDecision(db, id))?.answeredBy).toBe('withdrawn')
  }
})

test('dropped or --status doing settles the ask; plain notes and another session proposing done do not (#844)', async () => {
  isolatedHome()
  await run(['new', '--lane', 'atlas', 'Draft'])
  const asked = await run(['ask', 'atlas-1', 'Press Send?', '--option', 'Send', '--option', 'Cancel'])
  const id = /decision ([0-9a-f]{8})/.exec(asked.out.join('\n'))?.[1] as string
  expect(id).toBeTruthy()
  // Plain note while waiting on the owner leaves the decision open.
  expect((await run(['post', 'atlas-1', 'still waiting'])).code).toBe(0)
  expect(withDecisionsDb(db => getDecision(db, id))?.answeredAt).toBeNull()
  expect(cardDecisionOf(readCard(ANNA)?.decision)?.id).toBe(id)
  // Another session proposing done does not settle anna's ask.
  const ben: Party = { kind: 'session', key: BEN, name: 'ben' }
  expect((await run(['done', 'atlas-1', 'ben thinks done'], { actor: ben })).code).toBe(0)
  expect(withDecisionsDb(db => getDecision(db, id))?.answeredAt).toBeNull()
  expect(cardDecisionOf(readCard(ANNA)?.decision)?.id).toBe(id)
  // Owner dropping (or setting status doing) settles it.
  expect((await run(['post', 'atlas-1', '--status', 'dropped'], { actor: { kind: 'owner' } })).code).toBe(0)
  expect(withDecisionsDb(db => getDecision(db, id))).toMatchObject({ answeredBy: 'withdrawn', via: 'cleared' })
  expect(readCard(ANNA)?.decision).toBeUndefined()
  expect(readCard(ANNA)?.ask).toBeUndefined()

  // --status doing also settles.
  await run(['new', '--lane', 'atlas', 'Another'])
  const a2 = await run(['ask', 'atlas-2', 'Wait?', '--option', 'Yes', '--option', 'No'])
  const id2 = /decision ([0-9a-f]{8})/.exec(a2.out.join('\n'))?.[1] as string
  expect((await run(['post', 'atlas-2', '--status', 'doing', 'resumed'])).code).toBe(0)
  expect(withDecisionsDb(db => getDecision(db, id2))).toMatchObject({ answeredBy: 'withdrawn', via: 'cleared' })
  expect(readCard(ANNA)?.decision).toBeUndefined()
})

test('board thread post --settle settles an open ask and restores prior status; guards misuse (#844)', async () => {
  isolatedHome()
  await run(['new', '--lane', 'atlas', 'Draft'])
  await run(['post', 'atlas-1', '--status', 'waiting', '--waiting', 'hub sync'])
  const asked = await run([
    'ask',
    'atlas-1',
    'Press Send?',
    '--option',
    'Send',
    '--option',
    'Cancel',
    '--recommend',
    '1',
    '--default-after',
    '2h',
  ])
  const id = /decision ([0-9a-f]{8})/.exec(asked.out.join('\n'))?.[1] as string
  // Another session cannot settle anna's ask.
  const ben: Party = { kind: 'session', key: BEN, name: 'ben' }
  const notAsker = await run(['post', 'atlas-1', '--settle', 'moot'], { actor: ben })
  expect(notAsker.code).toBe(1)
  expect(notAsker.err.join('\n')).toContain('not yours')
  // Owner cannot use --settle.
  const ownerSettle = await run(['post', 'atlas-1', '--settle', 'moot'], { actor: { kind: 'owner' } })
  expect(ownerSettle.code).toBe(1)
  expect(ownerSettle.err.join('\n')).toContain('--settle is for the session that asked')
  // --settle cannot go with --status owner.
  const withOwnerStatus = await run(['post', 'atlas-1', '--settle', '--status', 'owner', 'x'])
  expect(withOwnerStatus.code).toBe(1)
  expect(withOwnerStatus.err.join('\n')).toContain('--settle cannot go with --status owner')

  // --settle without --status restores waiting + waitingOn and settles the decision.
  const settled = await run(['post', 'atlas-1', '--settle', 'draft went out by itself'])
  expect(settled.code).toBe(0)
  expect(settled.out[0]).toBe('ok · atlas-1 · waiting')
  expect(thread('atlas-1')?.waitingOn).toBe('hub sync')
  expect(withDecisionsDb(db => getDecision(db, id))).toMatchObject({ answeredBy: 'withdrawn', via: 'cleared' })
  expect(listEntries()).toEqual([])
  expect(readCard(ANNA)?.ask).toBeUndefined()
  expect(readCard(ANNA)?.decision).toBeUndefined()

  // --settle alone (no text) also works when restoring status from an open ask.
  await run(['new', '--lane', 'atlas', 'Draft 2'])
  await run(['ask', 'atlas-2', 'Still needed?', '--option', 'Yes', '--option', 'No'])
  const bare = await run(['post', 'atlas-2', '--settle'])
  expect(bare.code).toBe(0)
  expect(bare.out[0]).toBe('ok · atlas-2 · next')
  expect(readCard(ANNA)?.decision).toBeUndefined()
})

test('unrelated card ask and decisions-off setups behave cleanly (#844)', async () => {
  isolatedHome()
  await run(['new', '--lane', 'atlas', 'Thread A'])
  const a1 = await run(['ask', 'atlas-1', 'Question A?', '--option', '1', '--option', '2'])
  const id1 = /decision ([0-9a-f]{8})/.exec(a1.out.join('\n'))?.[1] as string
  // Session replaced its card ask with an unrelated plain card ask.
  writeCard(ANNA, { ask: 'Unrelated card question', askSince: Date.now(), decision: '' })
  expect((await run(['done', 'atlas-1', 'done A'])).code).toBe(0)
  expect(withDecisionsDb(db => getDecision(db, id1))).toMatchObject({ answeredBy: 'withdrawn', via: 'cleared' })
  // Unrelated ask on card stays intact.
  expect(readCard(ANNA)?.ask).toBe('Unrelated card question')

  // Decisions off: plain thread ask cleared when closed or --settle, unrelated card ask left untouched.
  await run(['new', '--lane', 'atlas', 'Thread B'], { decisions: null })
  expect((await run(['ask', 'atlas-2', 'Plain thread q?'], { decisions: null })).code).toBe(0)
  expect(readCard(ANNA)?.ask).toBe('Plain thread q?')
  expect((await run(['post', 'atlas-2', '--settle', 'moot'], { decisions: null })).code).toBe(0)
  expect(readCard(ANNA)?.ask).toBeUndefined()

  await run(['new', '--lane', 'atlas', 'Thread C'], { decisions: null })
  expect((await run(['ask', 'atlas-3', 'Plain C?'], { decisions: null })).code).toBe(0)
  writeCard(ANNA, { ask: 'Other plain ask' })
  expect((await run(['done', 'atlas-3', 'done C'], { decisions: null })).code).toBe(0)
  expect(readCard(ANNA)?.ask).toBe('Other plain ask')
})

test('on a node, settled notice from master clears local card via clearNodeAsk (#844)', async () => {
  isolatedHome()
  const node = { node: { id: 'server-1', port: 12430, workRoot: '/srv/work' }, port: 12422 }
  const cleared: unknown[] = []
  const r = await run(['post', 'atlas-1', '--settle', 'moot'], {
    cfg: node,
    clearNodeAsk: s => cleared.push(s),
    call: async () => ({
      state: 'answered',
      code: 0,
      out: ['ok · atlas-1 · doing'],
      err: [],
      settled: { thread: 'tid-1', question: 'Press Send?' },
    }),
  })
  expect(r.code).toBe(0)
  expect(cleared).toEqual([{ thread: 'tid-1', question: 'Press Send?' }])
})
