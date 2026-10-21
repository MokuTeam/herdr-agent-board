import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  type InstallPaths,
  isOurCommand,
  OLD_WAKE_HOOK,
  planSettings,
  planShims,
  quote,
  toastCommand,
  wakeHooksState,
} from '../../src/core/install-plan.ts'

// Where the plugin and Bun live on a Windows machine with a space and a Cyrillic user name in the paths.
const plugin = 'C:\\Users\\Имя\\AppData\\Roaming\\herdr\\plugins\\agent-board'
const paths: InstallPaths & { wakeHook: string } = {
  bun: 'C:\\Program Files\\Bun\\bun.exe',
  hook: `${plugin}\\src\\entrypoints\\hook.ts`,
  statusline: `${plugin}\\src\\entrypoints\\statusline.ts`,
  cli: `${plugin}\\src\\entrypoints\\cli.ts`,
  spawn: `${plugin}\\src\\entrypoints\\spawn-agent.ts`,
  toast: `${plugin}\\src\\integrations\\toast.ps1`,
  wakeHook: `${plugin}\\src\\entrypoints\\wake-hook.ts`,
  binDir: 'C:\\Users\\Имя\\.local\\bin',
}
const hookCommand =
  '"C:/Program Files/Bun/bun.exe" "C:/Users/Имя/AppData/Roaming/herdr/plugins/agent-board/src/entrypoints/hook.ts"'
const statusCommand =
  '"C:/Program Files/Bun/bun.exe" "C:/Users/Имя/AppData/Roaming/herdr/plugins/agent-board/src/entrypoints/statusline.ts"'
const ourHook = { hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] }
// The same hook on a question form, before its dialog opens (core/held-question.ts).
const ourAsk = { matcher: 'AskUserQuestion', ...ourHook }
const settingsOf = (settings: Record<string, unknown>) => settings.hooks as Record<string, unknown>
const ourStatusLine = { type: 'command', command: statusCommand }

// What main's install wrote: `node "<hook>"` with the path as it is, the status line with forward slashes.
const mainHook = 'node "C:\\Users\\me\\herdr-agent-board\\src\\hook.mjs"'
const mainStatusLine = 'node "C:/Users/me/herdr-agent-board/src/statusline.mjs"'

