import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  awaySince,
  diffStates,
  journalConfig,
  journalLines,
  journalList,
  kindOf,
  type Move,
  moved,
  type StateRow,
  withRecord,
} from '../../src/core/journal.ts'
import type { Item } from '../../src/core/types.ts'

const item = (key: string, o: Partial<Item> = {}): Item => ({
  key,
  session: key,
  pane: null,
  workspace: null,
  cwd: '/work/project with spaces %',
  status: 'idle',
  name: key,
  autoName: '',
  category: 'personal',
  categorySet: true,
  column: 'idle',
  attention: '',
  ...o,
})
const move = (key: string, kind: Move['kind'], at: number, line = ''): Move => ({
  key,
  kind,
  at,
  line,
  name: key,
  lane: 'personal',
})
const state = (kind: StateRow['kind'], at: number, line = '', gone: number | null = null): StateRow => ({
  kind,
  at,
  line,
  name: '',
  lane: 'personal',
  gone,
})

describe('journalConfig', () => {
  test('true, an object, else off', () => {
    expect(journalConfig(true)).toEqual({ returnMinutes: 15 })
    expect(journalConfig({ returnMinutes: 30 })).toEqual({ returnMinutes: 30 })
    expect(journalConfig({ returnMinutes: 0 })).toEqual({ returnMinutes: 15 })
    expect(journalConfig({})).toEqual({ returnMinutes: 15 })
    for (const off of [undefined, null, false, 'yes', 1, []]) expect(journalConfig(off)).toBeNull()
  })
})

describe('kindOf', () => {
  test("the column, with Claude Code's API error message told apart", () => {
    expect(kindOf(item('a', { column: 'me' }))).toBe('owner')
    expect(kindOf(item('a', { column: 'ext' }))).toBe('ext')
    expect(kindOf(item('a', { column: 'work' }))).toBe('work')
    expect(kindOf(item('a', { column: 'done' }))).toBe('done')
    expect(kindOf(item('a', { column: 'idle' }))).toBe('idle')
    const err = { apiError: true as const }
    expect(kindOf(item('a', { column: 'done', lastText: 'API Error: 529 overloaded', ...err }))).toBe('error')
    expect(kindOf(item('a', { column: 'idle', lastText: 'API Error: 500', ...err }))).toBe('error')
    // still working after an error: working
    expect(kindOf(item('a', { column: 'work', lastText: 'API Error: 500', ...err }))).toBe('work')
    // an agent's closing words that begin with the same text are no error
    expect(kindOf(item('a', { column: 'done', lastText: 'API Error: fixed, the retry now waits' }))).toBe('done')
    expect(kindOf(item('a', { column: 'done', lastText: 'API Error (request timed out) is handled' }))).toBe('done')
  })
})

describe('lines', () => {
  test("an agent's control characters never reach the line", () => {
    const r = diffStates(
      new Map([['x', state('idle', 1)]]),
      [item('anna', { column: 'me', question: 'ok?\u001b[2J\u0007 go' })],
      5,
    )
    expect(r.moves[0]?.line).toBe('ok? [2J go')
  })

  test('format characters (a right-to-left override, a zero-width space) are taken out', () => {
    const r = diffStates(
      new Map([['x', state('idle', 1)]]),
      [item('anna', { column: 'me', question: 'push\u202E to main\u200B?' })],
      5,
    )
    expect(r.moves[0]?.line).toBe('push to main?')
  })
})

