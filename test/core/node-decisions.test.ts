// A node's page shows its sessions' questions with options as its master holds them (#784,
// core/node-decisions.ts): the master cuts its queue and what went by default to the asking node's
// sessions (keys as the node names them), the node reads that part field by field, and its own cards
// and queue take the master's Hold and default while both agree the question is open. The answer the
// owner typed at the node rides the node's item to the master (core/node-items.ts). And what a board
// without nodes, or a node whose master gives no decisions, shows is as before.
import { describe, expect, test } from 'bun:test'
import { boardSlicesOf, nodeSlicesView, slicesOf, withNodeDecisions } from '../../src/core/board-slices.ts'
import {
  type DecisionAnswer,
  type DecisionsPayload,
  type DecisionView,
  decisionAnswerFor,
  decisionAnswerOf,
  masterHeld,
} from '../../src/core/decisions.ts'
import {
  decisionsForNode,
  decisionsSliceOf,
  masterHeldIds,
  withMasterDecisions,
} from '../../src/core/node-decisions.ts'
import { nodePart } from '../../src/core/node-items.ts'
import { nodeKey } from '../../src/core/nodes.ts'
import type { Card, Item } from '../../src/core/types.ts'

const S1 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d01'
const S2 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d02'
const PI = 'C:\\Users\\o w\\.pi\\sessions\\Тест 50%.jsonl'
const ASKED = 1_795_000_000_000

const row = (key: string, over: Partial<DecisionView> = {}): DecisionView => ({
  key,
  id: 'd1',
  who: 'anna',
  lane: 'atlas',
  question: 'Merge now or after the review?',
  options: ['Merge now', 'After review'],
  recommend: 1,
  askedAt: ASKED,
  defaultAt: ASKED + 7_200_000,
  held: false,
  ...over,
})
const went = (key: string, id = 'd0') => ({ id, key, who: 'ben', question: 'Ship it?', answer: 'Yes', at: ASKED - 1 })

describe("the master's part for a node", () => {
  test("only that node's sessions, with their keys as the node names them; another machine's stay", () => {
    const master: DecisionsPayload = {
      items: [
        row(S1, { id: 'own' }),
        row(nodeKey('server-1', S1)),
        row(nodeKey('server-1', PI), { id: 'd2' }),
        row(nodeKey('server-2', S2), { id: 'd3' }),
      ],
      defaulted: [went(nodeKey('server-1', S2)), went(S2, 'mine'), went(nodeKey('server-2', S1), 'theirs')],
      defaults: true,
    }
    expect(decisionsForNode(master, 'server-1')).toEqual({
      items: [row(S1), row(PI, { id: 'd2' })],
      defaulted: [went(S2)],
      defaults: true,
    })
    expect(decisionsForNode(master, 'server-3')).toEqual({ items: [], defaulted: [], defaults: true })
  })

  test('in the answer to the node beside the other parts; none while decisions are off on the master', () => {
    const slices = { time: { on: true } } as never
    const master: DecisionsPayload = { items: [row(nodeKey('server-1', S1))], defaulted: [], defaults: false }
    expect(withNodeDecisions(slices, master, 'server-1')).toEqual({
      time: { on: true },
      decisions: { items: [row(S1)], defaulted: [], defaults: false },
    } as never)
    expect(withNodeDecisions(slices, null, 'server-1')).toBe(slices)
  })

  test("a payload's parts as every board keeps them carry no decisions (#780's slices unchanged)", () => {
    const payload = { time: { on: true }, decisions: { items: [], defaulted: [], defaults: true } }
    expect(slicesOf(payload as never)).toEqual({ time: { on: true } } as never)
  })
})

