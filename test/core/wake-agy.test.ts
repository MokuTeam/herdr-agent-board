// Pure tests for Antigravity CLI (`agy`) sleep, wake and input box parsing (#631):
// `agyDraft`, `agyWakeLine`, `parseAgyResume`, `agyResumeArgv`, `asAgySleepers`,
// `agySleeperPane`, `agySleepingOf`, `agyWoken`, `findAgySleeper`, and `agyProcessOf`.
import { describe, expect, test } from 'bun:test'
import { agyProcessOf } from '../../src/adapters/agy-processes.ts'
import { agyDraft } from '../../src/core/dialogs/agy-dialogs.ts'
import { inputDraft } from '../../src/core/dialogs/input-box.ts'
import {
  type AgySleeper,
  type AgySnapshot,
  agyResumeArgv,
  agySleeperPane,
  agySleepingOf,
  agySleepLabel,
  agyWakeLine,
  agyWoken,
  asAgySleepers,
  findAgySleeper,
  isAgyProgram,
  parseAgyResume,
} from '../../src/core/wake/agy.ts'

const ID = '509dfc37-b58e-4851-9988-a8c7befe9f0d'
const ID2 = '18fb0773-7c19-4e3d-8e9b-ceadaef29211'
const RULE = '─'.repeat(50)

describe('agyDraft', () => {
  test('reads empty box, dim placeholder, and user-typed text without affecting Claude inputDraft', () => {
    const empty = [
      '● Done.',
      `\x1b[38;5;8m${RULE}\x1b[0m`,
      '\x1b[38;5;12m>\x1b[0m',
      `\x1b[38;5;8m${RULE}\x1b[0m`,
      '? for shortcuts                                 Gemini 4 Neon · high',
    ].join('\n')
    expect(agyDraft(empty)).toBe('')
    // Claude's inputDraft looks for ❯, never taking an agy box for Claude's.
    expect(inputDraft(empty)).toBeNull()

    const dimPlaceholder = [RULE, '> \x1b[2mAsk anything...\x1b[0m', RULE, 'Gemini 4 Neon'].join('\n')
    expect(agyDraft(dimPlaceholder)).toBe('')

    const typed = [RULE, '> check the PR', '  second line', RULE, 'Gemini 4 Neon'].join('\n')
    expect(agyDraft(typed)).toBe('check the PR\n  second line')
  })

  test('returns null for dialogs, pickers, or incomplete captures', () => {
    const picker = [RULE, '> ', RULE, '❯ Option 1', 'Enter to select · ↑/↓ to navigate'].join('\n')
    expect(agyDraft(picker)).toBeNull()

    const cut = [RULE, '> hello'].join('\n')
    expect(agyDraft(cut)).toBeNull()

    expect(agyDraft('plain shell output $ ')).toBeNull()
  })
})

describe('agyWakeLine and parseAgyResume', () => {
  test('accepts UUIDs and rejects paths, pane keys, and shell metacharacters', () => {
    expect(agyWakeLine(ID)).toBe(`board resume --agy ${ID}`)
    expect(agyWakeLine('pane-w1:p1')).toBeNull()
    expect(agyWakeLine('/tmp/session.jsonl')).toBeNull()
    expect(agyWakeLine(`${ID};rm -rf /`)).toBeNull()

    expect(parseAgyResume(['--agy', ID])).toBe(ID)
    expect(parseAgyResume([ID.toUpperCase(), '--agy'])).toBe(ID.toUpperCase())
    expect(() => parseAgyResume(['--agy'])).toThrow(/which Antigravity session/)
    expect(() => parseAgyResume(['--agy', 'not-a-uuid'])).toThrow(/not an Antigravity conversation id/)
  })
})

describe('agyResumeArgv and isAgyProgram', () => {
  test('recognises agy binary names across platforms', () => {
    expect(isAgyProgram('agy')).toBe(true)
    expect(isAgyProgram('/usr/local/bin/agy')).toBe(true)
    expect(isAgyProgram('C:\\Users\\dev\\AppData\\Local\\agy.exe')).toBe(true)
    expect(isAgyProgram('agy.cmd')).toBe(true)
    expect(isAgyProgram('claude')).toBe(false)
    expect(isAgyProgram('pi')).toBe(false)
  })

  test('keeps interactive flags, drops session/print flags, and falls back to launch.agy', () => {
    const kept = agyResumeArgv(
      [
        '/usr/local/bin/agy',
        '--dangerously-skip-permissions',
        '--conversation',
        ID2,
        '--mode',
        'auto',
        '--model=gemini-4-neon-high',
        '--add-dir',
        '/work/Проект 50%',
        '-c',
        '--print',
        '--output-format',
        'json',
        'initial prompt text',
        '--',
        'ignored tail',
      ],
      ID,
    )
    expect(kept).toEqual({
      argv: [
        '/usr/local/bin/agy',
        '--dangerously-skip-permissions',
        '--mode',
        'auto',
        '--model=gemini-4-neon-high',
        '--add-dir',
        '/work/Проект 50%',
        '--conversation',
        ID,
      ],
    })

    // Empty argv falls back to launch.agy.
    expect(agyResumeArgv([], ID, ['agy', '--dangerously-skip-permissions'])).toEqual({
      argv: ['agy', '--dangerously-skip-permissions', '--conversation', ID],
    })

    // Unknown --flag=value is kept; unknown --flag without = is refused.
    expect(agyResumeArgv(['agy', '--custom=1'], ID)).toEqual({
      argv: ['agy', '--custom=1', '--conversation', ID],
    })
    expect(agyResumeArgv(['agy', '--unknown-flag', 'val'], ID)).toEqual({
      error: 'its command line has an option wake cannot read: --unknown-flag',
    })
  })
})

