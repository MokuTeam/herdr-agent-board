import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { endWithSandbox, wakeOnConfig, wakeSandbox, writeBoardConfig } from '../support/wake-process.ts'

for (const background of [false, true]) {
  for (const existing of [false, true]) {
    for (const result of ['ok', 'error', 'missing-pane']) {
      test(`open: existing=${existing}, background=${background}, result=${result}`, async () => {
        const box = await sandbox()
        const stateDir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board')
        mkdirSync(stateDir, { recursive: true })
        writeFileSync(join(stateDir, 'board.json'), JSON.stringify({ pane: 'gone' }))
        box.state({
          'api snapshot': {
            result: {
              snapshot: {
                // user-tab: a shell next to the sidebar; orphan-tab: only the sidebar an old board left.
                panes: [
                  { pane_id: 'shell', tab_id: 'user-tab', workspace_id: 'w1' },
                  { pane_id: 'sb1', tab_id: 'user-tab', workspace_id: 'w1', tokens: { 'herdr-sidebar-git': '1' } },
                  { pane_id: 'sb2', tab_id: 'orphan-tab', workspace_id: 'w1', tokens: { 'herdr-sidebar-git': '1' } },
                ],
                workspaces: existing ? [{ label: 'Board', workspace_id: 'w1' }] : [],
                tabs: [
                  { tab_id: 'user-tab', workspace_id: 'w1' },
                  { tab_id: 'other-user-tab', workspace_id: 'w1' },
                  { tab_id: 'orphan-tab', workspace_id: 'w1' },
                ],
              },
            },
          },
          'workspace create': { result: { workspace: { workspace_id: 'w1' }, tab: { tab_id: 'initial-shell' } } },
          'plugin pane open':
            result === 'error'
              ? { error: 'open failed' }
              : { result: result === 'ok' ? { plugin_pane: { pane: { pane_id: 'new-board' } } } : {} },
          'tab close': { result: {} },
          'pane zoom': { result: {} },
        })
        const out = await box.open(background).exited
        assert.equal(out.code, result === 'error' ? 1 : 0, out.stderr)
        const closes = box.calls().filter(a => a[0] === 'tab' && a[1] === 'close')
        const expected =
          result !== 'ok' ? [] : existing ? [['tab', 'close', 'orphan-tab']] : [['tab', 'close', 'initial-shell']]
        assert.deepEqual(closes, expected)
        if (closes.length) {
          const calls = box.calls()
          assert.ok(calls.findIndex(a => a[2] === 'open') < calls.findIndex(a => a[1] === 'close'))
        }
      }, 10_000)
    }
  }
}

// After a restart herdr brings the board's tab back under the same pane id, with a shell in it in
// place of the board (no plugin pane any more), while board.json still names that pane.
const sidebar = { 'herdr-sidebar-git': '1' }
const restored = {
  panes: [
    { pane_id: 'wZ:p2', tab_id: 'board-tab', workspace_id: 'wZ', terminal_title_stripped: 'bash in herdr-agent-board' },
    { pane_id: 'wZ:p3', tab_id: 'board-tab', workspace_id: 'wZ', tokens: sidebar },
    { pane_id: 'w1:p1', tab_id: 'user-tab', workspace_id: 'w1' },
  ],
  workspaces: [
    { label: 'Board', workspace_id: 'wZ' },
    { label: 'my project', workspace_id: 'w1' },
  ],
  tabs: [
    { tab_id: 'board-tab', workspace_id: 'wZ' },
    { tab_id: 'user-tab', workspace_id: 'w1' },
  ],
  focused_pane_id: 'w1:p1',
}
// Once that pane is closed: its tab keeps only the sidebar's pane.
const closed = { ...restored, panes: restored.panes.filter(p => p.pane_id !== 'wZ:p2') }
// And once a new board is open, in a tab of its own.
const reopened = {
  ...closed,
  panes: [...closed.panes, { pane_id: 'wZ:p9', tab_id: 'new-tab', workspace_id: 'wZ' }],
  tabs: [...closed.tabs, { tab_id: 'new-tab', workspace_id: 'wZ' }],
}
const notPlugin = { error: 'plugin pane not found', code: 'plugin_pane_not_found' }

/** A pid no process has: that of a Bun that ran and ended. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
  return proc.pid
}

async function boardBox(board: unknown, placement?: string): Promise<Sandbox> {
  const box = await sandbox()
  const stateDir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board')
  mkdirSync(stateDir, { recursive: true })
  if (board !== undefined) writeFileSync(join(stateDir, 'board.json'), JSON.stringify(board))
  if (placement) {
    const configDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ placement }))
  }
  return box
}

/** The herdr calls, `plugin pane open` cut to its focus and placement. */
function said(box: Sandbox): string[] {
  return box
    .calls()
    .map(a =>
      a.slice(0, 3).join(' ') === 'plugin pane open'
        ? [
            'plugin pane open',
            ...a.filter(x => x === '--focus' || x === '--no-focus'),
            ...a.slice(a.indexOf('--placement')),
          ].join(' ')
        : a.join(' '),
    )
}

