// A node's gates and briefs with its master's flags (#775), as the hooks and `board` run: a node whose
// config.json lost the master-owned sections (the handover) reads them as on via the master once the
// master sent them, and as before without them. A board without `node` reads no flags at all.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brief, calendarBrief, decisionsBrief } from '../../src/core/brief.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { presenceBrief } from '../../src/core/presence.ts'
import { todosBrief } from '../../src/core/todos.ts'
import { watchesBrief } from '../../src/core/watches.ts'
import { threadsBrief } from '../../src/core/work-threads.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(15_000)

const SID = '11111111-2222-3333-4444-555555555555'
const NODE = { id: 'server-1', port: 12430, workRoot: '/tmp' }
const FLAGS = {
  master: 'laptop',
  on: ['threads', 'calendar', 'decisions', 'presence', 'watches', 'todos'],
  threads: { agents: true },
  todos: { agents: true },
  decisions: { defaults: true },
  presence: { state: 'away', since: 1000, by: 'user', mode: 'auto' },
  at: 1,
}

function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}
/** The flags as the node keeps them; just in by default (`at`: now). */
function flags(box: Sandbox, f: Record<string, unknown> = { ...FLAGS, at: Date.now() }): void {
  const dir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/node')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'master-flags.json'), JSON.stringify(f))
}
const cardFile = (box: Sandbox): string => join(box.cards, `${SID}.json`)
const cardOf = (box: Sandbox): Record<string, unknown> | null =>
  existsSync(cardFile(box)) ? JSON.parse(readFileSync(cardFile(box), 'utf8')) : null
function writeCard(box: Sandbox): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(cardFile(box), JSON.stringify({ key: SID, name: 'ticket-12', category: 'acme' }))
}

async function run(box: Sandbox, file: string, args: string[], input?: unknown) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints', file), ...args], {
    cwd: root,
    // The session's own process, as Claude Code runs `board` (CLAUDE_CODE_SESSION_ID).
    env: { ...box.env, HERDR_PANE_ID: 'p1', CLAUDE_CODE_SESSION_ID: SID },
    ...(input !== undefined && { stdin: new TextEncoder().encode(JSON.stringify(input)) }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: `${out}${err}`.trim() }
}
async function sessionStart(box: Sandbox): Promise<string> {
  const r = await run(box, 'hook.ts', [], { hook_event_name: 'SessionStart', session_id: SID, cwd: box.dir })
  expect(r.code).toBe(0)
  return JSON.parse(r.out).hookSpecificOutput.additionalContext
}
const plainBrief = (box: Sandbox): string =>
  brief(normalizeConfig({ language: 'en' }), cardOf(box), box.dir, { ...box.env, HERDR_PANE_ID: 'p1' })

test("a node with its master's flags: the brief tells of threads, calendar, watches, decisions, tasks and presence", async () => {
  const box = await sandbox()
  config(box, { node: NODE })
  flags(box)
  writeCard(box)
  const text = await sessionStart(box)
  useLanguage('en')
  for (const part of [
    threadsBrief(),
    calendarBrief(),
    watchesBrief(),
    decisionsBrief({ defaults: true }),
    todosBrief(),
  ])
    expect(text).toContain(part)
  // The user's state as the master said it, never this node's own "at the computer".
  expect(text).toContain(presenceBrief({ state: 'away', since: 1000, by: 'user' }))
  expect(text).not.toContain('last heard from')
})

test('the master not heard from for a while: the brief says how old its word on presence is', async () => {
  const box = await sandbox()
  config(box, { node: NODE })
  flags(box, { ...FLAGS, at: Date.now() - 2 * 3_600_000 })
  writeCard(box)
  const text = await sessionStart(box)
  expect(text).toContain(presenceBrief({ state: 'away', since: 1000, by: 'user' }))
  expect(text).toContain('[agent-board] The master board was last heard from 2 h ago')
})

test('presence on at the master but no state said: no presence line at all', async () => {
  const box = await sandbox()
  config(box, { node: NODE })
  const { presence: _p, ...noState } = FLAGS
  flags(box, { ...noState, at: Date.now() })
  writeCard(box)
  const text = await sessionStart(box)
  expect(text).not.toContain('- Presence:')
  expect(text).not.toContain('The user is at the computer')
})