describe('planSettings', () => {
  test("main's entries are replaced by one Bun entry per event and the new status line", () => {
    const before = {
      model: 'opus',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: mainHook, timeout: 10 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: mainHook, timeout: 10 }] }],
      },
      statusLine: { type: 'command', command: mainStatusLine },
    }
    const { settings, replaced, statusLineSet } = planSettings(before, paths)
    assert.deepEqual(settings, {
      model: 'opus',
      hooks: { SessionStart: [ourHook], UserPromptSubmit: [ourHook], PreToolUse: [ourAsk] },
      statusLine: ourStatusLine,
    })
    assert.deepEqual(replaced, [mainHook, mainHook, mainStatusLine])
    assert.equal(statusLineSet, true)
  })

  test("the user's own hook and status line stay untouched; ours are added next to them", () => {
    const own = { matcher: 'startup', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/hello.sh' }] }
    const ownLine = { type: 'command', command: 'npx ccusage statusline', padding: 0 }
    const before = { hooks: { SessionStart: [own], Stop: [own] }, statusLine: ownLine }
    const { settings, replaced, statusLineSet } = planSettings(structuredClone(before), paths)
    assert.deepEqual(settings, {
      hooks: { SessionStart: [own, ourHook], Stop: [own], UserPromptSubmit: [ourHook], PreToolUse: [ourAsk] },
      statusLine: ownLine,
    })
    assert.deepEqual(replaced, [])
    assert.equal(statusLineSet, false)
  })

  test("a status line that runs our hook's file is still someone else's status line", () => {
    const odd = { type: 'command', command: 'node "C:/x/agent-board/src/hook.mjs"' }
    const { settings, statusLineSet } = planSettings({ statusLine: odd }, paths)
    assert.deepEqual(settings.statusLine, odd)
    assert.equal(statusLineSet, false)
  })

  test("one of our hooks next to the user's in the same entry: only ours goes", () => {
    const before = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'echo hi' },
              { type: 'command', command: mainHook },
            ],
          },
        ],
      },
    }
    const { settings } = planSettings(before, paths)
    assert.deepEqual(settings.hooks, {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }, ourHook],
      UserPromptSubmit: [ourHook],
      PreToolUse: [ourAsk],
    })
  })

  test("the question hook: an entry of its own in PreToolUse, beside the user's and the notifications'", () => {
    const guard = { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/git-guard.sh' }] }
    const notify = { type: 'command', command: toastCommand(paths.toast), timeout: 30, async: true }
    const toast = { matcher: 'AskUserQuestion', hooks: [notify] }
    const { settings } = planSettings({ hooks: { PreToolUse: [guard] } }, paths, { toast: true })
    assert.deepEqual(settings.hooks, {
      SessionStart: [ourHook],
      UserPromptSubmit: [ourHook],
      PreToolUse: [guard, ourAsk, toast],
      Stop: [{ hooks: [notify] }],
      Notification: [{ matcher: 'permission_prompt|elicitation_dialog', hooks: [notify] }],
    })
    // main's hook under PreToolUse, or ours from another copy: one entry of ours, this copy's.
    const older = { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: mainHook }] }
    const moved = planSettings({ hooks: { PreToolUse: [older, guard] } }, paths)
    assert.deepEqual(settingsOf(moved.settings).PreToolUse, [guard, ourAsk])
    assert.deepEqual(moved.replaced, [mainHook])
    // Notifications off again: the question hook stays.
    const off = planSettings(settings, paths, { toast: false }).settings
    assert.deepEqual(settingsOf(off).PreToolUse, [guard, ourAsk])
  })

  test('no settings.json yet: hooks and status line from nothing', () => {
    const { settings, replaced, statusLineSet } = planSettings(undefined, paths)
    assert.deepEqual(settings, {
      hooks: { SessionStart: [ourHook], UserPromptSubmit: [ourHook], PreToolUse: [ourAsk] },
      statusLine: ourStatusLine,
    })
    assert.deepEqual(replaced, [])
    assert.equal(statusLineSet, true)
  })

  test('running it twice gives the same settings: no duplicates', () => {
    const own = { hooks: [{ type: 'command', command: 'echo hi' }] }
    const first = planSettings({ hooks: { SessionStart: [own] } }, paths).settings
    const second = planSettings(first, paths)
    assert.deepEqual(second.settings, first)
    assert.deepEqual(second.replaced, [hookCommand, hookCommand, hookCommand, statusCommand])
    assert.equal(second.statusLineSet, true)
  })

  test('the settings handed in are not changed', () => {
    const before = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: mainHook }] }] } }
    const copy = structuredClone(before)
    planSettings(before, paths)
    assert.deepEqual(before, copy)
  })

  test('settings.json that is not an object is refused rather than overwritten', () => {
    for (const bad of [null, [], 'text', 5]) assert.throws(() => planSettings(bad, paths), /not a JSON object/)
  })

  test('"hooks" that is not an object, or an event that is not a list, is replaced (as upstream)', () => {
    for (const hooks of [[], 'text', null])
      assert.deepEqual(planSettings({ hooks }, paths).settings.hooks, {
        SessionStart: [ourHook],
        UserPromptSubmit: [ourHook],
        PreToolUse: [ourAsk],
      })
    assert.deepEqual(planSettings({ hooks: { SessionStart: {}, PreToolUse: 5 } }, paths).settings.hooks, {
      SessionStart: [ourHook],
      UserPromptSubmit: [ourHook],
      PreToolUse: [ourAsk],
    })
  })

  test('entries not shaped like hook entries are left alone; ones with no hooks go, as on main', () => {
    const odd = ['text', { hooks: 'not a list' }, null]
    const { settings } = planSettings({ hooks: { SessionStart: [...odd, { matcher: 'x' }, { hooks: null }] } }, paths)
    assert.deepEqual(settings.hooks, {
      SessionStart: [...odd, ourHook],
      UserPromptSubmit: [ourHook],
      PreToolUse: [ourAsk],
    })
  })

  test('the command quotes Bun and the hook with forward slashes (spaces, Cyrillic)', () => {
    const { settings } = planSettings({}, paths)
    assert.deepEqual(settings.hooks, { SessionStart: [ourHook], UserPromptSubmit: [ourHook], PreToolUse: [ourAsk] })
    assert.equal(quote('C:\\Program Files\\Bun\\bun.exe'), '"C:/Program Files/Bun/bun.exe"')
    assert.equal(quote('/home/имя/.bun/bin/bun'), '"/home/имя/.bun/bin/bun"')
  })
})