describe('diffStates', () => {
  test('the first sight seeds the states and records no move', () => {
    const r = diffStates(new Map(), [item('anna', { column: 'done', result: 'PR opened' })], 100, true)
    expect(r.moves).toEqual([])
    expect(r.states.get('anna')).toMatchObject({ kind: 'done', line: 'PR opened', at: 100, gone: null })
  })

  test('a change of kind is one move; the same board again records nothing', () => {
    const before = new Map([['anna', { ...state('work', 1), name: 'anna' }]])
    const items = [item('anna', { column: 'me', question: 'May I push?' })]
    const first = diffStates(before, items, 200)
    expect(first.moves).toEqual([move('anna', 'owner', 200, 'May I push?')])
    const after = new Map([...before, ...first.states])
    const again = diffStates(after, items, 300)
    expect(again.moves).toEqual([])
    expect(again.states.size).toBe(0)
  })

  test('a new line in the same kind updates the state only, keeping when it went there', () => {
    const before = new Map([['ben', { ...state('owner', 50, 'old question'), name: 'ben' }]])
    const r = diffStates(before, [item('ben', { column: 'me', question: 'new question' })], 90)
    expect(r.moves).toEqual([])
    expect(r.states.get('ben')).toMatchObject({ kind: 'owner', line: 'new question', at: 50 })
  })

  test('a card that leaves keeps its state, marked gone; back unchanged it records nothing', () => {
    const before = new Map([['cleo', { ...state('ext', 10, 'CI'), name: 'cleo' }]])
    const left = diffStates(before, [], 20)
    expect(left.moves).toEqual([])
    expect(left.states.get('cleo')).toMatchObject({ kind: 'ext', gone: 20 })
    const gone = new Map([...before, ...left.states])
    const back = diffStates(gone, [item('cleo', { column: 'ext', wait: 'CI' })], 30)
    expect(back.moves).toEqual([])
    expect(back.states.get('cleo')).toMatchObject({ gone: null, at: 10 })
  })

  test('a session first seen after the seed is a move; one key twice counts once', () => {
    const r = diffStates(new Map([['x', state('idle', 1)]]), [item('atlas', { column: 'work' }), item('atlas')], 5)
    expect(r.moves).toEqual([{ ...move('atlas', 'work', 5), name: 'atlas' }])
  })
})

describe('a card first seen under its pane key', () => {
  test('gets its session id: one history under the new key, no second row', () => {
    const pane = item('pane-p7', { session: null, pane: 'p7', column: 'work' })
    const first = diffStates(new Map([['x', state('idle', 1)]]), [item('x'), pane], 100)
    expect(first.moves.map(m => m.key)).toEqual(['pane-p7'])
    const before = new Map([
      ['x', state('idle', 1)],
      ['pane-p7', first.states.get('pane-p7') as StateRow],
    ])
    // the same kind under the session id: renamed, no move, its time kept
    const same = diffStates(before, [item('x'), item('s-anna', { pane: 'p7', column: 'work' })], 200)
    expect(same.renames).toEqual([['pane-p7', 's-anna']])
    expect(same.moves).toEqual([])
    expect(same.states.get('s-anna')).toMatchObject({ kind: 'work', at: 100, gone: null })
    expect(same.states.has('pane-p7')).toBe(false)
    // another kind: renamed, and the move is the session's
    const asks = diffStates(before, [item('x'), item('s-anna', { pane: 'p7', column: 'me', question: 'ok?' })], 300)
    expect(asks.renames).toEqual([['pane-p7', 's-anna']])
    expect(asks.moves.map(m => [m.key, m.kind])).toEqual([['s-anna', 'owner']])
  })

  test('not folded when the pane key is still on the board, gone, or the session is known', () => {
    const before = new Map([
      ['pane-p7', state('work', 100)],
      ['pane-p8', state('work', 100, '', 150)],
      ['s-ben', state('work', 50)],
    ])
    const r = diffStates(
      before,
      [
        item('pane-p7', { session: null, pane: 'p7', column: 'work' }),
        item('s-anna', { pane: 'p7', column: 'work' }),
        item('s-cleo', { pane: 'p8', column: 'work' }),
        item('s-ben', { pane: 'p9', column: 'work' }),
      ],
      200,
    )
    expect(r.renames).toEqual([])
    expect(r.moves.map(m => m.key).sort()).toEqual(['s-anna', 's-cleo'])
  })
})

