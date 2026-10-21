import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, sep } from 'node:path'
import { BRIEF_VERSION, brief, waitReminder } from '../../src/core/brief.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { sameDir } from '../../src/core/launch/names.ts'
import { promptOf } from '../../src/core/schedule-rules.ts'
import { root, type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { notification } from '../support/task-notification.ts'

setDefaultTimeout(15_000)

// The Claude Code hook against a sandbox's cards and config.
type Card = Record<string, unknown>
const cardOf = (box: Sandbox, key: string): Card | null =>
  existsSync(join(box.cards, `${key}.json`)) ? JSON.parse(readFileSync(join(box.cards, `${key}.json`), 'utf8')) : null
function putCard(box: Sandbox, card: Card & { key: string }): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${card.key}.json`), JSON.stringify(card))
}
const configFile = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
function englishConfig(box: Sandbox): void {
  mkdirSync(join(configFile(box), '..'), { recursive: true })
  writeFileSync(configFile(box), JSON.stringify({ language: 'en' }))
}
/** A Claude profile folder in the sandbox's home: one with settings.json is found. */
function profileFolder(box: Sandbox, name: string): string {
  const dir = join(box.env.USERPROFILE as string, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{}')
  return dir
}
/** `C:\x` as `c:\x` and back: the same folder on Windows. */
const flipDriveCase = (p: string): string =>
  p.replace(/^[A-Za-z]/, c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))

/** The hook as Claude Code runs it: the event on stdin, `env` on top of the sandbox's; what it printed. */
async function runHook(
  box: Sandbox,
  input: unknown,
  pane: string | null = 'p1',
  env: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'hook.ts')], {
    cwd: root,
    env: { ...box.env, ...(pane ? { HERDR_PANE_ID: pane } : {}), ...env },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  assert.equal(await proc.exited, 0, stderr)
  assert.equal(stderr, '')
  return stdout
}
const context = (event: string, text: string): string =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`
const sessionStart = (box: Sandbox, sid: string) => ({ hook_event_name: 'SessionStart', session_id: sid, cwd: box.dir })
/** The brief as the hook in pane p1 gives it: the sandbox's env, which is not herdr's (no HERDR_ENV). */
const briefIn = (box: Sandbox, card: Card | null): string =>
  brief(normalizeConfig({ language: 'en' }), card, box.dir, { ...box.env, HERDR_PANE_ID: 'p1' })

test('SessionStart in a herdr pane: the full brief, and the card remembers it was briefed', async () => {
  const box = await sandbox()
  englishConfig(box)
  putCard(box, { key: 's1', category: 'acme', doing: 'fix the CI' })
  const out = await runHook(box, { hook_event_name: 'SessionStart', session_id: 's1', cwd: box.dir })
  useLanguage('en')
  assert.equal(out, context('SessionStart', briefIn(box, cardOf(box, 's1'))))
  assert.equal(cardOf(box, 's1')?.briefV, BRIEF_VERSION)
  assert.equal(typeof cardOf(box, 's1')?.briefedAt, 'number')
})

test('SessionStart where herdr says it is the host: the brief tells the session its pane', async () => {
  const box = await sandbox()
  englishConfig(box)
  const herdr = { HERDR_ENV: '1', HERDR_TAB_ID: 'w1:t2', HERDR_WORKSPACE_ID: 'w1' }
  const out = await runHook(box, sessionStart(box, 's1'), 'w1:p3', herdr)
  useLanguage('en')
  const text = brief(normalizeConfig({ language: 'en' }), cardOf(box, 's1'), box.dir, {
    ...box.env,
    HERDR_PANE_ID: 'w1:p3',
    ...herdr,
  })
  assert.equal(out, context('SessionStart', text))
  assert.match(text, /runs in herdr, in pane w1:p3 \(tab w1:t2, workspace w1\)\..*herdr-agents skill/)
})

test('UserPromptSubmit: the brief once for a session briefed by an older version, then the wait reminder', async () => {
  const box = await sandbox()
  englishConfig(box)
  putCard(box, { key: 's1', wait: 'the client', briefedAt: 1 })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt: 'go on' }
  const first = await runHook(box, prompt)
  assert.match(
    first,
    /^\{"hookSpecificOutput":\{"hookEventName":"UserPromptSubmit","additionalContext":"\[agent-board\] The user watches/,
  )
  assert.equal(cardOf(box, 's1')?.briefV, BRIEF_VERSION)
  assert.equal(await runHook(box, prompt), context('UserPromptSubmit', waitReminder({ wait: 'the client' })))
  putCard(box, { key: 's1', briefV: BRIEF_VERSION })
  assert.equal(await runHook(box, prompt), '')
})

test('outside a herdr pane, or without a session id: nothing said, no card written', async () => {
  const box = await sandbox()
  assert.equal(await runHook(box, { hook_event_name: 'SessionStart', session_id: 's1', cwd: box.dir }, null), '')
  assert.equal(await runHook(box, { hook_event_name: 'SessionStart', cwd: box.dir }), '')
  assert.equal(cardOf(box, 's1'), null)
})

test('a board reminder does not count as the user answering the session', async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', ask: 'Send it?', askSince: 1, pin: 'me', pinAt: 1, briefV: 99 })
  const hook = (prompt: string) =>
    runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt })
  await hook('[board reminder from lead-session] check the CI run')
  assert.equal(cardOf(box, 's1')?.ask, 'Send it?')
  // The session works again: a column dragged to by hand goes, as with any work.
  assert.equal(cardOf(box, 's1')?.pin, undefined)
  await hook('yes, send it')
  assert.equal(cardOf(box, 's1')?.ask, undefined)
})

