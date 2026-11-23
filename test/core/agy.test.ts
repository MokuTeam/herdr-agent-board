import { describe, expect, test } from 'bun:test'
import {
  AGY_AGENT,
  agyEffortOf,
  agyInterruptedSince,
  agyToolDetail,
  agyToolPath,
  agyUserText,
  isAgyItem,
  isAgySession,
  parseAgyConversation,
  parseAgyTail,
} from '../../src/core/agy.ts'
import { archiveBlock } from '../../src/core/archive.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { agyCommand, agyConfigured, defaultAgent, launchAgents } from '../../src/core/launch/agents.ts'
import { choosesSession, parseArgs } from '../../src/core/launch/spawn-args.ts'
import { AGY_NAMING, namingOf } from '../../src/core/pi.ts'
import { canSendNow, canStop, turnKeys } from '../../src/core/turn-keys.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const ID = '18fb0773-7c19-4e3d-8e9b-ceadaef29211'
const step = (data: Record<string, unknown>) => JSON.stringify({ created_at: '2026-11-23T12:47:12Z', ...data })

describe('Antigravity CLI transcript parsing (core/agy.ts)', () => {
  test('only agy panes and UUID session ids match', () => {
    expect(isAgyItem({ agent: AGY_AGENT })).toBe(true)
    expect(isAgyItem({ agent: 'claude' })).toBe(false)
    expect(isAgyItem({ agent: 'codex' })).toBe(false)
    expect(isAgyItem({})).toBe(false)
    expect(isAgySession(ID)).toBe(true)
    expect(isAgySession('pane-w1:p1')).toBe(false)
    expect(isAgySession('/tmp/session.jsonl')).toBe(false)
    expect(namingOf('agy')).toEqual(AGY_NAMING)
  })

  test('extracts user request from envelopes and effort from model ids', () => {
    expect(
      agyUserText(
        '<USER_REQUEST>\nFix the tests\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nTime: now\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nModel\n</USER_SETTINGS_CHANGE>',
      ),
    ).toBe('Fix the tests')
    expect(agyUserText('Plain message\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>')).toBe('Plain message')
    expect(agyEffortOf('gemini-4-neon-high')).toBe('high')
    expect(agyEffortOf('claude-opus-5-5-xhigh')).toBe('xhigh')
    expect(agyEffortOf('gemini-3.8-flash-low')).toBe('low')
    expect(agyEffortOf('gemini-pro-orchestrator-neon')).toBeNull()
  })

  test('unwraps JSON-quoted tool args for tool details and file paths', () => {
    expect(agyToolDetail('run_command', { CommandLine: '"bun test"', toolSummary: '"Run unit tests"' })).toBe(
      'Run unit tests',
    )
    expect(agyToolDetail('run_command', { CommandLine: JSON.stringify('git status\ngit diff') })).toBe('git status')
    expect(agyToolDetail('read_file', { Path: '"/home/user/project/src/app.ts"' })).toBe('app.ts')
    expect(agyToolPath('read_file', { Path: '"/home/user/project/src/app.ts"' })).toBe('/home/user/project/src/app.ts')
    expect(agyToolPath('run_command', { CommandLine: '"ls"' })).toBe('')
    expect(agyToolDetail('grep_search', { Query: '"AGY_AGENT"' })).toBe('AGY_AGENT')
    expect(agyToolDetail('invoke_subagent', { Role: '"Codebase Researcher"' })).toBe('Codebase Researcher')
  })

  test('card tail reads prompt, last answer, question, tool completion, context and model', () => {
    const lines = [
      step({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content:
          '<USER_REQUEST>\nimplement agy support\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>',
      }),
      step({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        model: 'gemini-4-neon-high',
        input_tokens: 12000,
        cache_read_tokens: 28000,
        output_tokens: 450,
        thinking: 'private thoughts must not leak',
        tool_calls: [{ name: 'read_file', args: { Path: '"/repo/src/core/agy.ts"' } }],
      }),
      step({ step_index: 2, type: 'GENERIC', source: 'MODEL', status: 'DONE', content: 'file body' }),
      step({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        created_at: '2026-11-23T12:48:00Z',
        model: 'gemini-4-neon-high',
        input_tokens: 15000,
        cache_read_tokens: 40000,
        output_tokens: 120,
        content: 'Implemented agy support. Shall I run the full suite?',
      }),
    ]
    const info = parseAgyTail(lines)
    expect(info).toMatchObject({
      prompt: 'implement agy support',
      lastText: 'Implemented agy support. Shall I run the full suite?',
      question: 'Implemented agy support. Shall I run the full suite?',
      replied: false,
      context: 55000,
      model: 'gemini-4-neon-high',
      effort: 'high',
      tool: { name: 'read_file', detail: 'agy.ts', pending: false },
    })

    const thread = parseAgyConversation(lines)
    expect(thread).toEqual([
      { role: 'user', text: 'implement agy support', at: Date.parse('2026-11-23T12:47:12Z') },
      {
        role: 'tool',
        label: 'read_file',
        detail: 'agy.ts',
        path: '/repo/src/core/agy.ts',
        done: true,
        at: Date.parse('2026-11-23T12:47:12Z'),
      },
      {
        role: 'assistant',
        text: 'Implemented agy support. Shall I run the full suite?',
        at: Date.parse('2026-11-23T12:48:00Z'),
      },
    ])
  })

  test('pending tool call stays pending until a finished result step arrives, and board reminders stay notices', () => {
    const lines = [
      step({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\ncheck status\n</USER_REQUEST>' }),
      step({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Ready to deploy?' }),
      step({
        step_index: 2,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\n[board reminder] check CI\n</USER_REQUEST>',
      }),
      step({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"bun test"' } }],
      }),
    ]
    const info = parseAgyTail(lines)
    expect(info.prompt).toBe('check status')
    expect(info.question).toBe('Ready to deploy?')
    expect(info.replied).toBe(false)
    expect(info.tool).toMatchObject({ name: 'run_command', detail: 'bun test', pending: true })
    expect(parseAgyConversation(lines).map(t => t.role)).toEqual(['user', 'assistant', 'notice', 'tool'])
  })

  test('agyInterruptedSince detects canceled steps at or after the key press', () => {
    const at = Date.parse('2026-11-23T12:50:00Z')
    const canceled = step({ step_index: 4, type: 'GENERIC', status: 'CANCELED', created_at: '2026-11-23T12:50:00Z' })
    expect(agyInterruptedSince(canceled, at - 500)).toBe(true)
    expect(agyInterruptedSince(canceled, at)).toBe(true)
    expect(agyInterruptedSince(canceled, at + 1)).toBe(false)
    expect(agyInterruptedSince(step({ step_index: 4, type: 'GENERIC', status: 'DONE' }), 0)).toBe(false)
  })
})

describe('Antigravity launch, stop and archive rules', () => {
  const CLAUDE = { id: 'claude', title: 'Claude Code' } as const
  const PI = { id: 'pi', title: 'pi' } as const
  const AGY = { id: 'agy', title: 'Antigravity' } as const

  test('launchAgents offers Antigravity when launch.agy is configured or agy is on PATH', () => {
    let asked = 0
    const agyFound = () => {
      asked++
      return true
    }
    expect(
      launchAgents(
        {},
        () => false,
        () => false,
      ),
    ).toEqual([CLAUDE])
    expect(launchAgents({}, () => false, agyFound)).toEqual([CLAUDE, AGY])
    expect(asked).toBe(1)
    expect(launchAgents({ agy: 'agy' }, () => false, agyFound)).toEqual([CLAUDE, AGY])
    expect(asked).toBe(1) // PATH not queried when launch.agy is set
    expect(
      launchAgents(
        {},
        () => true,
        () => true,
      ),
    ).toEqual([CLAUDE, PI, AGY])
    expect(
      launchAgents(
        { command: ['my-launcher'] },
        () => true,
        () => true,
      ),
    ).toEqual([])
    expect(agyConfigured({ agy: '' })).toBe(false)
    expect(agyConfigured({ agy: ['agy', '--mode', 'auto'] })).toBe(true)
    expect(defaultAgent({ default: 'agy' }, () => [CLAUDE, AGY])).toBe('agy')
    expect(defaultAgent({ default: 'agy' }, () => [CLAUDE])).toBe('claude')
  })

  test('agyCommand validates shell-typable commands', () => {
    expect(agyCommand(undefined)).toEqual(['agy'])
    expect(agyCommand('agy-work')).toEqual(['agy-work'])
    expect(agyCommand(['agy', '--model', 'gemini-4-neon-high'])).toEqual(['agy', '--model', 'gemini-4-neon-high'])
    expect(() => agyCommand(['-agy'])).toThrow('launch.agy')
    expect(() => agyCommand([])).toThrow('launch.agy')
  })

  test('spawn-agent parseArgs supports --agent agy and --resume, refuses --fork and --thread', () => {
    const basic = parseArgs(['--name', 'Demo', '--cwd', '/tmp', '--agent', 'agy', '--model', 'gemini-4-neon-high'])
    expect(basic).toMatchObject({ name: 'Demo', cwd: '/tmp', agent: 'agy', model: 'gemini-4-neon-high' })
    const resumed = parseArgs(['--name', 'Demo', '--cwd', '/tmp', '--agent', 'agy', '--resume', ID])
    expect(resumed).toMatchObject({ agent: 'agy', resume: ID })
    expect(() => parseArgs(['--name', 'Demo', '--cwd', '/tmp', '--agent', 'agy', '--fork', ID])).toThrow('--fork')
    expect(() => parseArgs(['--thread', 't1', '--agent', 'agy'])).toThrow('--thread')
    expect(choosesSession(['agy', '--conversation', ID])).toBe(true)
  })

  test('turnKeys offers Esc stop (not sendNow) for working agy sessions, and archiveBlock allows idle agy sessions', () => {
    const working = { agent: 'agy', pane: 'w1:p2', session: ID, sleeping: false, status: 'working' as const }
    expect(turnKeys(working, 'stop')).toEqual(['esc'])
    expect(turnKeys(working, 'sendNow')).toBeNull()
    expect(canStop(working)).toBe(true)
    expect(canSendNow(working)).toBe(false)
    expect(canStop({ ...working, status: 'idle' })).toBe(false)
    expect(archiveBlock({ key: ID, session: ID, agent: 'agy', pane: 'w1:p2', status: 'idle' })).toBe('')
    expect(archiveBlock({ key: ID, session: ID, agent: 'agy', pane: 'w1:p2', status: 'working' })).toBe(
      'archive.why.working',
    )
    expect(archiveBlock({ key: ID, session: null, agent: 'agy', pane: 'w1:p2', status: 'idle' })).toBe(
      'archive.why.notClaude',
    )
  })
})
