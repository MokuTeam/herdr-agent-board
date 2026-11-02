import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promptOf } from '../../src/core/schedule-rules.ts'
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

// An archived session's entries wait in its record (services/archive.ts holdEntries), not in the
// schedule folder: `board schedule` lists them, `board unschedule` removes them, `board schedule
// --move <id>` moves one to a session on the board (#279).
const ARCHIVED = '0f8fad5b-d9cb-469f-a165-70867728950e'
const archiveDirOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/archive')
const heldIn = (box: Sandbox, file: string): string[] =>
  (JSON.parse(readFileSync(join(archiveDirOf(box), file), 'utf8')).held as { id: string }[]).map(e => e.id)

/** A record in the archive as `board archive` leaves it, its entries held (no scheduler bookkeeping). */
function archived(box: Sandbox, key: string, name: string, held: Record<string, unknown>[]): void {
  mkdirSync(archiveDirOf(box), { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(archiveDirOf(box), `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`),
    JSON.stringify({
      key,
      session: key.startsWith('pane-') ? '' : key,
      name,
      autoName: '',
      category: 'personal',
      cwd: join(box.dir, 'probe'),
      workspace: 'Personal',
      workspaceId: 'wP',
      pane: 'wP:p1',
      tab: 'wP:t1',
      note: '',
      title: '',
      sleeping: false,
      activity: 0,
      archivedAt: now - 3 * 86_400_000,
      by: 'agent',
      state: 'archived',
      closeAt: now - 3 * 86_400_000,
      closedAt: now - 3 * 86_400_000,
      profile: 'default',
      held: held.map(e => ({ key, name, pane: 'wP:p1', cwd: join(box.dir, 'probe'), by: 'agent', ...e })),
    }),
  )
}

test('board schedule / unschedule reach an archived session’s parked entries; schedule --move moves one (#279)', async () => {
  const box = await sandbox()
  config(box)
  // On the board: Target in p2. In the archive: "Проба 100% card" (its pane closed), and a session known by its pane only.
  const snapshot = {
    panes: [
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
  const now = Date.now()
  const name = 'Проба 100% card'
  archived(box, ARCHIVED, name, [
    { id: 'abc123', text: 'check the CI', at: now - 2 * 3600e3, next: now - 2 * 3600e3, created: now - 86_400_000 },
    // Its next run went by while it was archived: shown, and moved, from the next one after now.
    {
      id: 'def456',
      text: 'look at the overnight alerts',
      cron: '0 9 * * *',
      next: now - 3 * 86_400_000,
      created: now - 9 * 86_400_000,
      movedFrom: { key: 'before-clear', name: 'Before' },
      gone: 2,
    },
    { id: '0a0b0c', text: 'send the report', at: now + 86_400_000, next: now + 86_400_000, idle: true },
  ])
  archived(box, 'pane-7', 'Shell one', [{ id: 'aaa111', text: 'in the shell', at: now + 3600e3, next: now + 3600e3 }])
  const own = await agentCli(box, ['remind', '--session', 'Target', 'in', '1h', 'own thing'])
  assert.equal(own.code, 0, own.out)
  const ownId = idIn(own.out, 'reminder')

  // A session on the board: its own entries, as before, none of the archive's.
  const target = await agentCli(box, ['schedule', '--session', 'Target'])
  assert.equal(target.code, 0, target.out)
  assert.match(target.out, new RegExp(`^${ownId} · .+ \\(in 1 h\\) · once · on time · own thing$`))

  // The archived one, by its name in another case, by its id, and one with a pane-<id> key by it.
  for (const by of ['проба 100% CARD', ARCHIVED]) {
    const list = await agentCli(box, ['schedule', '--session', by])
    assert.equal(list.code, 0, list.out)
    const lines = list.out.split('\n')
    assert.equal(lines.length, 4, list.out)
    assert.match(lines[0] ?? '', /^abc123 · .+ \(2 h ago\) · once · on time · parked in the archive · check the CI$/)
    assert.match(
      lines[1] ?? '',
      /^def456 · .+ \(in [^)]+\) · every "0 9 \* \* \*" · on time · parked in the archive · look at the overnight alerts$/,
    )
    assert.match(
      lines[2] ?? '',
      /^0a0b0c · .+ \(in 1 d\) · once · when free · parked in the archive · send the report$/,
    )
    assert.match(lines[3] ?? '', /^parked entries come back with their session; board schedule --move <id> moves one/)
  }
  assert.match((await agentCli(box, ['schedule', '--session', 'pane-7'])).out, /^aaa111 · .+ · in the shell$/m)
  assert.match(
    (await agentCli(box, ['schedule', '--session', 'nobody'])).out,
    /no session "nobody" on the board or in its archive/,
  )
  // Every session's: the schedule's, then the parked ones with their session's name.
  const all = (await agentCli(box, ['schedule', '--all'])).out.split('\n')
  assert.equal(all.length, 6, all.join('\n'))
  assert.match(all[0] ?? '', new RegExp(`^${ownId} · .+ · Target · own thing$`))
  assert.equal(all.filter(l => l.includes(`· ${name} · parked in the archive ·`)).length, 3)
  assert.equal(all.filter(l => l.includes('· Shell one · parked in the archive ·')).length, 1)

  // Removed by its id, from its record.
  const gone = await agentCli(box, ['unschedule', 'abc123'])
  assert.equal(gone.code, 0, gone.out)
  assert.match(gone.out, new RegExp(`^ok · removed abc123 \\(.+, ${name}, parked in the archive\\): check the CI$`))
  assert.deepEqual(heldIn(box, `${ARCHIVED}.json`), ['def456', '0a0b0c'])
  assert.match((await agentCli(box, ['unschedule', 'abc123'])).out, /no entry "abc123"/)

  // An id alone moves nothing: the cron prompt's tag reads `board schedule <id>`, and it lists as before.
  const look = await agentCli(box, ['schedule', 'def456', '--session', 'Target'])
  assert.equal(look.out, target.out)
  assert.deepEqual(heldIn(box, `${ARCHIVED}.json`), ['def456', '0a0b0c'])
  assert.match(
    (await agentCli(box, ['schedule', '--move', '--session', 'Target'])).out,
    /usage: board schedule --move <id>/,
  )
  // Moved to a session on the board: into the schedule under its id, from its next run, set by the archived one.
  const moved = await agentCli(box, ['schedule', '--move', 'def456', '--session', 'Target'])
  assert.equal(moved.code, 0, moved.out)
  assert.match(
    moved.out,
    /^ok · moved def456 to Target: every "0 9 \* \* \*", next .+ \(in [^)]+\): look at the overnight alerts · cancel: board unschedule def456/,
  )
  const e = read(box, 'def456')
  assert.ok(e)
  assert.deepEqual(
    [e.key, e.name, e.pane, e.cwd, e.from, e.movedFrom, e.gone, e.cron, e.text],
    [
      's2',
      'Target',
      'p2',
      box.dir,
      { key: ARCHIVED, name },
      undefined,
      undefined,
      '0 9 * * *',
      'look at the overnight alerts',
    ],
  )
  assert.ok(e.next > now && e.next <= now + 86_400_000 + 60_000)
  // Target is told whose it was; not that it was set before /clear.
  assert.equal(
    promptOf({ id: 'def456', key: 's2', ...e }, e.next),
    `[board schedule def456 from ${name}: 0 9 * * *] look at the overnight alerts`,
  )
  assert.deepEqual(heldIn(box, `${ARCHIVED}.json`), ['0a0b0c'])
  // Not to a session in the archive, and not one that is in the schedule already.
  assert.match(
    (await agentCli(box, ['schedule', '--move', '0a0b0c', '--session', ARCHIVED])).out,
    /is in the archive too; move the entry to a session on the board/,
  )
  assert.match(
    (await agentCli(box, ['schedule', '--move', ownId, '--session', 'Target'])).out,
    new RegExp(`no entry "${ownId}" is parked in the archive`),
  )
  assert.deepEqual(heldIn(box, `${ARCHIVED}.json`), ['0a0b0c'])

  // All of the archived session's: the record stays, without them.
  assert.match((await agentCli(box, ['unschedule', 'all', '--session', name])).out, /^ok · removed 1 entry$/)
  assert.deepEqual(heldIn(box, `${ARCHIVED}.json`), [])
  assert.equal(JSON.parse(readFileSync(join(archiveDirOf(box), `${ARCHIVED}.json`), 'utf8')).state, 'archived')
  assert.equal((await agentCli(box, ['schedule', '--session', ARCHIVED])).out, 'nothing scheduled for this session')
  // Target's own and the moved one, as before.
  assert.match((await agentCli(box, ['unschedule', 'all', '--session', 'Target'])).out, /^ok · removed 2 entries$/)
  assert.deepEqual(heldIn(box, 'pane-7.json'), ['aaa111'])
})

test('board schedule and unschedule all for a session never archived: as before, and no archive folder', async () => {
  const box = await sandbox()
  const s = ['--session', '11111111-2222-3333-4444-555555555555']
  assert.equal((await cli(box, ['schedule', ...s])).out, 'nothing scheduled for this session')
  assert.equal((await cli(box, ['schedule', '--all'])).out, 'nothing scheduled')
  assert.equal((await cli(box, ['unschedule', ...s, 'all'])).out, 'ok · removed 0 entries')
  assert.match((await cli(box, ['unschedule', 'abc123'])).out, /no entry "abc123"; see board schedule/)
  assert.equal(existsSync(archiveDirOf(box)), false)
})

test('board favorite keeps the session in sight; off takes it back (#64)', async () => {
  const box = await sandbox()
  const key = '11111111-2222-3333-4444-555555555555'
  const s = ['--session', key]
  const card = () =>
    JSON.parse(
      readFileSync(join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/cards', `${key}.json`), 'utf8'),
    )
  const on = await cli(box, ['favorite', ...s])
  assert.equal(on.code, 0, on.out)
  assert.match(on.out, /^ok · .* · favorite$/)
  assert.equal(card().favorite, true)
  const off = await cli(box, ['favorite', ...s, 'off'])
  assert.equal(off.code, 0, off.out)
  assert.doesNotMatch(off.out, /favorite/)
  assert.equal(card().favorite, undefined)
  assert.match((await cli(box, ['favorite', ...s, 'maybe'])).out, /usage: board favorite \[off\]/)
  assert.equal(card().favorite, undefined)
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

// `board call-report`: MokuPilot hands a call's results back to the session it was a fork of.
const SID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'

test('board call-report queues the results for the session: now, once it is free, of kind call', async () => {
  const box = await sandbox()
  const file = join(box.dir, 'report.md')
  const report =
    '# Release 2.4 call · Oct 17 · 32 min\n\n- Decided: ship on Monday\n\nFull protocol: /tmp/meeting_1.summary.md'
  writeFileSync(file, `\uFEFF${report.replace(/\n/g, '\r\n')}\r\n`)
  // The board knows the session: its name, pane and folder go into the entry.
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'p7',
              agent: 'claude',
              agent_session: { value: SID },
              agent_status: 'idle',
              cwd: box.dir,
              terminal_title_stripped: 'Release',
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const before = Date.now()
  config(box)
  // Run as MokuPilot runs it: outside any pane, herdr answered by the fake.
  const r = await agentCli(box, ['call-report', '--session', SID, '--file', file])
  assert.equal(r.code, 0, r.out)
  assert.match(
    r.out,
    /^ok · call report ([0-9a-f]{6}) for Release, typed in once the session is free · cancel: board unschedule \1/,
  )
  const e = read(box, /call report ([0-9a-f]{6})/.exec(r.out)?.[1] ?? '')
  assert.ok(e)
  assert.deepEqual(
    [e.key, e.kind, e.idle, e.by, e.pane, e.cwd, e.name, e.text],
    [SID, 'call', true, 'mokupilot', 'p7', box.dir, 'Release', report],
  )
  assert.ok(e.next >= before && e.next <= Date.now())

  // Without herdr (or the session gone from it) the entry is still kept, by the session's id.
  const lone = await sandbox()
  const f2 = join(lone.dir, 'r.md')
  writeFileSync(f2, 'x'.repeat(20_000))
  const long = await cli(lone, ['call-report', '--session', SID, '--file', f2])
  assert.equal(long.code, 0, long.out)
  const cut = read(lone, /call report ([0-9a-f]{6})/.exec(long.out)?.[1] ?? '')
  assert.ok(cut)
  assert.equal(cut.key, SID)
  assert.ok(cut.text.length <= 16_000)
  assert.ok(cut.text.endsWith(`[the report goes on; all of it: ${f2}]`))
})

test('board call-report refuses a bad session id and a missing or empty report', async () => {
  const box = await sandbox()
  const empty = join(box.dir, 'empty.md')
  writeFileSync(empty, ' \n')
  const fails: [string[], RegExp][] = [
    [['call-report', '--file', empty], /usage: board call-report --session/],
    [['call-report', '--session', 'Release', '--file', empty], /UUID/],
    [['call-report', '--session', SID], /usage: board call-report/],
    [['call-report', '--session', SID, '--file', join(box.dir, 'none.md')], /cannot read the report .*ENOENT/],
    [['call-report', '--session', SID, '--file', empty], /is empty/],
  ]
  for (const [args, re] of fails) {
    const r = await cli(box, args)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, re)
  }
  assert.equal(existsSync(dirOf(box)) ? readdirSync(dirOf(box)).filter(n => n.endsWith('.json')).length : 0, 0)
})

/** A profile folder in the sandbox's home whose registry has `name` running as `session` (with `extra` fields). */
function profileWith(
  box: Sandbox,
  folder: string,
  session: string,
  name: string,
  extra: Record<string, unknown> = {},
): string {
  const dir = join(box.env.HOME as string, folder)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{}')
  writeFileSync(
    join(dir, 'sessions', '1.json'),
    JSON.stringify({ sessionId: session, kind: 'interactive', pid: process.pid, name, ...extra }),
  )
  return dir
}

test('board remind in a work session names it from the work registry', async () => {
  const box = await sandbox()
  config(box)
  const work = profileWith(box, '.claude-work', 's1', 'Work one')
  // The default profile has a session of that id too: never what a work session is named after.
  profileWith(box, '.claude', 's1', 'Private one')
  const r = await agentCli(box, ['remind', 'in', '1h', 'check the invoices'], {
    CLAUDE_CODE_SESSION_ID: 's1',
    CLAUDE_CONFIG_DIR: work,
  })
  assert.equal(r.code, 0, r.out)
  assert.match(
    r.out,
    /^ok · reminder ([0-9a-f]{6}) (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{4}-\d\d-\d\d \d\d:\d\d \(in 1 h\): check the invoices · cancel: board unschedule \1 · note: no board with the scheduler is running now; this goes out once one runs \(late, with a note\)$/,
  )
  const e = read(box, idIn(r.out, 'reminder'))
  assert.ok(e)
  assert.deepEqual([e.key, e.name, e.text], ['s1', 'Work one', 'check the invoices'])
})

test('board call-report names the session from whichever profile it runs in, a hidden one too', async () => {
  const box = await sandbox()
  config(box)
  // ~/.claude-work is found but not shown: its registry is read all the same.
  profileWith(box, '.claude-work', SID, 'Work one')
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  const file = join(box.dir, 'report.md')
  writeFileSync(file, '# Call\n\n- Decided: ship')
  const r = await agentCli(box, ['call-report', '--session', SID, '--file', file])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ok · call report ([0-9a-f]{6}) for Work one, typed in once the session is free/)
  assert.equal(read(box, /call report ([0-9a-f]{6})/.exec(r.out)?.[1] ?? '')?.name, 'Work one')
})

test('board remind for a session in another profile takes its folder and name from that profile’s registry', async () => {
  const box = await sandbox()
  config(box)
  // The board command runs with the default env; the sessions run in ~/.claude-work (hidden).
  const project = join(box.dir, 'invoices')
  const work = profileWith(box, '.claude-work', SID, 'Work one', { cwd: project })
  const target = await agentCli(box, ['remind', '--session', SID, 'in', '1h', 'check the invoices'])
  assert.equal(target.code, 0, target.out)
  const e = read(box, idIn(target.out, 'reminder'))
  assert.ok(e)
  assert.deepEqual([e.key, e.cwd], [SID, project])
  // Its own session, when it runs in another profile than this env's: named from that registry too.
  writeFileSync(
    join(work, 'sessions', '2.json'),
    JSON.stringify({ sessionId: 's2', kind: 'interactive', pid: process.pid, name: 'Work two' }),
  )
  const own = await agentCli(box, ['remind', 'in', '1h', 'own'], { CLAUDE_CODE_SESSION_ID: 's2' })
  assert.equal(own.code, 0, own.out)
  assert.equal(read(box, idIn(own.out, 'reminder'))?.name, 'Work two')
})
