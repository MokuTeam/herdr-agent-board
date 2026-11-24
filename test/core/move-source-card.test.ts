// #642: the source card a move left awake. core/node-items.ts dropMovedCards drops it from the
// master's merged payload by the `movedTo` mark its own board wrote (services/move-out.ts finish),
// not by weighing two machines' clocks; services/board.ts carries the card's `moved` as `movedTo`,
// and core/agent-send.ts targetsOf answers the same way.
import { expect, test } from 'bun:test'
import { dropMovedCards, nodePart } from '../../src/core/node-items.ts'
import type { Item } from '../../src/core/types.ts'

const SID = '1f0e3c1a-5b7d-4c2e-9a10-3c4b5d6e7f80'

/** A card of the merged payload: this computer's when `device` is unset, a node's with it. */
const card = (more: Partial<Item> & { key: string }): Item =>
  ({
    session: SID,
    pane: 'w1:p1',
    workspace: null,
    cwd: '/w/atlas',
    status: 'idle',
    name: 'Legacy-master',
    autoName: '',
    category: 'other',
    categorySet: false,
    column: 'idle',
    attention: '',
    activity: 100,
    ...more,
  }) as Item

const keys = (items: readonly Item[], masterId = ''): string[] => dropMovedCards(items, masterId).map(i => i.key)

// The issue's shape: `board move Legacy-master --device server-2` on the laptop; the master's
// payload holds the laptop's awake card (no device, status done) beside server-2's, and the
// laptop's clock runs ahead, so #641's activity weigh cannot decide. The mark decides.
const laptop = (more: Partial<Item> = {}) => card({ key: SID, status: 'done', activity: 100, ...more })
const atServer2 = (more: Partial<Item> = {}) =>
  card({ key: `@server-2:${SID}`, device: 'server-2', pane: 'n1:p1', activity: 90, ...more })

test('a source card marked movedTo leaves once the session has a card on that device, whatever either clock says', () => {
  expect(keys([laptop({ movedTo: 'server-2' }), atServer2()])).toEqual([`@server-2:${SID}`])
  // The same with the node's card older by the clock: still only the mark weighs.
  expect(keys([laptop({ movedTo: 'server-2', activity: 9_999 }), atServer2({ activity: 1 })])).toEqual([
    `@server-2:${SID}`,
  ])
  // Also when the target card on server-2 is sleeping.
  expect(keys([laptop({ movedTo: 'server-2' }), atServer2({ sleeping: true, pane: null })])).toEqual([
    `@server-2:${SID}`,
  ])
})

test('a marked card stays while no card of its session is on the device it moved to', () => {
  // An offline node, or a move that never landed: the source card is all the board has.
  expect(keys([laptop({ movedTo: 'server-2' })])).toEqual([SID])
  // A chain move (laptop -> server-2 -> server-3): only server-3's card remains.
  expect(
    keys([
      laptop({ movedTo: 'server-2' }),
      atServer2({ movedTo: 'server-3' }),
      card({ key: `@server-3:${SID}`, device: 'server-3', pane: 'n2:p1' }),
    ]),
  ).toEqual([`@server-3:${SID}`])
  // server-2 still shows a card of the session, so the laptop's is gone; server-2's own source
  // stays, as nothing runs on server-3 yet.
  expect(keys([laptop({ movedTo: 'server-2' }), atServer2({ movedTo: 'server-3' })])).toEqual([`@server-2:${SID}`])
})

test('a move back names the master by its id, which its own cards carry no device under', () => {
  // server-2's card marked movedTo 'laptop': the session runs on the master again.
  expect(keys([atServer2({ movedTo: 'laptop' }), laptop()], 'laptop')).toEqual([SID])
  // When masterId is unknown (''), a node card marked movedTo 'laptop' stays instead of guessing.
  expect(keys([atServer2({ movedTo: 'laptop' }), laptop()], '')).toEqual([`@server-2:${SID}`, SID])
  // No card of it here: the marked node card stays.
  expect(keys([atServer2({ movedTo: 'laptop' })], 'laptop')).toEqual([`@server-2:${SID}`])
})

