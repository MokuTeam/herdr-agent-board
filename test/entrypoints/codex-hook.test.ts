import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BRIEF_VERSION, CODEX_BRIEF_VERSION } from '../../src/core/brief.ts'
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
  expect(readCard(box)).toMatchObject({ briefV: CODEX_BRIEF_VERSION })
  expect(readCard(box)?.profileDir).toBeUndefined()
})

test('native Codex hook refreshes post-#918 sessions and gates Workdesk guidance', async () => {
  const box = await sandbox()
  configure(box)
  const file = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  const env = { HERDR_ENV: '1' }
  const setWorkers = (workerBriefSessions: string[]) =>
    writeFileSync(file, JSON.stringify({ language: 'en', port: 9, workdesk: { workerBriefSessions } }))
  setWorkers(['another-id'])
  putCard(box, { briefV: CODEX_BRIEF_VERSION })
  const other = await hook(box, 'UserPromptSubmit', 'next step', env)
  expect(other).not.toContain('Workdesk rule 8')
  expect(other).toContain('board ask')
  expect(readCard(box)?.briefV).toBe(CODEX_BRIEF_VERSION + 1)
  setWorkers([ID])
  expect(await hook(box, 'SessionStart', '', env)).toContain('Workdesk rule 8')
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
  putCard(box, { briefV: CODEX_BRIEF_VERSION, ask: 'Push?', askSince: 1, pin: 'me', wait: 'CI' })
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

test("a resumed Codex pane herdr reports no session for is the hook's session by its `codex resume <id>` command", async () => {
  const box = await sandbox()
  configure(box)
  const running = (...argv: string[]) => ({
    result: { process_info: { shell_pid: 1, foreground_processes: [{ pid: 2, argv, name: 'codex' }] } },
  })
  box.state({
    'agent get p1': { result: { agent: { agent: 'codex' } } },
    'pane process-info --pane p1': running('codex', 'resume', ID, '--no-daemon'),
  })
  putCard(box, { briefV: CODEX_BRIEF_VERSION, ask: 'Push?', askSince: 1 })
  expect(await hook(box, 'UserPromptSubmit', 'yes')).toBe('')
  expect(readCard(box)?.ask).toBeUndefined()
  // A fresh Codex (no resume) without a session yet stays unbriefed, as before.
  box.state({
    'agent get p1': { result: { agent: { agent: 'codex' } } },
    'pane process-info --pane p1': running('codex', '--no-daemon'),
  })
  putCard(box, { ask: 'Push?', askSince: 1 })
  expect(await hook(box, 'SessionStart')).toBe('')
  expect(readCard(box)?.ask).toBe('Push?')
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

test('Codex hears of threads where config.json turns them on, and is not promised a wake from sleep', async () => {
  const off = await sandbox()
  configure(off)
  const plain = JSON.parse(await hook(off, 'SessionStart')).hookSpecificOutput.additionalContext
  expect(plain).not.toContain('board thread post')
  expect(plain).not.toContain('waking it if it sleeps')

  const on = await sandbox()
  configure(on)
  const config = join(on.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  writeFileSync(config, '{"language":"en","port":9,"threads":true}')
  const text = JSON.parse(await hook(on, 'SessionStart')).hookSpecificOutput.additionalContext
  expect(text).toContain('board thread post <key>')
  expect(text).toContain('board remind <when>')
  expect(text).not.toContain('waking it if it sleeps')
  writeFileSync(config, '{"language":"en","port":9,"threads":{"agents":false}}')
  expect(JSON.parse(await hook(on, 'SessionStart')).hookSpecificOutput.additionalContext).not.toContain('board thread')
})

test('a Codex card briefed with the Claude count is briefed again once; one at the Codex count is not', async () => {
  const box = await sandbox()
  configure(box)
  putCard(box, { briefV: BRIEF_VERSION })
  expect(await hook(box, 'UserPromptSubmit', 'next task')).toContain('every Codex session')
  expect(readCard(box)).toMatchObject({ briefV: CODEX_BRIEF_VERSION })
  expect(await hook(box, 'UserPromptSubmit', 'next task')).toBe('')
})

test('Codex gets MCP-first brief when agent-board is in config.toml (#911); boardMcp: false or no entry keeps commands', async () => {
  const box = await sandbox()
  configure(box)
  const home = box.env.USERPROFILE as string
  const config = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
  // No entry in config.toml: command brief as before.
  const withoutEntry = JSON.parse(await hook(box, 'SessionStart')).hookSpecificOutput.additionalContext as string
  expect(withoutEntry).toContain('- board doing')
  expect(withoutEntry).not.toContain("agent-board` MCP server's tools")

  // Entry in ~/.codex/config.toml (plus Team on): MCP-first brief with --session fallback and MCP waitReminder.
  writeFileSync(config, JSON.stringify({ language: 'en', port: 9, team: { hub: 'wss://hub.example', name: 'anna' } }))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.agent-board]\nurl = "http://127.0.0.1:9/mcp"\n')
  const withEntry = JSON.parse(await hook(box, 'SessionStart')).hookSpecificOutput.additionalContext as string
  expect(withEntry).toContain("Use the `agent-board` MCP server's tools")
  expect(withEntry).toContain('- card: op `cat`')
  expect(withEntry).toContain('- team: op `roster`')
  expect(withEntry).toContain(`board --session ${ID} <command>`)
  expect(withEntry).not.toContain('- board doing')

  putCard(box, { briefV: CODEX_BRIEF_VERSION, wait: 'CI' })
  const waitMsg = JSON.parse(await hook(box, 'UserPromptSubmit', 'next')).hookSpecificOutput.additionalContext as string
  expect(waitMsg).toContain('card op doing / done / wait')

  // boardMcp: false reverts to command brief even with config.toml entry present.
  writeFileSync(config, '{"language":"en","port":9,"boardMcp":false}')
  const disabled = JSON.parse(await hook(box, 'SessionStart')).hookSpecificOutput.additionalContext as string
  expect(disabled).toContain('- board doing')
  expect(disabled).not.toContain("agent-board` MCP server's tools")
})
