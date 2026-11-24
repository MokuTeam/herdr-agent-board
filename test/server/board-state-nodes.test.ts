// The seam in server/board-state.ts (#500), in a process of its own on a sandbox with a fake herdr:
// - Without `nodes`, the payload equals main's for the same sandbox, field for field: main's
//   board-state.ts is read from git (BASE) and run beside this one on the same modules, with
//   sessions keyed by a Claude id, by `pane-<id>` and by pi file paths, names with spaces, Cyrillic
//   and %.
// - With other devices' cards, the payload has them and `devices`, a lane of theirs shows by the
//   board's unknown-lane rule, and items(), find() and observation() still hold this computer's
//   sessions only; findAny() also finds a prefixed key.
// - The away journal (#489) beside them is fed this computer's sessions only: no other device's
//   card enters journal.db, and the payload carries both its part and the devices' cards.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, sandbox } from '../support/sandbox.ts'

/**
 * main before #500: server/board-state.ts as every board without `nodes` runs it. A later change
 * that means to change the payload of a board without `nodes` moves this to its own commit on main.
 */
const BASE = 'f596a6f4'
const SID = '5a6b7c8d-1e2f-4a3b-9c4d-5e6f7a8b9c0d'
const REMOTE = '6a6b7c8d-1e2f-4a3b-9c4d-5e6f7a8b9c0e'

const src = join(root, 'src').replaceAll('\\', '/')

function mainSource(file: string): string {
  const git = Bun.spawnSync(['git', 'show', `${BASE}:${file}`], { cwd: root })
  if (git.exitCode !== 0)
    throw new Error(`git show ${BASE}:${file} failed: these tests need git and the full history, not a shallow clone`)
  return git.stdout.toString()
}

/** The script: main's board state and this one's, built on one sandbox; their payloads and what the seam answers. */
const SCRIPT = (old: string) => `
import { normalizeConfig } from '${src}/core/categories.ts'
import { defaultDeps } from '${src}/services/deps.ts'
import { createBoardState as now } from '${src}/server/board-state.ts'
import { createBoardState as main } from '${old}'
import { createJournal } from '${src}/services/journal.ts'
import { journalStore, openJournalDb } from '${src}/adapters/journal-store.ts'

const cfg = normalizeConfig({ language: 'en', wakeUrl: null, categories: [{ id: 'other', title: 'Other', color: 'gray' }] })
const launches = { decorate: i => i, list: () => [], observe: () => {} }
const make = (create, extra = {}) => create({ deps: defaultDeps(cfg), launches, version: () => 'v1', push: () => {}, ...extra })
const remoteItem = key => ({
  key, session: key.slice(10), pane: 'w1:p1', workspace: null, cwd: '/srv/atlas', status: 'working', name: 'remote ' + key,
  autoName: '', category: 'atlas', categorySet: true, column: 'work', attention: '', device: 'server-1',
})
const part = {
  items: [remoteItem('@server-1:pane-1'), { ...remoteItem('@server-1:${REMOTE}'), todos: [{ id: 't', text: 'x', owner: 'user', by: 'user', at: 1 }] }],
  launches: [{ id: '@server-1:l-1', name: 'next', device: 'server-1' }],
  schedules: [{ id: '@server-1:a1b2c3', key: '@server-1:pane-1', text: 'later', next: 1, device: 'server-1' }],
  devices: [{ id: 'server-1', title: 'Server 1', kind: 'direct', link: null, status: null, sameCommit: null, payloadAt: 7,
    paused: false, drain: false, maxSessions: null, minFreeMemMb: null, maxLoad: null }],
}
const aggregate = { part: () => part, find: key => part.items.find(i => i.key === key) }

const journal = createJournal({ cfg: { journal: true }, log: () => {}, presence: () => null, viewers: () => 1 })
const fed = new Set()
const journaled = { observe: items => { for (const i of items) fed.add(i.key); journal.observe(items) }, view: () => journal.view() }
const boards = { main: make(main), now: make(now), off: make(now, { nodes: () => null }), master: make(now, { nodes: () => aggregate }),
  journaled: make(now, { nodes: () => aggregate, journal: journaled }) }
for (const b of Object.values(boards)) await b.refresh()
await boards.journaled.refresh()
journal.stop()
const jdb = openJournalDb(false)
const recorded = jdb ? [...journalStore(jdb).states().keys()] : null
jdb?.close()
const payload = b => {
  const p = JSON.parse(b.payload())
  delete p.lastSuccessfulRefreshAt
  return p
}
const m = boards.master
console.log(JSON.stringify({
  main: payload(boards.main),
  now: payload(boards.now),
  off: payload(boards.off),
  master: payload(m),
  items: m.items().map(i => i.key),
  find: [m.find('pane-1')?.key ?? null, m.find('@server-1:pane-1')?.key ?? null],
  findAny: [m.findAny('pane-1')?.key ?? null, m.findAny('@server-1:pane-1')?.key ?? null, m.findAny('@server-2:pane-1')?.key ?? null],
  observed: m.observation()?.items.map(i => i.key) ?? null,
  journaled: { payload: payload(boards.journaled), fed: [...fed], recorded },
}))
process.exit(0)
`