// A pi session runs Claude Code through its bridge: the hook hears of the bridge's Claude session,
// the board shows pi's (herdr's agent_session of the pane, the session's file), where `board ask` went.
const PI_KEY = '/home/me/.pi/agent/sessions/--home-me--/2026-10-20T05-10-02-695Z_01a1.jsonl'
const PI_FILE = PI_KEY.replace(/[^A-Za-z0-9_-]/g, '_')
const piPane = (box: Sandbox) =>
  box.state({
    'agent get': { result: { agent: { agent: 'pi', agent_status: 'idle', agent_session: { value: PI_KEY } } } },
  })

test("a pi session: the user's answer clears the ask on pi's card, the board's, not only the bridge's", async () => {
  const box = await sandbox()
  piPane(box)
  putCard(box, { key: PI_FILE, ask: 'Close the kit?', askSince: 1, pin: 'me', pinAt: 1 })
  putCard(box, { key: 'cc1', briefV: BRIEF_VERSION })
  const hook = (prompt: string) =>
    runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: box.dir, prompt }, 'w6:p1', {
      PI_CODING_AGENT: 'true',
    })
  await hook('[board reminder from lead-session] check the CI run')
  expect(cardOf(box, PI_FILE)).toMatchObject({ ask: 'Close the kit?', askSince: 1 })
  expect(cardOf(box, PI_FILE)?.pin).toBeUndefined()
  await hook('closed it, go on')
  expect(cardOf(box, PI_FILE)?.ask).toBeUndefined()
  expect(cardOf(box, PI_FILE)?.askSince).toBeUndefined()
  expect(box.calls()).toContainEqual(['agent', 'get', 'w6:p1'])
})

