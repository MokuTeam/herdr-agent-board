// The takeover's rules (src/core/wake/takeover.ts): the separate herdr-wake plugin's config.json,
// sleeping list, hooks and herdr key bindings, as the board's wake takes them over.
import { expect, test } from 'bun:test'
import {
  launcherNote,
  oldActionBindings,
  takeOverConfig,
  takeOverSessions,
  withoutOldHooks,
} from '../../../src/core/wake/takeover.ts'

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const DEFAULT_DIR = 'C:\\Users\\Иван Петров\\.claude'
const PROJECT = 'C:\\Work\\Проект x 50%'
const TELEGRAM = {
  mcpServers: { telegram: { url: 'http://127.0.0.1:8787/mcp', headers: { Authorization: 'Bearer t' } } },
}

test('the old config: reaper on with 2 excluded, Telegram from ~/.claude.json → auto; tg-router not carried; an unknown key kept; wakeCommand dropped', () => {
  const old = {
    port: 12421,
    wakeCommand: 'claude-tg --resume {session}',
    workspace: 'tg-router',
    wakeTimeoutSec: 90,
    pollTimeoutSec: 20,
    listSleepingDays: 3,
    reaper: { enabled: true, idleMinutes: 45, exclude: ['Billing', '/^ops-/'], maxPerRound: 2 },
    someday: { kept: true },
  }
  expect(takeOverConfig(old, TELEGRAM)).toEqual({
    port: 12421,
    wakeTimeoutSec: 90,
    pollTimeoutSec: 20,
    listSleepingDays: 3,
    reaper: { enabled: true, idleMinutes: 45, exclude: ['Billing', '/^ops-/'], maxPerRound: 2 },
    someday: { kept: true },
    telegram: 'auto',
  })
  // The input is left as it was.
  expect(old.wakeCommand).toBe('claude-tg --resume {session}')
})

test('the old config’s own url, token and server go over; a workspace of its own is kept', () => {
  const old = { url: 'http://box:1', authorization: 'Bearer own', server: 'tg', workspace: 'Боты 100%' }
  expect(takeOverConfig(old, {})).toEqual({ ...old, telegram: 'auto' })
  // Its server named in ~/.claude.json: that one's url and token, as the old router found them.
  const other = { mcpServers: { tg: { url: 'http://h:2/mcp/', headers: { Authorization: 'Bearer x' } } } }
  expect(takeOverConfig({ server: 'tg' }, other)).toEqual({ server: 'tg', telegram: 'auto' })
  expect(takeOverConfig({ server: 'tg' }, TELEGRAM)).toEqual({ server: 'tg' })
})

test('no Telegram where the old router had none: a url without a token, nothing found, a stray telegram key dropped', () => {
  expect(takeOverConfig({ url: 'http://box:1' }, {})).toEqual({ url: 'http://box:1' })
  expect(takeOverConfig({ url: 'http://box:1', telegram: 'auto' }, null)).toEqual({ url: 'http://box:1' })
  expect(takeOverConfig({ authorization: '' }, TELEGRAM)).toEqual({ authorization: '' })
  expect(takeOverConfig({}, { mcpServers: { telegram: { url: 5, headers: { Authorization: 'Bearer t' } } } })).toEqual(
    {},
  )
})

test('no old config, or one that does not read: the defaults, Telegram as ~/.claude.json gave it to the old router', () => {
  for (const old of [undefined, null, [], 'x', 42]) {
    expect(takeOverConfig(old, TELEGRAM)).toEqual({ telegram: 'auto' })
    expect(takeOverConfig(old, {})).toEqual({})
  }
})

test('the old sleeping list: each entry in the default folder, the ones that do not read left out', () => {
  const old = {
    'w1:p2': {
      session: SID,
      name: 'Ledger',
      cwd: PROJECT,
      title: 'claude',
      seen_at: 1000,
      slept_at: 2000,
      exited: true,
      extra: 'kept',
    },
    'w1:p3': { session: SID2, name: 'Billing', seen_at: 3000 },
    'w1:p4': { name: 'no session', seen_at: 1 },
    'w1:p5': 'broken',
  }
  expect(takeOverSessions(old, DEFAULT_DIR)).toEqual({
    'w1:p2': {
      session: SID,
      name: 'Ledger',
      cwd: PROJECT,
      title: 'claude',
      seen_at: 1000,
      slept_at: 2000,
      exited: true,
      extra: 'kept',
      profileDir: DEFAULT_DIR,
    },
    'w1:p3': { session: SID2, name: 'Billing', seen_at: 3000, profileDir: DEFAULT_DIR },
  })
  for (const broken of [null, [], 'x', undefined]) expect(takeOverSessions(broken, DEFAULT_DIR)).toEqual({})
})

test('an entry that names a profile already is the default folder’s all the same: the old router knew ~/.claude only', () => {
  const old = { 'w1:p1': { session: SID, name: 'x', seen_at: 1, profileDir: 'C:\\h\\.claude-work', profile: 'work' } }
  expect(takeOverSessions(old, DEFAULT_DIR)).toEqual({
    'w1:p1': { session: SID, name: 'x', seen_at: 1, profileDir: DEFAULT_DIR },
  })
})

