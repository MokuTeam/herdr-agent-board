// `board thread …` (#379, entrypoints/thread-cli.ts) as an agent runs it, in this process: the
// board's database and schedule in a temp state folder, no board running. Each write prints one
// line; the watchers' events are schedule entries (services/work-threads.ts), which the scheduler
// test against the fake herdr sends (test/services/thread-events.test.ts).
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../src/adapters/db.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import { listEntries, removeEntry } from '../../src/adapters/schedule-store.ts'
import { promptOf, type ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const master: Party = { kind: 'session', key: '11111111-1111-4111-8111-111111111111', name: 'master' }
const mapper: Party = { kind: 'session', key: 'pane-wP:p2', name: 'atlas-mapper' }
const sessions: Record<string, Party> = { master, 'atlas-mapper': mapper }

function setUp(o: { threads?: unknown } = { threads: true }) {
  const dir = isolatedHome()
  const asks: { key: string; q: string }[] = []
  const run = async (actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await threadCmd(args, {
      cfg: { ...('threads' in o && { threads: o.threads }), port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async w => sessions[w] ?? null,
      setAsk: q => asks.push({ key: actor.kind === 'session' ? actor.key : 'owner', q }),
      out: l => out.push(l),
      err: l => err.push(l),
      now: NOW,
      ...over,
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const json = async (actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) =>
    JSON.parse((await run(actor, [...args, '--json'], over)).out)
  return { dir, run, json, asks }
}

const events = (key: string): ScheduleEntry[] => listEntries().filter(e => e.key === key && e.by === 'threads')
/** The scheduler sent it: its entry goes. */
const deliver = (key: string): void => {
  for (const e of events(key)) removeEntry(e.id)
}

test('threads off: every command says so and fails; link --base answers, saying they are off', async () => {
  const { run, json } = setUp({})
  const r = await run(master, ['new', 'Import mapping'])
  assert.equal(r.code, 1)
  assert.equal(r.err, 'threads are off')
  assert.deepEqual(await json(master, ['list']), { ok: false, error: 'off', message: 'threads are off' })
  assert.deepEqual(await run(master, ['link', '--base']), {
    code: 0,
    out: 'http://127.0.0.1:12422/ · threads off',
    err: '',
  })
  assert.deepEqual(await json(master, ['link', '--base']), {
    ok: true,
    url: 'http://127.0.0.1:12422/',
    threads: false,
    agents: false,
  })
  // Nothing was made: no database, no schedule.
  assert.equal(existsSync(join(stateDir(), 'board.db')), false)
  assert.equal(existsSync(join(stateDir(), 'schedule')), false)
})

test("the worked example (3.7): the master hears one line of the worker's result, the report stays on the board", async () => {
  const { dir, run } = setUp()
  assert.deepEqual(await run(master, ['new', '--lane', 'atlas', 'Import mapping for the order feed']), {
    code: 0,
    out: 'ok · atlas-1 · next',
    err: '',
  })
  assert.equal(
    (await run(master, ['new', '--parent', 'atlas-1', '--to', 'atlas-mapper', 'Map the 2019 price columns'])).out,
    'ok · atlas-2 · doing · atlas-mapper',
  )
  // Nothing for anyone yet: the master's own changes are not news to it, the assignee hears answers only.
  assert.deepEqual(listEntries(), [])
  const report = join(dir, 'out', 'mapping-report.md')
  mkdirSync(join(dir, 'out'))
  writeFileSync(report, `# Mapping\n${'row ok\n'.repeat(1200)}`)
  const posted = await run(mapper, [
    'post',
    'atlas-2',
    '--status',
    'done',
    '--summary',
    '217 rows mapped, 3 flagged in the report',
    '--file',
    report,
  ])
  assert.equal(posted.out, 'ok · atlas-2 · done · 1 file')
  const [event, ...more] = listEntries()
  assert.deepEqual(more, [])
  assert.ok(event)
  assert.equal(event.key, master.kind === 'session' ? master.key : '')
  assert.equal(event.by, 'threads')
  assert.deepEqual(event.from, { key: 'threads', name: 'threads' })
  assert.equal(event.noWake, true)
  assert.equal(event.next, NOW)
  assert.equal(
    promptOf(event, NOW),
    '[board reminder from threads] atlas-2 done: 217 rows mapped, 3 flagged in the report. More: board thread changes',
  )
  // The report went to the board's state folder, not into anyone's context.
  const shown = (await run(master, ['show', 'atlas-2'])).out
  const path = shown.match(/file mapping-report\.md \(\d+ KB\) (\S+)/)?.[1]
  assert.ok(path, shown)
  assert.ok(path.startsWith(join(stateDir(), 'thread-files')))
  assert.equal(readFileSync(path, 'utf8'), readFileSync(report, 'utf8'))
  // The parent says its last sub-thread closed; the master reads it with changes.
  const changes = (await run(master, ['changes'])).out.split('\n')
  assert.deepEqual(changes, [
    'atlas-2 · done · atlas-mapper · Map the 2019 price columns · 217 rows mapped, 3 flagged in the report · +1',
    'atlas-1 · next · Import mapping for the order feed · +1',
  ])
  // Read: the pending event says nothing more, and goes.
  assert.deepEqual(events(master.kind === 'session' ? master.key : ''), [])
})

test('a session never hears of its own change; a watcher hears of the others, once', async () => {
  const { run } = setUp()
  await run(master, ['new', 'Map the 2019 price columns'])
  await run(mapper, ['watch', 'atlas-1', '--what', 'all'])
  await run(mapper, ['post', 'atlas-1', 'started on the price columns'])
  assert.deepEqual(events(mapper.kind === 'session' ? mapper.key : ''), [])
  assert.deepEqual(listEntries(), [], 'a plain note is not a status change: the master hears nothing')
  await run(master, ['post', 'atlas-1', 'the 2019 sheet is in the shared folder'])
  const [e] = events(mapper.kind === 'session' ? mapper.key : '')
  assert.equal(e?.text, 'atlas-1 +1. More: board thread changes')
})

test('ten changes before the event goes out are one line; the next one waits out the gap', async () => {
  const { run } = setUp({ threads: { events: { gapSec: 60 } } })
  const key = master.kind === 'session' ? master.key : ''
  for (let i = 1; i <= 10; i++) await run(master, ['new', `Part ${i}`])
  for (let i = 1; i <= 10; i++)
    await run(mapper, ['post', `atlas-${i}`, '--status', 'done', '--summary', `part ${i} done`])
  const [one, ...more] = events(key)
  assert.deepEqual(more, [])
  assert.equal(
    one?.text,
    'atlas-1 done: part 1 done · atlas-2 done: part 2 done · atlas-3 done: part 3 done · and 7 more. More: board thread changes',
  )
  assert.equal(one?.next, NOW, 'the first after a quiet spell is due at once')
  deliver(key)
  await run(mapper, ['post', 'atlas-1', '--status', 'doing', '--summary', 'reopened: two rows were off'], {
    now: NOW + 5000,
  })
  const [later] = events(key)
  assert.equal(later?.next, NOW + 60_000, 'no sooner than the gap after the last one')
  assert.equal(later?.text, 'atlas-1 doing: reopened: two rows were off. More: board thread changes')
})

test('ask: the thread waits on the owner with the question, the card asks; a session done there is only proposed', async () => {
  const { run, asks } = setUp()
  await run(master, ['new', '--to', 'atlas-mapper', 'Pick the price list'])
  assert.equal((await run(mapper, ['ask', '1', 'Which price list wins, 2019 or 2020?'])).out, 'ok · atlas-1 · owner')
  assert.deepEqual(asks, [{ key: 'pane-wP:p2', q: 'Which price list wins, 2019 or 2020?' }])
  const [e] = events(master.kind === 'session' ? master.key : '')
  assert.equal(e?.text, 'atlas-1 needs the owner: Which price list wins, 2019 or 2020?. More: board thread changes')
  assert.equal(
    (await run(mapper, ['done', 'atlas-1', 'the 2019 list, as in the contract'])).out,
    'ok · atlas-1 · owner · proposed done, the owner confirms',
  )
  assert.match(
    (await run(master, ['list'])).out,
    /^atlas-1 · owner, proposed done · atlas-mapper · Pick the price list/,
  )
})

test('keys: a bare number in the lane, an id prefix, the whole key; refusals say why', async () => {
  const { json, run } = setUp()
  const made = await json(master, ['new', 'Import mapping'])
  assert.equal(made.ok, true)
  const id: string = made.thread.id
  assert.equal((await json(master, ['show', '1'])).thread.key, 'atlas-1')
  assert.equal((await json(master, ['show', id.slice(0, 8)])).thread.key, 'atlas-1')
  assert.equal((await json(master, ['show', 'ATLAS-1'])).thread.key, 'atlas-1')
  assert.equal((await json(master, ['show', 'atlas-9'])).error, 'not_found')
  assert.equal((await json(master, ['show', '2'], { lane: null })).error, 'no_lane')
  assert.equal((await json(master, ['new', 'x'], { lane: null })).error, 'no_lane')
  assert.equal((await json(master, ['post', 'atlas-1'])).error, 'empty')
  assert.equal((await json(master, ['post', 'atlas-1', '--status', 'finished'])).error, 'usage')
  assert.equal((await json(master, ['new', 'x'.repeat(81)])).error, 'title_long')
  assert.equal((await json(master, ['post', 'atlas-1', '--summary', 'y'.repeat(161)])).error, 'summary_long')
  assert.equal((await json(master, ['share', 'atlas-1', 'ben'])).error, 'later')
  const r = await run(master, ['frobnicate'])
  assert.equal(r.code, 1)
  assert.match(r.err, /^no command "board thread frobnicate"\nboard thread new/)
})

test('sub-threads: one level, the last one closing tells the parent; a parent with no child left open says so', async () => {
  const { json, run } = setUp()
  await run(master, ['new', 'Import mapping'])
  await run(master, ['new', '--parent', 'atlas-1', 'Prices'])
  await run(master, ['new', '--parent', 'atlas-1', 'Taxes'])
  assert.equal((await json(master, ['new', '--parent', 'atlas-2', 'Deeper'])).error, 'nested')
  await run(mapper, ['done', 'atlas-2', 'prices mapped'])
  const key = master.kind === 'session' ? master.key : ''
  assert.equal(events(key)[0]?.text, 'atlas-2 done: prices mapped. More: board thread changes')
  await run(mapper, ['post', 'atlas-3', '--status', 'dropped', '--summary', 'taxes come from the ERP'])
  assert.equal(
    events(key)[0]?.text,
    'atlas-2 done: prices mapped · atlas-3 dropped: taxes come from the ERP. More: board thread changes',
  )
  const parent = await json(master, ['show', 'atlas-1'])
  assert.deepEqual(
    parent.entries.map((e: { type: string; text: string }) => [e.type, e.text]),
    [
      ['system', ''],
      ['system', 'all 2 sub-threads closed'],
    ],
  )
  assert.equal((await run(master, ['show', 'atlas-1'])).out.split('\n')[1]?.includes('1 of 2 sub-threads done'), true)
})

test('watches: --wake leaves the flag off, --idle waits for a free session, unwatch stops it', async () => {
  const { run } = setUp()
  await run(master, ['new', 'Import mapping'])
  const watcher: Party = { kind: 'session', key: 'cleo-1', name: 'cleo' }
  assert.equal(
    (await run(watcher, ['watch', '--lane', 'atlas', '--wake', '--idle'])).out,
    'ok · lane atlas · watched: status · when free · wakes you',
  )
  await run(mapper, ['done', 'atlas-1', 'mapped'])
  const [e] = events('cleo-1')
  assert.equal(e?.noWake, undefined)
  assert.equal(e?.idle, true)
  assert.equal(e?.name, 'cleo')
  assert.equal((await run(watcher, ['unwatch', '--lane', 'atlas'])).out, 'ok · lane atlas · not watched')
  deliver('cleo-1')
  await run(mapper, ['post', 'atlas-1', '--status', 'doing'])
  assert.deepEqual(events('cleo-1'), [])
  assert.equal((await run({ kind: 'owner' }, ['watch', 'atlas-1'])).err, 'run it from a session, or pass --session')
})

test('changes --peek leaves the cursor and the pending event; changes moves both', async () => {
  const { run } = setUp()
  const key = master.kind === 'session' ? master.key : ''
  await run(master, ['new', 'Import mapping'])
  assert.equal((await run(master, ['changes'])).out, 'nothing new since you last asked')
  await run(mapper, ['done', 'atlas-1', 'mapped'])
  const line = 'atlas-1 · done · Import mapping · mapped · +1'
  assert.equal((await run(master, ['changes', '--peek'])).out, line)
  assert.equal(events(key).length, 1)
  assert.equal((await run(master, ['changes'])).out, line)
  assert.equal(events(key).length, 0)
  assert.equal((await run(master, ['changes'])).out, 'nothing new since you last asked')
})

test('list: open ones of the lane, 20 at most then a count; --mine, --done, --all', async () => {
  const { run } = setUp()
  for (let i = 1; i <= 23; i++) await run(mapper, ['new', `Part ${i}`])
  await run(master, ['new', '--lane', 'other', 'Elsewhere'])
  const lines = (await run(master, ['list'])).out.split('\n')
  assert.equal(lines.length, 21)
  assert.equal(lines.at(-1), 'and 3 more (--all)')
  expect(lines.every(l => !l.includes('Elsewhere'))).toBe(true)
  assert.equal((await run(master, ['list', '--all'])).out.split('\n').length, 24)
  assert.equal((await run(master, ['list', '--mine'])).out, 'other-1 · next · Elsewhere')
  await run(master, ['done', 'other-1'])
  assert.equal((await run(master, ['list', '--mine'])).out, 'no open threads')
  assert.equal((await run(master, ['list', '--mine', '--done'])).out, 'other-1 · done · Elsewhere')
})

test('files: copied whole, five at most, 5 MB each; a missing one refuses the post and leaves no entry', async () => {
  const { dir, json } = setUp()
  await json(master, ['new', 'Import mapping'])
  const f = join(dir, 'a b.md')
  writeFileSync(f, 'report')
  assert.equal((await json(mapper, ['post', 'atlas-1', '--file', join(dir, 'missing.md')])).error, 'file')
  assert.equal((await json(mapper, ['post', 'atlas-1', ...Array(6).fill(['--file', f]).flat()])).error, 'files')
  const big = join(dir, 'big.bin')
  writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1))
  assert.equal((await json(mapper, ['post', 'atlas-1', '--file', big])).error, 'file_big')
  const shown = await json(master, ['show', 'atlas-1'])
  assert.equal(shown.entries.length, 1, 'only the creation entry')
  const ok = await json(mapper, ['post', 'atlas-1', '--file', f, '--file', f, '--link', 'https://example.org/ticket/7'])
  assert.equal(ok.entry.files.length, 2)
  assert.equal(new Set(ok.entry.files.map((x: { ref: string }) => x.ref)).size, 2)
  assert.deepEqual(ok.entry.links, [{ url: 'https://example.org/ticket/7' }])
  assert.equal((await json(mapper, ['post', 'atlas-1', '--link', 'javascript:alert(1)'])).error, 'link')
})

test('agents off: a session cannot write, the owner can; reads still work', async () => {
  const { json } = setUp({ threads: { agents: false } })
  assert.equal((await json(master, ['new', 'Import mapping'])).error, 'agents_off')
  assert.equal((await json({ kind: 'owner' }, ['new', 'Import mapping'])).thread.key, 'atlas-1')
  assert.equal((await json(master, ['show', 'atlas-1'])).thread.title, 'Import mapping')
})

test('every write is in the journal; watches and cursors are not', async () => {
  const { run } = setUp()
  await run(master, ['new', 'Import mapping'])
  await run(mapper, ['watch', 'atlas-1'])
  await run(mapper, ['post', 'atlas-1', 'a note'])
  await run(master, ['changes'])
  const db = openDb({ create: false })
  assert.ok(db)
  try {
    const rows = db.db.query("SELECT op, ref, by FROM journal WHERE store = 'threads' ORDER BY seq").all() as {
      op: string
      by: string
    }[]
    assert.deepEqual(
      rows.map(r => [r.op, JSON.parse(r.by).name]),
      [
        ['new', 'master'],
        ['post', 'atlas-mapper'],
      ],
    )
  } finally {
    db.close()
  }
})

test('a watch hears only what came after it began, also for a session that watched before', async () => {
  const { run } = setUp()
  const key = master.kind === 'session' ? master.key : ''
  await run(master, ['new', 'Import mapping'])
  await run(mapper, ['new', 'Prices'])
  await run(mapper, ['new', 'Taxes'])
  await run(mapper, ['done', 'atlas-2', 'old news'])
  await run(mapper, ['done', 'atlas-3', 'old news too'])
  await run(master, ['watch', '--lane', 'atlas'])
  await run(mapper, ['new', 'Rates'])
  await run(mapper, ['done', 'atlas-4', 'fresh'])
  assert.deepEqual(
    events(key).map(e => e.text),
    ['atlas-4 done: fresh. More: board thread changes'],
  )
  // Watching again later starts again from then.
  await run(master, ['unwatch', '--lane', 'atlas'])
  await run(mapper, ['done', 'atlas-1', 'more old news'])
  await run(master, ['watch', '--lane', 'atlas'])
  for (const e of events(key)) removeEntry(e.id)
  await run(mapper, ['post', 'atlas-4', '--status', 'doing', '--summary', 'reopened'], { now: NOW + 120_000 })
  assert.deepEqual(
    events(key).map(e => e.text),
    ['atlas-4 doing: reopened. More: board thread changes'],
  )
})

test('watch --idle on a lane holds the line for a free session, also over the creator’s own watch; --mine hears what is yours', async () => {
  const { run } = setUp()
  const key = master.kind === 'session' ? master.key : ''
  await run(master, ['new', 'Import mapping'])
  await run(master, ['watch', '--lane', 'atlas', '--idle'])
  await run(mapper, ['done', 'atlas-1', 'mapped'])
  assert.equal(events(key)[0]?.idle, true)
  const cleo: Party = { kind: 'session', key: 'cleo-1', name: 'cleo' }
  await run(cleo, ['watch', '--mine'])
  await run(master, ['new', '--to', 'cleo', 'Check the totals'], { findSession: async () => cleo })
  await run(mapper, ['post', 'atlas-2', '--status', 'waiting', '--waiting', 'the ERP export'])
  assert.equal(events('cleo-1')[0]?.text, 'atlas-2 waiting: the ERP export. More: board thread changes')
})

test('a pending event the scheduler claimed meanwhile goes as it is; the new one follows it, from where it ended', async () => {
  const { run } = setUp()
  const key = master.kind === 'session' ? master.key : ''
  await run(master, ['new', 'Prices'])
  await run(master, ['new', 'Taxes'])
  await run(mapper, ['done', 'atlas-1', 'prices mapped'])
  const [first] = events(key)
  assert.ok(first)
  // The scheduler claims it, as it does before typing it in.
  const file = join(stateDir(), 'schedule', `${first.id}.json`)
  writeFileSync(file, JSON.stringify({ ...first, claim: { pid: 1, at: Date.now() } }))
  await run(mapper, ['done', 'atlas-2', 'taxes mapped'], { now: NOW + 1000 })
  const all = events(key).sort((a, b) => a.next - b.next)
  assert.deepEqual(
    all.map(e => [e.text, e.next]),
    [
      ['atlas-1 done: prices mapped. More: board thread changes', NOW],
      ['atlas-2 done: taxes mapped. More: board thread changes', NOW + 60_000],
    ],
  )
})

test('two commands writing at once leave one pending event for a watcher', async () => {
  const { run } = setUp()
  const key = master.kind === 'session' ? master.key : ''
  for (let i = 1; i <= 6; i++) await run(master, ['new', `Part ${i}`])
  const cfg = join(process.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(
    join(cfg, 'config.json'),
    JSON.stringify({ language: 'en', port: 9, wakeUrl: 'http://127.0.0.1:9/', threads: true }),
  )
  const cli = join(import.meta.dir, '..', '..', 'src', 'entrypoints', 'cli.ts')
  const procs = Array.from({ length: 6 }, (_, i) =>
    Bun.spawn([process.execPath, cli, 'thread', 'done', `atlas-${i + 1}`, `part ${i + 1} mapped`], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: `worker-${i + 1}`, HERDR_PANE_ID: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
  const outs = await Promise.all(
    procs.map(async p => `${await new Response(p.stdout).text()}${await new Response(p.stderr).text()}`),
  )
  for (const [i, o] of outs.entries()) assert.equal(o.trim(), `ok · atlas-${i + 1} · done`)
  const pending = events(key)
  assert.equal(pending.length, 1, JSON.stringify(pending.map(e => e.text)))
  expect(pending[0]?.text).toMatch(/· and 3 more\. More: board thread changes$/)
})

test('flags: one a command does not take is refused; done keeps its file; text after -- may start with --', async () => {
  const { dir, json, run } = setUp()
  await run(master, ['new', 'Import mapping'])
  const typo = await run(mapper, ['post', 'atlas-1', '--stauts', 'done'])
  assert.equal(typo.code, 1)
  assert.match(typo.err, /^board thread post does not take --stauts/)
  assert.equal((await json(mapper, ['done', 'atlas-1', '--status', 'doing'])).error, 'usage')
  const report = join(dir, 'report.md')
  writeFileSync(report, 'the report')
  const done = await json(mapper, ['done', 'atlas-1', 'mapped', '--file', report])
  assert.equal(done.thread.summary, 'mapped')
  assert.equal(done.entry.files.length, 1)
  const note = JSON.parse((await run(mapper, ['post', 'atlas-1', '--json', '--', '--- result ---', '--json'])).out)
  assert.equal(note.entry.text, '--- result --- --json')
  assert.equal((await json(mapper, ['post', 'atlas-1', '--reply', 'zzz', 'x'])).error, 'no_entry')
  assert.equal((await json(mapper, ['post', 'atlas-1', '--status', 'doing', '--waiting', 'CI'])).error, 'waiting')
})

test('changes past a screen: the newest 20, nothing marked read; --all lists them and marks them', async () => {
  const { run } = setUp()
  for (let i = 1; i <= 23; i++) await run(master, ['new', `Part ${i}`])
  for (let i = 1; i <= 23; i++) await run(mapper, ['done', `atlas-${i}`, `part ${i}`])
  const first = (await run(master, ['changes'])).out.split('\n')
  assert.equal(first.length, 21)
  assert.equal(first.at(-1), 'and 3 more: board thread changes --all lists them all; none is marked read until then')
  assert.equal((await run(master, ['changes', '--all'])).out.split('\n').length, 23)
  assert.equal((await run(master, ['changes'])).out, 'nothing new since you last asked')
})

test("a lane id in another case than the categories' is the same lane", async () => {
  const { run } = setUp()
  assert.equal((await run(master, ['new', 'Import mapping'], { lane: 'ATLAS' })).out, 'ok · atlas-1 · next')
  assert.equal(
    (await run(master, ['show', '1'], { lane: 'Atlas' })).out.split('\n')[0],
    'atlas-1 · next · Import mapping',
  )
})