test("a pi session: the wait reminder comes from pi's card", async () => {
  const box = await sandbox()
  englishConfig(box)
  piPane(box)
  putCard(box, { key: PI_FILE, wait: 'the client' })
  putCard(box, { key: 'cc1', briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: box.dir, prompt: 'go on' }
  useLanguage('en')
  expect(await runHook(box, prompt, 'w6:p1', { PI_CODING_AGENT: 'true' })).toBe(
    context('UserPromptSubmit', waitReminder({ wait: 'the client' })),
  )
})

test("a pi session: pi's card is told the profile of the account its turn went to, as it changes", async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const work = profileFolder(box, '.claude-work')
  piPane(box)
  putCard(box, { key: PI_FILE, category: 'acme', doing: 'fix the CI' })
  const prompt = (sid: string) => ({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: box.dir, prompt: 'go' })
  // claude-bridge-work: the bridge runs its Claude in the work folder.
  await runHook(box, prompt('cc1'), 'w6:p1', { PI_CODING_AGENT: 'true', CLAUDE_CONFIG_DIR: work })
  expect(cardOf(box, PI_FILE)).toMatchObject({
    category: 'acme',
    doing: 'fix the CI',
    profile: 'work',
    profileDir: work,
  })
  const first = cardOf(box, PI_FILE)
  await Bun.sleep(5)
  await runHook(box, prompt('cc1'), 'w6:p1', { PI_CODING_AGENT: 'true', CLAUDE_CONFIG_DIR: work })
  expect(cardOf(box, PI_FILE)).toEqual(first)
  // The session switched to the personal account: the bridge's new Claude runs in ~/.claude.
  await runHook(box, prompt('cc2'), 'w6:p1', { PI_CODING_AGENT: 'true' })
  expect(cardOf(box, PI_FILE)?.profile).toBe('default')
  expect(sameDir(String(cardOf(box, PI_FILE)?.profileDir), join(home, '.claude'))).toBe(true)
})

test('a Claude session of its own tells no other card its profile', async () => {
  const box = await sandbox()
  const work = profileFolder(box, '.claude-work')
  putCard(box, { key: PI_FILE, category: 'acme' })
  putCard(box, { key: 's1', briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt: 'go' }
  await runHook(box, prompt, 'w6:p1', { CLAUDE_CONFIG_DIR: work })
  expect(cardOf(box, 's1')?.profile).toBe('work')
  expect(cardOf(box, PI_FILE)).toEqual({ key: PI_FILE, category: 'acme' })
  expect(box.calls()).toEqual([])
})

test('PI_CODING_AGENT in the env of a pane that herdr says runs Claude: no other card is touched', async () => {
  const box = await sandbox()
  box.state({
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: 'other' } } } },
  })
  putCard(box, { key: 'other', ask: 'Ship it?', askSince: 1 })
  putCard(box, { key: 'cc1', ask: 'Send it?', askSince: 1, briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: box.dir, prompt: 'yes' }
  await runHook(box, prompt, 'w1:p1', { PI_CODING_AGENT: 'true' })
  expect(cardOf(box, 'other')).toEqual({ key: 'other', ask: 'Ship it?', askSince: 1 })
  expect(cardOf(box, 'cc1')?.ask).toBeUndefined()
})

test('herdr failing or slow to answer leaves the hook as it was', async () => {
  const box = await sandbox()
  box.state({ 'agent get': { error: 'server not running' } })
  putCard(box, { key: 'cc1', ask: 'Send it?', askSince: 1, briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'cc1', cwd: box.dir, prompt: 'yes' }
  expect(await runHook(box, prompt, 'w1:p1', { PI_CODING_AGENT: 'true' })).toBe('')
  expect(cardOf(box, 'cc1')?.ask).toBeUndefined()
})

// As Claude Code 2.1.303 hands it over, in auto mode, before the dialog opens.
const QUESTIONS = {
  questions: [
    {
      question: 'Archive the 13 finished sessions?',
      header: 'Cleanup',
      multiSelect: false,
      options: [
        { label: 'Archive the 13 (Recommended)', description: 'Their tabs close; the board can bring any back.' },
        { label: 'Let me pick', description: 'Tell me which ones to keep.' },
      ],
    },
  ],
}
const preToolUse = (box: Sandbox, tool: string, input: unknown = QUESTIONS) => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  transcript_path: join(box.dir, 's1.jsonl'),
  cwd: box.dir,
  permission_mode: 'auto',
  tool_name: tool,
  tool_input: input,
  tool_use_id: 'toolu_01Ks',
})

