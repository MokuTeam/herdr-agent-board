import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BRIEF_VERSION } from '../../src/core/brief.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const ID = '18fb0773-7c19-4e3d-8e9b-ceadaef29211'
type Card = Record<string, unknown>

const readCard = (box: Sandbox): Card | null => {
  const file = join(box.cards, `${ID}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Card) : null
}
function putCard(box: Sandbox, card: Card): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${ID}.json`), JSON.stringify({ key: ID, ...card }))
}
function configure(box: Sandbox, agent = 'agy', session: string | null = ID): void {
  const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, '{"language":"en","port":9}')
  box.state({
    'agent get p1': {
      result: {
        agent: {
          agent,
          ...(session !== null && { agent_session: { value: session } }),
        },
      },
    },
  })
}
async function hook(
  box: Sandbox,
  event: string,
  payload: Record<string, unknown> = {},
  extra: Record<string, string> = {},
  raw?: string,
) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/agy-hook.ts')], {
    cwd: root,
    env: { ...box.env, HERDR_ENV: '1', HERDR_PANE_ID: 'p1', ANTIGRAVITY_CONVERSATION_ID: ID, ...extra },
    stdin: new TextEncoder().encode(
      raw ??
        JSON.stringify({
          hookEventName: event,
          conversationId: ID,
          cwd: box.dir,
          lastUserInput: '',
          ...payload,
        }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited).toBe(0)
  expect(err).toBe('')
  return JSON.parse(out) as Record<string, unknown>
}

test('Antigravity SessionStart injects brief as systemMessage even before herdr reports agent_session', async () => {
  const box = await sandbox()
  configure(box, 'agy', null)
  const out = await hook(box, 'SessionStart')
  const steps = out.injectSteps as { systemMessage: { systemMessage: string } }[]
  expect(steps).toHaveLength(1)
  const text = steps[0]?.systemMessage.systemMessage ?? ''
  expect(text).toContain('every Antigravity session')
  expect(text).toContain('board doing')
  expect(text).toContain(`board --session ${ID}`)
  expect(text).toContain('herdr-agents skill')
  expect(text).not.toContain('CronCreate')
  expect(readCard(box)).toMatchObject({ briefV: BRIEF_VERSION })
  expect(readCard(box)?.profileDir).toBeUndefined()
})

test('PreInvocation briefs once, clears ask/pin only on a new turn, and keeps ask across tool-loop invocations', async () => {
  const box = await sandbox()
  configure(box)
  const first = await hook(box, 'PreInvocation', { lastUserInput: 'hello', invocationNum: 1, initialNumSteps: 1 })
  expect(first.injectSteps).toBeDefined()

  // Same turn (tool loop: initialNumSteps unchanged): agent just ran `board ask`, hook must NOT clear it.
  putCard(box, { ...readCard(box), ask: 'Approve?', askSince: 1, pin: 'me', wait: 'CI' })
  const sameTurn = await hook(box, 'PreInvocation', { lastUserInput: 'hello', invocationNum: 2, initialNumSteps: 1 })
  expect(sameTurn).toEqual({})
  expect(readCard(box)).toMatchObject({ ask: 'Approve?', pin: 'me' })

  // Next user turn (initialNumSteps increased): clears ask and pin, injects waitReminder.
  const nextTurn = await hook(box, 'PreInvocation', { lastUserInput: 'yes', invocationNum: 1, initialNumSteps: 5 })
  const steps = nextTurn.injectSteps as { systemMessage: { systemMessage: string } }[]
  expect(steps[0]?.systemMessage.systemMessage).toContain("This session's card says it waits for")
  for (const field of ['ask', 'askSince', 'pin', 'pinAt', 'pinBusy']) expect(readCard(box)?.[field]).toBeUndefined()
})

