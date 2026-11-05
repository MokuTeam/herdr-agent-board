// Tasks from the agent's side (#202, #319): `board todo` with keys, what a task refers to and
// waits on, and closing the user's tasks (proposed, or closed with autoClose); the hook's line of
// the session's open tasks, once per change and again on a start. A setup without tasks sees none of it.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(15_000)

const SID = '11111111-2222-3333-4444-555555555555'
type Card = Record<string, unknown> & { todos?: Record<string, unknown>[]; todoSeq?: number; todosSeen?: string }
const cardFile = (box: Sandbox, key: string): string => join(box.cards, `${key}.json`)
const cardOf = (box: Sandbox, key = SID): Card | null =>
  existsSync(cardFile(box, key)) ? JSON.parse(readFileSync(cardFile(box, key), 'utf8')) : null
function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}
function writeCard(box: Sandbox, card: Card, key = SID): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(cardFile(box, key), JSON.stringify({ key, ...card }))
}

async function run(box: Sandbox, file: string, args: string[], input?: unknown) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints', file), ...args], {
    cwd: root,
    env: { ...box.env, HERDR_PANE_ID: 'p1' },
    ...(input !== undefined && { stdin: new TextEncoder().encode(JSON.stringify(input)) }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: `${out}${err}`.trim() }
}
const todo = (box: Sandbox, ...args: string[]) => run(box, 'cli.ts', ['todo', ...args, '--session', SID])
const hook = async (box: Sandbox, event: string): Promise<string> => {
  const r = await run(box, 'hook.ts', [], { hook_event_name: event, session_id: SID, cwd: box.dir, prompt: 'go on' })
  expect(r.code).toBe(0)
  return r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : ''
}

test('board todo add prints the key; ref and why are kept; list shows keys; done by key or number', async () => {
  const box = await sandbox()
  config(box, { todos: true })
  writeCard(box, { name: 'ticket-12', category: 'acme' })
  const add = await todo(box, 'add', '--ref', 'TICKET-12', '--why', 'waits on the client', 'Post the reply')
  expect(add.code).toBe(0)
  expect(add.out).toBe("ok · task acme-ticket-12-1 · the user's")
  expect(cardOf(box)?.todos?.[0]).toMatchObject({
    text: 'Post the reply',
    n: 1,
    ref: 'TICKET-12',
    why: 'waits on the client',
    by: 'agent',
  })
  expect((await todo(box, 'add', '--mine', 'Run the migration after the review')).out).toBe(
    'ok · task acme-ticket-12-2 · yours',
  )
  expect((await todo(box, 'list')).out).toBe(
    [
      "acme-ticket-12-1 · the user's · Post the reply · ref TICKET-12",
      'acme-ticket-12-2 · yours · Run the migration after the review',
    ].join('\n'),
  )
  // The agent's own: closed by its number.
  expect((await todo(box, 'done', '2')).out).toBe('ok · task acme-ticket-12-2 done')
  // The user's: proposed, open until the user confirms.
  const proposed = await todo(box, 'done', 'acme-ticket-12-1', '--why', 'the comment is posted')
  expect(proposed.code).toBe(0)
  expect(proposed.out).toBe('ok · task acme-ticket-12-1 proposed done: the user confirms it on the board')
  expect(cardOf(box)?.todos?.[0]).toMatchObject({ proposed: { why: 'the comment is posted' } })
  expect(cardOf(box)?.todos?.[0]).not.toHaveProperty('done')
  expect((await todo(box, 'list')).out).toBe(
    "acme-ticket-12-1 · the user's, proposed done · Post the reply · ref TICKET-12",
  )
  const none = await todo(box, 'done', 'acme-ticket-12-9')
  expect(none.code).not.toBe(0)
  expect(none.out).toMatch(/No such task/)
})

test("autoClose: the agent closes the user's task itself, with its reason", async () => {
  const box = await sandbox()
  config(box, { todos: { autoClose: true } })
  writeCard(box, { name: 'Solo' })
  expect((await todo(box, 'add', 'Send the file')).out).toBe("ok · task solo-1 · the user's")
  expect((await todo(box, 'done', 'solo-1', '--why', 'sent')).out).toBe('ok · task solo-1 done')
  expect(cardOf(box)?.todos?.[0]).toMatchObject({ doneBy: 'agent', doneWhy: 'sent' })
})

test('tasks made before numbers get them in the order they were made, the same on the board and in the CLI', async () => {
  const box = await sandbox()
  config(box, { todos: true })
  writeCard(box, {
    name: 'x',
    category: 'acme',
    todos: [
      { id: 'bbbbbbbb', text: 'second', owner: 'user', by: 'agent', at: 20 },
      { id: 'aaaaaaaa', text: 'first', owner: 'user', by: 'user', at: 10 },
    ],
  })
  expect((await todo(box, 'list')).out).toBe(
    ["acme-x-1 · the user's · first", "acme-x-2 · the user's · second"].join('\n'),
  )
  expect((await todo(box, 'add', 'third')).out).toBe("ok · task acme-x-3 · the user's")
  expect(cardOf(box)?.todos?.map(x => [x.id, x.n])).toEqual([
    ['bbbbbbbb', 2],
    ['aaaaaaaa', 1],
    [expect.any(String), 3],
  ])
  expect(cardOf(box)?.todoSeq).toBe(3)
})

test('the hook: the open tasks once per change, again on a start; nothing with agents off or no tasks', async () => {
  const box = await sandbox()
  config(box, { todos: true })
  writeCard(box, { name: 'ticket-12', category: 'acme', briefV: 99 })
  // No tasks yet: nothing said, nothing marked.
  expect(await hook(box, 'UserPromptSubmit')).not.toMatch(/open tasks/)
  expect(cardOf(box)).not.toHaveProperty('todosSeen')
  await todo(box, 'add', '--ref', 'TICKET-12', 'Post the reply')
  const first = await hook(box, 'UserPromptSubmit')
  expect(first).toMatch(/This session's open tasks on the board/)
  expect(first).toMatch(/acme-ticket-12-1 · the user's · Post the reply · ref TICKET-12/)
  expect(first).toMatch(/board todo done <key> --why/)
  expect(await hook(box, 'UserPromptSubmit')).not.toMatch(/open tasks/)
  // A start (a resume, a compaction): told again.
  expect(await hook(box, 'SessionStart')).toMatch(/acme-ticket-12-1/)
  expect(await hook(box, 'UserPromptSubmit')).not.toMatch(/open tasks/)
  // Proposed done: a change, told once.
  await todo(box, 'done', '1')
  expect(await hook(box, 'UserPromptSubmit')).toMatch(/you proposed it done/)
  expect(await hook(box, 'UserPromptSubmit')).not.toMatch(/open tasks/)
  // Pins only: the agent hears nothing of them.
  config(box, { todos: { agents: false } })
  writeCard(box, { ...cardOf(box), todosSeen: '' })
  expect(await hook(box, 'UserPromptSubmit')).not.toMatch(/open tasks/)
})

test('without tasks in config.json a card with old tasks gets no line and no mark', async () => {
  const box = await sandbox()
  config(box)
  writeCard(box, {
    name: 'x',
    briefV: 99,
    todos: [{ id: 'aaaaaaaa', text: 'first', owner: 'user', by: 'user', at: 10 }],
  })
  expect(await hook(box, 'UserPromptSubmit')).toBe('')
  expect(cardOf(box)).not.toHaveProperty('todosSeen')
  expect((await todo(box, 'list')).out).toMatch(/Tasks are off/)
})