test('PreToolUse on AskUserQuestion: the call goes on the card, nothing is said, nothing else is written', async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', category: 'acme', ask: 'Ship it?', askSince: 1, briefV: BRIEF_VERSION })
  const before = Date.now()
  expect(await runHook(box, preToolUse(box, 'AskUserQuestion'))).toBe('')
  const card = cardOf(box, 's1')
  const asking = card?.asking as Record<string, unknown>
  expect(asking).toEqual({
    id: 'toolu_01Ks',
    detail: 'Archive the 13 finished sessions?',
    questions: [{ ...QUESTIONS.questions[0], preview: false }],
    at: asking.at,
  })
  expect(asking.at).toBeGreaterThanOrEqual(before)
  // The rest of the card as it was: no profile report, no brief, the ask stays.
  expect(Object.keys(card ?? {}).sort()).toEqual([
    'ask',
    'askSince',
    'asking',
    'briefV',
    'category',
    'key',
    'updatedAt',
  ])
  expect(box.calls()).toEqual([])

  // A form the board cannot answer (no options) still names its question.
  await runHook(box, preToolUse(box, 'AskUserQuestion', { questions: [{ question: 'Which?', options: [] }] }))
  expect(cardOf(box, 's1')?.asking).toMatchObject({ id: 'toolu_01Ks', detail: 'Which?', questions: null })
})

test('PreToolUse of another tool, outside a herdr pane or without a call id: no card written', async () => {
  const box = await sandbox()
  expect(await runHook(box, preToolUse(box, 'Bash', { command: 'ls' }))).toBe('')
  expect(await runHook(box, preToolUse(box, 'AskUserQuestion'), null)).toBe('')
  expect(await runHook(box, { ...preToolUse(box, 'AskUserQuestion'), tool_use_id: '' })).toBe('')
  expect(cardOf(box, 's1')).toBeNull()
  expect(box.calls()).toEqual([])
})

test('a Claude session of its own asks herdr nothing', async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', ask: 'Send it?', askSince: 1, briefV: BRIEF_VERSION })
  await runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt: 'yes' })
  expect(cardOf(box, 's1')?.ask).toBeUndefined()
  expect(box.calls()).toEqual([])
})

test('a task reporting back does not count as the user answering the session (hook)', async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', ask: 'Send it?', askSince: 1, briefV: 99 })
  const prompt = notification('Agent "Review" finished')
  await runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt })
  assert.equal(cardOf(box, 's1')?.ask, 'Send it?')
})

test("a call's results do not count as the user answering the session (hook)", async () => {
  const box = await sandbox()
  putCard(box, { key: 's1', ask: 'Deploy now?', askSince: 1, briefV: 99 })
  const report =
    '# Release 2.4 call · Oct 17 · 32 min\n\n- Decided: ship on Monday\n\nFull protocol: /tmp/meeting_1.summary.md'
  const prompt = promptOf({ id: 'c1', key: 's1', kind: 'call', text: report, next: Date.now() }, Date.now())
  await runHook(box, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt })
  assert.equal(cardOf(box, 's1')?.ask, 'Deploy now?')
})

// The profile a session runs in: the hook runs in the session's own env, so its CLAUDE_CONFIG_DIR
// (unset: ~/.claude) is the session's folder, and the profile that has that folder its id.
test('every spelling of the default folder reports default, and the brief is as before', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  englishConfig(box)
  useLanguage('en')
  putCard(box, { key: 's1', category: 'acme', doing: 'fix the CI' })
  const variants = [
    undefined,
    join(home, '.claude'),
    `${join(home, '.claude')}${sep}`,
    `${home}/.claude/`,
    `${join(home, '.claude').replaceAll('\\', '/')}/`,
    '~/.claude',
    ...(process.platform === 'win32' ? [flipDriveCase(join(home, '.claude'))] : []),
  ]
  for (const v of variants) {
    const out = await runHook(box, sessionStart(box, 's1'), 'p1', v === undefined ? {} : { CLAUDE_CONFIG_DIR: v })
    expect(out).toBe(context('SessionStart', briefIn(box, cardOf(box, 's1'))))
    expect(cardOf(box, 's1')?.profile).toBe('default')
    expect(sameDir(String(cardOf(box, 's1')?.profileDir), join(home, '.claude'))).toBe(true)
  }
})