test('stale mutual marks or corrupt self-marks never drop all cards', () => {
  expect(keys([laptop({ movedTo: 'server-2' }), atServer2({ movedTo: 'laptop' })], 'laptop')).toEqual([
    SID,
    `@server-2:${SID}`,
  ])
  expect(keys([atServer2({ movedTo: 'server-2' })], 'laptop')).toEqual([`@server-2:${SID}`])
})

test('cards with no mark, cards without a session id, and other setups stay as they came', () => {
  const a = laptop()
  const b = atServer2()
  expect(keys([a, b])).toEqual([SID, `@server-2:${SID}`])
  // A pane-keyed card of no session: never compared.
  expect(keys([card({ key: 'pane-w1:p9', session: null, movedTo: 'server-2' }), b])).toEqual([
    'pane-w1:p9',
    `@server-2:${SID}`,
  ])
  // Windows paths, pi session paths, names with spaces, Cyrillic, and % keep their order.
  const piWin = card({
    key: 'C:\\Users\\anna\\.pi\\sessions\\Тест 50%.jsonl',
    session: 'C:\\Users\\anna\\.pi\\sessions\\Тест 50%.jsonl',
    name: 'Тест 50% x',
  })
  const piNix = card({
    key: '/home/anna/.pi/sessions/Тест 50%.jsonl',
    session: '/home/anna/.pi/sessions/Тест 50%.jsonl',
    name: 'Тест 50% y',
  })
  expect(keys([laptop({ movedTo: 'server-2' }), piWin, atServer2(), piNix])).toEqual([
    piWin.key,
    `@server-2:${SID}`,
    piNix.key,
  ])
})

test('nodePart forwards valid movedTo and drops invalid or empty movedTo', () => {
  const base = {
    key: SID,
    session: SID,
    pane: 'w1:p1',
    workspace: 'w1',
    cwd: '/w/atlas',
    status: 'idle',
    name: 'Legacy-master',
    autoName: '',
    category: 'other',
    categorySet: true,
    column: 'idle',
    attention: '',
  }
  const good = nodePart({ items: [{ ...base, movedTo: 'server-3', movedAt: 1234 }] }, 'server-2')
  expect(good?.items[0]?.movedTo).toBe('server-3')
  expect(good?.items[0]?.movedAt).toBe(1234)
  const offlineCopy = nodePart({ items: [{ ...base, movedTo: 'laptop', movedAt: 500 }] }, null)
  expect(offlineCopy?.items[0]?.movedTo).toBe('laptop')
  expect(offlineCopy?.items[0]?.movedAt).toBe(500)
  const bad = nodePart(
    {
      items: [
        { ...base, key: 'k-empty', movedTo: '' },
        { ...base, key: 'k-num', movedTo: 42, movedAt: '100' },
        { ...base, key: 'k-long', movedTo: 'x'.repeat(300), movedAt: Number.NaN },
      ],
    },
    'server-2',
  )
  expect(bad?.items.map(i => i.movedTo)).toEqual([undefined, undefined, 'x'.repeat(256)])
  expect(bad?.items.map(i => i.movedAt)).toEqual([undefined, undefined, undefined])
})

test('locally resumed card (activity > movedAt) keeps its card even with an un-cleared movedTo mark', () => {
  expect(keys([laptop({ movedTo: 'server-2', movedAt: 1000, activity: 2000 }), atServer2({ activity: 1500 })])).toEqual(
    [SID, `@server-2:${SID}`],
  )
  // Activity at or before movedAt: mark still holds and drops the stale source card.
  expect(keys([laptop({ movedTo: 'server-2', movedAt: 1000, activity: 1000 }), atServer2({ activity: 500 })])).toEqual([
    `@server-2:${SID}`,
  ])
})

test('legacy movedTo board mark matches master hostname id unless a device is named board', () => {
  expect(keys([atServer2({ movedTo: 'board', movedAt: 500, activity: 400 }), laptop()], 'anna-laptop')).toEqual([SID])
  // If a remote device itself is literally id "board", do not treat movedTo "board" as the master.
  expect(
    keys(
      [
        atServer2({ movedTo: 'board', movedAt: 500, activity: 400 }),
        card({ key: `@board:other`, device: 'board', session: 'other-session' }),
        laptop(),
      ],
      'anna-laptop',
    ),
  ).toEqual([`@server-2:${SID}`, `@board:other`, SID])
})
