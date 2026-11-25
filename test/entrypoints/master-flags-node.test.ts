// A node's gates and briefs with its master's flags (#775), as the hooks and `board` run: a node whose
// config.json lost the master-owned sections (the handover) reads them as on via the master once the
// master sent them, and as before without them. A board without `node` reads no flags at all.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brief, calendarBrief, decisionsBrief } from '../../src/core/brief.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { useLanguage } from '../../src/core/lang.ts'
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
  at: 1,
}

function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}
function flags(box: Sandbox, f: unknown = FLAGS): void {
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
  expect(text).toContain('- Presence: the board knows')
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

test('board ask with options on a node: a decision on the card via the master; a plain ask without its flags', async () => {
  const box = await sandbox()
  config(box, { node: NODE })
  writeCard(box)
  const plain = await run(box, 'cli.ts', ['ask', 'Which one?', '--option', 'A', '--option', 'B', '--session', SID])
  expect(plain.out).toContain('decisions are off')
  expect(cardOf(box)?.decision).toBeUndefined()
  flags(box)
  const asked = await run(box, 'cli.ts', ['ask', 'Which one?', '--option', 'A', '--option', 'B', '--session', SID])
  expect(asked.code).toBe(0)
  expect(asked.out).not.toContain('decisions are off')
  expect(cardOf(box)?.decision).toMatchObject({ options: ['A', 'B'] })
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
