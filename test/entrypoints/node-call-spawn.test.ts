// spawn-agent's call to the node's board (#760): a board that is not there was never sent the start,
// so the node may start it itself (null); one that took it and dropped the line may have sent it on,
// so that is an answer (exit 1), never "not sent". Other commands keep reading both as not sent.
import { afterEach, expect, test } from 'bun:test'
import { callBoard } from '../../src/entrypoints/node-call.ts'
import { unusedPort } from '../support/board-server.ts'

const listeners: { stop(force?: boolean): unknown }[] = []
afterEach(() => {
  for (const l of listeners.splice(0)) l.stop(true)
})

/** A port that takes the connection and closes it at once, before any answer. */
function dropping(): number {
  const l = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(s) {
        s.end()
      },
      open() {},
    },
  })
  listeners.push(l)
  return l.port
}

const call = (cmd: 'spawn' | 'agents') => ({ cmd, argv: ['{}'], session: 's-1', lane: null, files: [] })

test('nothing on the port: not sent, for a start too', async () => {
  const port = await unusedPort()
  expect(await callBoard(port)(call('spawn'))).toBeNull()
  expect(await callBoard(port)(call('agents'))).toBeNull()
})

test('a board that dropped the line: a start may have gone on, so it is an answer; others stay not sent', async () => {
  const port = dropping()
  expect(await callBoard(port)(call('spawn'))).toEqual({
    state: 'answered',
    code: 1,
    out: [],
    err: ['the board on this computer dropped the start: see the board before starting it again'],
  })
  expect(await callBoard(port)(call('agents'))).toBeNull()
})