describe('asAgySleepers, panes, sleepingOf, woken, findAgySleeper', () => {
  const sleeper: AgySleeper = {
    session: ID,
    name: 'Gemini Dev',
    pane: 'w5:p9',
    workspace: 'w5',
    workspaceLabel: 'Server',
    cwd: '/work/Проект x 50%',
    argv: ['agy', '--dangerously-skip-permissions'],
    slept_at: Date.UTC(2026, 10, 23, 15, 0, 0),
  }

  test('validates sleepers, drops broken entries, and preserves unknown fields', () => {
    expect(asAgySleepers('nope')).toBeNull()
    expect(
      asAgySleepers({
        [ID]: { ...sleeper, extraField: 42 },
        badKey: { ...sleeper, session: 'badKey' },
        [ID2]: { ...sleeper, session: ID2, argv: [123] },
      }),
    ).toEqual({ [ID]: { ...sleeper, extraField: 42 } })
  })

  test('matches sleeper pane by 💤 label or cwd, lists sleepingOf, detects woken, and finds by id/pane/name', () => {
    const snap: AgySnapshot = {
      workspaces: [{ workspace_id: 'w5', label: 'Live Server' }],
      panes: [{ pane_id: 'w5:p9', workspace_id: 'w5', cwd: '/work/Проект x 50%', label: agySleepLabel(sleeper) }],
    }
    expect(agySleeperPane(snap, sleeper)?.pane_id).toBe('w5:p9')
    expect(agySleepingOf(snap, { [ID]: sleeper })).toEqual([
      {
        name: 'Gemini Dev',
        pane: 'w5:p9',
        session: ID,
        workspace: 'Live Server',
        slept_at: '2026-11-23T15:00:00.000Z',
        exited: false,
        agent: 'agy',
        cwd: '/work/Проект x 50%',
      },
    ])

    // Pane replaced by an agent or gone: pane becomes '' (wakes in a new tab).
    const gone: AgySnapshot = { workspaces: [], panes: [] }
    expect(agySleeperPane(gone, sleeper)).toBeUndefined()
    expect(agySleepingOf(gone, { [ID]: sleeper })[0]?.pane).toBe('')
    expect(agySleepingOf(gone, { [ID]: sleeper })[0]?.workspace).toBe('Server')

    // Running again in any pane -> woken.
    expect(
      agyWoken(
        { panes: [{ pane_id: 'w5:p12', agent: 'agy', agent_session: { value: ID.toUpperCase() } }] },
        { [ID]: sleeper },
      ),
    ).toEqual([ID])

    // findAgySleeper matches UUID, pane, name (case-insensitive) and name with [hex] ref.
    const map = { [ID]: sleeper }
    expect(findAgySleeper(ID, map)).toEqual(sleeper)
    expect(findAgySleeper(ID.toUpperCase(), map)).toEqual(sleeper)
    expect(findAgySleeper('w5:p9', map)).toEqual(sleeper)
    expect(findAgySleeper('gemini dev [509dfc37]', map)).toEqual(sleeper)
    expect(findAgySleeper('other', map)).toBeUndefined()
  })
})

describe('agyProcessOf', () => {
  test('extracts the foreground agy process and ignores child MCP servers', () => {
    const answer = {
      process_info: {
        foreground_process_group_id: 745570,
        foreground_processes: [
          { pid: 745592, name: 'bun', argv: ['bun', 'cli.ts', 'mcp', '--agents'] },
          { pid: 745570, name: 'agy', argv: ['agy', '--dangerously-skip-permissions', '--conversation', ID] },
        ],
      },
    }
    expect(agyProcessOf(answer)).toEqual({
      pid: 745570,
      argv: ['agy', '--dangerously-skip-permissions', '--conversation', ID],
    })
    expect(
      agyProcessOf({ process_info: { foreground_processes: [{ pid: 1, name: 'claude', argv: ['claude'] }] } }),
    ).toBeNull()
  })
})
