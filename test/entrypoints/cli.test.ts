import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(15_000)

// The board command's side of the schedule (the scheduler itself: test/services/scheduler.test.ts;
// the web board's: test/server/schedule-routes.test.ts; the hook's: test/entrypoints/hook.test.ts).
// Child processes run against a fake herdr: entries are files in the sandbox's
// schedule folder, the session's prompt is a logged `herdr agent prompt` call.
const dirOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')

type Stored = Record<string, unknown> & { text: string; next: number; idle?: boolean; cron?: string }
const read = (box: Sandbox, id: string): Stored | null =>
  existsSync(join(dirOf(box), `${id}.json`)) ? JSON.parse(readFileSync(join(dirOf(box), `${id}.json`), 'utf8')) : null

/** The id an "ok · reminder <id> …" / "ok · every <id> …" answer names. */
function idIn(out: string, kind: 'reminder' | 'every'): string {
  const id = new RegExp(`${kind} ([0-9a-f]{6})`).exec(out)?.[1]
  assert.ok(id, out)
  return id
}

/** The sandbox's board config; port 9 answers nothing, so the CLI never reaches the live board. */
function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

/** The board command in an agent's session (its env), with herdr answered by the fake. */
async function agentCli(box: Sandbox, args: string[], env: Record<string, string> = {}) {
  const out = await box.run('cli', { args, env }).exited
  return { code: out.code, out: `${out.stdout}${out.stderr}`.trim() }
}

function cli(box: Sandbox, args: string[]): Promise<{ code: number | null; out: string }> {
  if (!existsSync(join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json'))) config(box)
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/entrypoints/cli.ts'), ...args], { cwd: root, env: box.env })
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

test('board remind / every / schedule / unschedule keep entries for the session', async () => {
  const box = await sandbox()
  const s = ['--session', '11111111-2222-3333-4444-555555555555']
  const one = await cli(box, ['remind', ...s, 'in', '30m', 'check the CI run'])
  assert.equal(one.code, 0, one.out)
  const id = idIn(one.out, 'reminder')
  const entry = read(box, id)
  assert.ok(entry)
  assert.equal(entry.text, 'check the CI run')
  assert.ok(Math.abs(entry.next - (Date.now() + 30 * 60e3)) < 10_000)
  assert.equal(entry.idle, undefined) // on time unless asked otherwise
  const free = await cli(box, ['remind', ...s, '--idle', 'in', '1h', 'when free'])
  assert.match(free.out, /when the session is free/)
  assert.equal(read(box, idIn(free.out, 'reminder'))?.idle, true)
  assert.equal((await cli(box, ['unschedule', idIn(free.out, 'reminder')])).code, 0)
  const every = await cli(box, ['every', ...s, '0 9 * * 1-5', 'check the inbox'])
  assert.equal(every.code, 0, every.out)
  assert.equal(read(box, idIn(every.out, 'every'))?.cron, '0 9 * * 1-5')
  // PowerShell passes the five fields unquoted.
  assert.equal((await cli(box, ['every', ...s, '0', '9', '*', '*', 'mon', 'weekly'])).code, 0)
  assert.match((await cli(box, ['remind', ...s, 'today', '0:00', 'past'])).out, /in the past/)
  assert.match((await cli(box, ['remind', ...s, 'soon', 'text'])).out, /usage/)
  assert.match((await cli(box, ['every', ...s, '0 0 30 2 *', 'never'])).out, /never runs/)
  assert.match((await cli(box, ['every', ...s, '*/2 * * * *', 'too often'])).out, /more often than every 5 minutes/)
  assert.match((await cli(box, ['remind', ...s, 'in', '99999999999d', 'never'])).out, /usage/)
  assert.match((await cli(box, ['remind', ...s, 'in', '3000d', 'far'])).out, /five years/)
  assert.match((await cli(box, ['every', ...s, '* * *', 'bad'])).out, /5 fields/)
  const list = await cli(box, ['schedule', ...s])
  assert.equal(list.out.split('\n').length, 3)
  assert.match(list.out, /every "0 9 \* \* 1-5"/)
  assert.match((await cli(box, ['unschedule', ...s])).out, /usage/)
  assert.match((await cli(box, ['unschedule', id])).out, new RegExp(`removed ${id}`))
  assert.equal(read(box, id), null)
  assert.match((await cli(box, ['unschedule', ...s, 'all'])).out, /removed 2 entries/)
  assert.deepEqual(
    readdirSync(dirOf(box)).filter(n => n.endsWith('.json')),
    [],
  )
})

test('board remind records who set it, the pane and the pane folder, and no control characters', async () => {
  const box = await sandbox()
  config(box)
  const project = join(box.dir, 'project')
  const snapshot = {
    panes: [
      {
        pane_id: 'p1',
        agent: 'claude',
        agent_session: { value: 's1' },
        agent_status: 'working',
        cwd: project,
        terminal_title_stripped: 'Setter',
      },
      {
        pane_id: 'p2',
        agent: 'claude',
        agent_session: { value: 's2' },
        agent_status: 'idle',
        cwd: box.dir,
        terminal_title_stripped: 'Target',
      },
    ],
    tabs: [],
    workspaces: [],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
  // Its own: the folder is the pane's, not the shell's (the runner's cwd is the repo).
  const own = await agentCli(box, ['remind', 'in', '1h', 'own'], { CLAUDE_CODE_SESSION_ID: 's1', HERDR_PANE_ID: 'p1' })
  assert.equal(own.code, 0, own.out)
  const mine = read(box, idIn(own.out, 'reminder'))
  assert.ok(mine)
  assert.equal(mine.pane, 'p1')
  assert.equal(mine.cwd, project)
  assert.equal(mine.from, undefined)
  // For another session: who set it, and the text without control characters.
  const other = await agentCli(box, ['remind', '--session', 'Target', 'in', '1h', 'look\x07 at\x1b[31m this\x7f'], {
    CLAUDE_CODE_SESSION_ID: 's1',
    HERDR_PANE_ID: 'p1',
  })
  assert.equal(other.code, 0, other.out)
  const theirs = read(box, idIn(other.out, 'reminder'))
  assert.ok(theirs)
  assert.equal(theirs.key, 's2')
  assert.equal(theirs.cwd, box.dir)
  assert.deepEqual(theirs.from, { key: 's1', name: 'Setter' })
  assert.equal(theirs.text, 'look at[31m this')
  // No board answers on the sandbox's port: the agent is told it goes out once one runs.
  assert.match(own.out, /no board with the scheduler is running/)
})

test('board remind says nothing about the board when one with the scheduler answers', async () => {
  const box = await sandbox()
  const board = http.createServer((_req, res) => res.end(JSON.stringify({ items: [], schedules: [] })))
  await new Promise<void>(resolve => board.listen(0, '127.0.0.1', resolve))
  try {
    config(box, { port: (board.address() as AddressInfo).port })
    const out = await agentCli(box, ['remind', '--session', '11111111-2222-3333-4444-555555555555', 'in', '1h', 'x'])
    assert.equal(out.code, 0, out.out)
    assert.doesNotMatch(out.out, /no board/)
  } finally {
    await new Promise(resolve => board.close(resolve))
  }
})
