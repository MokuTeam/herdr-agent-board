// The lanes control and the profile switch folded into a pill without a page (models/segment-fold.ts):
// whether a control's segments fit the room they get, which control folds or unfolds first, and
// the choices as a menu.
import { describe, expect, test } from 'bun:test'
import {
  FOLD_SLACK,
  type FoldControl,
  foldsNow,
  nextFold,
  pickedOptions,
  segmentMenu,
  withFold,
} from '../../web/src/models/segment-fold.ts'

describe('a control folds when its segments are cut, and unfolds once they fit with room to spare', () => {
  test('drawn: it stays while the room holds all of its segments, rounding aside; cut, it folds', () => {
    expect(foldsNow(false, { natural: 240, room: 240 })).toBe(false)
    expect(foldsNow(false, { natural: 241, room: 240 })).toBe(false)
    expect(foldsNow(false, { natural: 242, room: 240 })).toBe(true)
    expect(foldsNow(false, { natural: 300, room: 240 })).toBe(true)
  })

  test('folded: just enough room is not enough; the slack past its natural width unfolds it', () => {
    expect(FOLD_SLACK).toBeGreaterThan(1)
    expect(foldsNow(true, { natural: 240, room: 240 })).toBe(true)
    expect(foldsNow(true, { natural: 240, room: 240 + FOLD_SLACK - 2 })).toBe(true)
    expect(foldsNow(true, { natural: 240, room: 240 + FOLD_SLACK })).toBe(false)
    expect(foldsNow(true, { natural: 240, room: 600 })).toBe(false)
    // The slack is the caller's to choose.
    expect(foldsNow(true, { natural: 240, room: 250 }, 20)).toBe(true)
  })

  test('between the two, a control stays as it is drawn: no flip-flop', () => {
    const room = { natural: 240, room: 243 }
    expect(foldsNow(false, room)).toBe(false)
    expect(foldsNow(true, room)).toBe(true)
  })
})

describe('one change at a time, in the row’s order', () => {
  /** A control whose room is measured once asked; `asked` notes which were. */
  const control = (asked: number[], i: number, folded: boolean, room: { natural: number; room: number } | null) => ({
    folded,
    room: () => {
      asked.push(i)
      return room
    },
  })
  const WHOLE = { natural: 200, room: 200 }
  const CUT = { natural: 260, room: 200 }
  const FITS = { natural: 200, room: 200 + FOLD_SLACK }
  const TIGHT = { natural: 200, room: 201 }

  test('nothing cut, nothing folded: as they are', () => {
    const asked: number[] = []
    expect(nextFold([control(asked, 0, false, WHOLE), control(asked, 1, false, WHOLE)])).toBe(-1)
    expect(nextFold([])).toBe(-1)
  })

  test('both cut: the last one folds first (the lanes keep theirs over the profile switch)', () => {
    const asked: number[] = []
    expect(nextFold([control(asked, 0, false, CUT), control(asked, 1, false, CUT)])).toBe(1)
    expect(asked).toEqual([1])
  })

  test('only one cut: that one folds, the other stays as it is', () => {
    expect(nextFold([control([], 0, false, CUT), control([], 1, false, WHOLE)])).toBe(0)
    expect(nextFold([control([], 0, false, WHOLE), control([], 1, false, CUT)])).toBe(1)
  })

  test('something cut: it folds before any folded control is tried', () => {
    const asked: number[] = []
    expect(nextFold([control(asked, 0, true, FITS), control(asked, 1, false, CUT)])).toBe(1)
    expect(asked).toEqual([1])
  })

  test('nothing cut: the first folded one whose segments fit again unfolds, the next not tried yet', () => {
    const asked: number[] = []
    expect(nextFold([control(asked, 0, true, FITS), control(asked, 1, true, FITS)])).toBe(0)
    expect(asked).toEqual([0])
  })

  test('a folded one with no room to spare stays; the next one is tried, independently', () => {
    const asked: number[] = []
    expect(nextFold([control(asked, 0, true, TIGHT), control(asked, 1, true, FITS)])).toBe(1)
    expect(asked).toEqual([0, 1])
    expect(nextFold([control([], 0, true, TIGHT), control([], 1, true, TIGHT)])).toBe(-1)
    expect(nextFold([control([], 0, true, FITS), control([], 1, false, WHOLE)])).toBe(0)
  })

  test('a folded one whose segments would cut another control’s (no room given) stays folded', () => {
    expect(nextFold([control([], 0, false, WHOLE), control([], 1, true, null)])).toBe(-1)
  })

  test('the slack is the one the controls were tried with', () => {
    const tried: FoldControl = { folded: true, room: () => ({ natural: 200, room: 212 }) }
    expect(nextFold([tried], 20)).toBe(-1)
    expect(nextFold([tried], 12)).toBe(0)
  })

  test('the folded controls, one changed: a new set each time, the others as they were', () => {
    const none: ReadonlySet<string> = new Set()
    const lanes = withFold(none, 'lanes', true)
    expect([...lanes]).toEqual(['lanes'])
    expect([...none]).toEqual([])
    expect([...withFold(lanes, 'profiles', true)].sort()).toEqual(['lanes', 'profiles'])
    expect([...withFold(withFold(lanes, 'profiles', true), 'lanes', false)]).toEqual(['profiles'])
    expect(withFold(lanes, 'lanes', true)).toBe(lanes)
    expect(withFold(lanes, 'profiles', false)).toBe(lanes)
  })
})