test('a work session reports work; a folder no profile has keeps the folder and no id', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const work = profileFolder(box, '.claude-work')
  await runHook(box, sessionStart(box, 's2'), 'p1', { CLAUDE_CONFIG_DIR: work })
  expect(cardOf(box, 's2')).toMatchObject({ profile: 'work', profileDir: work })
  // `~` is the home folder, never a folder named so.
  await runHook(box, sessionStart(box, 's4'), 'p1', { CLAUDE_CONFIG_DIR: '~/.claude-work' })
  expect(cardOf(box, 's4')?.profile).toBe('work')
  expect(sameDir(String(cardOf(box, 's4')?.profileDir), join(home, '.claude-work'))).toBe(true)
  // A profile the card named before goes: it is never kept for a folder that is not its own.
  putCard(box, { key: 's3', profile: 'default', profileDir: join(home, '.claude') })
  await runHook(box, sessionStart(box, 's3'), 'p1', { CLAUDE_CONFIG_DIR: join(box.dir, 'odd') })
  expect(cardOf(box, 's3')?.profile).toBeUndefined()
  expect(cardOf(box, 's3')?.profileDir).toBe(join(box.dir, 'odd'))
})

test('outside a herdr pane nothing is written; an unchanged profile is not written again', async () => {
  const box = await sandbox()
  const work = { CLAUDE_CONFIG_DIR: profileFolder(box, '.claude-work') }
  expect(await runHook(box, sessionStart(box, 's1'), null, work)).toBe('')
  expect(cardOf(box, 's1')).toBeNull()
  putCard(box, { key: 's1', briefV: BRIEF_VERSION })
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: box.dir, prompt: 'go on' }
  expect(await runHook(box, prompt, 'p1', work)).toBe('')
  const first = cardOf(box, 's1')
  expect(first).toMatchObject({ profile: 'work', profileDir: work.CLAUDE_CONFIG_DIR })
  expect(typeof first?.updatedAt).toBe('number')
  await Bun.sleep(5)
  expect(await runHook(box, prompt, 'p1', work)).toBe('')
  expect(cardOf(box, 's1')).toEqual(first)
  // The profiles are only read: config.json is written where it was before (a first brief), not here.
  expect(existsSync(configFile(box))).toBe(false)
})

// After a herdr restart, herdr types each pane's resume command into a new shell, which has the
// default profile: a session in another profile has its SessionStart tell herdr `board resume …`
// instead (core/resume.ts), by a reporter of its own (test/entrypoints/resume.test.ts). Claude Code
// runs hooks without the sandbox's no-orphans flag, so these do too: the reporter outlives the hook.
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const claudeIn = (session: string) => ({
  'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: session } } } },
  'pane report-agent-session': { result: null },
})

/** `board` on PATH, as install puts it there (the shims are never run here); the PATH with it. */
function boardOnPath(box: Sandbox): string {
  const bin = join(box.dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'board'), '#!/bin/sh\n# agent-board\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'board.cmd'), '@rem agent-board\r\n@exit /b 0\r\n')
  return `${bin}${delimiter}${box.env.PATH}`
}

/** The hook as Claude Code runs it in herdr pane w1:p1; `input` on top of a SessionStart of SID. */
async function runInHerdr(box: Sandbox, env: Record<string, string>, input: Record<string, unknown> = {}) {
  const { BUN_FEATURE_FLAG_NO_ORPHANS: _, ...plain } = box.env
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'hook.ts')], {
    cwd: root,
    env: { ...plain, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', ...env },
    stdin: new TextEncoder().encode(JSON.stringify({ ...sessionStart(box, SID), ...input })),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  assert.equal(await proc.exited, 0, stderr)
  assert.equal(stderr, '')
  return stdout
}
const reported = (box: Sandbox): string[] | undefined => box.calls().find(c => c[1] === 'report-agent-session')

/** herdr-wake's SessionStart hook in the profile folder `dir`, and its config.json with `wakeCommand`. */
function herdrWake(box: Sandbox, dir: string, wakeCommand: string): void {
  const wakeDir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'herdr-wake')
  const command = `node "${join(wakeDir, 'hook.mjs')}" session-start`
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] } }),
  )
  mkdirSync(wakeDir, { recursive: true })
  writeFileSync(join(wakeDir, 'config.json'), JSON.stringify({ wakeCommand }))
}