describe("the node's reading", () => {
  const answer = (decisions: unknown) => ({ ok: true, slices: { time: { on: true }, decisions } })

  test("the master's part, field by field; an older master's answer without it has none", () => {
    const part = {
      items: [row(S1), row(PI, { id: null, options: [], board: true })],
      defaulted: [went(S2)],
      defaults: true,
    }
    expect(boardSlicesOf(answer(part))).toEqual({ time: { on: true }, decisions: part } as never)
    expect(boardSlicesOf({ ok: true, slices: { time: { on: true } } })).toEqual({ time: { on: true } } as never)
  })

  test('a part that is not one is left out; the other parts still hold', () => {
    const bad: unknown[] = [
      null,
      [],
      { items: [], defaulted: [] },
      { items: [row(S1, { key: '' })], defaulted: [], defaults: true },
      { items: [row(S1, { id: 'x'.repeat(65) })], defaulted: [], defaults: true },
      { items: [row(S1, { held: 'yes' as never })], defaulted: [], defaults: true },
      { items: [row(S1, { options: Array.from({ length: 11 }, (_, i) => String(i)) })], defaulted: [], defaults: true },
      { items: [row(S1, { defaultAt: Number.NaN })], defaulted: [], defaults: true },
      { items: [], defaulted: [{ ...went(S2), at: 'soon' }], defaults: true },
      { items: Array.from({ length: 201 }, () => row(S1)), defaulted: [], defaults: true },
    ]
    for (const b of bad) {
      expect(decisionsSliceOf(b)).toBeNull()
      expect(boardSlicesOf(answer(b))).toEqual({ time: { on: true } } as never)
    }
  })

  test("the node's payload parts leave decisions to its own queue and cards", () => {
    const view = nodeSlicesView(
      { time: { on: true }, decisions: { items: [], defaulted: [], defaults: true } } as never,
      {
        self: 'server-1',
        ownTeam: false,
        ownDevices: false,
        online: true,
      },
    )
    expect(view).toEqual({ time: { on: true } } as never)
  })
})

describe("the node's cards and queue with the master's part", () => {
  const held = (id = 'd1'): Card => ({
    key: S1,
    ask: 'Merge now or after the review?',
    askSince: ASKED,
    decision: masterHeld({ id, options: ['Merge now', 'After review'], recommend: 1, defaultAt: ASKED + 7_200_000 }),
  })
  const item = (key: string, decision?: Item['decision']) =>
    ({ key, name: 'anna', ...(decision && { decision }) }) as Pick<Item, 'key' | 'decision'> & { name: string }
  const carried = { id: 'd1', options: ['Merge now', 'After review'], recommend: 1, defaultAt: ASKED + 7_200_000 }
  const own = (items: DecisionView[]): DecisionsPayload => ({ items, defaulted: [went(S2, 'local')], defaults: true })

  test("held on the master: the card and the queue say held, with no default; what went by default is the master's", () => {
    const master: DecisionsPayload = {
      items: [row(S1, { defaultAt: null, held: true })],
      defaulted: [went(S2)],
      defaults: true,
    }
    const got = withMasterDecisions([item(S1, carried)], own([row(S1)]), master, new Map([[S1, held()]]))
    expect(got.items).toEqual([item(S1, { id: 'd1', options: ['Merge now', 'After review'], recommend: 1, held: 0 })])
    expect(got.decisions).toEqual({
      items: [row(S1, { defaultAt: null, held: true })],
      defaulted: [went(S2)],
      defaults: true,
    })
  })

  test("the default as the master runs it, not as the node's card wrote it", () => {
    const master: DecisionsPayload = { items: [row(S1, { defaultAt: ASKED + 60_000 })], defaulted: [], defaults: true }
    const got = withMasterDecisions([item(S1, carried)], own([row(S1)]), master, new Map([[S1, held()]]))
    expect(got.items[0]?.decision?.defaultAt).toBe(ASKED + 60_000)
    expect(got.decisions?.items).toEqual([row(S1, { defaultAt: ASKED + 60_000 })])
  })

  test('one the master no longer holds leaves the card and the queue: no buttons that answer nothing', () => {
    const master: DecisionsPayload = { items: [], defaulted: [], defaults: true }
    const got = withMasterDecisions([item(S1, carried)], own([row(S1)]), master, new Map([[S1, held()]]))
    expect(got.items).toEqual([item(S1)])
    expect(got.decisions?.items).toEqual([])
  })

  test("one the master lists that the node's card no longer carries (answered in the terminal) is not shown", () => {
    const master: DecisionsPayload = { items: [row(S1), row(S2, { id: 'd9' })], defaulted: [], defaults: true }
    const answered: Card = { key: S1, doing: 'merging' }
    const other = { ...held('d8'), key: S2 }
    const got = withMasterDecisions(
      [item(S1), item(S2)],
      own([]),
      master,
      new Map([
        [S1, answered],
        [S2, other],
      ]),
    )
    expect(got.decisions?.items).toEqual([])
  })

  test("a question of the node's own database (asked before #781) shows as a plain ask; plain asks stay", () => {
    const local: Card = { key: S1, ask: 'Old question?', decision: { id: 'old', options: ['a', 'b'], defaultAt: 5 } }
    const plainAsk = row(S2, { id: null, options: [], recommend: null, defaultAt: null })
    const master: DecisionsPayload = { items: [], defaulted: [], defaults: true }
    const got = withMasterDecisions(
      [item(S1, { id: 'old', options: ['a', 'b'], defaultAt: 5 }), item(S2)],
      own([row(S1, { id: 'old', options: ['a', 'b'], defaultAt: 5 }), plainAsk]),
      master,
      new Map([
        [S1, local],
        [S2, { key: S2, ask: 'Which branch?' }],
      ]),
    )
    expect(got.items).toEqual([item(S1), item(S2)])
    expect(got.decisions?.items).toEqual([
      row(S1, { id: null, options: [], recommend: null, defaultAt: null }),
      plainAsk,
    ])
  })

  test('decisions off on the node: none on show', () => {
    const master: DecisionsPayload = { items: [row(S1)], defaulted: [], defaults: true }
    expect(withMasterDecisions([item(S1)], null, master, new Map([[S1, held()]])).decisions).toBeNull()
  })

  test("what the node's cards carry for the master, as one line that changes with them", () => {
    expect(masterHeldIds(new Map())).toBe('')
    const local: Card = { key: S2, ask: 'q', decision: { id: 'x', options: ['a'] } }
    expect(
      masterHeldIds(
        new Map([
          [S1, held()],
          [S2, local],
        ]),
      ),
    ).toBe(`${S1}:d1`)
    expect(masterHeldIds(new Map([[S1, held('d2')]]))).toBe(`${S1}:d2`)
    expect(masterHeldIds(new Map([[S1, { ...held(), ask: '' }]]))).toBe('')
  })
})

