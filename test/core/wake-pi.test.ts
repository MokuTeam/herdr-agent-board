// pi sessions asleep (#178), the pure rules: when a pi session's turn is over, the provider it
// goes on with, the line and the command line that wake it, the env it wakes in, the sleepers'
// file, and which pane is still a sleeper's own.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { piDraft, piEditor } from '../../src/core/dialogs/pi-dialogs.ts'
import { piProvider, piSessionCwd, piTurnOver } from '../../src/core/pi.ts'
import {
  accountOf,
  asPiSleepers,
  findPiSleeper,
  isPiProgram,
  type PiSleeper,
  parsePiResume,
  piResumeArgv,
  piResumeEnv,
  piSleeperPane,
  piSleepingOf,
  piWakeLine,
  piWoken,
} from '../../src/core/wake/pi.ts'

const ID = '01a15d6d-9f21-7751-a71a-834d50839768'
const FILE = `/home/u/.pi/agent/sessions/--home-u--/2026-10-21T07-47-07-681Z_${ID}.jsonl`
/** A folder and a session file with spaces, Cyrillic and %. */
const DIR = '/home/u/Проект x 50%'
const FILE2 =
  '/home/u/.pi/agent/sessions/--home-u-Проект x 50%--/2026-10-21T13-16-31-210Z_01a15e9b-3069-70f9-b902-f363327574f0.jsonl'

// A pi session file's lines, each entry naming its parent.
let n = 0
let last: string | null = null
function entry(type: string, fields: Record<string, unknown>): string {
  const id = `e${++n}`
  const line = JSON.stringify({ type, id, parentId: last, timestamp: '2026-10-22T08:00:00.000Z', ...fields })
  last = id
  return line
}
function session(...lines: (() => string)[]): string[] {
  n = 0
  last = null
  return [JSON.stringify({ type: 'session', version: 3, id: ID, cwd: DIR }), ...lines.map(f => f())]
}
const user = () => entry('message', { message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })
const answer =
  (stopReason: string, provider = 'claude-bridge-work') =>
  () =>
    entry('message', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider, stopReason },
    })
const toolResult = () => entry('message', { message: { role: 'toolResult', toolCallId: 'c1', content: [] } })
const system = () => entry('message', { message: { role: 'system', content: '' } })
const named = () => entry('session_info', { name: 'drop-teaching-tips' })
const model = (provider: string) => () => entry('model_change', { provider, modelId: 'claude-opus-5-5' })
const thinking = () => entry('thinking_level_change', { thinkingLevel: 'high' })
const custom = () => entry('custom', { customType: 'codemode-store', data: {} })
const extensionMessage = () =>
  entry('custom_message', { customType: 'mempalace-autosave', content: 'save now', display: true })

test('a turn is over when the last message is the assistant’s and calls no tool', () => {
  expect(piTurnOver(session(user, answer('stop')))).toBe(true)
  // Stopped by the user, or failed: over as well.
  expect(piTurnOver(session(user, answer('aborted')))).toBe(true)
  expect(piTurnOver(session(user, answer('error')))).toBe(true)
})

test('what pi writes after a turn (its name, a model, a thinking level, an extension’s data) leaves it over', () => {
  expect(piTurnOver(session(user, answer('stop'), named, model('claude-bridge'), thinking, custom, system))).toBe(true)
})

test('a tool call, a tool’s result, a prompt, an extension’s message, or no message: not over', () => {
  expect(piTurnOver(session(user, answer('toolUse')))).toBe(false)
  expect(piTurnOver(session(user, answer('toolUse'), toolResult))).toBe(false)
  expect(piTurnOver(session(user, answer('stop'), user))).toBe(false)
  expect(piTurnOver(session(user, answer('stop'), extensionMessage))).toBe(false)
  expect(piTurnOver(session(named))).toBe(false)
  expect(piTurnOver([])).toBe(false)
})

test('a branch left behind with /tree does not count: the turn is the one the session goes on from', () => {
  const lines = session(user, answer('stop'))
  const kept = last
  lines.push(user(), answer('toolUse')())
  // Back on the first answer, then a session_info on it: the session goes on from there.
  last = kept
  lines.push(named())
  expect(piTurnOver(lines)).toBe(true)
})

test('the provider: the latest model change, else the latest answer’s', () => {
  expect(piProvider(session(model('claude-bridge'), user, answer('stop', 'claude-bridge')))).toBe('claude-bridge')
  expect(piProvider(session(model('claude-bridge'), user, answer('stop'), model('claude-bridge-work')))).toBe(
    'claude-bridge-work',
  )
  expect(piProvider(session(user, answer('stop', 'openai')))).toBe('openai')
  expect(piProvider(session(user))).toBe('')
})

