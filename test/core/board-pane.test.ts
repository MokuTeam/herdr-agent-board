import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { asSavedBoard, lastBoard } from '../../src/core/board-pane.ts'

const panes = [{ pane_id: 'wZ:p1' }, { pane_id: 'wZ:p2' }]
const alive = (pid: number): boolean => pid === 100
const none = (): boolean => {
  throw new Error('no process to look for')
}

test('board.json: the pane and the pid the board wrote; no pane, no board', () => {
  assert.deepEqual(asSavedBoard({ pane: 'wZ:p2', pid: 31804, overlay: false }), { pane: 'wZ:p2', pid: 31804 })
  assert.deepEqual(asSavedBoard({ pane: 'wZ:p2' }), { pane: 'wZ:p2' })
  assert.deepEqual(asSavedBoard({ pane: 'pane-7 a%b', pid: 0 }), { pane: 'pane-7 a%b' })
  assert.deepEqual(asSavedBoard({ pane: 'p', pid: -4 }), { pane: 'p' })
  assert.deepEqual(asSavedBoard({ pane: 'p', pid: '31804' }), { pane: 'p' })
  assert.deepEqual(asSavedBoard({ pane: 'p', pid: 1.5 }), { pane: 'p' })
  for (const value of [null, undefined, 'wZ:p2', 7, [], {}, { pane: '' }, { pane: 3, pid: 100 }, { pid: 100 }])
    assert.equal(asSavedBoard(value), null, JSON.stringify(value))
})

test('a board whose pane is there and whose process lives runs', () => {
  assert.deepEqual(lastBoard({ pane: 'wZ:p2', pid: 100 }, panes, alive), { pane: 'wZ:p2', stale: false })
})

test('a pane that is there with the board process gone is stale: herdr brought the pane back, not the board', () => {
  assert.deepEqual(lastBoard({ pane: 'wZ:p2', pid: 31804 }, panes, alive), { pane: 'wZ:p2', stale: true })
})

test('a board.json without a pid (an older board) trusts the pane, as before', () => {
  assert.deepEqual(lastBoard({ pane: 'wZ:p2' }, panes, none), { pane: 'wZ:p2', stale: false })
})

test('pane ids are matched whole, whatever they hold', () => {
  const odd = [{ pane_id: 'pane-7 a%b' }, { pane_id: 'панель:2' }, { pane_id: 'C:\\x y' }]
  for (const { pane_id } of odd) {
    assert.deepEqual(lastBoard({ pane: pane_id, pid: 31804 }, odd, alive), { pane: pane_id, stale: true })
    assert.deepEqual(lastBoard({ pane: pane_id, pid: 100 }, odd, alive), { pane: pane_id, stale: false })
  }
  assert.equal(lastBoard({ pane: 'pane-7', pid: 31804 }, odd, none), null)
  assert.equal(lastBoard({ pane: 'ПАНЕЛЬ:2', pid: 31804 }, odd, none), null)
})

test('no board.json, or a pane that is gone: no board, and no process looked for', () => {
  assert.equal(lastBoard(null, panes, none), null)
  assert.equal(lastBoard({ pane: 'gone', pid: 100 }, panes, none), null)
  assert.equal(lastBoard({ pane: 'wZ:p2', pid: 100 }, [], none), null)
})