for (const background of [false, true]) {
  test(`open: a pane herdr restored without the board in it is closed and a new board opens (background=${background})`, async () => {
    const box = await boardBox({ pane: 'wZ:p2', pid: await deadPid(), overlay: false })
    box.state({
      'api snapshot': {
        result: { snapshot: restored },
        until: ['pane close'],
        // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply after the close (test/support/fake-herdr.ts)
        then: { seq: [{ result: { snapshot: closed } }, { result: { snapshot: reopened } }] },
      },
      'pane close': { result: {} },
      'plugin pane open': { result: { plugin_pane: { pane: { pane_id: 'wZ:p9' } } } },
      'plugin pane focus': notPlugin,
      'plugin pane close': notPlugin,
      'tab close': { result: {} },
      'tab focus': { result: {} },
      'pane zoom': { result: {} },
    })
    const out = await box.open(background).exited
    assert.equal(out.code, 0, out.stderr)
    assert.deepEqual(
      said(box),
      background
        ? [
            'api snapshot',
            'pane close wZ:p2',
            'api snapshot',
            'plugin pane open --no-focus --placement tab --workspace wZ',
            'tab close board-tab',
          ]
        : [
            'api snapshot',
            'pane close wZ:p2',
            'api snapshot',
            'plugin pane open --focus --placement tab --workspace wZ',
            'tab close board-tab',
            'api snapshot',
            'tab focus new-tab',
            'pane zoom wZ:p9 --on',
          ],
    )
  }, 10_000)
}

for (const placement of ['tab', 'overlay']) {
  for (const background of [false, true]) {
    test(`open: a restored pane without the board, placement=${placement}, background=${background}`, async () => {
      const box = await boardBox({ pane: 'wZ:p2', pid: await deadPid(), overlay: placement === 'overlay' }, placement)
      box.state({
        'api snapshot': {
          result: { snapshot: restored },
          until: ['pane close'],
          // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply after the close (test/support/fake-herdr.ts)
          then: { result: { snapshot: closed } },
        },
        'pane close': { result: {} },
        'plugin pane open': { result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } } },
        'plugin pane focus': notPlugin,
        'plugin pane close': notPlugin,
      })
      const out = await box.open(background).exited
      assert.equal(out.code, 0, out.stderr)
      // The startup hook leaves a tab or overlay board to the key, as before.
      assert.deepEqual(
        said(box),
        background
          ? ['api snapshot']
          : ['api snapshot', 'pane close wZ:p2', 'api snapshot', `plugin pane open --focus --placement ${placement}`],
      )
    }, 10_000)
  }
}

test('open: a restored pane that does not close still leaves a new board open', async () => {
  const box = await boardBox({ pane: 'wZ:p2', pid: await deadPid(), overlay: false })
  box.state({
    'api snapshot': { result: { snapshot: restored } },
    'pane close': { error: 'pane not found', code: 'pane_not_found' },
    'plugin pane open': { result: { plugin_pane: { pane: { pane_id: 'wZ:p9' } } } },
  })
  const out = await box.open(true).exited
  assert.equal(out.code, 0, out.stderr)
  assert.deepEqual(said(box), [
    'api snapshot',
    'pane close wZ:p2',
    'api snapshot',
    'plugin pane open --no-focus --placement tab --workspace wZ',
  ])
}, 10_000)

// What stays as it was: a board that runs (its pid alive, or no pid in an older board.json) is
// focused, toggled back or left alone; with no board.json a board opens.
for (const pid of ['alive', 'missing'] as const) {
  for (const focused of [false, true]) {
    for (const background of [false, true]) {
      test(`open: a running board (pid ${pid}), focused=${focused}, background=${background}`, async () => {
        const box = await boardBox({ pane: 'wZ:p2', ...(pid === 'alive' ? { pid: process.pid } : {}), overlay: false })
        box.state({
          'api snapshot': { result: { snapshot: { ...restored, focused_pane_id: focused ? 'wZ:p2' : 'w1:p1' } } },
          'plugin pane focus': { result: {} },
          'plugin pane close': { result: {} },
          'tab focus': { result: {} },
          'pane zoom': { result: {} },
        })
        const out = await box.open(background).exited
        assert.equal(out.code, 0, out.stderr)
        assert.deepEqual(
          said(box),
          background
            ? ['api snapshot']
            : focused
              ? ['api snapshot', 'plugin pane close wZ:p2']
              : ['api snapshot', 'plugin pane focus wZ:p2', 'tab focus board-tab', 'pane zoom wZ:p2 --on'],
        )
      }, 10_000)
    }
  }
}

