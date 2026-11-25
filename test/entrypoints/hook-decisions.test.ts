// The hook's side of decisions (#487): a prompt that clears a card's ask closes its open decision,
// as the owner's answer only for the owner's own words. A board reminder, a Team notice, a task
// notification and Code Mode's background result (source poll_event) leave the ask and the decision
// as on main, and so does a restart's note the board types; another session's message, a Code Mode
// envelope without that source and a slash command (the board's own /compact) clear the ask as on
// main, and the decision is recorded as withdrawn, never as the owner's.
import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDecision } from '../../src/adapters/decision-store.ts'
import type { AskSpec } from '../../src/core/decisions.ts'
import { askDecision, withDecisionsDb } from '../../src/services/decisions.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { notification } from '../support/task-notification.ts'

setDefaultTimeout(20_000)

const SID = '11111111-2222-4333-8444-555555555555'
const spec: AskSpec = { question: 'Merge now?', options: ['yes', 'no'], recommend: 1, defaultMs: 3_600_000 }

/** `fn` with this process pointed at the sandbox's config and state folders. */
function inBox<T>(box: Sandbox, fn: () => T): T {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const cardOf = (box: Sandbox): Record<string, unknown> | null =>
  existsSync(join(box.cards, `${SID}.json`)) ? JSON.parse(readFileSync(join(box.cards, `${SID}.json`), 'utf8')) : null

async function setUp(): Promise<{ box: Sandbox; id: string }> {
  const box = await sandbox()
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', decisions: true }))
  const id = inBox(
    box,
    () =>
      withDecisionsDb(db =>
        askDecision(db, { key: SID, name: 'anna', spec, ask: spec.question, now: Date.now() - 60_000 }),
      ).id,
  )
  // Briefed already, so the prompt's output is only what the card says.
  const card = cardOf(box) as Record<string, unknown>
  writeFileSync(join(box.cards, `${SID}.json`), JSON.stringify({ ...card, briefV: 99, briefedAt: 1 }))
  return { box, id }
}

async function prompt(box: Sandbox, text: string, extra: Record<string, unknown> = {}): Promise<string> {
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'hook.ts')], {
    cwd: root,
    env: { ...box.env, HERDR_PANE_ID: 'p1' },
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: box.dir, prompt: text, ...extra }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  assert.equal(await proc.exited, 0, stderr)
  assert.equal(stderr, '')
  return stdout
}

const rowOf = (box: Sandbox, id: string) => inBox(box, () => withDecisionsDb(db => getDecision(db, id)))

test("the owner's own prompt: the ask and the decision go, recorded as the owner's answer", async () => {
  const { box, id } = await setUp()
  expect(await prompt(box, 'no, wait for the review\nthanks')).toBe('')
  expect(cardOf(box)?.ask).toBeUndefined()
  expect(cardOf(box)?.decision).toBeUndefined()
  expect(rowOf(box, id)).toMatchObject({ answer: 'no, wait for the review', answeredBy: 'owner', via: 'prompt' })
})

for (const [what, text, extra] of [
  ['a board reminder', '[board reminder] check CI', {}],
  ['a Team notice', '[board reminder from team] cleo posted in atlas-2', {}],
  ["a restart's note the board types", '[board reminder; restarted at 10:00] go on with the review', {}],
  ['a task notification', notification('Background command "x" completed (exit code 0)'), {}],
  [
    "Code Mode's background result (#424)",
    '<event kind="repl-eval" at="2026-11-21T10:00:00Z">ok</event>',
    { source: 'poll_event' },
  ],
] as const) {
  test(`${what}: the ask and the decision stay open, as the ask does on main`, async () => {
    const { box, id } = await setUp()
    await prompt(box, text, extra)
    expect(cardOf(box)?.ask).toBe('Merge now?')
    expect((cardOf(box)?.decision as { id?: string } | undefined)?.id).toBe(id)
    expect(rowOf(box, id)?.answeredAt).toBeNull()
  })
}

for (const [what, text] of [
  ["another session's message", '<cross-session-message from="x" from-name="ben">yes, merge</cross-session-message>'],
  ["a teammate's message", '<teammate-message teammate_id="t1">merge it</teammate-message>'],
  ["an agent's message", '<agent-message from="cleo">merge it</agent-message>'],
  ['a Code Mode envelope without poll_event (#445)', '<event kind="repl-eval" at="2026-11-21T10:00:00.5Z">yes</event>'],
  ["the board's own /compact", '/compact keep the plan for #487'],
] as const) {
  test(`${what}: the ask goes as on main, the decision is withdrawn, never the owner's`, async () => {
    const { box, id } = await setUp()
    await prompt(box, text)
    expect(cardOf(box)?.ask).toBeUndefined()
    expect(cardOf(box)?.decision).toBeUndefined()
    expect(rowOf(box, id)).toMatchObject({ answer: null, answeredBy: 'withdrawn', via: 'cleared' })
  })
}

test("a node's card (#781): the decision its master holds leaves with the ask; this computer's database is not made for it", async () => {
  const box = await sandbox()
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ language: 'en', node: { id: 'server-1', port: 12430, workRoot: '/tmp' } }),
  )
  mkdirSync(box.cards, { recursive: true })
  const decision = { id: 'd1', options: ['yes', 'no'], recommend: 1, master: true }
  writeFileSync(
    join(box.cards, `${SID}.json`),
    JSON.stringify({ key: SID, ask: 'Merge now?', askSince: Date.now() - 60_000, decision, briefV: 99, briefedAt: 1 }),
  )
  await prompt(box, 'yes')
  expect(cardOf(box)?.ask).toBeUndefined()
  expect(cardOf(box)?.decision).toBeUndefined()
  expect(existsSync(join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/board.db'))).toBe(false)
})
