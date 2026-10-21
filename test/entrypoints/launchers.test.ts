// claude-tg without Node (#119), on disk and as it runs. The install refreshes the launchers only
// where a herdr-wake (or the board's) claude-tg is already there, and never one without the mark;
// the panel's "Install claude-tg" (POST /api/wake { op: 'launcher' }) writes both into
// ~/.local/bin, and nothing over someone else's. As they run: a stand-in claude says what it got;
// the key comes from the board's own `board` command (the install's shim, running this copy's
// cli.ts) asking the compiled fake herdr, where herdr-wake's ran node. Ported from herdr-wake's
// install-launcher, claude-tg.cmd and sh tests.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'
import { installLaunchers } from '../../src/adapters/launchers.ts'
import { planShims } from '../../src/core/install-plan.ts'
import { boardFiles } from '../../src/core/setup.ts'
import { launcherFiles } from '../../src/core/wake/launchers.ts'
import { serveBoard } from '../support/board-server.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(60_000)

/** herdr-wake's own launchers and key script, as its install-launcher.mjs left them. */
const OLD = {
  'claude-tg':
    '#!/bin/sh\n' +
    "# herdr-wake: claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)\n" +
    'TG_KEY="$(node "$(dirname "$0")/claude-tg-key.mjs" 2>/dev/null)"\n' +
    '[ -n "$TG_KEY" ] || TG_KEY="$(pwd)"\n' +
    'export TG_KEY\n' +
    'exec claude "$@"\n',
  'claude-tg.cmd': [
    '@echo off',
    "rem herdr-wake: claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)",
    'setlocal DisableDelayedExpansion',
    'set "TG_KEY="',
    'for /f "usebackq delims=" %%k in (`node "%~dp0claude-tg-key.mjs" 2^>nul`) do set "TG_KEY=%%k"',
    'if not defined TG_KEY set "TG_KEY=%CD%"',
    'claude %*',
    '',
  ].join('\r\n'),
  'claude-tg-key.mjs': '#!/usr/bin/env node\n// herdr-wake: the Telegram topic …\n',
}

const homeOf = (box: Sandbox): string => {
  const home = box.env.USERPROFILE as string
  expect(home.startsWith(box.dir + sep)).toBe(true)
  return home
}
const binOf = (box: Sandbox): string => join(homeOf(box), '.local', 'bin')
const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null)

/** The install action in the sandbox's home, with no herdr-wake for its check to ask. */
async function install(box: Sandbox) {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, 'config.json')))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', wakeUrl: '' }))
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'install.ts')], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test('the install refreshes a herdr-wake claude-tg and writes none where there is none', async () => {
  const box = await sandbox()
  box.state({ 'integration install claude': { claudeHook: true } })
  const bin = binOf(box)
  // None there: none written, and the install says nothing of it.
  const first = await install(box)
  expect(first.code).toBe(0)
  expect([read(join(bin, 'claude-tg')), read(join(bin, 'claude-tg.cmd'))]).toEqual([null, null])
  expect(first.stdout).not.toContain('claude-tg')

  // herdr-wake's there: both replaced by the board's; its key script beside them is left alone.
  for (const [name, text] of Object.entries(OLD)) writeFileSync(join(bin, name), text)
  const second = await install(box)
  expect(second.code).toBe(0)
  expect(read(join(bin, 'claude-tg'))).toBe(launcherFiles()['claude-tg'])
  expect(read(join(bin, 'claude-tg.cmd'))).toBe(launcherFiles()['claude-tg.cmd'])
  expect(read(join(bin, 'claude-tg-key.mjs'))).toBe(OLD['claude-tg-key.mjs'])
  expect(second.stdout).toContain(`claude-tg: ${join(bin, 'claude-tg')}, ${join(bin, 'claude-tg.cmd')}`)
  // Again: nothing left to refresh.
  const third = await install(box)
  expect(third.stdout).not.toContain('claude-tg')
})

test('someone else’s claude-tg is never replaced', async () => {
  const box = await sandbox()
  box.state({ 'integration install claude': { claudeHook: true } })
  const bin = binOf(box)
  mkdirSync(bin, { recursive: true })
  const mine = '@echo mine, not from herdr-wake\r\n'
  writeFileSync(join(bin, 'claude-tg.cmd'), mine)
  writeFileSync(join(bin, 'claude-tg'), OLD['claude-tg'])
  // The install: herdr-wake's sh refreshed, theirs left as it was.
  expect((await install(box)).code).toBe(0)
  expect(read(join(bin, 'claude-tg'))).toBe(launcherFiles()['claude-tg'])
  expect(read(join(bin, 'claude-tg.cmd'))).toBe(mine)

  // The panel's Install: nothing at all while one of them is someone else's, and it says which.
  const other = join(box.dir, 'other-bin')
  mkdirSync(other)
  writeFileSync(join(other, 'claude-tg'), '#!/bin/sh\n# my own\nexec claude "$@"\n')
  expect(installLaunchers(other, { onlyWhereThere: false })).toEqual({
    written: [],
    foreign: [join(other, 'claude-tg')],
  })
  expect(read(join(other, 'claude-tg.cmd'))).toBeNull()
  // A folder with none: both, the folder made.
  const fresh = join(box.dir, 'Иван Петров 100%', '.local', 'bin')
  expect(installLaunchers(fresh, { onlyWhereThere: false })).toEqual({
    written: [join(fresh, 'claude-tg'), join(fresh, 'claude-tg.cmd')],
    foreign: [],
  })
  expect(read(join(fresh, 'claude-tg.cmd'))).toBe(launcherFiles()['claude-tg.cmd'])
})

