// Decisions (#487, services/decisions.ts): a question with options on the card and in the record,
// replaced, held, its default due or not, the default given, the hook's close by whose prompt it
// was, a stale id refused, the queue and what went by default since the panel was opened. Cards,
// the schedule and the database in a temp state folder.
import { expect, test } from 'bun:test'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { openDb } from '../../src/adapters/db.ts'
import { closedDecisions, getDecision } from '../../src/adapters/decision-store.ts'
import { getEntry, listEntries, removeEntry } from '../../src/adapters/schedule-store.ts'
import { type AskSpec, cardDecisionOf } from '../../src/core/decisions.ts'
import type { Card, Item } from '../../src/core/types.ts'
import {
  askDecision,
  closeCardDecision,
  closeOnPrompt,
  decisionsFromCards,
  decisionsPayload,
  defaultDue,
  defaulted,
  holdOpen,
  markAnswering,
  markSeen,
  openOf,
  withDecisionsDb,
} from '../../src/services/decisions.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-21T10:00:00Z')
const ANNA = 'aaaaaaaa-0000-4000-8000-00000000000a'
const BEN = 'pane-wP:p2'
const spec = (over: Partial<AskSpec> = {}): AskSpec => ({
  question: 'Merge now or after the review?',
  options: ['Merge now', 'After review'],
  recommend: 1,
  defaultMs: 2 * 3_600_000,
  ...over,
})
const ask = (key = ANNA, s = spec(), now = NOW) =>
  withDecisionsDb(db =>
    askDecision(db, { key, name: key === ANNA ? 'anna' : 'ben', lane: 'atlas', spec: s, ask: s.question, now }),
  )
const row = (id: string) => withDecisionsDb(db => getDecision(db, id))
const gone = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  return 'taken'
}

test('board ask with a default: the card asks with its decision, the record has it, the default is in the schedule', () => {
  isolatedHome()
  const r = ask()
  const card = readCard(ANNA)
  expect(card?.ask).toBe('Merge now or after the review?')
  expect(card?.askSince).toBe(NOW)
  expect(cardDecisionOf(card?.decision)).toEqual({
    id: r.id,
    options: ['Merge now', 'After review'],
    recommend: 1,
    defaultAt: NOW + 7_200_000,
    defaultMs: 7_200_000,
  })
  const saved = row(r.id)
  expect(saved).toMatchObject({
    session: ANNA,
    name: 'anna',
    lane: 'atlas',
    recommend: 1,
    defaultAt: NOW + 7_200_000,
    answeredAt: null,
  })
  const entry = getEntry(saved?.entry)
  expect(entry).toMatchObject({
    key: ANNA,
    next: NOW + 7_200_000,
    by: 'decisions',
    decision: r.id,
    from: { key: 'decisions', name: 'decisions' },
    text: 'no answer in 2 h: go with your recommendation "Merge now"',
  })
})

test('a second ask replaces the first: withdrawn, its default taken back, and a click on the first is refused (#139)', () => {
  isolatedHome()
  const first = ask()
  const firstEntry = row(first.id)?.entry
  // The page read the first one; the agent asks again before the click.
  const second = ask(ANNA, spec({ question: 'Which branch?', options: ['main', 'dev'], defaultMs: null }), NOW + 1000)
  expect(row(first.id)).toMatchObject({ answeredBy: 'withdrawn', via: 'replaced', answeredAt: NOW + 1000 })
  expect(getEntry(firstEntry)).toBeNull()
  expect(gone(() => withDecisionsDb(db => openOf(db, ANNA, first.id)))).toBe('this question is no longer open')
  expect(gone(() => withDecisionsDb(db => holdOpen(db, ANNA, first.id, NOW + 2000)))).toBe(
    'this question is no longer open',
  )
  expect(withDecisionsDb(db => openOf(db, ANNA, second.id)).decision.options).toEqual(['main', 'dev'])
})

