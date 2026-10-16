import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { type InstallPaths, isOurCommand, planSettings, planShims, quote } from '../../src/core/install-plan.ts'

// Where the plugin and Bun live on a Windows machine with a space and a Cyrillic user name in the paths.
const plugin = 'C:\\Users\\Имя\\AppData\\Roaming\\herdr\\plugins\\agent-board'
const paths: InstallPaths = {
  bun: 'C:\\Program Files\\Bun\\bun.exe',
  hook: `${plugin}\\src\\entrypoints\\hook.ts`,
  statusline: `${plugin}\\src\\entrypoints\\statusline.ts`,
  cli: `${plugin}\\src\\entrypoints\\cli.ts`,
  binDir: 'C:\\Users\\Имя\\.local\\bin',
}
const hookCommand =
  '"C:/Program Files/Bun/bun.exe" "C:/Users/Имя/AppData/Roaming/herdr/plugins/agent-board/src/entrypoints/hook.ts"'
const statusCommand =
  '"C:/Program Files/Bun/bun.exe" "C:/Users/Имя/AppData/Roaming/herdr/plugins/agent-board/src/entrypoints/statusline.ts"'
const ourHook = { hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] }
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
    const { settings, replaced } = planSettings(before, paths)
    assert.deepEqual(settings, {
      model: 'opus',
      hooks: { SessionStart: [ourHook], UserPromptSubmit: [ourHook] },
      statusLine: ourStatusLine,
    })
    assert.deepEqual(replaced, [mainHook, mainHook, mainStatusLine])
  })

  test("the user's own hook and status line stay untouched; ours are added next to them", () => {
    const own = { matcher: 'startup', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/hello.sh' }] }
    const ownLine = { type: 'command', command: 'npx ccusage statusline', padding: 0 }
    const before = { hooks: { SessionStart: [own], Stop: [own] }, statusLine: ownLine }
    const { settings, replaced } = planSettings(structuredClone(before), paths)
    assert.deepEqual(settings, {
      hooks: { SessionStart: [own, ourHook], Stop: [own], UserPromptSubmit: [ourHook] },
      statusLine: ownLine,
    })
    assert.deepEqual(replaced, [])
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
    })
  })

  test('no settings.json yet: hooks and status line from nothing', () => {
    const { settings, replaced } = planSettings(undefined, paths)
    assert.deepEqual(settings, {
      hooks: { SessionStart: [ourHook], UserPromptSubmit: [ourHook] },
      statusLine: ourStatusLine,
    })
    assert.deepEqual(replaced, [])
  })

  test('running it twice gives the same settings: no duplicates', () => {
    const own = { hooks: [{ type: 'command', command: 'echo hi' }] }
    const first = planSettings({ hooks: { SessionStart: [own] } }, paths).settings
    const second = planSettings(first, paths)
    assert.deepEqual(second.settings, first)
    assert.deepEqual(second.replaced, [hookCommand, hookCommand, statusCommand])
  })

  test('the settings handed in are not changed', () => {
    const before = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: mainHook }] }] } }
    const copy = structuredClone(before)
    planSettings(before, paths)
    assert.deepEqual(before, copy)
  })

  test('settings.json that is not an object is refused rather than overwritten', () => {
    for (const bad of [null, [], 'text', 5]) assert.throws(() => planSettings(bad, paths), /not a JSON object/)
    assert.throws(() => planSettings({ hooks: [] }, paths), /"hooks" is not an object/)
    assert.throws(() => planSettings({ hooks: { SessionStart: {} } }, paths), /not a list/)
  })

  test('entries not shaped like hook entries are left alone; ones with no hooks go, as on main', () => {
    const odd = ['text', { hooks: 'not a list' }, null]
    const { settings } = planSettings({ hooks: { SessionStart: [...odd, { matcher: 'x' }, { hooks: null }] } }, paths)
    assert.deepEqual(settings.hooks, { SessionStart: [...odd, ourHook], UserPromptSubmit: [ourHook] })
  })

  test('the command quotes Bun and the hook with forward slashes (spaces, Cyrillic)', () => {
    const { settings } = planSettings({}, paths)
    assert.deepEqual(settings.hooks, { SessionStart: [ourHook], UserPromptSubmit: [ourHook] })
    assert.equal(quote('C:\\Program Files\\Bun\\bun.exe'), '"C:/Program Files/Bun/bun.exe"')
    assert.equal(quote('/home/имя/.bun/bin/bun'), '"/home/имя/.bun/bin/bun"')
  })
})

describe('planShims', () => {
  test('the sh and the cmd shim quote Bun and the board command', () => {
    assert.deepEqual(planShims(paths), {
      board:
        '#!/bin/sh\n# agent-board\nexec "C:/Program Files/Bun/bun.exe" "C:/Users/Имя/AppData/Roaming/herdr/plugins/agent-board/src/entrypoints/cli.ts" "$@"\n',
      'board.cmd':
        '@rem agent-board\r\n@"C:\\Program Files\\Bun\\bun.exe" "C:\\Users\\Имя\\AppData\\Roaming\\herdr\\plugins\\agent-board\\src\\entrypoints\\cli.ts" %*\r\n',
    })
  })

  test('on macOS and Linux: POSIX paths as they are', () => {
    const shims = planShims({
      bun: '/Users/me/.bun/bin/bun',
      cli: '/Users/me/My Plugins/agent-board/src/entrypoints/cli.ts',
      hook: '',
      statusline: '',
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
      'npx ccusage statusline',
      '',
    ])
      assert.equal(isOurCommand(command), false, command)
  })
})
