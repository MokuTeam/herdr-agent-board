import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BRIEF_VERSION } from '../../src/core/brief.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const ID = '01a15a8a-bd97-7701-a7f7-401e4bec3147'
type Card = Record<string, unknown>
const readCard = (box: Sandbox): Card | null => {
  const file = join(box.cards, `${ID}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Card) : null
}
function putCard(box: Sandbox, card: Card): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${ID}.json`), JSON.stringify({ key: ID, ...card }))
}
function configure(box: Sandbox, agent = 'codex', session = ID): void {
  const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, '{"language":"en","port":9}')
  box.state({ 'agent get p1': { result: { agent: { agent, agent_session: { value: session } } } } })
}
async function hook(box: Sandbox, event: string, prompt = '', extra: Record<string, string> = {}, raw?: string) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/codex-hook.ts')], {
    cwd: root,
    env: { ...box.env, HERDR_PANE_ID: 'p1', CODEX_THREAD_ID: ID, ...extra },
    stdin: new TextEncoder().encode(
      raw ?? JSON.stringify({ hook_event_name: event, session_id: ID, cwd: box.dir, prompt }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited).toBe(0)
  expect(err).toBe('')
  return out
}

test('Codex SessionStart gives the card brief, without Claude profile metadata or Claude-only instructions', async () => {
  const box = await sandbox()
  configure(box)
  const out = JSON.parse(await hook(box, 'SessionStart'))
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(out.hookSpecificOutput.additionalContext).toContain('every Codex session')
  expect(out.hookSpecificOutput.additionalContext).toContain('board doing')
  expect(out.hookSpecificOutput.additionalContext).toContain(`board --session ${ID}`)
  expect(out.hookSpecificOutput.additionalContext).not.toContain('CronCreate')
  expect(readCard(box)).toMatchObject({ briefV: BRIEF_VERSION })
  expect(readCard(box)?.profileDir).toBeUndefined()
})

test('first prompt briefs an already running Codex session; subsequent prompts clear ask/pin without another brief', async () => {
  const box = await sandbox()
  configure(box)
  expect(await hook(box, 'UserPromptSubmit', 'hello')).toContain('additionalContext')
  putCard(box, { ...readCard(box), ask: 'Push?', askSince: 1, pin: 'me' })
  expect(await hook(box, 'UserPromptSubmit', 'yes')).toBe('')
  for (const field of ['ask', 'askSince', 'pin', 'pinAt', 'pinBusy']) expect(readCard(box)?.[field]).toBeUndefined()
})

test('the root hook refreshes a changed inherited Claude identity, including its removal', async () => {
  const box = await sandbox()
  configure(box)
  for (const parent of ['previous-claude', 'current-claude', '']) {
    await hook(box, 'UserPromptSubmit', 'hello', { CLAUDE_CODE_SESSION_ID: parent })
    expect(readCard(box)?.codexParentClaude).toBe(parent || false)
  }
})

test('a pure Codex root can update its board card without a Claude identity or prior hook record', async () => {
  const box = await sandbox()
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [{ pane_id: 'p1', agent: 'codex', agent_session: { value: ID } }],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const result = await box.run('cli', {
    args: ['doing', 'Codex root'],
    env: { CODEX_THREAD_ID: ID, HERDR_PANE_ID: 'p1' },
  }).exited
  expect(result.code).toBe(0)
  expect(readCard(box)?.doing).toBe('Codex root')
})

test('a reminder preserves ask; waiting sessions get the same wait reminder as Claude', async () => {
  const box = await sandbox()
  configure(box)
  putCard(box, { briefV: BRIEF_VERSION, ask: 'Push?', askSince: 1, pin: 'me', wait: 'CI' })
  expect(await hook(box, 'UserPromptSubmit', '[board reminder] check CI')).toContain(
    'This session\u0027s card says it waits for',
  )
  expect(readCard(box)).toMatchObject({ ask: 'Push?', askSince: 1 })
  expect(readCard(box)?.pin).toBeUndefined()
})

test('Claude, pi and a replaced Codex session never receive a Codex brief or a card write', async () => {
  const box = await sandbox()
  for (const [kind, session] of [
    ['claude', ID],
    ['pi', '/tmp/pi.jsonl'],
    ['codex', 'other'],
  ]) {
    configure(box, kind, session)
    expect(await hook(box, 'SessionStart')).toBe('')
    expect(readCard(box)).toBeNull()
  }
})

test('a Codex child, missing pane context or irrelevant event does not even query herdr', async () => {
  const box = await sandbox()
  configure(box)
  expect(await hook(box, 'SessionStart', '', { CODEX_THREAD_ID: 'child' })).toBe('')
  expect(await hook(box, 'SessionStart', '', { HERDR_PANE_ID: '' })).toBe('')
  expect(await hook(box, 'Stop')).toBe('')
  expect(box.calls()).toEqual([])
})

