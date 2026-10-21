// The agent a new session starts as, as the new-session window reads it (web/src/models/launch-agent.ts).
import { describe, expect, test } from 'bun:test'
import {
  agentBody,
  agentRow,
  agentStart,
  launcherFor,
  NO_AGENT_ROW,
  offersAgents,
} from '../../web/src/models/launch-agent.ts'

const CLAUDE = { id: 'claude', title: 'Claude Code' }
const PI = { id: 'pi', title: 'pi' }
const BOTH = [CLAUDE, PI]

describe('the agent row', () => {
  test('a choice with two agents or more; none with one, or none offered', () => {
    expect(offersAgents(BOTH)).toBe(true)
    expect(offersAgents([CLAUDE])).toBe(false)
    expect(offersAgents([])).toBe(false)
    expect(agentRow('claude', [CLAUDE])).toEqual(NO_AGENT_ROW)
    expect(agentRow(null, BOTH)).toEqual(NO_AGENT_ROW)
    expect(agentRow('pi', BOTH)).toEqual({
      offered: true,
      options: [
        { id: 'claude', title: 'Claude Code', pressed: false },
        { id: 'pi', title: 'pi', pressed: true },
      ],
    })
  })

  test('it starts on the agent asked for again, else the board’s default, each only while offered', () => {
    expect(agentStart(null, BOTH, 'pi')).toBe('pi')
    expect(agentStart(undefined, BOTH, 'claude')).toBe('claude')
    expect(agentStart('pi', BOTH, 'claude')).toBe('pi')
    expect(agentStart('claude', BOTH, 'pi')).toBe('claude')
    // Asked for again, gone since; a default the board does not offer (a board before the choice says claude).
    expect(agentStart('codex', BOTH, 'pi')).toBe('pi')
    expect(agentStart(null, BOTH, 'codex')).toBe('claude')
    // No choice: nothing picked.
    expect(agentStart('pi', [CLAUDE], 'claude')).toBeNull()
    expect(agentStart(null, [], 'claude')).toBeNull()
  })

  test('what a start sends: the agent picked while there is a choice of it, else nothing', () => {
    expect(agentBody('pi', BOTH)).toEqual({ agent: 'pi' })
    expect(agentBody('claude', BOTH)).toEqual({ agent: 'claude' })
    expect(agentBody(null, BOTH)).toEqual({})
    expect(agentBody('claude', [CLAUDE])).toEqual({})
    expect(agentBody('codex', BOTH)).toEqual({})
  })

  test('the line under the title names the agent picked for the board’s own launcher only', () => {
    const own = { kind: 'herdr', agent: 'claude' } as const
    expect(launcherFor(own, 'pi')).toEqual({ kind: 'herdr', agent: 'pi' })
    expect(launcherFor(own, null)).toBe(own)
    const command = { kind: 'command', name: 'my-cli' } as const
    expect(launcherFor(command, 'pi')).toBe(command)
  })
})