describe('journalList', () => {
  const since = 1000
  const states = (rows: Record<string, StateRow>) => new Map(Object.entries(rows))

  test('groups in order: waits on you, error, finished, waits on others; the rest only counted', () => {
    const moves = [
      move('d', 'ext', 1100, 'CI'),
      move('c', 'done', 1200, 'PR opened'),
      move('b', 'error', 1300, 'API Error: 529'),
      move('a', 'owner', 1400, 'push?'),
      move('w', 'work', 1500),
      move('i', 'idle', 1600),
      move('w2', 'work', 1700),
    ]
    const list = journalList(
      moves,
      states({
        a: state('owner', 1400, 'push?'),
        b: state('error', 1300, 'API Error: 529'),
        c: state('done', 1200, 'PR opened'),
        d: state('ext', 1100, 'CI'),
        w: state('work', 1500),
        i: state('idle', 1600),
        w2: state('work', 1700),
      }),
      since,
    )
    expect(list.rows.map(r => [r.key, r.kind])).toEqual([
      ['a', 'owner'],
      ['b', 'error'],
      ['c', 'done'],
      ['d', 'ext'],
    ])
    expect(list.rest).toEqual({ work: 2, idle: 1 })
    expect(list.more).toBe(0)
  })

  test('finished and then woken for the next task is still finished, with its line', () => {
    const moves = [move('a', 'done', 1100, 'first task done'), move('a', 'work', 1200)]
    const list = journalList(moves, states({ a: state('work', 1200) }), since)
    expect(list.rows).toEqual([
      { key: 'a', name: 'a', lane: 'personal', kind: 'done', line: 'first task done', at: 1100 },
    ])
    expect(list.rest).toEqual({ work: 0, idle: 0 })
  })

  test('finished and then put to sleep is finished', () => {
    const list = journalList(
      [move('a', 'done', 1100, 'ok'), move('a', 'idle', 1200)],
      states({ a: state('idle', 1200) }),
      since,
    )
    expect(list.rows.map(r => r.kind)).toEqual(['done'])
  })

  test('an error and a later finish: the later wins; waiting on you now wins over both', () => {
    const later = journalList(
      [move('a', 'error', 1100, 'API Error'), move('a', 'work', 1150), move('a', 'done', 1200, 'done after all')],
      states({ a: state('done', 1200, 'done after all') }),
      since,
    )
    expect(later.rows.map(r => [r.kind, r.line])).toEqual([['done', 'done after all']])
    const asks = journalList(
      [move('a', 'done', 1100, 'x'), move('a', 'owner', 1200, 'next?')],
      states({ a: state('owner', 1200, 'next?') }),
      since,
    )
    expect(asks.rows.map(r => [r.kind, r.line])).toEqual([['owner', 'next?']])
  })

  test('an error, then woken for the next task: still stopped on an error, with its line', () => {
    const list = journalList(
      [move('a', 'error', 1100, 'API Error: 529'), move('a', 'work', 1200)],
      states({ a: state('work', 1200) }),
      since,
    )
    expect(list.rows.map(r => [r.kind, r.line])).toEqual([['error', 'API Error: 529']])
    expect(list.rest).toEqual({ work: 0, idle: 0 })
  })

  test('a finish and a later error: the error wins', () => {
    const list = journalList(
      [move('a', 'done', 1100, 'step one done'), move('a', 'work', 1150), move('a', 'error', 1200, 'API Error: 500')],
      states({ a: state('error', 1200, 'API Error: 500') }),
      since,
    )
    expect(list.rows.map(r => [r.kind, r.line])).toEqual([['error', 'API Error: 500']])
  })

  test('waiting on someone else now wins over an earlier finish or error', () => {
    const list = journalList(
      [
        move('a', 'done', 1100, 'x'),
        move('a', 'ext', 1200, 'CI'),
        move('b', 'error', 1100, 'e'),
        move('b', 'ext', 1300, 'ben'),
      ],
      states({ a: state('ext', 1200, 'CI'), b: state('ext', 1300, 'ben') }),
      since,
    )
    expect(list.rows.map(r => [r.key, r.kind, r.line])).toEqual([
      ['a', 'ext', 'CI'],
      ['b', 'ext', 'ben'],
    ])
  })

  test('a waiting card shows its latest line', () => {
    const list = journalList([move('a', 'owner', 1100, 'first')], states({ a: state('owner', 1100, 'second') }), since)
    expect(list.rows[0]?.line).toBe('second')
  })

  test('cards that waited on you before and still do are counted, not listed', () => {
    const list = journalList(
      [move('a', 'owner', 1100, 'new')],
      states({
        a: state('owner', 1100, 'new'),
        old1: state('owner', 500, 'waiting since yesterday'),
        old2: state('owner', 900, 'still waiting'),
        answered: state('work', 400),
        gone: state('owner', 300, 'archived', 800),
      }),
      since,
    )
    expect(list.rows.map(r => r.key)).toEqual(['a'])
    expect(list.before).toBe(2)
  })

  test('only cards that waited before: the count, and nothing moved', () => {
    const list = journalList([], states({ old: state('owner', 500, 'waiting since yesterday') }), since)
    expect(list.before).toBe(1)
    expect(moved(list)).toBe(false)
    expect(moved(journalList([move('a', 'work', 1100)], states({ a: state('work', 1100) }), since))).toBe(true)
  })

  test('a card that left the board waits on no one: no row, no count', () => {
    const list = journalList(
      [
        move('a', 'owner', 1100, 'push?'),
        move('b', 'ext', 1200, 'CI'),
        move('c', 'work', 1300),
        move('d', 'done', 1400, 'ok'),
      ],
      states({
        a: state('owner', 1100, 'push?', 1500),
        b: state('ext', 1200, 'CI', 1600),
        c: state('work', 1300, '', 1700),
        d: state('done', 1400, 'ok', 1800),
      }),
      since,
    )
    expect(list.rows.map(r => [r.key, r.kind])).toEqual([['d', 'done']])
    expect(list.rest).toEqual({ work: 0, idle: 0 })
    // gone only after the window's end: still listed for that window
    const window = journalList(
      [move('a', 'owner', 1100, 'push?')],
      states({ a: state('owner', 1100, 'push?', 3000) }),
      since,
      2000,
    )
    expect(window.rows.map(r => r.key)).toEqual(['a'])
  })

  test('twenty rows at most, then how many more', () => {
    const moves = Array.from({ length: 25 }, (_, i) => move(`s${i}`, 'done', 1100 + i, 'ok'))
    const list = journalList(moves, new Map(), since)
    expect(list.rows).toHaveLength(20)
    expect(list.more).toBe(5)
    expect(list.rows[0]?.key).toBe('s0')
  })

  test('moves before since or after until are left out', () => {
    const moves = [move('a', 'done', 900, 'old'), move('b', 'done', 1100, 'in'), move('c', 'done', 2100, 'after')]
    const list = journalList(moves, new Map(), since, 2000)
    expect(list.rows.map(r => r.key)).toEqual(['b'])
  })
})

