import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeShell } from '../../src/adapters/watch-probe.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(60_000)

// `board wait --probe` (#486) as an agent runs it, the probe run once in the real shell (Git Bash
// on Windows, /bin/sh elsewhere). The scheduler's side: test/services/watches.e2e.test.ts.
const shell = probeShell()
if ('error' in shell) throw new Error(shell.error)
const SHELL_ENV: Record<string, string> = process.platform === 'win32' ? { CLAUDE_CODE_GIT_BASH_PATH: shell.file } : {}
const SID = '11111111-2222-3333-4444-555555555555'
// The agent's own pane: the board finds the session, and its folder, by it.
const s: string[] = []

const watchesDir = (box: Sandbox) => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule/watches')
const watches = (box: Sandbox): Record<string, unknown>[] =>
  existsSync(watchesDir(box))
    ? readdirSync(watchesDir(box)).map(n => JSON.parse(readFileSync(join(watchesDir(box), n), 'utf8')))
    : []
const card = (box: Sandbox): Record<string, unknown> => {
  const f = join(box.cards, `${SID}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
}

/** The sandbox's board config; port 9 answers nothing, so the CLI never reaches the live board. */
function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

/** herdr with the session in pane p1, its folder with a space, Cyrillic and `%` (the probe runs there). */
function onBoard(box: Sandbox): string {
  const cwd = join(box.dir, 'Проект x 50%')
  mkdirSync(cwd, { recursive: true })
  const pane = { pane_id: 'p1', agent: 'claude', agent_session: { value: SID }, agent_status: 'idle', cwd }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
    'pane get': { result: { pane } },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID } } } },
  })
  return cwd
}

function cli(box: Sandbox, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/entrypoints/cli.ts'), ...args], {
      cwd: root,
      env: { ...box.env, ...SHELL_ENV, HERDR_ENV: '1', HERDR_PANE_ID: 'p1' },
    })
    let out = ''
    proc.stdout.on('data', c => {
      out += c
    })
    proc.stderr.on('data', c => {
      out += c
    })
    proc.on('close', code => resolve({ code, out: out.trim() }))
  })
}

test('board wait --probe: tried once, a watch on exit 1, nothing on exit 0 or an error; listed, replaced, ended', async () => {
  const box = await sandbox()
  config(box, { watches: true })
  const cwd = onBoard(box)
  writeFileSync(join(cwd, 'state'), '1')
  const set = await cli(box, ['wait', ...s, 'CI on PR 12', '--probe', 'exit "$(cat state)"', '--every', '5m'])
  assert.equal(set.code, 0, set.out)
  const id = /watch ([0-9a-f]{6})/.exec(set.out)?.[1]
  assert.ok(id, set.out)
  assert.match(
    set.out,
    /nothing yet \(exit 1\)\. The board checks every 5 min in .+Проект x 50%, first within a minute/,
  )
  assert.deepEqual(
    watches(box).map(w => [w.id, w.kind, w.text, w.probe]),
    [[id, 'watch', 'CI on PR 12', { cmd: 'exit "$(cat state)"', everyMs: 300_000, timeoutMs: 20_000 }]],
  )
  const first = watches(box)[0] as { next: number; created: number }
  assert.ok(first.next - first.created <= 45_000)
  assert.equal(card(box).wait, 'CI on PR 12')

  const list = await cli(box, ['schedule', ...s])
  assert.match(
    list.out,
    new RegExp(
      `^${id} · watch every 5 min · first check in 1 min · probe: exit "\\$\\(cat state\\)" · waits for: CI on PR 12$`,
    ),
  )

  // Already true: nothing set, the card as it was.
  const done = await cli(box, ['wait', ...s, 'other', '--probe', 'echo "build 7 green"; exit 0'])
  assert.match(done.out, /already true: the probe exited 0 and printed "build 7 green"; no watch set/)
  assert.equal(card(box).wait, 'CI on PR 12')
  // A broken command: refused, nothing written.
  const broken = await cli(box, ['wait', ...s, 'other', '--probe', 'echo nope >&2; exit 7'])
  assert.notEqual(broken.code, 0)
  assert.match(broken.out, /the probe failed when tried once \(exit 7: nope\); no watch set, the card unchanged/)
  assert.match(
    (await cli(box, ['wait', ...s, 'x', '--probe', 'exit 1', '--every', '20s'])).out,
    /--every is below 1 min/,
  )
  assert.deepEqual(
    watches(box).map(w => w.id),
    [id],
  )

  // A new wait with a probe replaces it; doing ends the new one.
  const again = await cli(box, ['wait', ...s, 'CI on PR 13', '--probe', 'exit 1'])
  assert.match(again.out, new RegExp(`\\(watch ${id} ended\\)`))
  const second = watches(box)[0]?.id as string
  assert.notEqual(second, id)
  const doing = await cli(box, ['doing', ...s, 'back at it'])
  assert.match(doing.out, new RegExp(`watch ${second} ended$`))
  assert.deepEqual(watches(box), [])

  // board unschedule <id> removes one; a plain wait ends one too.
  const third = /watch ([0-9a-f]{6})/.exec((await cli(box, ['wait', ...s, 'w', '--probe', 'exit 1'])).out)?.[1]
  assert.match((await cli(box, ['unschedule', third ?? ''])).out, new RegExp(`removed watch ${third}`))
  await cli(box, ['wait', ...s, 'w2', '--probe', 'exit 1'])
  assert.match((await cli(box, ['wait', ...s, 'just waiting'])).out, /watch [0-9a-f]{6} ended$/)
  assert.deepEqual(watches(box), [])
})

test('watches off: --probe is words of the wait text, as before, with a note; the help names the flags only while on', async () => {
  const box = await sandbox()
  config(box)
  onBoard(box)
  const r = await cli(box, ['wait', ...s, 'CI', '--probe', 'exit 1'])
  assert.equal(r.code, 0, r.out)
  assert.equal(card(box).wait, 'CI --probe exit 1')
  assert.match(
    r.out,
    /note: watches are off in config\.json, so --probe is part of the wait text and nothing will check it$/,
  )
  assert.deepEqual(watches(box), [])
  // A plain wait says what it said on main.
  assert.doesNotMatch((await cli(box, ['wait', ...s, 'CI'])).out, /watches|probe/)
  assert.equal((await cli(box, ['wait', '--help'])).out, 'usage: board wait <text>')
  config(box, { watches: true })
  assert.match(
    (await cli(box, ['wait', '--help'])).out,
    /usage: board wait <text> \[--probe "<command>" \[--every 10m\] \[--timeout 20s\] \[--silence 3d\]\]/,
  )
})
