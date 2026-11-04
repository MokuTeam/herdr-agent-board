// A MokuPilot call agent on the board (#326), against a fake MokuPilot: a temp HOME with its agent
// files (~/.meeting-copilot/call-agents/<session>.json), their task boards (~/.agent-boards) and a
// transcript in the profile folder MokuPilot started the agent in. A call agent has a card of its
// own, right after the session it is a fork of and in its lane, marked as on a call (or after it);
// one MokuPilot went on in a sleeping session is that session's card. Without MokuPilot, or with
// an old one that writes call.json only, `board list` prints what main printed.
import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const PARENT = '7a2b4c6d-0000-4000-8000-000000000002'
const CALL = '1f0c9a3e-0000-4000-8000-000000000001'
const ALONE = '2b3c4d5e-0000-4000-8000-000000000003'
const KEPT = '3c4d5e6f-0000-4000-8000-000000000004'
const CATEGORIES = [
  { id: 'other', title: 'Other', color: 'gray' },
  { id: 'proj', title: 'Проект 50%', color: 'blue' },
]

const home = (box: Sandbox): string => box.env.HOME as string
const configDir = (box: Sandbox): string => join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
const stateDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const put = (file: string, value: unknown): void => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
/** config.json for `board`, with a fake wake of the test's: never the real one. */
const config = (box: Sandbox, cfg: { wakeUrl: string } & Record<string, unknown>): void =>
  put(join(configDir(box), 'config.json'), { language: 'en', categories: CATEGORIES, ...cfg })

/** herdr's view: the session a call was started from, idle, and another one at work. */
function herdrState(box: Sandbox): void {
  const pane = (id: string, session: string | null, status: string, title: string) => ({
    pane_id: id,
    tab_id: 't1',
    workspace_id: 'w1',
    ...(session && { agent: 'claude', agent_session: { value: session }, agent_status: status }),
    cwd: box.dir,
    terminal_title_stripped: title,
  })
  const snapshot = {
    workspaces: [{ workspace_id: 'w1', label: 'Work stuff' }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
    panes: [
      pane('w1:p1', PARENT, 'idle', 'Invoices 100%'),
      pane('w1:p2', 's-busy', 'working', 'Busy one'),
      pane('w1:p3', null, '', 'shell'),
    ],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
}

/** A call agent's file as MokuPilot writes it; its MokuPilot is this test's process, alive. */
function callAgent(box: Sandbox, session: string, over: Record<string, unknown> = {}): void {
  const now = Date.now() / 1000
  put(join(home(box), '.meeting-copilot', 'call-agents', `${session}.json`), {
    format: 'mokupilot-call-agent',
    version: 1,
    pid: process.pid,
    session_id: session,
    harness: 'claude',
    parent_session_id: '',
    config_dir: '',
    cwd: box.dir,
    started: now - 600,
    call: 'on',
    busy: false,
    updated: now - 5,
    ...over,
  })
}

function taskBoard(box: Sandbox, session: string, items: unknown[]): void {
  put(join(home(box), '.agent-boards', 'claude', `${session}.json`), {
    format: 'agent-board',
    version: 1,
    harness: 'claude',
    session_id: session,
    writer: 'mokupilot',
    items,
  })
}

/** Its transcript in a profile folder: a line copied from its parent (its title), then its own words. */
function transcript(box: Sandbox, profile: string, session: string, said: string): void {
  const at = new Date(Date.now() - 60_000).toISOString()
  const lines = [
    { type: 'summary', summary: 'The parent’s title', leafUuid: 'x' },
    { type: 'user', message: { role: 'user', content: '[call] Speaker 1: check the totals' }, timestamp: at },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] }, timestamp: at },
  ]
  put(
    join(home(box), profile, 'projects', projectFolderName(box.dir), `${session}.jsonl`),
    `${lines.map(l => JSON.stringify(l)).join('\n')}\n`,
  )
  put(join(home(box), profile, 'settings.json'), {})
}