describe('withRecord', () => {
  const list = { since: 100, rows: [], more: 0, rest: { work: 0, idle: 0 }, before: 0 }
  test('the start of recording only when the list asks for earlier', () => {
    expect(withRecord(list, 50)).toBe(list)
    expect(withRecord(list, 100)).toBe(list)
    expect(withRecord(list, 200).recordedFrom).toBe(200)
    expect(withRecord(list, null, 300).recordedFrom).toBe(300)
    expect(withRecord(list, undefined)).toBe(list)
  })
})

describe('journalLines', () => {
  const t = translator('en')
  const base = { since: 0, more: 0, rest: { work: 0, idle: 0 }, before: 0 }
  const row = (key: string, kind: 'owner' | 'done', line: string) => ({
    key,
    name: key,
    lane: 'personal',
    kind,
    line,
    at: 0,
  })

  test('the "before" count closes the first group', () => {
    const lines = journalLines(
      {
        ...base,
        rows: [row('anna', 'owner', 'push?'), row('ben', 'done', 'PR')],
        before: 2,
        rest: { work: 3, idle: 1 },
      },
      t,
      0,
    )
    expect(lines.slice(1)).toEqual([
      'waits on you · anna (personal) 00:00: push?',
      'and 2 more were waiting on you before',
      'finished · ben (personal) 00:00: PR',
      'and 4 more moved: 3 working, 1 idle',
    ])
  })

  test('with no new wait the count still comes first', () => {
    const lines = journalLines({ ...base, rows: [row('ben', 'done', 'PR')], before: 1 }, t, 0)
    expect(lines.slice(1)).toEqual(['and 1 more was waiting on you before', 'finished · ben (personal) 00:00: PR'])
  })

  test('lane titles, and a window before recording began says so', () => {
    const lines = journalLines({ ...base, rows: [row('ben', 'done', 'PR')], recordedFrom: 0 }, t, 0, id =>
      id === 'personal' ? 'Personal' : id,
    )
    expect(lines).toEqual([
      'Since 00:00:',
      'The journal has no record before 00:00: it was not recording then.',
      'finished · ben (Personal) 00:00: PR',
    ])
  })

  test('nothing moved', () => {
    expect(journalLines({ ...base, rows: [] }, t, 0)).toEqual(['Since 00:00:', 'Nothing on the board changed.'])
  })
})

describe('awaySince', () => {
  test('presence away now, else the last time the owner left', () => {
    expect(awaySince({ state: 'away', since: 500, by: 'user' }, {})).toBe(500)
    expect(awaySince({ state: 'here', since: 900, by: 'auto' }, { left: 100, back: 900 })).toBe(100)
    expect(awaySince(null, { left: 300 })).toBe(300)
    expect(awaySince(null, {})).toBeNull()
    // a call taken and ended inside the absence does not move its start
    expect(awaySince({ state: 'away', since: 900, by: 'auto' }, { left: 100 })).toBe(100)
    expect(awaySince({ state: 'call', since: 700, by: 'auto', before: 'away' }, { left: 100 })).toBe(100)
    // the marks of an earlier absence that ended: since presence went away again
    expect(awaySince({ state: 'away', since: 900, by: 'auto' }, { left: 100, back: 200 })).toBe(900)
  })
})