test('without nodes the payload is main’s; with devices the payload has their cards and the item list stays local', async () => {
  const box = await sandbox()
  const panes = [
    { pane_id: '1', agent: 'claude', agent_status: 'idle', cwd: box.dir, terminal_title_stripped: 'shell one' },
    {
      pane_id: '2',
      agent: 'claude',
      agent_session: { value: SID },
      agent_status: 'working',
      cwd: join(box.dir, 'Проект 50%'),
      terminal_title_stripped: 'Тест 50% x',
    },
    {
      pane_id: '3',
      agent: 'pi',
      agent_session: { value: '/home/o w/.pi/sessions/Тест 50%.jsonl' },
      agent_status: 'idle',
      cwd: box.dir,
    },
    {
      pane_id: '4',
      agent: 'pi',
      agent_session: { value: 'C:\\Users\\o w\\.pi\\sessions\\Тест 50%.jsonl' },
      agent_status: 'idle',
      cwd: box.dir,
    },
  ]
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
  const old = join(box.dir, 'main-board-state.ts')
  writeFileSync(old, mainSource('src/server/board-state.ts').replaceAll("from '../", `from '${src}/`))
  const script = join(box.dir, 'seam.ts')
  writeFileSync(script, SCRIPT(old.replaceAll('\\', '/')))
  const proc = Bun.spawn([process.execPath, script], { cwd: root, env: box.env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect([await proc.exited, err]).toEqual([0, ''])
  const got = JSON.parse(out.trim().split('\n').at(-1) ?? 'null')

  // Without nodes: main's payload, field for field, whether `nodes` is not given or gives null.
  expect(got.main.items.map((i: { key: string }) => i.key)).toEqual(
    expect.arrayContaining(['pane-1', SID, '/home/o w/.pi/sessions/Тест 50%.jsonl']),
  )
  expect(got.now).toEqual(got.main)
  expect(got.off).toEqual(got.main)
  expect(JSON.stringify(got.now)).toBe(JSON.stringify(got.main))
  expect('devices' in got.now).toBe(false)

  // With devices: their cards after this computer's, pane-1 twice under two keys, `devices`.
  const keys = got.master.items.map((i: { key: string }) => i.key)
  expect(keys).toEqual([
    ...got.main.items.map((i: { key: string }) => i.key),
    '@server-1:pane-1',
    `@server-1:${REMOTE}`,
  ])
  expect(got.master.schedules.map((e: { id: string }) => e.id)).toEqual(['@server-1:a1b2c3'])
  expect(got.master.launches.map((l: { id: string }) => l.id)).toEqual(['@server-1:l-1'])
  // Tasks are off on this board: another device's card carries none either.
  expect(got.master.items.some((i: Record<string, unknown>) => 'todos' in i)).toBe(false)
  expect(got.master.devices.map((d: { id: string }) => d.id)).toEqual(['server-1'])
  // A lane this board does not have: as a lane a session made up, just before 'other' (core/categories.ts laneRank).
  expect(got.master.categories.map((c: { id: string; configured: boolean }) => [c.id, c.configured])).toEqual([
    ['atlas', false],
    ['other', true],
  ])
  // Everything else as without them.
  const rest = (p: Record<string, unknown>) => {
    const { items, launches, schedules, categories, devices, ...others } = p
    return others
  }
  expect(rest(got.master)).toEqual(rest(got.main))

  // The item list, find() and the observation Workdesk reads: this computer's only.
  expect(got.items).toEqual(got.main.items.map((i: { key: string }) => i.key))
  expect(got.observed).toEqual(got.items)
  expect(got.find).toEqual(['pane-1', null])
  expect(got.findAny).toEqual(['pane-1', '@server-1:pane-1', null])

  // The away journal beside devices: fed and recording this computer's sessions only; the payload
  // has its part and the devices' cards.
  expect(got.journaled.fed.sort()).toEqual([...got.items].sort())
  expect(got.journaled.recorded.sort()).toEqual([...got.items].sort())
  expect(got.journaled.payload.journal).toEqual({ strip: null, last: null })
  expect(got.journaled.payload.items.map((i: { key: string }) => i.key)).toEqual(keys)
}, 30_000)

test('#642 awake source card marked moved is dropped from master payload when moved card is present, kept when absent', async () => {
  const box = await sandbox()
  const repo = join(box.dir, 'atlas')
  mkdirSync(repo, { recursive: true })
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'w1:p1',
              agent: 'claude',
              agent_session: { value: SID },
              agent_status: 'done',
              cwd: repo,
              terminal_title_stripped: 'Legacy-master',
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(
    join(box.cards, `${SID}.json`),
    JSON.stringify({ key: SID, name: 'Legacy-master', moved: { to: 'server-1', cwd: repo, at: 1000 } }),
  )
  const script = join(box.dir, 'moved-source.ts')
  writeFileSync(
    script,
    `
import { normalizeConfig } from '${src}/core/categories.ts'
import { defaultDeps } from '${src}/services/deps.ts'
import { createBoardState } from '${src}/server/board-state.ts'

const cfg = normalizeConfig({
  language: 'en',
  wakeUrl: null,
  categories: [{ id: 'other', title: 'Other', color: 'gray' }],
  nodes: { id: 'laptop', devices: {} },
})
const launches = { decorate: i => i, list: () => [], observe: () => {} }
const remote = {
  key: '@server-1:${SID}',
  session: '${SID}',
  pane: 'n1:p1',
  workspace: null,
  cwd: '/srv/atlas',
  status: 'idle',
  name: 'Legacy-master',
  autoName: '',
  category: 'other',
  categorySet: false,
  column: 'idle',
  attention: '',
  activity: 1,
  device: 'server-1',
}
let withRemote = true
const aggregate = {
  part: () => ({
    items: withRemote ? [remote] : [],
    launches: [],
    schedules: [],
    devices: [{
      id: 'server-1',
      title: 'Server 1',
      kind: 'direct',
      link: null,
      status: null,
      sameCommit: null,
      payloadAt: 7,
      paused: false,
      drain: false,
      maxSessions: null,
      minFreeMemMb: null,
      maxLoad: null,
    }],
  }),
  find: () => undefined,
}
const board = createBoardState({
  deps: defaultDeps(cfg),
  launches,
  version: () => 'v1',
  push: () => {},
  nodes: () => aggregate,
})
await board.refresh()
const present = JSON.parse(board.payload()).items.map(i => ({ key: i.key, movedTo: i.movedTo ?? null }))
withRemote = false
board.publish()
const absent = JSON.parse(board.payload()).items.map(i => ({ key: i.key, movedTo: i.movedTo ?? null }))
console.log(JSON.stringify({ localMovedTo: board.items()[0]?.movedTo ?? null, present, absent }))
process.exit(0)
`,
  )
  const proc = Bun.spawn([process.execPath, script], { cwd: root, env: box.env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect([await proc.exited, err]).toEqual([0, ''])
  const got = JSON.parse(out.trim().split('\n').at(-1) ?? 'null')
  expect(got.localMovedTo).toBe('server-1')
  expect(got.present).toEqual([{ key: `@server-1:${SID}`, movedTo: null }])
  expect(got.absent).toEqual([{ key: SID, movedTo: 'server-1' }])
}, 30_000)

test('#642 local resume after move clears stale card.moved on disk and keeps local card beside remote one', async () => {
  const box = await sandbox()
  const repo = join(box.dir, 'atlas')
  mkdirSync(repo, { recursive: true })
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [
            {
              pane_id: 'w1:p2',
              agent: 'claude',
              agent_session: { value: SID },
              agent_status: 'idle',
              cwd: repo,
              terminal_title_stripped: 'Atlas',
            },
          ],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  mkdirSync(box.cards, { recursive: true })
  const cardPath = join(box.cards, `${SID}.json`)
  writeFileSync(cardPath, JSON.stringify({ key: SID, name: 'Atlas', moved: { to: 'server-1', cwd: repo, at: 1000 } }))
  const script = join(box.dir, 'resumed-local.ts')
  writeFileSync(
    script,
    `
import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '${src}/core/categories.ts'
import { deviceIdFromHost } from '${src}/core/nodes.ts'
import { projectFolderName } from '${src}/core/resume.ts'
import { defaultDeps } from '${src}/services/deps.ts'
import { createBoardState } from '${src}/server/board-state.ts'

// A local resume writes a transcript line after moved.at (1000).
const project = join(${JSON.stringify(box.env.HOME)}, '.claude', 'projects', projectFolderName(${JSON.stringify(repo)}))
mkdirSync(project, { recursive: true })
writeFileSync(
  join(project, '${SID}.jsonl'),
  JSON.stringify({ type: 'user', cwd: ${JSON.stringify(repo)}, sessionId: '${SID}', timestamp: '2026-01-01T00:00:02.000Z' }) + '\\n',
)

// Omitted nodes.id falls back to deviceIdFromHost(hostname()) consistently across master state.
const cfg = normalizeConfig({
  language: 'en',
  wakeUrl: null,
  categories: [{ id: 'other', title: 'Other', color: 'gray' }],
  nodes: { devices: {} },
})
const launches = { decorate: i => i, list: () => [], observe: () => {} }
const remote = {
  key: '@server-1:${SID}',
  session: '${SID}',
  pane: 'n1:p1',
  workspace: null,
  cwd: '/srv/atlas',
  status: 'idle',
  name: 'Atlas',
  autoName: '',
  category: 'other',
  categorySet: false,
  column: 'idle',
  attention: '',
  activity: 500,
  movedTo: deviceIdFromHost(hostname()),
  movedAt: 600,
  device: 'server-1',
}
const aggregate = {
  part: () => ({
    items: [remote],
    launches: [],
    schedules: [],
    devices: [{
      id: 'server-1',
      title: 'Server 1',
      kind: 'direct',
      link: null,
      status: null,
      sameCommit: null,
      payloadAt: 7,
      paused: false,
      drain: false,
      maxSessions: null,
      minFreeMemMb: null,
      maxLoad: null,
    }],
  }),
  find: () => undefined,
}
const board = createBoardState({
  deps: defaultDeps(cfg),
  launches,
  version: () => 'v1',
  push: () => {},
  nodes: () => aggregate,
})
await board.refresh()
const payloadKeys = JSON.parse(board.payload()).items.map(i => ({ key: i.key, movedTo: i.movedTo ?? null }))
console.log(JSON.stringify({ payloadKeys, localMovedTo: board.items()[0]?.movedTo ?? null }))
process.exit(0)
`,
  )
  const proc = Bun.spawn([process.execPath, script], { cwd: root, env: box.env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect([await proc.exited, err]).toEqual([0, ''])
  const got = JSON.parse(out.trim().split('\n').at(-1) ?? 'null')
  expect(got.localMovedTo).toBeNull()
  // Local card had moved cleared on resume; remote card with movedTo=<master hostname id> is dropped.
  expect(got.payloadKeys).toEqual([{ key: SID, movedTo: null }])
  const savedAfter = JSON.parse(readFileSync(cardPath, 'utf8')) as { moved?: unknown }
  expect(savedAfter.moved).toBeUndefined()
}, 30_000)