async function boardItems(box: Sandbox, cfg: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
  const { url } = await serveBoard(box, { language: 'en', categories: CATEGORIES, ...cfg })
  for (let tries = 0; ; tries++) {
    const board = (await (await fetch(`${url}/api/board`)).json()) as {
      stale: boolean
      items: Record<string, unknown>[]
    }
    if (!board.stale) return board.items
    if (tries > 200) throw new Error('the board did not refresh')
    await Bun.sleep(25)
  }
}

async function cli(box: Sandbox, args: string[], env: Record<string, string> = {}): Promise<string> {
  const out = await box.run('cli', { args, env }).exited
  assert.equal(out.code, 0, out.stderr)
  return out.stdout.trim()
}

test('a call agent: its own card right after its parent, in its lane, on a call, with its task board', async () => {
  const box = await sandbox()
  herdrState(box)
  const wake = await fakeWake({ sleeping: [] })
  config(box, { wakeUrl: wake.url })
  await cli(box, ['cat', 'proj', '--session', PARENT])
  callAgent(box, CALL, {
    parent_session_id: PARENT,
    config_dir: join(home(box), '.claude-work'),
    busy: true,
    helpers: 1,
  })
  transcript(box, '.claude-work', CALL, 'Totals match the contract')
  taskBoard(box, CALL, [
    { id: 'b1', text: 'Check the invoice totals', status: 'doing' },
    { id: 'b2', text: 'Draft the summary', status: 'next' },
    { id: 'b3', text: 'Book the follow-up', status: 'next' },
    { id: 'b4', text: 'Read the contract', status: 'done' },
  ])
  const items = await boardItems(box)
  const call = items.find(i => i.key === CALL)
  assert.ok(call, 'the call agent has a card')
  expect({
    session: call.session,
    pane: call.pane,
    workspace: call.workspace,
    agent: call.agent,
    name: call.name,
    category: call.category,
    status: call.status,
    column: call.column,
    sleeping: call.sleeping,
    doing: call.doing,
    title: call.title,
    prompt: call.prompt,
    lastText: call.lastText,
    profile: call.profile,
    fork: (call.fork as { of: string }).of,
  }).toEqual({
    session: CALL,
    pane: null,
    workspace: 'Work stuff',
    agent: 'claude',
    name: 'Call · Invoices 100%',
    category: 'proj',
    status: 'working',
    column: 'work',
    sleeping: false,
    // No `board doing` of its own: its task board's.
    doing: 'Check the invoice totals',
    // Its parent's title and MokuPilot's prompts are not its words; what it said is.
    title: '',
    prompt: '',
    lastText: 'Totals match the contract',
    profile: 'work',
    fork: PARENT,
  })
  expect(call.call).toMatchObject({
    phase: 'on',
    parent: PARENT,
    helpers: 1,
    tasks: [
      { id: 'b1', text: 'Check the invoice totals', status: 'doing' },
      { id: 'b2', text: 'Draft the summary', status: 'next' },
      { id: 'b3', text: 'Book the follow-up', status: 'next' },
      { id: 'b4', text: 'Read the contract', status: 'done' },
    ],
  })
  // Right after its parent; the parent and the others as they were, with no call of their own.
  const keys = items.map(i => i.key)
  expect(keys.indexOf(CALL)).toBe(keys.indexOf(PARENT) + 1)
  expect(items.filter(i => i.call).map(i => i.key)).toEqual([CALL])

  // Its own `board doing` (no herdr pane: Claude Code's session id) wins over its task board's.
  await cli(box, ['doing', 'Reading the numbers aloud'], { CLAUDE_CODE_SESSION_ID: CALL })
  const again = (await boardItems(box)).find(i => i.key === CALL)
  expect(again?.doing).toBe('Reading the numbers aloud')
})