describe('planShims', () => {
  test('the sh and the cmd shims quote Bun and the board command, and spawn-agent the same way', () => {
    // UTF-8 around the call (the paths may not be ASCII), then the code page and exit code as they were.
    const cmd = (script: string) =>
      [
        '@rem agent-board',
        '@setlocal',
        '@for /f "tokens=2 delims=:." %%c in (\'chcp\') do @set "AB_CP=%%c"',
        '@chcp 65001 >nul',
        `@"C:\\Program Files\\Bun\\bun.exe" "C:\\Users\\Имя\\AppData\\Roaming\\herdr\\plugins\\agent-board\\src\\entrypoints\\${script}" %*`,
        '@set "AB_RC=%errorlevel%"',
        '@chcp %AB_CP% >nul',
        '@exit /b %AB_RC%',
        '',
      ].join('\r\n')
    const sh = (script: string) =>
      `#!/bin/sh\n# agent-board\nexec "C:/Program Files/Bun/bun.exe" "C:/Users/Имя/AppData/Roaming/herdr/plugins/agent-board/src/entrypoints/${script}" "$@"\n`
    assert.deepEqual(planShims(paths), {
      board: sh('cli.ts'),
      'board.cmd': cmd('cli.ts'),
      'spawn-agent': sh('spawn-agent.ts'),
      'spawn-agent.cmd': cmd('spawn-agent.ts'),
    })
  })

  test('on macOS and Linux: POSIX paths as they are', () => {
    const shims = planShims({
      bun: '/Users/me/.bun/bin/bun',
      cli: '/Users/me/My Plugins/agent-board/src/entrypoints/cli.ts',
      hook: '',
      statusline: '',
      spawn: '',
      toast: '',
      binDir: '/Users/me/.local/bin',
    })
    assert.equal(
      shims.board,
      '#!/bin/sh\n# agent-board\nexec "/Users/me/.bun/bin/bun" "/Users/me/My Plugins/agent-board/src/entrypoints/cli.ts" "$@"\n',
    )
  })
})

describe('isOurCommand', () => {
  test("main's node entries: either slash, quoted or not", () => {
    for (const command of [
      mainHook,
      mainStatusLine,
      'node "C:/Users/me/herdr-agent-board/src/hook.mjs"',
      'node C:\\Users\\me\\agent-board\\src\\hook.mjs',
      'node /home/me/agent-board/src/statusline.mjs',
      'node "C:\\Users\\me\\AppData\\Roaming\\herdr\\plugins\\agent-board\\src\\statusline.mjs"',
      // This branch before the entrypoints moved: bun on PATH, same .mjs files.
      'bun "C:\\Users\\me\\herdr-agent-board\\src\\hook.mjs"',
    ])
      assert.equal(isOurCommand(command), true, command)
  })

  test('the new Bun entries: either slash, quoted or not', () => {
    for (const command of [
      hookCommand,
      statusCommand,
      '"/home/me/.bun/bin/bun" "/home/me/agent-board/src/entrypoints/hook.ts"',
      'bun /home/me/agent-board/src/entrypoints/statusline.ts',
      '"C:\\Program Files\\Bun\\bun.exe" "C:\\Users\\me\\agent-board\\src\\entrypoints\\hook.ts"',
    ])
      assert.equal(isOurCommand(command), true, command)
  })

  test("someone else's commands are not ours", () => {
    for (const command of [
      'bash ~/.claude/hooks/hello.sh',
      'node "C:\\tools\\hook.mjs"',
      'node /home/me/hooks/statusline.mjs',
      'bun "/home/me/other-plugin/src/entrypoints/hook.ts"',
      'bun "/home/me/agent-board/scripts/hook.ts"',
      'bun "/home/me/agent-board/src/entrypoints/cli.ts"',
      'node "C:\\Users\\me\\agent-board-notes\\prehook.mjs"',
      'node /home/me/agent-board/tools/prestatusline.mjs',
      'bun "/home/me/agent-board/src/myentrypoints/hook.ts"',
      'npx ccusage statusline',
      '',
    ])
      assert.equal(isOurCommand(command), false, command)
  })
})