test('the panel’s Install claude-tg: both into ~/.local/bin, the folder in its answer; someone else’s refused', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: { workspaces: [], tabs: [], panes: [] } } } })
  const { url } = await serveBoard(box, { language: 'en', wake: false })
  const post = async () => {
    const res = await fetch(`${url}/api/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'launcher' }),
    })
    return [res.status, await res.json()]
  }
  const bin = binOf(box)
  expect(await post()).toEqual([200, { ok: true, dir: bin }])
  expect(read(join(bin, 'claude-tg'))).toBe(launcherFiles()['claude-tg'])
  expect(read(join(bin, 'claude-tg.cmd'))).toBe(launcherFiles()['claude-tg.cmd'])
  writeFileSync(join(bin, 'claude-tg.cmd'), '@echo mine\r\n')
  expect(await post()).toEqual([
    409,
    {
      ok: false,
      error: `${join(bin, 'claude-tg.cmd')}: not the board’s nor herdr-wake’s, so it was left as it is. Move it away and try again`,
    },
  ])
  expect(read(join(bin, 'claude-tg.cmd'))).toBe('@echo mine\r\n')
})

// ---------------------------------------------------------------- as they run

/** The snapshot herdr answers: the pane w1:p3 is the second tab ("hotfix") of workspace Billing. */
const SNAPSHOT = {
  workspaces: [{ workspace_id: 'w1', label: 'Billing' }],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'hotfix', number: 2 },
    { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 },
  ],
  panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' },
    { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1' },
  ],
}

/**
 * The launchers in a bin folder with the board's own `board` (the install's shims, this copy's
 * cli.ts) and a stand-in claude; herdr is the compiled fake. No node anywhere on PATH.
 */
async function launcherBox(claude: { name: string; body: string }, path: string[]) {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: SNAPSHOT } } })
  const bin = binOf(box)
  mkdirSync(bin, { recursive: true })
  const shims = planShims({ bun: process.execPath, ...boardFiles(root), binDir: bin })
  writeFileSync(join(bin, 'board'), shims.board, { mode: 0o755 })
  writeFileSync(join(bin, 'board.cmd'), shims['board.cmd'])
  for (const [name, body] of Object.entries(launcherFiles())) writeFileSync(join(bin, name), body, { mode: 0o755 })
  writeFileSync(join(bin, claude.name), claude.body, { mode: 0o755 })
  const cwd = join(box.dir, 'Work 50%')
  mkdirSync(cwd)
  const env = { ...box.env, PATH: [bin, dirname(process.execPath), ...path].join(delimiter), HERDR_PANE_ID: 'w1:p3' }
  return { box, bin, cwd, env }
}

const isWindows = process.platform === 'win32'
test.skipIf(!isWindows)('claude-tg.cmd: the key in TG_KEY, the arguments and the exit code passed on', async () => {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const comspec = process.env.ComSpec || join(system, 'cmd.exe')
  const { box, cwd, env } = await launcherBox(
    { name: 'claude.cmd', body: '@echo key=[%TG_KEY%] args=[%*]\r\n@exit /b 7\r\n' },
    [system],
  )
  const run = (extra: Record<string, string>) =>
    spawnSync(comspec, ['/d', '/c', 'claude-tg.cmd', '--resume', 'abc'], {
      env: { ...env, ComSpec: comspec, ...extra },
      cwd,
      encoding: 'utf8',
    })
  const r = run({})
  expect([r.stdout.trim(), r.status]).toEqual(['key=[topic:Billing / hotfix] args=[--resume abc]', 7])
  // Outside herdr: the folder.
  const outside = run({ HERDR_PANE_ID: '' })
  expect([outside.stdout.trim(), outside.status]).toEqual([`key=[${cwd}] args=[--resume abc]`, 7])
  // One snapshot, for the run in herdr.
  expect(box.calls()).toEqual([['api', 'snapshot']])
})

const sh = Bun.which('sh')
test.skipIf(!sh)('claude-tg (sh): the key in TG_KEY, then claude in its place with the arguments', async () => {
  const shell = sh as string
  const { bin, cwd, env } = await launcherBox(
    { name: 'claude', body: '#!/bin/sh\necho "key=[$TG_KEY] args=[$*]"\nexit 7\n' },
    [dirname(shell)],
  )
  const r = spawnSync(shell, [join(bin, 'claude-tg').replace(/\\/g, '/'), '--resume', 'a b'], {
    env,
    cwd,
    encoding: 'utf8',
  })
  expect([r.stdout.trim(), r.status]).toEqual(['key=[topic:Billing / hotfix] args=[--resume a b]', 7])
})