test('the folder a session started in is in its header', () => {
  expect(piSessionCwd(session()[0] ?? '')).toBe(DIR)
  expect(piSessionCwd('{"type":"message"}')).toBe('')
  expect(piSessionCwd('not json')).toBe('')
})

test('the wake line carries the session’s id only, never its file’s path', () => {
  expect(piWakeLine(FILE)).toBe(`board resume --pi ${ID}`)
  expect(piWakeLine(FILE2)).toBe('board resume --pi 01a15e9b-3069-70f9-b902-f363327574f0')
  expect(piWakeLine('/home/u/.pi/agent/sessions/x/no-id.jsonl')).toBeNull()
  expect(piWakeLine('/home/u/.pi/agent/sessions/x/t_a;rm -rf.jsonl')).toBeNull()
  expect(parsePiResume(['--pi', ID])).toBe(ID)
  expect(() => parsePiResume(['--pi'])).toThrow(/which pi session/)
  expect(() => parsePiResume(['--pi', 'a b'])).toThrow(/not a pi session id/)
  expect(() => parsePiResume(['--pi', ID, 'more'])).toThrow(/which pi session/)
})

test('the command line it wakes with: pi’s own options, without what starts another conversation or sets the model', () => {
  // How the board's own sessions are started (herdr's process-info argv).
  const started = [
    'pi',
    '--model',
    'claude-bridge/claude-opus-5-5',
    '--name',
    'herdr-wake-pi',
    'Read the brief and follow it.',
  ]
  expect(piResumeArgv(started, FILE)).toEqual({ argv: ['pi', '--session', FILE] })
  const shaped = [
    '/opt/pi/bin/pi',
    '--no-mcp',
    '-e',
    '/x/ext.ts',
    '--tools=read,bash',
    '--thinking',
    'high',
    '--session',
    '/old.jsonl',
    '--subagents-workflow-file=/w.js',
    '@notes.md',
    '-c',
    '--',
    '--not-an-option',
  ]
  expect(piResumeArgv(shaped, FILE2)).toEqual({
    argv: [
      '/opt/pi/bin/pi',
      '--no-mcp',
      '-e',
      '/x/ext.ts',
      '--tools=read,bash',
      '--subagents-workflow-file=/w.js',
      '--session',
      FILE2,
    ],
  })
  // pi run by another program: pi itself on the line.
  expect(piResumeArgv(['node', '/opt/pi/dist/cli.js', '--offline'], FILE)).toEqual({
    argv: ['pi', '--offline', '--session', FILE],
  })
  // Taken over from a pane stopped by hand: nothing known, plain pi.
  expect(piResumeArgv([], FILE)).toEqual({ argv: ['pi', '--session', FILE] })
  // An extension's option in the `--name value` form: its value or a message? No line.
  expect(piResumeArgv(['pi', '--plan', 'do it'], FILE)).toEqual({
    error: 'its command line has an option wake cannot read: --plan',
  })
  expect(isPiProgram('C:\\Users\\Иван\\AppData\\Roaming\\npm\\pi.cmd')).toBe(true)
  expect(isPiProgram('pip')).toBe(false)
})

test('the env it wakes in: CLAUDE_CONFIG_DIR for the account it slept with, as board resume sets a Claude session’s', () => {
  const home = '/home/u'
  const work = join(home, '.claude-work')
  const shell = { PATH: '/bin', CLAUDE_CONFIG_DIR: work }
  // Slept on the personal account; the shell points at Work: unset, so the bridge takes ~/.claude.
  expect(piResumeEnv(shell, join(home, '.claude'), home, 'linux')).toEqual({ PATH: '/bin' })
  // Slept on Work, a shell with none: set.
  expect(piResumeEnv({ PATH: '/bin' }, work, home, 'linux')).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: work })
  // Already there, spelled another way: as it is.
  const tilde = { CLAUDE_CONFIG_DIR: '~/.claude-work/' }
  expect(piResumeEnv(tilde, work, home, 'linux')).toBe(tilde)
  // Not known: as it is.
  expect(piResumeEnv(shell, undefined, home, 'linux')).toBe(shell)
  expect(accountOf('', home, 'linux')).toBe(join(home, '.claude'))
  expect(accountOf('~/.claude-work', home, 'linux')).toBe(work)
  expect(accountOf(null, home, 'linux')).toBeUndefined()
  expect(accountOf('relative/dir', home, 'linux')).toBeUndefined()
})

const sleeper = (over: Partial<PiSleeper> = {}): PiSleeper => ({
  session: FILE,
  name: 'drop-teaching-tips',
  pane: 'wC:p6',
  workspace: 'wC',
  workspaceLabel: 'Personal',
  cwd: '/home/u',
  argv: ['pi'],
  account: '/home/u/.claude',
  slept_at: Date.parse('2026-10-22T08:00:00.000Z'),
  ...over,
})