test('Hold: the default goes, the question stays', () => {
  isolatedHome()
  const r = ask()
  const entry = row(r.id)?.entry
  withDecisionsDb(db => holdOpen(db, ANNA, r.id, NOW + 60_000))
  expect(getEntry(entry)).toBeNull()
  const cd = cardDecisionOf(readCard(ANNA)?.decision)
  expect(cd?.held).toBe(NOW + 60_000)
  expect(cd?.defaultAt).toBeUndefined()
  expect(readCard(ANNA)?.ask).toBe('Merge now or after the review?')
  expect(row(r.id)).toMatchObject({ held: NOW + 60_000, defaultAt: null, answeredAt: null })
})

test('the default goes only while its question is open, once, and is recorded as the default', () => {
  isolatedHome()
  const r = ask()
  const entry = getEntry(row(r.id)?.entry)
  if (!entry) throw new Error('no entry')
  expect(defaultDue(entry)).toBe('go')
  // The owner's answer being typed in: it waits.
  markAnswering(ANNA, r.id, 'button')
  expect(defaultDue(entry)).toBe('wait')
  markAnswering(ANNA, r.id, null)
  expect(defaultDue(entry)).toBe('go')
  defaulted(entry, NOW + 7_200_000)
  expect(row(r.id)).toMatchObject({
    answer: 'Merge now',
    answeredBy: 'default',
    via: 'default',
    answeredAt: NOW + 7_200_000,
  })
  expect(readCard(ANNA)?.ask).toBeUndefined()
  expect(readCard(ANNA)?.decision).toBeUndefined()
  // Twice: nothing more.
  expect(defaultDue(entry)).toBe('drop')
  defaulted(entry, NOW + 7_300_000)
  expect(row(r.id)?.answeredAt).toBe(NOW + 7_200_000)
})

test('the default is dropped once the owner wrote (the ask cleared), once held, once replaced', () => {
  isolatedHome()
  const a = ask()
  const entryA = getEntry(row(a.id)?.entry)
  // The hook cleared the ask on the owner's prompt.
  writeCard(ANNA, { ask: '', askSince: '' })
  expect(entryA && defaultDue(entryA)).toBe('drop')
  const b = ask(BEN)
  const entryB = getEntry(row(b.id)?.entry)
  withDecisionsDb(db => holdOpen(db, BEN, b.id, NOW))
  expect(entryB && defaultDue(entryB)).toBe('drop')
  const c = ask(ANNA)
  const entryC = getEntry(row(c.id)?.entry)
  ask(ANNA, spec({ question: 'Other?' }))
  expect(entryC && defaultDue(entryC)).toBe('drop')
})

test("the hook's close: the owner's words, by the button when the page typed it, else withdrawn", () => {
  isolatedHome()
  const typed = ask()
  closeOnPrompt(readCard(ANNA), 'after the review please\nand rebase', NOW + 5)
  expect(row(typed.id)).toMatchObject({ answer: 'after the review please', answeredBy: 'owner', via: 'prompt' })
  expect(getEntry(row(typed.id)?.entry)).toBeNull()

  const clicked = ask()
  markAnswering(ANNA, clicked.id, 'button')
  closeOnPrompt(readCard(ANNA), 'Merge now', NOW + 6)
  expect(row(clicked.id)).toMatchObject({ answer: 'Merge now', answeredBy: 'owner', via: 'button' })

  for (const prompt of [
    '<cross-session-message from="x" from-name="ben">merge it</cross-session-message>',
    '<event kind="repl-eval" at="2026-11-21T10:00:00Z">ok</event>',
    '<teammate-message teammate_id="t">merge</teammate-message>',
  ]) {
    const r = ask()
    closeOnPrompt(readCard(ANNA), prompt, NOW + 7)
    expect(row(r.id)).toMatchObject({ answer: null, answeredBy: 'withdrawn', via: 'cleared' })
  }
})

test('board doing / done / clear withdraw the open decision and take its default back', () => {
  isolatedHome()
  const r = ask()
  const entry = row(r.id)?.entry
  withDecisionsDb(db =>
    closeCardDecision(db, ANNA, { answer: null, answeredBy: 'withdrawn', via: 'cleared', at: NOW + 9 }),
  )
  expect(row(r.id)).toMatchObject({ answeredBy: 'withdrawn', via: 'cleared' })
  expect(getEntry(entry)).toBeNull()
  expect(readCard(ANNA)?.decision).toBeUndefined()
  // The ask itself is the caller's (board doing clears it).
  expect(readCard(ANNA)?.ask).toBe('Merge now or after the review?')
})