describe('the choices as a menu', () => {
  const LANES = [
    { id: 'all', title: 'Все', n: 4 },
    { id: 'blu', title: 'bluBanyan', n: 3 },
    { id: 'proj', title: 'Проекты', n: 1 },
  ]
  const PROFILES = [
    { id: 'all', title: 'Все профили', color: '', n: 4 },
    { id: 'default', title: 'Private', color: '#5856D6', n: 1 },
    { id: 'work', title: 'Work', color: '#30B0C7', n: 3 },
  ]

  test('every choice with its count, the one on show checked', () => {
    expect(segmentMenu(LANES, ['blu'], false)).toEqual([
      { id: 'all', label: 'Все', checked: false, count: 4 },
      { id: 'blu', label: 'bluBanyan', checked: true, count: 3 },
      { id: 'proj', label: 'Проекты', checked: false, count: 1 },
    ])
  })

  test('a profile’s count in its color, as its segment has it; "All profiles" has none', () => {
    expect(segmentMenu(PROFILES, ['default'], true)).toEqual([
      { id: 'all', label: 'Все профили', checked: false, count: 4, tint: '' },
      { id: 'default', label: 'Private', checked: true, count: 1, tint: '#5856D6' },
      { id: 'work', label: 'Work', checked: false, count: 3, tint: '#30B0C7' },
    ])
  })

  test('several on show (the lanes): each checked, and each keeps the menu open but "All"', () => {
    expect(segmentMenu(LANES, ['proj', 'blu'], false, true)).toEqual([
      { id: 'all', label: 'Все', checked: false, count: 4 },
      { id: 'blu', label: 'bluBanyan', checked: true, count: 3, keep: true },
      { id: 'proj', label: 'Проекты', checked: true, count: 1, keep: true },
    ])
    expect(segmentMenu(LANES, ['all'], false, true).map(i => [i.id, i.checked, !!i.keep])).toEqual([
      ['all', true, false],
      ['blu', false, true],
      ['proj', false, true],
    ])
  })

  test('the choices the pill names: those lit in the segments’ order, else the first', () => {
    expect(pickedOptions(LANES, ['proj'])).toEqual([{ id: 'proj', title: 'Проекты', n: 1 }])
    expect(pickedOptions(LANES, ['proj', 'blu']).map(o => o.id)).toEqual(['blu', 'proj'])
    expect(pickedOptions(LANES, ['gone', 'proj']).map(o => o.id)).toEqual(['proj'])
    expect(pickedOptions(LANES, ['gone'])).toEqual([{ id: 'all', title: 'Все', n: 4 }])
    expect(pickedOptions([], ['all'])).toEqual([])
  })
})
