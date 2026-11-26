import { expect, test } from 'bun:test'
import { doorRefusal } from '../../src/core/node-door.ts'

// The master syncs the MokuTab functions registry through a node's door (#864): without these on
// the door's list the node answers 404 and the master takes it for an older board.
test('the door takes the functions registry routes the master calls', () => {
  expect(doorRefusal('GET', '/api/node/functions', '/api/node/functions')).toBeNull()
  expect(doorRefusal('POST', '/api/node/functions/bundle', '/api/node/functions/bundle')).toBeNull()
  expect(doorRefusal('POST', '/api/node/functions/take', '/api/node/functions/take')).toBeNull()
  expect(doorRefusal('POST', '/api/node/functions', '/api/node/functions')).toEqual({ status: 404, error: 'not found' })
})