describe("the owner's answer typed at the node", () => {
  const decision = masterHeld({ id: 'd1', options: ['yes', 'no'] })

  test("the owner's words, first line; never another session's message, a board notice or a slash command", () => {
    expect(decisionAnswerFor(decision, 'after the review\nthanks', 5)).toEqual({
      id: 'd1',
      answer: 'after the review',
      at: 5,
    })
    for (const p of [
      '<cross-session-message from="x">go</cross-session-message>',
      '/compact',
      '[board reminder] check CI',
    ])
      expect(decisionAnswerFor(decision, p, 5)).toBeNull()
    expect(decisionAnswerFor({ options: [] }, 'yes', 5)).toBeNull()
  })

  test("read field by field; it rides the node's item to the master with the key prefixed and itself as it was", () => {
    const note: DecisionAnswer = { id: 'd1', answer: 'Тест 50% yes', at: 5 }
    expect(decisionAnswerOf(note)).toEqual(note)
    for (const bad of [
      null,
      'd1',
      { id: '', answer: 'a', at: 1 },
      { id: 'd1', answer: 'a'.repeat(501), at: 1 },
      { id: 'd1', answer: 'a' },
    ])
      expect(decisionAnswerOf(bad)).toBeNull()
    const raw = { key: S1, session: S1, name: 'anna', status: 'idle', column: 'me', attention: 'ask' }
    const got = nodePart(
      {
        items: [
          { ...raw, decisionAnswer: note },
          { ...raw, key: S2, decisionAnswer: { id: 1 } },
        ],
      },
      'server-1',
    )
    expect(got?.items.map(i => [i.key, i.decisionAnswer])).toEqual([
      [nodeKey('server-1', S1), note],
      [nodeKey('server-1', S2), undefined],
    ])
  })
})