for (const background of [false, true]) {
  test(`open: no board.json opens a board and closes no pane (background=${background})`, async () => {
    const box = await boardBox(undefined)
    box.state({
      'api snapshot': { seq: [{ result: { snapshot: restored } }, { result: { snapshot: reopened } }] },
      'plugin pane open': { result: { plugin_pane: { pane: { pane_id: 'wZ:p9' } } } },
      'tab focus': { result: {} },
      'pane zoom': { result: {} },
    })
    const out = await box.open(background).exited
    assert.equal(out.code, 0, out.stderr)
    assert.deepEqual(
      said(box),
      background
        ? ['api snapshot', 'plugin pane open --no-focus --placement tab --workspace wZ']
        : [
            'api snapshot',
            'plugin pane open --focus --placement tab --workspace wZ',
            'api snapshot',
            'tab focus new-tab',
            'pane zoom wZ:p9 --on',
          ],
    )
  }, 10_000)
}

// Wake (#119) has a startup entry of its own beside the board's: herdr runs them side by side and
// waits for neither. The board's start must not know wake, nor wait for it, whatever it does.
test('the board opens whatever wake’s start does: failing, hanging, or missing', async () => {
  const source = readFileSync(join(root, 'src', 'entrypoints', 'open.ts'), 'utf8')
  const imports = [...source.matchAll(/^import [^;]*? from '([^']+)'/gm)].map(m => m[1] ?? '')
  assert.ok(imports.length > 0)
  assert.deepEqual(
    imports.filter(path => /wake/i.test(path)),
    [],
  )

  // The state of `open: existing=true, background=true, result=ok`, wake on in config.json.
  async function boardBox(pluginList: Record<string, unknown> | null): Promise<Sandbox> {
    const box = await wakeSandbox()
    const stateDir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'board.json'), JSON.stringify({ pane: 'gone' }))
    writeBoardConfig(box, wakeOnConfig(await unusedPort()))
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              { pane_id: 'shell', tab_id: 'user-tab', workspace_id: 'w1' },
              { pane_id: 'sb1', tab_id: 'user-tab', workspace_id: 'w1', tokens: { 'herdr-sidebar-git': '1' } },
              { pane_id: 'sb2', tab_id: 'orphan-tab', workspace_id: 'w1', tokens: { 'herdr-sidebar-git': '1' } },
            ],
            workspaces: [{ label: 'Board', workspace_id: 'w1' }],
            tabs: [
              { tab_id: 'user-tab', workspace_id: 'w1' },
              { tab_id: 'other-user-tab', workspace_id: 'w1' },
              { tab_id: 'orphan-tab', workspace_id: 'w1' },
            ],
          },
        },
      },
      'plugin pane open': { result: { plugin_pane: { pane: { pane_id: 'new-board' } } } },
      'tab close': { result: {} },
      'pane zoom': { result: {} },
      ...(pluginList && { 'plugin list': pluginList }),
    })
    return box
  }
  const board = (box: Sandbox): string[][] => box.calls().filter(c => c.slice(0, 2).join(' ') !== 'plugin list')

  // Missing: the board alone, as herdr runs it when wake has no entry.
  const alone = await boardBox(null)
  let started = Date.now()
  const out = await alone.open(true).exited
  const aloneMs = Date.now() - started
  assert.equal(out.code, 0, out.stderr)
  const expected = board(alone)
  assert.deepEqual(
    expected.filter(c => c[0] === 'tab' && c[1] === 'close'),
    [['tab', 'close', 'orphan-tab']],
  )

  for (const how of ['hanging', 'failing'] as const) {
    const box = await boardBox(
      how === 'hanging'
        ? // A gate that never opens: the fake herdr gives up after 5 s, wake's start at its deadline.
          { waitFor: join(alone.dir, 'never') }
        : { error: 'plugin list failed', code: 'internal' },
    )
    const wake = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'wake-start.ts')], {
      cwd: root,
      env: { ...box.env, BOARD_WAKE_START_DEADLINE_MS: '4000' },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    endWithSandbox(wake)
    // Wake's start is under way first: it asks herdr for its plugins.
    while (!box.calls().some(c => c.slice(0, 2).join(' ') === 'plugin list')) await Bun.sleep(10)
    started = Date.now()
    const opened = await box.open(true).exited
    const ms = Date.now() - started
    assert.equal(opened.code, 0, `${how}: ${opened.stderr}`)
    assert.ok(ms < aloneMs + 2000, `${how}: the board took ${ms} ms, ${aloneMs} ms alone`)
    if (how === 'hanging') assert.equal(wake.exitCode, null, 'the board did not wait for wake’s start')
    assert.equal(await wake.exited, 0)
    // Wake's start made no other call once its plugin list failed; the board's calls are as alone.
    assert.deepEqual(board(box), expected, how)
  }
}, 30_000)