test('after the call, with no parent, and one MokuPilot went on in a sleeping session', async () => {
  const box = await sandbox()
  herdrState(box)
  const wake = await fakeWake({ sleeping: [] })
  put(join(stateDir(box), 'wake-sessions.json'), {
    'w1:p3': {
      session: KEPT,
      name: 'Kept talk',
      cwd: box.dir,
      seen_at: Date.now() - 120_000,
      slept_at: Date.now() - 60_000,
    },
  })
  config(box, { wakeUrl: wake.url, wake: false })
  callAgent(box, ALONE, { call: 'after', helpers: 2 })
  // Its last words to the call end in a question: that is no question to the user.
  transcript(box, '.claude', ALONE, 'Shall we move the deadline to Friday?')
  callAgent(box, KEPT, { parent_session_id: KEPT, busy: true })
  // The session was archived from its pane before: MokuPilot going on in it shows it, and it stays archived.
  put(join(stateDir(box), 'archive', `${KEPT}.json`), {
    key: KEPT,
    session: KEPT,
    name: 'Kept talk',
    pane: 'w1:p3',
    state: 'archived',
    held: [],
    archivedAt: Date.now() - 3_600_000,
    closeAt: Date.now() - 3_600_000,
  })
  // A call agent herdr shows in a pane: its pane's card, marked.
  callAgent(box, 's-busy', { busy: true })
  // A file of a MokuPilot that is gone, and one of a newer format: no card.
  callAgent(box, 'gone-1', { pid: 999_999_999 })
  callAgent(box, 'newer-1', { version: 2 })
  const items = await boardItems(box, { wakeUrl: wake.url, wake: false })
  const alone = items.find(i => i.key === ALONE)
  expect(alone).toMatchObject({
    name: 'MokuPilot call',
    category: 'other',
    status: 'idle',
    column: 'idle',
    attention: '',
    lastText: 'Shall we move the deadline to Friday?',
    pane: null,
    call: { phase: 'after', parent: null, helpers: 2, tasks: [] },
  })
  expect(alone?.fork).toBeUndefined()
  // The sleeper is the call agent now: one card, its name, at work, not asleep.
  const kept = items.filter(i => i.key === KEPT)
  expect(kept).toHaveLength(1)
  expect(kept[0]).toMatchObject({
    name: 'Kept talk',
    workspace: 'Work stuff',
    status: 'working',
    sleeping: false,
    call: { phase: 'on', parent: null },
  })
  const record = JSON.parse(readFileSync(join(stateDir(box), 'archive', `${KEPT}.json`), 'utf8'))
  expect([record.state, record.pane]).toEqual(['archived', 'w1:p3'])
  const busy = items.filter(i => i.key === 's-busy')
  expect(busy).toHaveLength(1)
  expect(busy[0]).toMatchObject({ pane: 'w1:p2', name: 'Busy one', call: { phase: 'on', parent: null } })
  expect(items.map(i => i.key).sort()).toEqual([ALONE, KEPT, PARENT, 's-busy'].sort())
})

// What `board list` printed for this herdr state against main's files (run there once, as
// AGENTS.md says): a setup without MokuPilot, and one whose MokuPilot writes call.json only.
const MAIN = ['Busy one [other] Working', 'Invoices 100% [other] Idle']

test('without MokuPilot, or with one that writes call.json only, the board lists what main listed', async () => {
  const box = await sandbox()
  herdrState(box)
  const wake = await fakeWake({ sleeping: [] })
  config(box, { wakeUrl: wake.url })
  expect((await cli(box, ['list'])).split('\n')).toEqual(MAIN)
  put(join(home(box), '.meeting-copilot', 'call.json'), { pid: process.pid, started: Date.now() / 1000 - 60 })
  expect((await cli(box, ['list'])).split('\n')).toEqual(MAIN)
  expect(box.calls()).toEqual([
    ['api', 'snapshot'],
    ['api', 'snapshot'],
  ])
  expect(wake.requests().map(r => r.path)).toEqual(['/sleeping', '/sleeping'])
})