test('SessionStart of a work session in herdr: herdr is told to resume it with board resume, in work', async () => {
  const box = await sandbox()
  englishConfig(box)
  const work = profileFolder(box, '.claude-work')
  box.state(claudeIn(SID))
  const before = Date.now()
  const out = await runInHerdr(box, { CLAUDE_CONFIG_DIR: work, PATH: boardOnPath(box) })
  // The brief as ever, and the card says the folder board resume finds the session in.
  expect(out).toContain('"hookEventName":"SessionStart"')
  expect(cardOf(box, SID)).toMatchObject({ profile: 'work', profileDir: work })
  await until(() => reported(box), 8000)
  expect(box.calls()[0]).toEqual(['agent', 'get', 'w1:p1'])
  const sent = reported(box) ?? []
  expect(sent.slice(0, 8)).toEqual([
    'pane',
    'report-agent-session',
    'w1:p1',
    '--source',
    'herdr:claude',
    '--agent',
    'claude',
    '--seq',
  ])
  expect(Number(sent[8])).toBeGreaterThan(before)
  expect(sent.slice(9)).toEqual(['--agent-session-id', SID, '--', 'board', 'resume', SID, '--profile', 'work'])
})

test("herdr-wake with its default wakeCommand reports nothing, so the board's report goes", async () => {
  const box = await sandbox()
  const work = profileFolder(box, '.claude-work')
  herdrWake(box, work, 'claude --resume {session}')
  box.state(claudeIn(SID))
  await runInHerdr(box, { CLAUDE_CONFIG_DIR: work, PATH: boardOnPath(box) })
  await until(() => reported(box), 8000)
  expect(reported(box)?.slice(-5)).toEqual(['board', 'resume', SID, '--profile', 'work'])
})

test("every other session keeps herdr's own claude --resume: no reporter, no herdr call", async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const work = profileFolder(box, '.claude-work')
  const PATH = boardOnPath(box)
  box.state(claudeIn(SID))
  // The default profile: unset, or spelled out as the owner's .bashrc exports it.
  await runInHerdr(box, { PATH })
  await runInHerdr(box, { PATH, CLAUDE_CONFIG_DIR: join(home, '.claude') })
  await runInHerdr(box, { PATH, CLAUDE_CONFIG_DIR: '~/.claude/' })
  // Not in herdr: no pane, or herdr does not say it is the host.
  await runInHerdr(box, { PATH, CLAUDE_CONFIG_DIR: work, HERDR_PANE_ID: '' })
  await runInHerdr(box, { PATH, CLAUDE_CONFIG_DIR: work, HERDR_ENV: '' })
  // A subagent's start, pi's bridge (pi reports its own), and every prompt.
  await runInHerdr(box, { PATH, CLAUDE_CONFIG_DIR: work }, { agent_id: 'agent-1' })
  await runInHerdr(box, { PATH, CLAUDE_CONFIG_DIR: work, PI_CODING_AGENT: 'true' })
  await runInHerdr(box, { PATH, CLAUDE_CONFIG_DIR: work }, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' })
  // No board on PATH: herdr could not run the command in the restored shell.
  await runInHerdr(box, { CLAUDE_CONFIG_DIR: work })
  // herdr-wake's SessionStart hook in the profile, with a wakeCommand of its own: it reports that.
  const team = profileFolder(box, '.claude-team')
  herdrWake(box, team, 'claude-tg --resume {session}')
  await runInHerdr(box, { PATH, CLAUDE_CONFIG_DIR: team })
  // A reporter would have asked herdr by now (its first try is a second after the start).
  await Bun.sleep(1800)
  expect(box.calls()).toEqual([])
})
