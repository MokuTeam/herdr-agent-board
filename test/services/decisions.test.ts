// Decisions (#487, services/decisions.ts): a question with options on the card and in the record,
// replaced, held, its default due or not, the default given, the hook's close by whose prompt it
// was, a stale id refused, the queue and what went by default since the panel was opened. Cards,
// the schedule and the database in a temp state folder.
import { expect, test } from 'bun:test'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { openDb } from '../../src/adapters/db.ts'
import { closedDecisions, getDecision } from '../../src/adapters/decision-store.ts'
import { addEntry, getEntry, listEntries, logRun, removeEntry } from '../../src/adapters/schedule-store.ts'
import { entriesOf, getThread } from '../../src/adapters/work-thread-store.ts'
import { type AskSpec, cardDecisionOf } from '../../src/core/decisions.ts'
import { nodeKey } from '../../src/core/nodes.ts'
import { MAX_PER_SESSION, type ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Card, Item } from '../../src/core/types.ts'
import { type Party, threadsConfig } from '../../src/core/work-threads.ts'
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
import { askOwner, newThread, type ThreadsCtx } from '../../src/services/work-threads.ts'
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
  expect(defaultDue(entry, undefined, NOW)).toBe('go')
  // The owner's answer being typed in: it waits.
  markAnswering(ANNA, r.id, 'button', NOW)
  expect(defaultDue(entry, undefined, NOW + 1000)).toBe('wait')
  markAnswering(ANNA, r.id, null, NOW + 2000)
  expect(defaultDue(entry, undefined, NOW + 2000)).toBe('go')
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
  expect(defaultDue(entry, undefined, NOW + 7_200_000)).toBe('drop')
  defaulted(entry, NOW + 7_300_000)
  expect(row(r.id)?.answeredAt).toBe(NOW + 7_200_000)
})

test('the default is dropped once the owner wrote (the ask cleared), once held, once replaced', () => {
  isolatedHome()
  const a = ask()
  const entryA = getEntry(row(a.id)?.entry)
  // The hook cleared the ask on the owner's prompt.
  writeCard(ANNA, { ask: '', askSince: '' })
  expect(entryA && defaultDue(entryA, undefined, NOW)).toBe('drop')
  const b = ask(BEN)
  const entryB = getEntry(row(b.id)?.entry)
  withDecisionsDb(db => holdOpen(db, BEN, b.id, NOW))
  expect(entryB && defaultDue(entryB, undefined, NOW)).toBe('drop')
  const c = ask(ANNA)
  const entryC = getEntry(row(c.id)?.entry)
  ask(ANNA, spec({ question: 'Other?' }))
  expect(entryC && defaultDue(entryC, undefined, NOW)).toBe('drop')
})

test("the hook's close: the owner's words, by the button when the page typed it, else withdrawn", () => {
  isolatedHome()
  const typed = ask()
  closeOnPrompt(readCard(ANNA), 'after the review please\nand rebase', NOW + 5)
  expect(row(typed.id)).toMatchObject({ answer: 'after the review please', answeredBy: 'owner', via: 'prompt' })
  expect(getEntry(row(typed.id)?.entry)).toBeNull()

  const clicked = ask()
  markAnswering(ANNA, clicked.id, 'button', NOW + 5)
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
  // The card as the board read it: written a second after the ask.
  const cards = new Map<string, Card>([[ANNA, { ...(readCard(ANNA) as Card), updatedAt: NOW + 1000 }]])
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
  const cards = new Map<string, Card>([[ANNA, { ...(readCard(ANNA) as Card), updatedAt: NOW }]])
  decisionsPayload([], cards, { now: NOW + 60_000, defaults: true, seen: 0 })
  expect(row(r.id)).toMatchObject({ held: NOW + 60_000, defaultAt: null, answeredAt: null })
  const cd = cardDecisionOf(readCard(ANNA)?.decision)
  expect(cd?.held).toBe(NOW + 60_000)
  expect(cd?.defaultAt).toBeUndefined()
})

