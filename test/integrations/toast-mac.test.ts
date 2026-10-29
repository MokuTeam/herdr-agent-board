import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { asSnapshot } from '../../src/adapters/herdr.ts'
import { toastCommand } from '../../src/core/install-plan.ts'
import { boardFiles } from '../../src/core/setup.ts'
import {
  appBundleOf,
  isPaneId,
  lastAssistantText,
  plainText,
  terminalAppOf,
  toastMessage,
  toastTitle,
} from '../../src/integrations/toast-mac.ts'

// The macOS notification's pure parts: the words of a notification, its title, and the ways to a
// pane. The app it is shown by (swiftc, codesign, LaunchServices) belongs to its owner's computer
// and is not built here.

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
