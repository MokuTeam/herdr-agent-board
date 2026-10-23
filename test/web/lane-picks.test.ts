// The lanes control's picks (models/lane-picks.ts): any set of lanes on show, none for every lane;
// board.filter as older pages kept it and as this one keeps it; and what reads the picks: a new
// session's lane (hooks/useNewSession.ts laneContext) and a lane's and the board's menus.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { laneContext } from '../../web/src/hooks/useNewSession.ts'
import {
  ALL_LANES,
  firstPicked,
  laneShown,
  lanesText,
  litLanes,
  onlyLane,
  parseLanes,
  toggledLane,
  withLane,
} from '../../web/src/models/lane-picks.ts'
import { boardMenu, laneMenu, type MenuEntry } from '../../web/src/models/menu-model.ts'

describe('the picks', () => {
  test('none shows every lane; else the lanes picked, whatever their order', () => {
    expect(laneShown(ALL_LANES, 'acme')).toBe(true)
    expect(laneShown(['acme'], 'acme')).toBe(true)
    expect(laneShown(['acme'], 'web')).toBe(false)
    expect(laneShown(['web', 'acme'], 'acme')).toBe(true)
    expect(laneShown(['web', 'acme'], 'other')).toBe(false)
  })

  test('a click puts a lane on show or takes it off; "All" and the last one off show every lane', () => {
    expect(toggledLane([], 'acme')).toEqual(['acme'])
    expect(toggledLane(['acme'], 'web')).toEqual(['acme', 'web'])
    expect(toggledLane(['acme', 'web'], 'acme')).toEqual(['web'])
    expect(toggledLane(['web'], 'web')).toEqual([])
    expect(toggledLane(['acme', 'web'], 'all')).toEqual([])
    // From the segments lit ("All" among them while none is picked), as the pill's menu has them.
    expect(toggledLane(litLanes([]), 'acme')).toEqual(['acme'])
    expect(litLanes([])).toEqual(['all'])
    expect(litLanes(['web', 'acme'])).toEqual(['web', 'acme'])
  })

  test('"Show only", a session started off the picks, and the lane a new session starts in', () => {
    expect(onlyLane('acme')).toEqual(['acme'])
    expect(onlyLane('all')).toEqual([])
    const picks = ['web']
    expect(withLane(picks, 'acme')).toEqual(['web', 'acme'])
    expect(withLane(picks, 'web')).toBe(picks)
    expect(withLane(ALL_LANES, 'acme')).toBe(ALL_LANES)
    expect(firstPicked(['web', 'acme'])).toBe('web')
    expect(firstPicked([])).toBe(null)
  })
})

describe('board.filter in localStorage', () => {
  test('what an older page kept reads as it did: all, or one lane', () => {
    expect(parseLanes('all')).toEqual([])
    expect(parseLanes('')).toEqual([])
    expect(parseLanes('acme')).toEqual(['acme'])
    expect(parseLanes('Клиент · 2')).toEqual(['Клиент · 2'])
  })

  test('several as a JSON list; text that is no such list is one lane’s id', () => {
    expect(parseLanes('["web","acme"]')).toEqual(['web', 'acme'])
    expect(parseLanes('["web","web","all",""]')).toEqual(['web'])
    expect(parseLanes('[]')).toEqual([])
    expect(parseLanes('[wip]')).toEqual(['[wip]'])
    expect(parseLanes('[1,2]')).toEqual(['[1,2]'])
  })

  test('written as an older page reads it while it can: all, one lane, and several as a list', () => {
    expect(lanesText([])).toBe('all')
    expect(lanesText(['acme'])).toBe('acme')
    expect(lanesText(['web', 'acme'])).toBe('["web","acme"]')
    for (const picks of [[], ['acme'], ['web', 'acme'], ['a "quoted" lane', 'Клиент']])
      expect(parseLanes(lanesText(picks))).toEqual(picks)
  })
})

describe('what reads the picks', () => {
  test('New session from the toolbar or Shift+N: the lane when one is picked; none else, the form decides', () => {
    expect(laneContext([])).toEqual({})
    expect(laneContext(['acme'])).toEqual({ category: 'acme' })
    // Several: the form starts in the first picked and says so (models/launch-form.ts formStart).
    expect(laneContext(['web', 'acme'])).toEqual({})
  })

  const t = translator('en')
  const ctx = { t, canMutate: true, canEdit: true }
  const acme = { id: 'acme', title: 'Acme', color: '#007AFF' }
  const ids = (items: MenuEntry[]) => items.flatMap(it => (it.separator ? [] : [it.id]))

  test('a lane’s menu: "Show only" unless it is on show alone, "Show all lanes" while it is picked', () => {
    expect(ids(laneMenu(acme, { ...ctx, filter: [] })).slice(-1)).toEqual(['showOnly'])
    expect(ids(laneMenu(acme, { ...ctx, filter: ['acme'] })).slice(-1)).toEqual(['showAll'])
    expect(ids(laneMenu(acme, { ...ctx, filter: ['web', 'acme'] })).slice(-2)).toEqual(['showOnly', 'showAll'])
  })

  test('the board’s menu: "Show all lanes" once a lane is picked', () => {
    expect(ids(boardMenu({ ...ctx, filter: [], sleepers: true }))).not.toContain('showAll')
    expect(ids(boardMenu({ ...ctx, filter: ['acme'], sleepers: true }))).toContain('showAll')
    expect(ids(boardMenu({ ...ctx, filter: ['web', 'acme'], sleepers: true }))).toContain('showAll')
  })
})
