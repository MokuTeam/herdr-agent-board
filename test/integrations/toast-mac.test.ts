import { afterEach, beforeEach, describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSnapshot } from '../../src/adapters/herdr.ts'
import { toastCommand } from '../../src/core/install-plan.ts'
import { boardFiles } from '../../src/core/setup.ts'
import {
  appBundleOf,
  endEarlier,
  isPaneId,
  lastAssistantText,
  plainText,
  showToast,
  terminalAppOf,
  toastApp,
  toastMessage,
  toastTitle,
} from '../../src/integrations/toast-mac.ts'

// The macOS notification's pure parts: the words of a notification, its title, and the ways to a
// pane. The app it is shown by (swiftc, codesign, LaunchServices) belongs to its owner's computer
// and is not built here.

// The state folder (where the app, a pane's record and its pid file live) is a temp one: the folders
// are computed at call time from LOCALAPPDATA, so no test touches the real one.
let state = ''
const savedState = process.env.LOCALAPPDATA
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'toast-mac-'))
  process.env.LOCALAPPDATA = state
})
afterEach(() => {
  if (savedState === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = savedState
  rmSync(state, { recursive: true, force: true })
})
const toastDir = (): string => join(state, 'herdr', 'plugins', 'agent-board', 'toast')
const helperBinary = (): string => join(toastApp(), 'Contents', 'MacOS', 'ClaudeToast')

describe('the words of a notification', () => {
  test('plainText: Markdown as one line, clipped with an ellipsis', () => {
    const text = '## Done\n\n> quoted\n\n- **one**\n- [two](https://x.y) with `code`\n\n```\nblock\n```'
    assert.equal(plainText(text, 300), 'Done quoted one two with code')
    assert.equal(plainText('a'.repeat(400), 10), 'aaaaaaaaaa…')
    assert.equal(plainText('', 10), '')
    assert.equal(plainText(null, 10), '')
  })

  test('toastMessage: a finished turn, a permission, a question; nothing for the rest', () => {
    assert.deepEqual(toastMessage({ hook_event_name: 'Stop', last_assistant_message: 'Hi' }), {
      kind: 'stop',
      text: 'Hi',
      subtitle: 'claude finished',
    })
    assert.equal(toastMessage({ hook_event_name: 'Stop' })?.text, '')
    assert.deepEqual(
      toastMessage({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow?' }),
      { kind: 'attention', text: 'Allow?', subtitle: 'claude needs attention' },
    )
    // idle_prompt only repeats what the Stop notification said.
    assert.equal(toastMessage({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null)
    assert.deepEqual(
      toastMessage({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which one?' }] },
      }),
      { kind: 'ask', text: 'Which one?', subtitle: 'claude asks' },
    )
    assert.equal(toastMessage({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), null)
    assert.equal(toastMessage({ hook_event_name: 'SessionStart' }), null)
    // A shape that is not the one expected says nothing rather than throwing.
    assert.equal(toastMessage({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: 5 })?.text, '')
  })
})

describe('what it is titled', () => {
  const snapshot = asSnapshot({
    snapshot: {
      workspaces: [{ workspace_id: 'w1', label: 'Work' }],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'tab' }],
      panes: [
        { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', terminal_title_stripped: 'Fix the tests' },
        { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', terminal_title_stripped: 'Claude Code' },
        { pane_id: 'w1:p3', tab_id: 'w1:t1', workspace_id: 'w1' },
      ],
    },
  })

  test('workspace and session, the tab its label when the title says nothing', () => {
    assert.equal(toastTitle(snapshot, 'w1:p1'), 'Work · Fix the tests')
    assert.equal(toastTitle(snapshot, 'w1:p2'), 'Work · tab')
    assert.equal(toastTitle(snapshot, 'w1:p3'), 'Work · tab')
  })

  test('a pane herdr no longer has: the folder, else Claude', () => {
    assert.equal(toastTitle(snapshot, 'w1:p9', '/Users/me/project'), 'project')
    assert.equal(toastTitle(null, 'w1:p9'), 'Claude')
  })
})

describe('the ways to a pane', () => {
  test('a pane id only', () => {
    for (const ok of ['w1:p2', 'wP:p3G', 'w12:p1']) assert.equal(isPaneId(ok), true, ok)
    for (const bad of ['w1:p2;calc', 'claude-pane:w1:p2', 'w1:', '../x', '', 'w1:p2 x'])
      assert.equal(isPaneId(bad), false, bad)
  })

  test('the app a program runs from', () => {
    assert.equal(appBundleOf('/Applications/iTerm.app/Contents/MacOS/iTerm2'), '/Applications/iTerm.app')
    assert.equal(
      appBundleOf('/Applications/My Terminal.app/Contents/MacOS/My Terminal'),
      '/Applications/My Terminal.app',
    )
    assert.equal(appBundleOf('/opt/homebrew/bin/herdr'), '')
  })

  test('the terminal app: the first ancestor in a bundle, not the app at the top', () => {
    const chain: Record<number, string> = {
      100: ' 99 /opt/homebrew/bin/node',
      99: ' 98 /Users/me/.local/bin/claude',
      98: ' 97 /bin/zsh',
      97: ' 96 /opt/homebrew/bin/herdr',
      96: ' 1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
      1: ' 0 /sbin/launchd',
    }
    assert.equal(
      terminalAppOf(100, pid => chain[pid] ?? ''),
      '/Applications/Ghostty.app',
    )
    assert.equal(
      terminalAppOf(1, pid => chain[pid] ?? ''),
      '',
    )
    // A process whose parent is gone ends the walk rather than looping.
    assert.equal(
      terminalAppOf(100, () => ' 100 /opt/homebrew/bin/node'),
      '',
    )
  })

  test('the last reply in a transcript, read from its end', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'do it' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second' }, { type: 'tool_use' }] },
      }),
    ]
    assert.equal(
      lastAssistantText('/x', () => lines.join('\n')),
      'second',
    )
    assert.equal(
      lastAssistantText('/x', () => 'not json\n{"type":"assistant"'),
      '',
    )
  })
})

describe('the helper of an earlier notification', () => {
  const pidFile = (): string => join(toastDir(), 'pane-w1_p2.pid')
  /** The pid file of pane w1:p2 with `pid`, and what happens to it when ps says `program` runs there. */
  function endWith(pid: string, program: string): { killed: number[]; asked: number[] } {
    mkdirSync(toastDir(), { recursive: true })
    writeFileSync(pidFile(), pid)
    const killed: number[] = []
    const asked: number[] = []
    endEarlier(
      'w1:p2',
      p => {
        asked.push(p)
        return program
      },
      p => {
        killed.push(p)
      },
    )
    return { killed, asked }
  }

  test('ended while the pid still runs our helper', () => {
    assert.deepEqual(endWith('4242', helperBinary()), { killed: [4242], asked: [4242] })
    assert.equal(existsSync(pidFile()), false)
    // ps may show the helper under another state folder's path: still the helper.
    assert.deepEqual(endWith('4242', '/Users/me/state/toast/ClaudeToast.app/Contents/MacOS/ClaudeToast').killed, [4242])
  })

  test('a pid that was given out again, or is gone, is left alone and its file removed', () => {
    for (const program of ['/usr/bin/vim', '/Applications/ClaudeToast.app/Contents/MacOS/ClaudeToastHelper', '']) {
      assert.deepEqual(endWith('4242', program).killed, [], program)
      assert.equal(existsSync(pidFile()), false, program)
    }
  })

  test('no pid file: nothing asked; not a pid: nothing asked, the file removed', () => {
    endEarlier(
      'w1:p2',
      () => assert.fail('ps asked'),
      () => assert.fail('killed'),
    )
    for (const text of ['', 'x', '0', '-3', '1.5']) {
      assert.deepEqual(endWith(text, helperBinary()), { killed: [], asked: [] }, text)
      assert.equal(existsSync(pidFile()), false, text)
    }
  })
})

// showToast against a stand-in for the helper: an app in the state folder that is newer than its
// source, so nothing is built, whose program is `body` with `mode`. Windows has no execute bit.
describe.skipIf(process.platform === 'win32')('showing a notification', () => {
  const toast = { pane: 'w1:p2', title: 'Work', subtitle: 'claude finished', body: 'Done', tab: 'w1:t1', app: '/A.app' }
  const record = (): string => join(toastDir(), 'pane-w1_p2.json')
  const pidFile = (): string => join(toastDir(), 'pane-w1_p2.pid')

  function stand(body: string, mode: number): void {
    mkdirSync(join(toastApp(), 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(toastApp(), 'Contents', 'Info.plist'), '<plist/>')
    writeFileSync(helperBinary(), body, { mode })
    chmodSync(helperBinary(), mode)
    const later = new Date(Date.now() + 60_000)
    utimesSync(helperBinary(), later, later)
  }
  async function show(over: Partial<typeof toast> = {}): Promise<[string, string][]> {
    const sent: [string, string][] = []
    await showToast({ ...toast, ...over }, async (title, body) => {
      sent.push([title, body])
    })
    return sent
  }

  test('the helper runs: no notification of herdr’s, the pane’s record and the helper’s pid written', async () => {
    stand('#!/bin/sh\nexit 0\n', 0o755)
    assert.deepEqual(await show(), [])
    const saved = JSON.parse(readFileSync(record(), 'utf8'))
    assert.deepEqual({ ...saved, at: 0 }, { tab: 'w1:t1', app: '/A.app', at: 0 })
    assert.match(readFileSync(pidFile(), 'utf8'), /^\d+$/)
  })

  test('a helper that cannot start: herdr’s own notification instead, nothing written', async () => {
    const cases: [string, string, number][] = [
      ['not allowed to run', '#!/bin/sh\nexit 0\n', 0o644],
      ['its interpreter is missing', '#!/nonexistent/sh\n', 0o755],
    ]
    for (const [why, body, mode] of cases) {
      stand(body, mode)
      assert.deepEqual(await show(), [['Work', 'claude finished — Done']], why)
      assert.equal(existsSync(record()), false, why)
      assert.equal(existsSync(pidFile()), false, why)
    }
    // A spawn that throws at once (an argument with a NUL byte; a file the system cannot execute) is the same.
    stand('#!/bin/sh\nexit 0\n', 0o755)
    assert.deepEqual(await show({ body: 'a\0b' }), [['Work', 'claude finished — a\0b']])
    assert.equal(existsSync(record()), false)
    assert.equal(existsSync(pidFile()), false)
  })

  // On a Mac this would build the real app, and show it.
  test.skipIf(process.platform === 'darwin')(
    'no app and none to build: herdr’s own notification, nothing written',
    async () => {
      assert.deepEqual(await show(), [['Work', 'claude finished — Done']])
      assert.equal(existsSync(toastDir()), false)
    },
  )
})

describe('the hook the install writes', () => {
  test('macOS runs the board’s own Bun entrypoint, Windows its PowerShell script', () => {
    const bun = '/Users/me/.bun/bin/bun'
    assert.equal(
      toastCommand({ bun, toast: '/x/src/entrypoints/toast.ts', platform: 'darwin' }),
      '"/Users/me/.bun/bin/bun" "/x/src/entrypoints/toast.ts"',
    )
    assert.equal(
      toastCommand({ bun, toast: '/x/src/integrations/toast.ps1', platform: 'win32' }),
      'powershell -NoProfile -ExecutionPolicy Bypass -File "/x/src/integrations/toast.ps1"',
    )
  })

  test('the files of a copy: the notification script by platform', () => {
    assert.equal(boardFiles('/x', 'darwin').toast, '/x/src/entrypoints/toast.ts')
    assert.equal(boardFiles('/x', 'win32').toast, '/x/src/integrations/toast.ps1')
  })
})
