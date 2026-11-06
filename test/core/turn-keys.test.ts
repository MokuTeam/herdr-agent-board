// Stop and Send now (#330): which program gets which keys, where the board offers neither, and how
// the transcript tells that a turn was interrupted (core/turn-keys.ts).
import { describe, expect, test } from 'bun:test'
import { canSendNow, canStop, interruptedSince, turnKeys } from '../../src/core/turn-keys.ts'
import type { Item } from '../../src/core/types.ts'

const S = '07624983-b6d4-410f-9664-28b0bc29b012'
const claude: Pick<Item, 'agent' | 'pane' | 'session' | 'sleeping' | 'status'> = {
  agent: 'claude',
  pane: 'w1:p2',
  session: S,
  sleeping: false,
  status: 'working',
}

describe('the keys, by program', () => {
  test('Claude Code: Esc stops the turn, ctrl+enter sends the queue in now', () => {
    expect(turnKeys(claude, 'stop')).toEqual(['esc'])
    expect(turnKeys(claude, 'sendNow')).toEqual(['ctrl+enter'])
    expect(canStop(claude)).toBe(true)
    expect(canSendNow(claude)).toBe(true)
  })

  test('pi, Codex, an agent herdr does not name, a pane-<id> key: none until their keys are known', () => {
    const { agent: _claude, ...unnamed } = claude
    expect([turnKeys(unnamed, 'stop'), canStop(unnamed), canSendNow(unnamed)]).toEqual([null, false, false])
    for (const agent of ['pi', 'codex', 'opencode', '', 'constructor', '__proto__']) {
      const it = { ...claude, agent, session: agent === 'pi' ? 'pane-w1:p2' : S }
      expect([agent, turnKeys(it, 'stop'), turnKeys(it, 'sendNow')]).toEqual([agent, null, null])
      expect([agent, canStop(it), canSendNow(it)]).toEqual([agent, false, false])
    }
  })

  test('no pane (a MokuPilot call agent, a day session), no session id, asleep: none', () => {
    for (const it of [
      { ...claude, pane: null },
      { ...claude, session: null },
      { ...claude, sleeping: true },
    ]) {
      expect(turnKeys(it, 'stop')).toBeNull()
      expect(canStop(it)).toBe(false)
      expect(canSendNow(it)).toBe(false)
    }
    expect(turnKeys(null, 'stop')).toBeNull()
  })

  test('only while its turn runs: idle, done, blocked on a dialog, unknown get no button', () => {
    for (const status of ['idle', 'done', 'blocked', 'unknown', 'sleeping'] as const) {
      expect([status, canStop({ ...claude, status }), canSendNow({ ...claude, status })]).toEqual([
        status,
        false,
        false,
      ])
    }
  })
})

describe('the transcript says the turn was interrupted', () => {
  const at = Date.parse('2026-11-06T11:06:02.379Z')
  // As Claude Code 2.1.319 writes it (trimmed), with a tool running and without.
  const tool = JSON.stringify({
    parentUuid: 'x',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    timestamp: '2026-11-06T11:06:02.379Z',
  })
  const plain = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: '[Request interrupted by user]' },
    timestamp: '2026-11-06T11:06:02.379Z',
  })

  test('a marker at or after the press counts, one from before does not', () => {
    for (const line of [tool, plain]) {
      expect(interruptedSince(`{"type":"assistant"}\n${line}\n`, at - 500)).toBe(true)
      expect(interruptedSince(line, at)).toBe(true)
      expect(interruptedSince(line, at + 1)).toBe(false)
    }
  })

  test('not the words elsewhere: a helper of its own, Claude quoting them, a broken line', () => {
    const side = tool.replace('"isSidechain":false', '"isSidechain":true')
    const quoted = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      timestamp: '2026-11-06T11:06:03.000Z',
    })
    const said = JSON.stringify({
      type: 'user',
      message: { content: 'what does [Request interrupted by user] mean?' },
      timestamp: '2026-11-06T11:06:03.000Z',
    })
    expect(interruptedSince([side, quoted, said, '{"type":"user","[Request interrupted by user'].join('\n'), 0)).toBe(
      false,
    )
    expect(interruptedSince(null, 0)).toBe(false)
  })
})