describe('wake’s hooks (#119)', () => {
  const wakeCommand = (mode: string): string =>
    `"C:/Program Files/Bun/bun.exe" "C:/Users/Имя/AppData/Roaming/herdr/plugins/agent-board/src/entrypoints/wake-hook.ts" ${mode}`
  const send = { matcher: 'SendMessage', hooks: [{ type: 'command', command: wakeCommand('pre-send'), timeout: 180 }] }
  const list = { matcher: 'ListAgents', hooks: [{ type: 'command', command: wakeCommand('post-list'), timeout: 10 }] }
  const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'theirs' }] }
  // As herdr-wake's install-hooks.mjs writes them.
  const oldHook = (mode: string) => ({
    ...(mode === 'session-start' ? {} : { matcher: mode === 'pre-send' ? 'SendMessage' : 'ListAgents' }),
    hooks: [
      {
        type: 'command',
        command: `node "C:\\Users\\Имя\\AppData\\Roaming\\herdr\\plugins\\config\\herdr-wake\\hook.mjs" ${mode}`,
        timeout: mode === 'pre-send' ? 180 : 10,
      },
    ],
  })
  const oldPlugin = {
    hooks: {
      PreToolUse: [theirs, oldHook('pre-send')],
      PostToolUse: [oldHook('post-list')],
      SessionStart: [oldHook('session-start')],
    },
  }
  type Hooks = Record<string, unknown[] | undefined>
  const hooksOf = (settings: Record<string, unknown>): Hooks => settings.hooks as Hooks
  /** An entry that runs wake's hook, any copy's. */
  const isWake = (e: unknown): boolean => JSON.stringify(e).includes('wake-hook.ts')
  const wakeOf = (settings: Record<string, unknown>, event: string): unknown[] =>
    (hooksOf(settings)[event] ?? []).filter(isWake)
  /** The settings without wake's entries (an event left with none goes). */
  const wakeFree = (settings: Record<string, unknown>): Record<string, unknown> => {
    const hooks: Hooks = {}
    for (const [event, list] of Object.entries(hooksOf(settings))) {
      const left = (list ?? []).filter(e => !isWake(e))
      if (left.length) hooks[event] = left
    }
    return { ...settings, hooks }
  }
  const wakeCommands = (replaced: string[]): string[] => replaced.filter(c => c.includes('wake-hook.ts'))

  test('wake on: SendMessage and ListAgents once, everyone else’s left alone, the rest as without', () => {
    const before = { model: 'opus', hooks: { PreToolUse: [theirs], Stop: [theirs] } }
    const without = planSettings(before, paths)
    const plan = planSettings(before, paths, { wake: true })
    assert.deepEqual(wakeFree(plan.settings), without.settings)
    assert.deepEqual(hooksOf(plan.settings).PreToolUse?.[0], theirs)
    assert.deepEqual(hooksOf(plan.settings).PreToolUse?.at(-1), send)
    assert.deepEqual(wakeOf(plan.settings, 'PreToolUse'), [send])
    assert.deepEqual(hooksOf(plan.settings).PostToolUse, [list])
    assert.deepEqual([plan.oldWake, plan.replaced, plan.statusLineSet], [false, without.replaced, true])
    // Again: the same file, ours replaced by ours.
    const again = planSettings(plan.settings, paths, { wake: true })
    assert.deepEqual(again.settings, plan.settings)
    assert.deepEqual(wakeCommands(again.replaced), [wakeCommand('pre-send'), wakeCommand('post-list')])
    // With the notification hooks on too: each once in PreToolUse, wake's last.
    const once = planSettings(plan.settings, paths, { wake: true, toast: true })
    const twice = planSettings(once.settings, paths, { wake: true, toast: true })
    assert.deepEqual(twice.settings, once.settings)
    const pre = hooksOf(twice.settings).PreToolUse ?? []
    assert.equal(pre.filter(e => JSON.stringify(e).includes('toast.ps1')).length, 1)
    assert.deepEqual(wakeOf(twice.settings, 'PreToolUse'), [send])
    assert.deepEqual(pre.at(-1), send)
  })

  test('a copy moved elsewhere: the earlier ones of ours replaced, also in an entry shared with someone else', () => {
    const earlier = (mode: string) => ({
      type: 'command',
      command: `"D:/bun.exe" "D:/Tools/herdr-agent-board/src/entrypoints/wake-hook.ts" ${mode}`,
      timeout: 5,
    })
    const shared = { matcher: 'SendMessage', hooks: [{ type: 'command', command: 'theirs' }, earlier('pre-send')] }
    const before = {
      hooks: { PreToolUse: [shared], PostToolUse: [{ matcher: 'ListAgents', hooks: [earlier('post-list')] }] },
    }
    const plan = planSettings(before, paths, { wake: true })
    assert.deepEqual(hooksOf(plan.settings).PreToolUse?.[0], {
      matcher: 'SendMessage',
      hooks: [{ type: 'command', command: 'theirs' }],
    })
    assert.deepEqual(wakeOf(plan.settings, 'PreToolUse'), [send])
    assert.deepEqual(hooksOf(plan.settings).PostToolUse, [list])
    assert.deepEqual(wakeCommands(plan.replaced), [earlier('pre-send').command, earlier('post-list').command])
  })

  test('wake off, or not said: ours neither added nor taken out', () => {
    for (const off of [{ wake: false }, {}]) {
      const none = planSettings({ hooks: { PreToolUse: [theirs] } }, paths, off)
      assert.deepEqual(none.settings, planSettings({ hooks: { PreToolUse: [theirs] } }, paths).settings)
      assert.equal(JSON.stringify(none.settings).includes('wake-hook.ts'), false)
      const had = planSettings({}, paths, { wake: true }).settings
      const kept = planSettings(had, paths, off)
      assert.deepEqual(kept.settings, had)
      assert.equal(kept.oldWake, false)
    }
  })

  test('never beside the old plugin’s hooks: none of ours added, earlier ones of ours taken out, its own left', () => {
    const plan = planSettings(oldPlugin, paths, { wake: true })
    assert.equal(plan.oldWake, true)
    assert.deepEqual(plan.settings, planSettings(oldPlugin, paths).settings)
    assert.deepEqual(hooksOf(plan.settings).PreToolUse?.slice(0, 2), oldPlugin.hooks.PreToolUse)
    assert.deepEqual(hooksOf(plan.settings).PostToolUse, oldPlugin.hooks.PostToolUse)
    assert.deepEqual(hooksOf(plan.settings).SessionStart, [oldHook('session-start'), ourHook])
    const both = planSettings(
      { hooks: { ...oldPlugin.hooks, PostToolUse: [oldHook('post-list'), list], PreToolUse: [send] } },
      paths,
      { wake: true },
    )
    assert.deepEqual(hooksOf(both.settings).PostToolUse, [oldHook('post-list')])
    assert.equal(JSON.stringify(both.settings).includes('wake-hook.ts'), false)
    assert.deepEqual(wakeCommands(both.replaced), [wakeCommand('pre-send'), wakeCommand('post-list')])
    // Wake off: the old plugin's and ours as they were.
    const off = planSettings({ hooks: { PostToolUse: [oldHook('post-list'), list] } }, paths, { wake: false })
    assert.deepEqual(hooksOf(off.settings).PostToolUse, [oldHook('post-list'), list])
    assert.equal(off.oldWake, true)
  })

  test('the old plugin’s commands as its install-hooks.mjs recognises them; ours are not the board’s every-prompt hook', () => {
    for (const command of [
      'node "C:\\Users\\Имя\\AppData\\Roaming\\herdr\\plugins\\config\\herdr-wake\\hook.mjs" pre-send',
      'node "/home/me/.config/herdr/plugins/config/herdr-wake/hook.mjs" post-list',
      'node /home/me/.config/herdr/plugins/config/herdr-wake/hook.mjs session-start',
    ])
      assert.equal(OLD_WAKE_HOOK.test(command), true, command)
    for (const command of [wakeCommand('pre-send'), 'node "C:\\tools\\herdr-wake\\hook.mjs" report', 'theirs'])
      assert.equal(OLD_WAKE_HOOK.test(command), false, command)
    assert.equal(isOurCommand(wakeCommand('pre-send')), false)
  })

  test('what a settings.json has of wake’s hooks: both of this copy’s, the old plugin’s, or not both', () => {
    const on = planSettings({}, paths, { wake: true }).settings
    assert.equal(wakeHooksState(on, paths.wakeHook), 'in')
    assert.equal(wakeHooksState(on, 'D:\\other\\agent-board\\src\\entrypoints\\wake-hook.ts'), 'missing')
    assert.equal(wakeHooksState({ hooks: { PreToolUse: [send] } }, paths.wakeHook), 'missing')
    assert.equal(wakeHooksState(oldPlugin, paths.wakeHook), 'old')
    for (const settings of [undefined, null, {}, { hooks: [] }, 'text'])
      assert.equal(wakeHooksState(settings, paths.wakeHook), 'missing')
  })
})