test('malformed hook input and unavailable herdr stay silent and leave the card alone', async () => {
  const box = await sandbox()
  putCard(box, { ask: 'Push?' })
  const before = readCard(box)
  expect(await hook(box, 'SessionStart', '', {}, '{broken')).toBe('')
  expect(box.calls()).toEqual([])
  box.state({ 'agent get p1': { error: 'offline' } })
  expect(await hook(box, 'SessionStart')).toBe('')
  expect(readCard(box)).toEqual(before)
})

test('board commands prefer the reported Codex identity over inherited Claude env, and refuse a child session', async () => {
  const box = await sandbox()
  configure(box)
  await hook(box, 'SessionStart', '', { CLAUDE_CODE_SESSION_ID: 'parent-claude' })
  expect(readCard(box)?.codexParentClaude).toBe('parent-claude')
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          panes: [{ pane_id: 'p1', agent: 'codex', agent_session: { value: ID }, cwd: 'C:\\Work\\Проект 100%' }],
          tabs: [],
          workspaces: [],
        },
      },
    },
  })
  const env = { CODEX_THREAD_ID: ID, CLAUDE_CODE_SESSION_ID: 'parent-claude', HERDR_PANE_ID: 'p1' }
  for (const args of [
    ['doing', 'fix hooks'],
    ['ask', 'Push?'],
    ['wait', 'CI'],
    ['done', 'fixed'],
    ['cat', 'work', 'Работа'],
  ])
    expect((await box.run('cli', { args, env }).exited).code).toBe(0)
  expect(readCard(box)).toMatchObject({ result: 'fixed', category: 'work' })
  for (const field of ['doing', 'wait', 'ask']) expect(readCard(box)?.[field]).toBeUndefined()
  expect(existsSync(join(box.cards, 'parent-claude.json'))).toBe(false)
  const before = readCard(box)
  const child = await box.run('cli', {
    args: ['doing', 'wrong'],
    env: { CODEX_THREAD_ID: 'child', HERDR_PANE_ID: 'p1' },
  }).exited
  expect(child.code).toBe(1)
  expect(child.stderr).toContain('cannot tell which Codex session')
  expect(readCard(box)).toEqual(before)
  const explicit = await box.run('cli', { args: ['--session', ID, 'doing', 'tool shell'] }).exited
  expect(explicit.code).toBe(0)
  expect(readCard(box)?.doing).toBe('tool shell')
})

test('a Claude child of a Codex root keeps its own card, including when herdr is offline', async () => {
  const box = await sandbox()
  configure(box)
  await hook(box, 'SessionStart', '', { CLAUDE_CODE_SESSION_ID: 'codex-inherited-parent' })
  const before = readCard(box)
  const calls = box.calls().length
  for (const offline of [false, true]) {
    box.state(
      offline
        ? { 'api snapshot': { error: 'offline' } }
        : {
            'api snapshot': {
              result: {
                snapshot: {
                  panes: [{ pane_id: 'p1', agent: 'codex', agent_session: { value: ID } }],
                  tabs: [],
                  workspaces: [],
                },
              },
            },
          },
    )
    for (const args of [
      ['doing', 'Claude child'],
      ['ask', 'Approve?'],
      ['done', 'child result'],
    ]) {
      const result = await box.run('cli', {
        args,
        env: {
          CODEX_THREAD_ID: ID,
          HERDR_PANE_ID: 'p1',
          CLAUDE_CODE_SESSION_ID: 'claude-child',
        },
      }).exited
      expect(result.code).toBe(0)
    }
    expect(JSON.parse(readFileSync(join(box.cards, 'claude-child.json'), 'utf8')).result).toBe('child result')
    expect(readCard(box)).toEqual(before)
  }
  expect(box.calls()).toHaveLength(calls)
})

test('without a Codex hook record a mixed environment keeps Claude priority; explicit target is available', async () => {
  const box = await sandbox()
  configure(box)
  const env = { CODEX_THREAD_ID: ID, CLAUDE_CODE_SESSION_ID: 'claude-own', HERDR_PANE_ID: 'p1' }
  expect((await box.run('cli', { args: ['doing', 'Claude'], env }).exited).code).toBe(0)
  expect(readCard(box)).toBeNull()
  expect(box.calls()).toEqual([])
  expect((await box.run('cli', { args: ['--session', ID, 'doing', 'Codex'], env }).exited).code).toBe(0)
  expect(readCard(box)?.doing).toBe('Codex')
})

test('a Claude or pi bridge session carrying an inherited CODEX_THREAD_ID keeps its own Claude card', async () => {
  const box = await sandbox()
  configure(box)
  for (const agent of ['claude', 'pi']) {
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [{ pane_id: 'p1', agent, agent_session: { value: 'claude-own' } }],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    const result = await box.run('cli', {
      args: ['doing', agent],
      env: {
        CODEX_THREAD_ID: ID,
        CLAUDE_CODE_SESSION_ID: 'claude-own',
        HERDR_PANE_ID: 'p1',
      },
    }).exited
    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(join(box.cards, 'claude-own.json'), 'utf8')).doing).toBe(agent)
    expect(readCard(box)).toBeNull()
  }
})