test("the hook's close wins over the board's tidy-up: a card written a moment ago is never taken for one left behind", () => {
  isolatedHome()
  const r = ask()
  const snapshot = readCard(ANNA)
  // The board refreshes while the card has just lost its ask (the hook on its way).
  writeCard(ANNA, { ask: '', askSince: '', decision: '' })
  decisionsPayload([], new Map([[ANNA, { ...(readCard(ANNA) as Card), updatedAt: NOW + 60_000 }]]), {
    now: NOW + 60_001,
    defaults: true,
    seen: 0,
  })
  expect(row(r.id)?.answeredAt).toBeNull()
  closeOnPrompt(snapshot, 'wait for the review', NOW + 60_001)
  expect(row(r.id)).toMatchObject({ answeredBy: 'owner', answer: 'wait for the review' })
})

test('a card missed by one read leaves its question open and its default in place', () => {
  isolatedHome()
  const r = ask()
  const entry = row(r.id)?.entry as string
  decisionsPayload([], new Map(), { now: NOW + 60_000, defaults: true, seen: 0 })
  expect(row(r.id)?.answeredAt).toBeNull()
  expect(getEntry(entry)).not.toBeNull()
})

test('one answer at a time: a second while the first goes is refused; one left by a board that stopped expires', () => {
  isolatedHome()
  const r = ask()
  expect(markAnswering(ANNA, r.id, 'button', NOW)).toBe(true)
  expect(markAnswering(ANNA, r.id, 'text', NOW + 1000)).toBe(false)
  const entry = getEntry(row(r.id)?.entry)
  if (!entry) throw new Error('no entry')
  expect(defaultDue(entry, undefined, NOW + 1000)).toBe('wait')
  // Renewed while the send runs: it holds a minute from the last renewal, and only the mark it holds.
  expect(markAnswering(ANNA, r.id, 'text', NOW + 50_000, { renew: true })).toBe(false)
  expect(markAnswering(ANNA, r.id, 'button', NOW + 50_000, { renew: true })).toBe(true)
  expect(defaultDue(entry, undefined, NOW + 100_000)).toBe('wait')
  // A minute past the last renewal, the mark no longer holds anything.
  expect(defaultDue(entry, undefined, NOW + 111_000)).toBe('go')
  expect(markAnswering(ANNA, r.id, 'text', NOW + 111_000)).toBe(true)
  markAnswering(ANNA, r.id, null, NOW + 112_000)
  expect(defaultDue(entry, undefined, NOW + 112_000)).toBe('go')
})

test('defaults turned off (or decisions altogether) after the ask: the default is dropped', () => {
  isolatedHome()
  const r = ask()
  const entry = getEntry(row(r.id)?.entry)
  if (!entry) throw new Error('no entry')
  expect(defaultDue(entry, { decisions: true }, NOW)).toBe('go')
  expect(defaultDue(entry, { decisions: { defaults: false } }, NOW)).toBe('drop')
  expect(defaultDue(entry, {}, NOW)).toBe('drop')
})

test("at the schedule's cap the ask is refused and the open question stays as it was, buttons and default", () => {
  isolatedHome()
  const first = ask()
  const firstEntry = row(first.id)?.entry
  for (let i = 1; i < MAX_PER_SESSION; i++)
    addEntry({ key: ANNA, text: `reminder ${i}`, at: NOW + i, next: NOW + 3_600_000 })
  expect(gone(() => ask(ANNA, spec({ question: 'Other?' }), NOW + 1000))).toContain(
    `${MAX_PER_SESSION} entries already`,
  )
  expect(row(first.id)).toMatchObject({ answeredAt: null, held: null })
  expect(getEntry(firstEntry)).not.toBeNull()
  expect(cardDecisionOf(readCard(ANNA)?.decision)?.id).toBe(first.id)
  expect(readCard(ANNA)?.ask).toBe('Merge now or after the review?')
  expect(withDecisionsDb(db => openOf(db, ANNA, first.id)).row.id).toBe(first.id)
})

test("a device's session (#501): no decision is asked for it here, and a default with its key never goes", () => {
  isolatedHome()
  const dev = nodeKey('studio', ANNA)
  expect(gone(() => ask(dev))).toBe("a device's session asks on its own board")
  expect(readCard(dev)).toBeNull()
  // Even with a card under that key that would let it go (an open question, its id, a default due):
  // dropped for being a device's, not by accident.
  writeCard(dev, {
    ask: 'q',
    askSince: NOW,
    decision: { id: 'deadbeef', options: ['a', 'b'], recommend: 1, defaultAt: NOW, defaultMs: 300_000 },
  } as Parameters<typeof writeCard>[1])
  const entry = { id: 'abc123', key: dev, text: 'x', at: NOW, next: NOW, decision: 'deadbeef' } as ScheduleEntry
  expect(defaultDue(entry, { decisions: true }, NOW)).toBe('drop')
})