test('board reminder preserves ask while unpinning the card', async () => {
  const box = await sandbox()
  configure(box)
  putCard(box, { briefV: BRIEF_VERSION, ask: 'Push?', askSince: 1, pin: 'me', wait: 'CI', agyTurnSteps: 2 })
  const out = await hook(box, 'PreInvocation', {
    lastUserInput: '[board reminder] check CI',
    invocationNum: 1,
    initialNumSteps: 4,
  })
  expect(JSON.stringify(out)).toContain("This session's card says it waits for")
  expect(readCard(box)).toMatchObject({ ask: 'Push?', askSince: 1 })
  expect(readCard(box)?.pin).toBeUndefined()
})

test('non-agy panes, subagents, missing pane context, malformed input and offline herdr emit {} and leave cards alone', async () => {
  const box = await sandbox()
  for (const [kind, session] of [
    ['claude', ID],
    ['pi', '/tmp/pi.jsonl'],
    ['codex', ID],
    ['agy', '00000000-0000-0000-0000-000000000001'],
  ] as const) {
    configure(box, kind, session)
    expect(await hook(box, 'SessionStart')).toEqual({})
    expect(readCard(box)).toBeNull()
  }
  configure(box)
  const beforeCalls = box.calls().length
  expect(await hook(box, 'SessionStart', {}, { ANTIGRAVITY_CONVERSATION_ID: 'child-id' })).toEqual({})
  expect(await hook(box, 'SessionStart', {}, { HERDR_PANE_ID: '' })).toEqual({})
  expect(await hook(box, 'Stop')).toEqual({})
  expect(await hook(box, 'SessionStart', {}, {}, '{broken')).toEqual({})
  expect(box.calls()).toHaveLength(beforeCalls)

  putCard(box, { ask: 'Keep?' })
  const before = readCard(box)
  box.state({ 'agent get p1': { error: 'offline' } })
  expect(await hook(box, 'SessionStart')).toEqual({})
  expect(readCard(box)).toEqual(before)
})

test('board CLI resolves agy root identity, handles mixed Claude env, and refuses agy subagent without --session', async () => {
  const box = await sandbox()
  configure(box)
  await hook(box, 'SessionStart', {}, { CLAUDE_CODE_SESSION_ID: 'parent-claude' })
  expect(readCard(box)?.agyParentClaude).toBe('parent-claude')

  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [{ pane_id: 'p1', agent: 'agy', agent_session: { value: ID }, cwd: '/work/Проект 100%' }],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const env = { ANTIGRAVITY_CONVERSATION_ID: ID, CLAUDE_CODE_SESSION_ID: 'parent-claude', HERDR_PANE_ID: 'p1' }
  for (const args of [
    ['doing', 'agy tasks'],
    ['ask', 'Ship?'],
    ['wait', 'CI'],
    ['done', 'shipped'],
    ['cat', 'work', 'Работа'],
  ])
    expect((await box.run('cli', { args, env }).exited).code).toBe(0)
  expect(readCard(box)).toMatchObject({ result: 'shipped', category: 'work' })
  expect(existsSync(join(box.cards, 'parent-claude.json'))).toBe(false)

  // A subagent in the same pane cannot silently overwrite the root card without --session.
  const sub = await box.run('cli', {
    args: ['doing', 'subagent'],
    env: { ANTIGRAVITY_CONVERSATION_ID: '909adb87-3850-4c02-acf4-dc87166db197', HERDR_PANE_ID: 'p1' },
  }).exited
  expect(sub.code).toBe(1)
  expect(sub.stderr).toContain('cannot tell which Antigravity session')

  // A Claude child spawned inside an agy pane keeps its own Claude card even when herdr is offline.
  box.state({ 'api snapshot': { error: 'offline' } })
  const claudeChild = await box.run('cli', {
    args: ['doing', 'Claude child'],
    env: { ANTIGRAVITY_CONVERSATION_ID: ID, CLAUDE_CODE_SESSION_ID: 'claude-child', HERDR_PANE_ID: 'p1' },
  }).exited
  expect(claudeChild.code).toBe(0)
  expect(JSON.parse(readFileSync(join(box.cards, 'claude-child.json'), 'utf8')).doing).toBe('Claude child')
})