// The items main's files gave the page for the test below (run there once, as AGENTS.md says).
const MAIN_ITEMS: unknown = [
  {
    key: '7a2b4c6d-0000-4000-8000-000000000002',
    session: '7a2b4c6d-0000-4000-8000-000000000002',
    pane: 'w1:p1',
    workspace: 'Work stuff',
    agent: 'claude',
    name: 'Invoices 100%',
    cwd: '<dir>',
    status: 'idle',
    sleeping: false,
    focused: false,
    activity: 'a time',
    autoName: 'Invoices 100%',
    category: 'proj',
    categorySet: true,
    doing: 'Checking the invoices',
    doingAt: 'a time',
    wait: '',
    waitSince: null,
    result: '',
    title: '',
    prompt: '',
    lastText: 'Shall I go on?',
    lastAt: 1793527320000,
    recap: 'Went through half of October',
    recapAt: 1793527260000,
    context: null,
    contextPct: null,
    contextSize: null,
    model: null,
    effort: null,
    tool: null,
    attention: 'question',
    question: 'Shall I go on?',
    askSince: null,
    column: 'me',
    pin: '',
    auto: 'me',
    helpers: null,
    profile: 'default',
    links: null,
  },
  {
    key: 's-busy',
    session: 's-busy',
    pane: 'w1:p2',
    workspace: 'Work stuff',
    agent: 'claude',
    name: 'Busy one',
    cwd: '<dir>',
    status: 'working',
    sleeping: false,
    focused: false,
    activity: 0,
    autoName: 'Busy one',
    category: 'other',
    categorySet: false,
    doing: '',
    doingAt: null,
    wait: '',
    waitSince: null,
    result: '',
    title: '',
    prompt: '',
    lastText: '',
    lastAt: null,
    recap: '',
    recapAt: null,
    context: null,
    contextPct: null,
    contextSize: null,
    model: null,
    effort: null,
    tool: null,
    attention: '',
    question: '',
    askSince: null,
    column: 'work',
    pin: '',
    auto: 'work',
    helpers: null,
    profile: 'default',
    links: null,
  },
]

/** The board's items with this sandbox's folder as <dir>, for comparing runs. */
const normalized = (box: Sandbox, items: unknown): unknown =>
  JSON.parse(JSON.stringify(items).split(JSON.stringify(box.dir).slice(1, -1)).join('<dir>'))

test('without MokuPilot, or with call.json only, the page gets the items main gave it', async () => {
  const box = await sandbox()
  herdrState(box)
  const wake = await fakeWake({ sleeping: [] })
  config(box, { wakeUrl: wake.url })
  put(join(home(box), '.meeting-copilot', 'call.json'), { pid: process.pid, started: Date.now() / 1000 - 60 })
  // A card with a lane and a doing, and a transcript with a title, a prompt, a question and a recap.
  await cli(box, ['cat', 'proj', '--session', PARENT])
  await cli(box, ['doing', 'Checking the invoices', '--session', PARENT])
  const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString()
  const lines = [
    { type: 'summary', summary: 'Invoice review', leafUuid: 'x' },
    { type: 'user', message: { role: 'user', content: 'Go through October' }, timestamp: at(0) },
    { type: 'system', subtype: 'away_summary', content: 'Went through half of October', timestamp: at(1) },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Shall I go on?' }] },
      timestamp: at(2),
    },
  ]
  put(
    join(home(box), '.claude', 'projects', projectFolderName(box.dir), `${PARENT}.jsonl`),
    `${lines.map(l => JSON.stringify(l)).join('\n')}\n`,
  )
  put(join(home(box), '.claude', 'settings.json'), {})
  const raw = (await boardItems(box, { wakeUrl: wake.url })) as Record<string, unknown>[]
  // When the doing was written and the transcript last changed are now: a time on both sides.
  for (const it of raw)
    for (const k of ['doingAt', 'activity']) if (typeof it[k] === 'number' && it[k]) it[k] = 'a time'
  const items = normalized(box, raw)
  if (process.env.PRINT_ITEMS) console.log(JSON.stringify(items))
  expect(items).toEqual(MAIN_ITEMS)
})