test('a node the master sent nothing yet, and a board without node beside a flags file: the brief as before', async () => {
  useLanguage('en')
  for (const [cfg, withFlags] of [
    [{ node: NODE }, false],
    [{}, true],
  ] as const) {
    const box = await sandbox()
    config(box, cfg)
    if (withFlags) flags(box)
    writeCard(box)
    const text = await sessionStart(box)
    expect(text).toBe(plainBrief(box))
  }
})

test('board todo on a node: on via the master; off without its flags, as before', async () => {
  const box = await sandbox()
  config(box, { node: NODE })
  writeCard(box)
  const off = await run(box, 'cli.ts', ['todo', 'add', 'Post the reply', '--session', SID])
  expect(off.code).not.toBe(0)
  expect(off.out).toContain('Tasks are off')
  flags(box)
  const on = await run(box, 'cli.ts', ['todo', 'add', 'Post the reply', '--session', SID])
  expect(on.out).toBe("ok · task acme-ticket-12-1 · the user's")
  expect(on.code).toBe(0)
})

test('board ask with options on a node: the master holds it and the card gets its decision (#781); a plain ask without its flags', async () => {
  const box = await sandbox()
  const calls: Record<string, unknown>[] = []
  let answer: unknown = { state: 'unreachable' }
  // This node's board: POST /api/node/call, which hands the call to the master.
  const board = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/api/node/call')
        return new Response(null, { status: 404 })
      calls.push((await req.json()) as Record<string, unknown>)
      return Response.json(answer)
    },
  })
  try {
    config(box, { node: NODE, port: board.port })
    writeCard(box)
    const plain = await run(box, 'cli.ts', ['ask', 'Which one?', '--option', 'A', '--option', 'B', '--session', SID])
    expect(plain.out).toContain('decisions are off')
    expect(cardOf(box)?.decision).toBeUndefined()
    expect(calls).toEqual([])
    flags(box)
    const held = { id: 'd1', options: ['A', 'B'], recommend: 1 }
    answer = { state: 'answered', code: 0, out: [' · decision d1'], err: [], decision: held }
    const asked = await run(box, 'cli.ts', [
      'ask',
      'Which one?',
      '--option',
      'A',
      '--option',
      'B',
      '--recommend',
      '1',
      '--session',
      SID,
    ])
    expect(asked.code).toBe(0)
    expect(asked.out).toContain('decision d1')
    expect(calls.map(c => [c.cmd, c.argv, c.session])).toEqual([
      ['ask', ['Which one?', '--option', 'A', '--option', 'B', '--recommend', '1', '--'], SID],
    ])
    expect(cardOf(box)?.ask).toBe('Which one?')
    expect(cardOf(box)?.decision).toEqual({ ...held, master: true })
    // board done: the decision leaves the card, and this computer's database is not made for it.
    expect((await run(box, 'cli.ts', ['done', '--session', SID])).code).toBe(0)
    expect(cardOf(box)?.decision).toBeUndefined()
    expect(existsSync(join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/board.db'))).toBe(false)
    // The master not reachable: the question still goes on the card, without options, and says so.
    answer = { state: 'unreachable' }
    const away = await run(box, 'cli.ts', ['ask', 'Which one?', '--option', 'A', '--option', 'B', '--session', SID])
    expect(away.code).toBe(0)
    expect(away.out).toContain("the board's computer is not reachable, so this asks without options")
    expect(cardOf(box)?.ask).toBe('Which one?')
    expect(cardOf(box)?.decision).toBeUndefined()
    // A plain question stays this card's, with no call.
    calls.length = 0
    expect((await run(box, 'cli.ts', ['ask', 'Plain?', '--session', SID])).code).toBe(0)
    expect(calls).toEqual([])
    expect(cardOf(box)?.ask).toBe('Plain?')
  } finally {
    board.stop(true)
  }
})

test('board wait --probe on a node: a watch via the master; words of the wait text without its flags', async () => {
  const box = await sandbox()
  config(box, { node: NODE })
  writeCard(box)
  const plain = await run(box, 'cli.ts', ['wait', 'CI', '--probe', 'exit 1', '--session', SID])
  expect(plain.out).toContain('watches are off')
  const help = await run(box, 'cli.ts', ['--help'])
  expect(help.out).not.toContain('--probe')
  flags(box)
  const helped = await run(box, 'cli.ts', ['--help'])
  expect(helped.out).toContain('--probe')
})