test('the sleepers’ file: what does not read is dropped, unknown fields are kept', () => {
  const ok = sleeper({ future: 1 })
  expect(
    asPiSleepers({
      [FILE]: ok,
      [FILE2]: { ...sleeper({ session: FILE2 }), argv: 'pi' },
      '/not/a/pi/file.txt': sleeper({ session: '/not/a/pi/file.txt' }),
      [`${FILE}x.jsonl`]: sleeper(),
    }),
  ).toEqual({ [FILE]: ok })
  expect(asPiSleepers([])).toBeNull()
  expect(asPiSleepers({ [FILE]: { ...ok, account: '' } })).toEqual({})
})

const ws = [{ workspace_id: 'wC', label: 'Personal' }]

test('its own pane is the one it slept in while that is a shell with its label or in its folder', () => {
  const s = sleeper()
  // After a reboot: the label is gone, the shell is back in its folder.
  expect(piSleeperPane({ panes: [{ pane_id: 'wC:p6', cwd: '/home/u' }] }, s)?.pane_id).toBe('wC:p6')
  expect(
    piSleeperPane({ panes: [{ pane_id: 'wC:p6', cwd: '/tmp', label: '💤 drop-teaching-tips' }] }, s)?.pane_id,
  ).toBe('wC:p6')
  // Another folder, another program in it, or gone: not its own; it wakes in a new tab.
  expect(piSleeperPane({ panes: [{ pane_id: 'wC:p6', cwd: '/tmp' }] }, s)).toBeUndefined()
  expect(piSleeperPane({ panes: [{ pane_id: 'wC:p6', cwd: '/home/u', agent: 'claude' }] }, s)).toBeUndefined()
  expect(piSleeperPane({ panes: [] }, s)).toBeUndefined()
})

test('the list the board reads: every sleeper, its pane only while it is its own', () => {
  const sleepers = {
    [FILE]: sleeper(),
    [FILE2]: sleeper({ session: FILE2, name: 'git-guard', pane: 'wC:p9', cwd: DIR }),
  }
  const list = piSleepingOf(
    { workspaces: ws, panes: [{ pane_id: 'wC:p6', workspace_id: 'wC', cwd: '/home/u' }] },
    sleepers,
  )
  expect(list).toEqual([
    {
      name: 'drop-teaching-tips',
      pane: 'wC:p6',
      session: FILE,
      workspace: 'Personal',
      slept_at: '2026-10-22T08:00:00.000Z',
      exited: false,
      agent: 'pi',
      cwd: '/home/u',
    },
    {
      name: 'git-guard',
      pane: '',
      session: FILE2,
      workspace: 'Personal',
      slept_at: '2026-10-22T08:00:00.000Z',
      exited: false,
      agent: 'pi',
      cwd: DIR,
    },
  ])
})

test('one whose session runs in a pane again is awake; found by its file, id, pane or name', () => {
  const sleepers = { [FILE]: sleeper(), [FILE2]: sleeper({ session: FILE2, name: 'git-guard', pane: 'wC:p9' }) }
  const snap = { panes: [{ pane_id: 'w9:p2', agent: 'pi', agent_session: { value: FILE2 } }] }
  expect(piWoken(snap, sleepers)).toEqual([FILE2])
  expect(findPiSleeper(FILE, sleepers)?.session).toBe(FILE)
  expect(findPiSleeper(ID.toUpperCase(), sleepers)?.session).toBe(FILE)
  expect(findPiSleeper('wC:p9', sleepers)?.session).toBe(FILE2)
  expect(findPiSleeper('Git-Guard', sleepers)?.session).toBe(FILE2)
  expect(findPiSleeper('', sleepers)).toBeUndefined()
})

// pi's input box at the bottom of its screen, between two rules, the footer under it.
const RULE = '─'.repeat(40)
const screen = (box: string) =>
  ['● done', '', RULE, box, RULE, 'xhigh · Opus 5.5   PERSONAL   Max 20x', '░░░░ 45% 447k/1M'].join('\n')

test('pi’s input box: empty, with a draft, or not on screen', () => {
  // The cursor is an inverse space.
  expect(piDraft(screen('\x1b[7m \x1b[0m'))).toBe('')
  expect(piDraft(screen('half a thought'))).toBe('half a thought')
  expect(piDraft('no box here')).toBeNull()
  const dialog = [
    RULE,
    ' Git approval needed',
    ' → Approve',
    '   Reject',
    ' ↑↓ navigate  enter select  escape/ctrl+c cancel',
    RULE,
  ].join('\n')
  expect(piDraft(dialog)).toBeNull()
  expect(piEditor(screen(''))).toBe(true)
})