test('call 25: the old wakeCommand’s program against launch.claude’s', () => {
  expect(launcherNote('claude-tg --resume {session}', ['claude'])).toEqual({ old: 'claude-tg', now: 'claude' })
  expect(launcherNote('claude-tg --resume {session}', undefined)).toEqual({ old: 'claude-tg', now: 'claude' })
  expect(launcherNote('"C:\\Program Files\\tg\\claude-tg.cmd" --resume {session}', 'claude')).toEqual({
    old: 'C:\\Program Files\\tg\\claude-tg.cmd',
    now: 'claude',
  })
  expect(launcherNote('claude --model opus --resume {session}', ['claude-tg'])).toEqual({
    old: 'claude',
    now: 'claude-tg',
  })
})

test('call 25: no note when they agree, or the old one is the default', () => {
  expect(launcherNote('claude --resume {session}', ['claude'])).toBeNull()
  expect(launcherNote('claude --resume {session}', ['claude-tg', '--model', 'opus'])).toBeNull()
  for (const none of [undefined, null, '', '  ', 42, ['claude-tg']]) expect(launcherNote(none, ['claude'])).toBeNull()
  expect(launcherNote('claude-tg --resume {session}', ['claude-tg'])).toBeNull()
  expect(launcherNote('claude-tg --resume {session}', 'C:\\Users\\x\\.local\\bin\\CLAUDE-TG.cmd')).toBeNull()
  expect(launcherNote('claude.exe --resume {session} --model opus', undefined)).toBeNull()
})

test('settings.json with the old and other hooks: only the old ones removed', () => {
  const oldPre =
    'node "C:\\Users\\Иван Петров\\AppData\\Roaming\\herdr\\plugins\\config\\herdr-wake\\hook.mjs" pre-send'
  const oldList = 'node "/home/u/.config/herdr/plugins/config/herdr-wake/hook.mjs" post-list'
  const oldStart = 'node "C:/x/herdr-wake/hook.mjs" session-start'
  const board = '"C:/bun/bun.exe" "C:/agent-board/src/entrypoints/hook.ts"'
  const mine = 'node C:\\tools\\herdr-wake-notes.mjs pre-send'
  const settings = {
    model: 'opus',
    hooks: {
      PreToolUse: [
        { matcher: 'SendMessage', hooks: [{ type: 'command', command: oldPre, timeout: 180 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: mine }] },
      ],
      PostToolUse: [{ matcher: 'ListAgents', hooks: [{ type: 'command', command: oldList, timeout: 10 }] }],
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: board, timeout: 10 },
            { type: 'command', command: oldStart, timeout: 10 },
          ],
        },
      ],
      Stop: 'not a list',
    },
  }
  const before = structuredClone(settings)
  const r = withoutOldHooks(settings)
  expect(r.removed).toEqual([oldPre, oldList, oldStart])
  expect(r.settings).toEqual({
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: mine }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: board, timeout: 10 }] }],
      Stop: 'not a list',
    },
  })
  expect(settings).toEqual(before)
})

test('settings.json without the old hooks, or not an object: as it was, nothing removed', () => {
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] } }
  expect(withoutOldHooks(settings)).toEqual({ settings, removed: [] })
  for (const odd of [undefined, null, [], 'x', { hooks: 'none' }])
    expect(withoutOldHooks(odd)).toEqual({ settings: odd, removed: [] })
})

test('call 26: herdr key bindings of herdr-wake’s actions, with their new names', () => {
  const toml = [
    '[ui.toast]',
    'delivery = "system"',
    '',
    '[[keys.command]]',
    'key = "prefix+a"',
    'type = "plugin_action"',
    'command = "agent-board.open"',
    '',
    '[[keys.command]]',
    "key = 'prefix+z'",
    'type = "plugin_action"',
    'command = "herdr-wake.sleep" # put it to sleep',
    'description = "sleep"',
    '',
    '[[keys.command]]',
    'type = "plugin_action"',
    'command = "herdr-wake.wake"',
    'key = "prefix+w"',
    '',
    '[[keys.command]]',
    '# command = "herdr-wake.wake"',
    'key = "prefix+q"',
    'command = "herdr-wake.start"',
    '',
    '[keys]',
    'command = "herdr-wake.sleep"',
  ].join('\r\n')
  expect(oldActionBindings(toml)).toEqual([
    { key: 'prefix+z', old: 'herdr-wake.sleep', now: 'agent-board.sleep' },
    { key: 'prefix+w', old: 'herdr-wake.wake', now: 'agent-board.wake' },
  ])
  expect(oldActionBindings('[[keys.command]]\ncommand = "herdr-wake.sleep"\n')).toEqual([
    { key: '', old: 'herdr-wake.sleep', now: 'agent-board.sleep' },
  ])
  for (const none of [null, '', '[[keys.command]]\nkey = "x"\ncommand = "agent-board.sleep"\n'])
    expect(oldActionBindings(none)).toEqual([])
})