const itemOf = (key: string, name: string, over: Partial<Item> = {}): Item =>
  ({ key, session: key, name, attention: '', ...over }) as Item

test('the queue: every card that waits on the owner, defaults first; what went by default since the panel was opened', () => {
  isolatedHome()
  ask(ANNA, spec(), NOW - 60_000) // default at NOW + 2 h - 1 min
  ask(BEN, spec({ question: 'Soon?', defaultMs: 30 * 60_000 }), NOW) // default at NOW + 30 min
  const cleo = 'cccccccc-0000-4000-8000-00000000000c'
  writeCard(cleo, { ask: 'plain question', askSince: NOW - 3_600_000 })
  const secret = 'dddddddd-0000-4000-8000-00000000000d'
  const cards = new Map<string, Card>([ANNA, BEN, cleo, secret].map(k => [k, readCard(k) ?? ({ key: k } as Card)]))
  const items = [
    itemOf(ANNA, 'anna'),
    itemOf(BEN, 'ben'),
    itemOf(cleo, 'cleo'),
    itemOf(secret, 'atlas', { attention: 'ask', question: 'Fill the token' }),
  ]
  const p = decisionsPayload(items, cards, { now: NOW, defaults: true, seen: 0 })
  expect(p.items.map(d => [d.who, d.defaultAt !== null, d.board ?? false])).toEqual([
    ['ben', true, false],
    ['anna', true, false],
    ['cleo', false, false],
    ['atlas', false, true],
  ])
  expect(p.items[0]?.options).toEqual(['Merge now', 'After review'])
  expect(p.defaulted).toEqual([])
  expect(decisionsFromCards(cards).map(d => d.who)).toEqual(['ben', 'anna', 'cccccccc'])

  // ben's default goes; it shows until the panel is opened.
  const benRow = withDecisionsDb(db => closedDecisions(db).length)
  expect(benRow).toBe(0)
  const benEntry = listEntries().find(e => e.key === BEN)
  if (!benEntry) throw new Error('no entry')
  defaulted(benEntry, NOW + 30 * 60_000)
  const after = decisionsPayload(items, new Map([...cards, [BEN, readCard(BEN) as Card]]), {
    now: NOW + 30 * 60_000,
    defaults: true,
  })
  expect(after.defaulted.map(d => [d.who, d.question, d.answer])).toEqual([['ben', 'Soon?', 'Merge now']])
  markSeen(NOW + 31 * 60_000)
  expect(decisionsPayload(items, cards, { now: NOW + 32 * 60_000, defaults: true }).defaulted).toEqual([])
})

test('an open row no card points at any more is withdrawn by the queue, not before it settled', () => {
  isolatedHome()
  const r = ask()
  writeCard(ANNA, { ask: '', askSince: '', decision: '' })
  const cards = new Map<string, Card>([[ANNA, readCard(ANNA) as Card]])
  decisionsPayload([], cards, { now: NOW + 5000, defaults: true, seen: 0 })
  expect(row(r.id)?.answeredAt).toBeNull()
  decisionsPayload([], cards, { now: NOW + 60_000, defaults: true, seen: 0 })
  expect(row(r.id)).toMatchObject({ answeredBy: 'withdrawn', via: 'cleared' })
  const db = openDb({ create: false })
  db?.close()
})

test('a default taken out of the schedule by hand is held: the card stops counting down', () => {
  isolatedHome()
  const r = ask()
  const entry = row(r.id)?.entry as string
  removeEntry(entry)
  const cards = new Map<string, Card>([[ANNA, readCard(ANNA) as Card]])
  decisionsPayload([], cards, { now: NOW + 60_000, defaults: true, seen: 0 })
  expect(row(r.id)).toMatchObject({ held: NOW + 60_000, defaultAt: null, answeredAt: null })
  const cd = cardDecisionOf(readCard(ANNA)?.decision)
  expect(cd?.held).toBe(NOW + 60_000)
  expect(cd?.defaultAt).toBeUndefined()
})