test("a default typed in whose record was not written is the default's, never held: the tidy-up finds it in the log", () => {
  isolatedHome()
  const r = ask()
  const entry = row(r.id)?.entry as string
  // The scheduler typed it and logged it; its write to the record failed, and the entry went.
  logRun({ id: entry, key: ANNA, result: 'sent', at: NOW + 7_200_000 })
  removeEntry(entry)
  const cards = new Map<string, Card>([[ANNA, { ...(readCard(ANNA) as Card), updatedAt: NOW }]])
  const p = decisionsPayload([itemOf(ANNA, 'anna')], cards, { now: NOW + 7_260_000, defaults: true, seen: 0 })
  expect(row(r.id)).toMatchObject({
    answer: 'Merge now',
    answeredBy: 'default',
    via: 'default',
    answeredAt: NOW + 7_200_000,
    held: null,
  })
  expect(p.defaulted.map(d => [d.who, d.answer, d.at])).toEqual([['anna', 'Merge now', NOW + 7_200_000]])
  expect(readCard(ANNA)?.decision).toBeUndefined()
  expect(readCard(ANNA)?.ask).toBeUndefined()
})

test('what went by default stays unseen past the time the page marked: one that went after it shows on', () => {
  isolatedHome()
  const a = ask(ANNA, spec(), NOW)
  const b = ask(BEN, spec({ question: 'Soon?' }), NOW)
  const ea = getEntry(row(a.id)?.entry)
  const eb = getEntry(row(b.id)?.entry)
  if (!ea || !eb) throw new Error('no entry')
  defaulted(ea, NOW + 7_200_000)
  defaulted(eb, NOW + 7_230_000)
  markSeen(NOW + 7_200_000)
  const p = decisionsPayload([], new Map(), { now: NOW + 7_300_000, defaults: true })
  expect(p.defaulted.map(d => d.who)).toEqual(['ben'])
})

test('a default on a shared thread: its system line stays on this board, the peers get none of it (#394)', () => {
  isolatedHome()
  const actor: Party = { kind: 'session', key: ANNA, name: 'anna' }
  const r = withDecisionsDb(db => {
    const ctx: ThreadsCtx = {
      db,
      cfg: threadsConfig(true) as NonNullable<ReturnType<typeof threadsConfig>>,
      actor,
      now: NOW,
    }
    const made = newThread(ctx, { lane: 'atlas', title: 'Release' })
    db.db.query('UPDATE threads SET scope = ? WHERE id = ?').run(
      JSON.stringify({
        kind: 'peer',
        peer: 'ben-peer',
        topic: `ben-peer/${made.head.id}`,
        key: made.head.key,
        by: 'me',
        at: NOW,
      }),
      made.head.id,
    )
    const head = getThread(db, made.head.id)
    if (!head) throw new Error('no thread')
    const asked = askOwner(ctx, head, 'Ship it?')
    const s = spec({ question: 'Ship it?' })
    const d = askDecision(db, {
      key: ANNA,
      name: 'anna',
      lane: 'atlas',
      spec: s,
      ask: asked.head.waitingOn,
      thread: { id: head.id, key: head.key },
      now: NOW,
    })
    return { ...d, head: asked.head }
  })
  const entry = getEntry(row(r.id)?.entry)
  if (!entry) throw new Error('no entry')
  defaulted(entry, NOW + 7_200_000)
  const entries = withDecisionsDb(db => entriesOf(db, r.head.id))
  const ask = entries.find(e => e.type === 'ask')
  const line = entries.at(-1)
  // The question went to the peer as any entry of a shared thread does; the default's line does not.
  expect(ask?.out).toBe('queued')
  expect(line).toMatchObject({
    type: 'system',
    private: true,
    text: 'no answer in 2 h: went with the recommendation "Merge now"',
  })
  expect(line?.out).toBeUndefined()
  expect(withDecisionsDb(db => getThread(db, r.head.id))?.status).not.toBe('owner')
})
