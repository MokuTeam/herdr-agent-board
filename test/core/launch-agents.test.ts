import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { useLanguage } from '../../src/core/lang.ts'
import { defaultAgent, launchAgents, piCommand, piConfigured } from '../../src/core/launch/agents.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const CLAUDE = { id: 'claude', title: 'Claude Code' } as const
const PI = { id: 'pi', title: 'pi' } as const

describe('the agents a start may pick', () => {
  test('Claude Code always, pi when launch.pi is set or pi is on PATH', () => {
    const found = () => true
    const missing = () => false
    assert.deepEqual(launchAgents(undefined, missing), [CLAUDE])
    assert.deepEqual(launchAgents({}, missing), [CLAUDE])
    assert.deepEqual(launchAgents({}, found), [CLAUDE, PI])
    assert.deepEqual(launchAgents({ pi: 'pi' }, missing), [CLAUDE, PI])
    assert.deepEqual(launchAgents({ pi: ['pi', '--model', 'sonnet'] }, missing), [CLAUDE, PI])
    // launch.claude is Claude's: it offers nothing more.
    assert.deepEqual(launchAgents({ claude: ['claude', '--model', 'opus'] }, missing), [CLAUDE])
  })

  test('PATH is not looked at when launch.pi says how to start pi', () => {
    let asked = 0
    const look = () => {
      asked++
      return false
    }
    launchAgents({ pi: 'pi' }, look)
    assert.equal(asked, 0)
    launchAgents({}, look)
    assert.equal(asked, 1)
  })

  test('none with a launcher of the config’s own: launch.command or launch.agent picks the agent', () => {
    let asked = 0
    const look = () => {
      asked++
      return true
    }
    assert.deepEqual(launchAgents({ command: ['start-session', '{name}'] }, look), [])
    assert.deepEqual(launchAgents({ agent: 'claude' }, look), [])
    assert.deepEqual(launchAgents({ agent: 'pi', pi: 'pi' }, look), [])
    assert.equal(asked, 0)
  })

  test('launch.pi counts as set unless it is blank', () => {
    for (const pi of [undefined, null, '', '  ']) assert.equal(piConfigured({ pi } as never), false, String(pi))
    for (const pi of ['pi', ['pi'], 5]) assert.equal(piConfigured({ pi } as never), true, String(pi))
  })
})

describe('the agent a start that names none starts as (launch.default)', () => {
  const both = () => [CLAUDE, PI]
  test('Claude Code unless launch.default names an agent the board offers', () => {
    for (const standard of [undefined, null, '', ' ', 'claude', 'Claude', 5, ['pi']])
      assert.equal(defaultAgent({ default: standard } as never, both), 'claude', String(standard))
    assert.equal(defaultAgent(undefined, both), 'claude')
    for (const standard of ['pi', 'PI', ' pi ']) assert.equal(defaultAgent({ default: standard }, both), 'pi', standard)
    // pi not offered (not on PATH, no launch.pi; a launcher of the config's own), or an agent the board has none of.
    assert.equal(
      defaultAgent({ default: 'pi' }, () => [CLAUDE]),
      'claude',
    )
    assert.equal(
      defaultAgent({ default: 'pi' }, () => []),
      'claude',
    )
    assert.equal(defaultAgent({ default: 'codex' }, both), 'claude')
  })

  test('what the board offers is looked up only when launch.default names another agent than Claude Code', () => {
    let asked = 0
    const look = () => {
      asked++
      return [CLAUDE, PI]
    }
    defaultAgent(undefined, look)
    defaultAgent({}, look)
    defaultAgent({ default: 'claude' }, look)
    defaultAgent({ claude: ['claude', '--dangerously-skip-permissions'] }, look)
    assert.equal(asked, 0)
    defaultAgent({ default: 'pi' }, look)
    assert.equal(asked, 1)
  })
})

describe('what a pi start types', () => {
  test('pi when launch.pi is unset, the program as a string, a list as it is', () => {
    assert.deepEqual(piCommand(undefined), ['pi'])
    assert.deepEqual(piCommand(null), ['pi'])
    assert.deepEqual(piCommand(' '), ['pi'])
    assert.deepEqual(piCommand('pi-work'), ['pi-work'])
    assert.deepEqual(piCommand(['pi', '--model', 'claude-bridge/claude-opus-5-5']), [
      'pi',
      '--model',
      'claude-bridge/claude-opus-5-5',
    ])
    assert.deepEqual(piCommand('C:\\tools\\pi.exe', true), ['C:\\tools\\pi.exe'])
  })

  test('refused when it is no program, or not one the tab’s shell can type', () => {
    for (const bad of [5, [], [''], ['pi', 5], { program: 'pi' }])
      expect(() => piCommand(bad)).toThrow('launch.pi in config.json must be a program')
    expect(() => piCommand(['-pi'])).toThrow('launch.pi: “-pi” cannot be typed')
    expect(() => piCommand(['my pi'])).toThrow('launch.pi: “my pi” cannot be typed')
    expect(() => piCommand(['pi', "it's"])).toThrow("launch.pi: “it's” cannot be typed")
    expect(() => piCommand('C:\\tools\\pi.exe', false)).toThrow('cannot be typed')
  })
})
